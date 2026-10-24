import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashSessionNameForOwnerKey } from '@/lib/ws-server/dash-terminal-persistence';

type WireFrame = {
  channel?: string;
  event?: string;
  data?: {
    data?: string;
    requestId?: string;
    sessionName?: string;
    source?: string;
    fallbackReason?: string | null;
    snapshot?: boolean;
    scrollbackBytes?: number;
    scrollbackOverflowed?: boolean;
  };
};

const ownerKey = `workspace:terminal-1981-reveal-${process.pid}`;
const sessionName = dashSessionNameForOwnerKey(ownerKey)!;
const dataDir = mkdtempSync(join(tmpdir(), 'o8-1981-ws-reveal-'));
const captureOverridePath = join(dataDir, 'tmux-capture-override');
const token = 'dash-terminal-1981-reveal-token';
const sockets = new Set<WebSocket>();
const SCROLLBACK_MAX = 512 * 1024;
const HEAD_MARKER = 'OVERFLOW-HEAD-1981-UNIQUE';
const TAIL_MARKER = 'OVERFLOW-TAIL-1981-UNIQUE';
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

const TUI_ROWS = [
  'ROW0-cursor-addressed-aaaa',
  'ROW1-cursor-addressed-bbbb',
  'ROW2-cursor-addressed-cccc',
  'ROW3-cursor-addressed-dddd',
  'ROW4-cursor-addressed-eeee',
];
const NEWLINE_ROWS = [
  'alpha-scroll-line-aaaaaaaa',
  'bravo-scroll-line-bbbbbbbb',
  'charlie-scroll-line-cccccc',
];

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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-4_000)}`);
}

async function startWsServer() {
  serverOutput = '';
  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_PERSISTENT_TERMINALS: '1',
      O8_TEST_TMUX_CAPTURE_OVERRIDE: captureOverridePath,
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok;
    } catch {
      return false;
    }
  }, 'ws server health', 30_000);
}

async function stopWsServer() {
  const processToStop = wsProcess;
  wsProcess = null;
  if (!processToStop || processToStop.exitCode !== null) return;
  processToStop.kill('SIGTERM');
  await Promise.race([
    once(processToStop, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ws server did not stop')), 10_000)),
  ]);
}

async function connectClient() {
  const frames: WireFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as WireFrame));
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  await waitFor(
    () => frames.some((frame) => frame.channel === 'system' && frame.event === 'connected'),
    'authenticated WebSocket connection',
  );
  return { socket, frames };
}

function captureVisible() {
  return execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], {
    encoding: 'utf8',
  });
}

function sendHiddenCommand(command: string) {
  execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', command]);
  execFileSync('tmux', ['send-keys', '-t', sessionName, 'Enter']);
}

function decodeData(frames: WireFrame[]) {
  return frames
    .filter((frame) => frame.channel === 'terminal' && frame.event === 'data' && frame.data?.sessionName === sessionName)
    .map((frame) => Buffer.from(frame.data?.data ?? '', 'base64').toString('utf8'))
    .join('');
}

function pythonLiteral(text: string) {
  return JSON.stringify(text);
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
  await stopWsServer().catch(() => undefined);
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  } catch { /* session may not exist */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe.runIf(tmuxAvailable)('dashboard terminal hidden-view reveal freshness through WebSocket (#1981)', () => {
  it('overflows the 512 KiB ring while detached, reveals cursor TUI from tmux, and falls back on a stale capture', async () => {
    const first = await connectClient();
    first.socket.send(JSON.stringify({
      type: 'terminal-create',
      cols: 80,
      rows: 12,
      requestId: '1981-create',
      ownerKey,
    }));
    await waitFor(
      () => first.frames.some((frame) => frame.event === 'created' && frame.data?.sessionName === sessionName),
      'terminal creation',
    );
    first.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 80, rows: 12 }));
    await waitFor(
      () => first.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === sessionName),
      'first attach',
    );

    first.socket.send(JSON.stringify({ type: 'terminal-detach', sessionName }));
    await waitFor(
      () => first.frames.some((frame) => frame.event === 'detached' && frame.data?.sessionName === sessionName),
      'hidden detach',
    );
    first.socket.close();
    await once(first.socket, 'close');

    sendHiddenCommand(`python3 -c ${pythonLiteral(`print(${JSON.stringify(NEWLINE_ROWS.join('\n'))})`)}`);
    await waitFor(
      () => NEWLINE_ROWS.every((row) => captureVisible().includes(row)),
      'hidden newline rows in tmux',
    );

    const revealNewline = await connectClient();
    revealNewline.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 80, rows: 12 }));
    await waitFor(
      () => revealNewline.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === sessionName && frame.data?.source === 'tmux'),
      'newline reveal attached with tmux source',
    );
    const newlineSnapshot = revealNewline.frames.find((frame) => frame.event === 'data' && frame.data?.snapshot === true);
    expect(newlineSnapshot?.data?.source).toBe('tmux');
    expect(newlineSnapshot?.data?.fallbackReason ?? null).toBeNull();
    const newlineText = decodeData(revealNewline.frames);
    for (const row of NEWLINE_ROWS) expect(newlineText).toContain(row);
    revealNewline.socket.send(JSON.stringify({ type: 'terminal-detach', sessionName }));
    await waitFor(
      () => revealNewline.frames.some((frame) => frame.event === 'detached' && frame.data?.sessionName === sessionName),
      'newline reveal detach before overflow',
    );
    revealNewline.socket.close();
    await once(revealNewline.socket, 'close');

    const overflowScript = join(dataDir, 'overflow-tui.py');
    writeFileSync(overflowScript, [
      'import sys, time',
      `print(${JSON.stringify(HEAD_MARKER)})`,
      'sys.stdout.flush()',
      'line = ("F" * 1024)',
      'for i in range(700):',
      '    print(line)',
      '    sys.stdout.flush()',
      '    time.sleep(0.04)',
      'sys.stdout.flush()',
      `print(${JSON.stringify(TAIL_MARKER)})`,
      'sys.stdout.flush()',
    ].join('\n'));
    sendHiddenCommand(`python3 ${overflowScript}`);
    await waitFor(
      () => captureVisible().includes(TAIL_MARKER),
      'overflow filler tail in tmux while detached',
      180_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const tuiScript = [
      'import sys',
      "sys.stdout.write('\\x1b[2J\\x1b[H')",
      ...TUI_ROWS.map((row, index) => `sys.stdout.write('\\x1b[${index + 1};1H${row}')`),
      'sys.stdout.flush()',
    ].join('; ');
    sendHiddenCommand(`python3 -c ${pythonLiteral(tuiScript)}`);
    await waitFor(
      () => TUI_ROWS.every((row) => captureVisible().includes(row)),
      'hidden cursor-addressed rows in tmux',
      30_000,
    );

    const revealTui = await connectClient();
    revealTui.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 80, rows: 12 }));
    await waitFor(
      () => revealTui.frames.some((frame) =>
        frame.event === 'attached' && frame.data?.sessionName === sessionName),
      'TUI reveal attached after overflow',
      30_000,
    );
    const overflowAttached = revealTui.frames.find((frame) => frame.event === 'attached' && frame.data?.sessionName === sessionName);
    expect(overflowAttached?.data, JSON.stringify(overflowAttached)).toMatchObject({
      source: 'tmux',
      scrollbackOverflowed: true,
    });
    expect(overflowAttached?.data?.fallbackReason ?? null).toBeNull();
    expect(overflowAttached?.data?.scrollbackBytes).toBeLessThanOrEqual(SCROLLBACK_MAX);
    const tuiSnapshot = revealTui.frames.find((frame) => frame.event === 'data' && frame.data?.snapshot === true);
    expect(tuiSnapshot?.data?.source).toBe('tmux');
    const tuiText = decodeData(revealTui.frames);
    for (const row of TUI_ROWS) expect(tuiText).toContain(row);
    expect(tuiText).not.toContain(HEAD_MARKER);
    revealTui.socket.close();
    await once(revealTui.socket, 'close');

    writeFileSync(captureOverridePath, 'OLD-ROW-AAAAAAAA\nOLD-ROW-BBBBBBBB\n');
    const revealStale = await connectClient();
    revealStale.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 80, rows: 12 }));
    await waitFor(
      () => revealStale.frames.some((frame) =>
        frame.event === 'attached'
        && frame.data?.sessionName === sessionName
        && frame.data?.source === 'scrollback'
        && frame.data?.fallbackReason === 'stale-snapshot'),
      'stale capture fallback through production reveal',
    );
    const staleSnapshot = revealStale.frames.find((frame) => frame.event === 'data' && frame.data?.snapshot === true);
    expect(staleSnapshot?.data?.source).toBe('scrollback');
    expect(staleSnapshot?.data?.fallbackReason).toBe('stale-snapshot');
    const staleText = decodeData(revealStale.frames);
    expect(staleText).not.toContain('OLD-ROW-AAAAAAAA');
    expect(staleText).not.toContain(HEAD_MARKER);
    for (const row of TUI_ROWS) expect(staleText).toContain(row);

    revealStale.socket.close();
  }, 240_000);
});
