import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/xterm';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashSessionNameForOwnerKey } from '@/lib/ws-server/dash-terminal-persistence';
import { resolvePreferredShell, resolveTmuxBinary, sanitizePtyEnv } from '@/lib/ws-server/pty-support';

type WireFrame = {
  channel?: string;
  event?: string;
  data?: { data?: string; requestId?: string; sessionName?: string };
};

const ESC = String.fromCharCode(27);
const CSI_S = new RegExp(`${ESC}\\[[0-9]*S`);
const COLS = 20;
const ROWS = 5;
const LINE_COUNT = 40;
const dataDir = mkdtempSync(join(tmpdir(), 'o8-csi-s-ws-xterm-'));
const token = 'dash-terminal-csi-s-token';
const brokenOwner = `csi-s-broken-${process.pid}`;
const fixedOwner = `csi-s-fixed-${process.pid}`;
const brokenSession = dashSessionNameForOwnerKey(brokenOwner)!;
const fixedSession = dashSessionNameForOwnerKey(fixedOwner)!;
const sockets = new Set<WebSocket>();
let apiServer: Server;
let apiPort = 0;
let wsPort = 0;
let wsProcess: ChildProcess | null = null;
let serverOutput = '';

const tmuxAvailable = process.platform !== 'win32' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-4_000)}`);
}

function capturePane(sessionName: string) {
  return execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', sessionName], { encoding: 'utf8' });
}

function numberedLines(text: string): string[] {
  return [...text.matchAll(/\b(\d{3})\b/g)].map((match) => match[1]!);
}

function renderedText(terminal: Terminal) {
  const lines: string[] = [];
  for (let index = 0; index < terminal.buffer.active.length; index += 1) {
    lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

async function renderPayload(payload: string) {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1_000 });
  await new Promise<void>((resolve) => terminal.write(Buffer.from(payload, 'base64'), resolve));
  return numberedLines(renderedText(terminal));
}

async function connectRenderedClient() {
  const frames: WireFrame[] = [];
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1_000 });
  let rawTerminalData = '';
  let writes = Promise.resolve();
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as WireFrame;
    frames.push(frame);
    if (frame.channel !== 'terminal' || frame.event !== 'data' || typeof frame.data?.data !== 'string') return;
    const bytes = Buffer.from(frame.data.data, 'base64');
    rawTerminalData += bytes.toString('utf8');
    writes = writes.then(() => new Promise<void>((resolve) => terminal.write(bytes, resolve)));
  });
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  await waitFor(() => frames.some((frame) => frame.channel === 'system' && frame.event === 'connected'), 'authenticated WebSocket connection');
  return { socket, frames, terminal, raw: () => rawTerminalData, flushed: () => writes };
}

async function startWsServer() {
  serverOutput = '';
  wsProcess = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_PERSISTENT_TERMINALS: '1',
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; } catch { return false; }
  }, 'ws server health', 30_000);
}

async function stopWsServer() {
  const running = wsProcess;
  wsProcess = null;
  if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await Promise.race([once(running, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function createAndFill(ownerKey: string, sessionName: string) {
  const client = await connectRenderedClient();
  client.socket.send(JSON.stringify({ type: 'terminal-create', cols: COLS, rows: ROWS, requestId: ownerKey, ownerKey }));
  await waitFor(() => client.frames.some((frame) => frame.event === 'created' && frame.data?.sessionName === sessionName), `${ownerKey} creation`);
  client.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: COLS, rows: ROWS }));
  await waitFor(() => client.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === sessionName), `${ownerKey} attachment`);
  client.socket.send(JSON.stringify({
    type: 'terminal-input',
    sessionName,
    data: `python3 -c 'for i in range(${LINE_COUNT}): print(f"{i:03d}")'\n`,
  }));
  const expected = Array.from({ length: LINE_COUNT }, (_, index) => String(index).padStart(3, '0'));
  await waitFor(() => expected.every((line) => numberedLines(capturePane(sessionName)).includes(line)), `${ownerKey} pane history`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await client.flushed();
  return client;
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  await startWsServer();
}, 40_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await stopWsServer();
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  for (const sessionName of [brokenSession, fixedSession]) {
    try { execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' }); } catch { /* */ }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe.runIf(tmuxAvailable)('dashboard terminal CSI S through WebSocket and xterm (#1979)', () => {
  it('witnesses unfixed scrollback loss, then renders the production fix equal to tmux history', async () => {
    const tmuxBin = resolveTmuxBinary();
    execFileSync(tmuxBin, ['new-session', '-d', '-s', brokenSession, '-x', String(COLS), '-y', String(ROWS), resolvePreferredShell(), '-l'], {
      env: sanitizePtyEnv() as NodeJS.ProcessEnv,
      timeout: 8_000,
    });
    const broken = await createAndFill(brokenOwner, brokenSession);
    expect(CSI_S.test(broken.raw())).toBe(true);
    expect(numberedLines(renderedText(broken.terminal))).not.toEqual(numberedLines(capturePane(brokenSession)));

    const fixed = await createAndFill(fixedOwner, fixedSession);
    expect(CSI_S.test(fixed.raw())).toBe(false);
    const partialRegionRows = await renderPayload(Buffer.from(
      `111\r\n222\r\n333\r\n444\r\n555${ESC}[2;4r${ESC}[4;1H777\n${ESC}[r`,
    ).toString('base64'));
    expect(partialRegionRows).toContain('777');
    fixed.socket.close();
    await once(fixed.socket, 'close');
    await stopWsServer();
    await startWsServer();
    const restored = await connectRenderedClient();
    restored.socket.send(JSON.stringify({ type: 'terminal-create', cols: COLS, rows: ROWS, requestId: 'restored', ownerKey: fixedOwner }));
    await waitFor(() => restored.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === fixedSession), 'cold restored attachment');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await restored.flushed();
    const captureRows = numberedLines(capturePane(fixedSession));
    const scrollbackFrame = restored.frames.find((frame) => {
      if (frame.channel !== 'terminal' || frame.event !== 'data' || !frame.data?.data) return false;
      return Buffer.from(frame.data.data, 'base64').toString('utf8').includes('000');
    });
    expect(scrollbackFrame?.data?.data).toBeTypeOf('string');
    const replayRows = await renderPayload(scrollbackFrame!.data!.data!);
    const visibleRows = numberedLines(renderedText(restored.terminal));
    expect([...replayRows, ...visibleRows.filter((row) => !replayRows.includes(row))]).toEqual(captureRows);


  }, 60_000);
});
