import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createDashTmuxSessionSync } from '@/lib/ws-server/dash-terminal-persistence';
import { resolvePreferredShell, resolveTmuxBinary, sanitizePtyEnv } from '@/lib/ws-server/pty-support';

const require = createRequire(import.meta.url);
const ESC = String.fromCharCode(27);
const CSI_S = new RegExp(`${ESC}\\[[0-9]*S`);
const COLS = 20;
const ROWS = 5;
const LINE_COUNT = 40;

type ChildPty = {
  onData(cb: (data: string) => void): void;
  write(data: string): void;
  kill(): void;
};

function loadPty(): {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): ChildPty;
} | null {
  try {
    return require('node-pty');
  } catch {
    return null;
  }
}

const pty = loadPty();
const tmuxAvailable = process.platform !== 'win32' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function stripAnsi(text: string) {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');
}

function numberedLines(text: string): string[] {
  return [...stripAnsi(text).matchAll(/\b(\d{3})\b/g)].map((m) => m[1]!);
}

async function attachAndPrint(sessionName: string): Promise<{ raw: string; capture: string }> {
  const tmuxBin = resolveTmuxBinary();
  const proc = pty!.spawn(tmuxBin, ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: process.cwd(),
    env: sanitizePtyEnv() as NodeJS.ProcessEnv,
  });
  let raw = '';
  proc.onData((chunk) => { raw += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 250));
  proc.write(`python3 -c 'for i in range(${LINE_COUNT}): print(f"{i:03d}")'\n`);
  const expected = Array.from({ length: LINE_COUNT }, (_, i) => String(i).padStart(3, '0'));
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    let capture = '';
    try {
      capture = execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', sessionName], { encoding: 'utf8' });
    } catch { /* session settling */ }
    if (expected.every((n) => numberedLines(capture).includes(n))) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      proc.kill();
      return { raw, capture };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  proc.kill();
  throw new Error(`timed out filling capture-pane. pty=${JSON.stringify(raw.slice(-500))}`);
}

describe.runIf(Boolean(pty) && tmuxAvailable)('tmux attach CSI S vs indn@ (#1979)', () => {
  it('unfixed attach emits CSI S; createDashTmuxSessionSync indn@ does not', async () => {
    const tmuxBin = resolveTmuxBinary();
    const shell = resolvePreferredShell();
    const broken = `o8-csi-s-broken-${process.pid}`;
    const fixed = `o8-csi-s-fixed-${process.pid}`;
    const env = sanitizePtyEnv();
    try {
      execFileSync(tmuxBin, [
        'new-session', '-d', '-s', broken, '-x', String(COLS), '-y', String(ROWS), shell, '-l',
      ], { env: env as NodeJS.ProcessEnv, timeout: 8000 });
      const brokenRun = await attachAndPrint(broken);
      expect(CSI_S.test(brokenRun.raw)).toBe(true);

      expect(createDashTmuxSessionSync({
        enabled: true,
        sessionName: fixed,
        cols: COLS,
        rows: ROWS,
        cwd: process.cwd(),
        shell,
        env: env as NodeJS.ProcessEnv,
      })).toBe(true);
      const fixedRun = await attachAndPrint(fixed);
      expect(CSI_S.test(fixedRun.raw)).toBe(false);
      const expected = Array.from({ length: LINE_COUNT }, (_, i) => String(i).padStart(3, '0'));
      const captured = numberedLines(fixedRun.capture);
      expect(expected.every((n) => captured.includes(n))).toBe(true);
    } finally {
      for (const name of [broken, fixed]) {
        try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* */ }
      }
    }
  });
});
