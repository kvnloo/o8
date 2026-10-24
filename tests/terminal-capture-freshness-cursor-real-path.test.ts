import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assessTmuxCaptureFreshness,
  legacyScrollbackFreshnessToken,
} from '@/lib/ws-server/terminal-capture-freshness';
import { resolveTmuxBinary, sanitizePtyEnv } from '@/lib/ws-server/pty-support';

const ESC = String.fromCharCode(27);
const COLS = 40;
const ROWS = 8;
const SESSION = `o8-1981-freshness-${process.pid}`;

const tmuxAvailable = process.platform !== 'win32' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function killSession() {
  try {
    execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

function capturePane(): string {
  return execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', SESSION], {
    encoding: 'utf8',
    env: sanitizePtyEnv() as NodeJS.ProcessEnv,
  });
}

function waitForCapture(predicate: (text: string) => boolean, label: string): string {
  const deadline = Date.now() + 8_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = capturePane();
    } catch {
      last = '';
    }
    if (predicate(last)) return last;
    const spinUntil = Date.now() + 50;
    while (Date.now() < spinUntil) { /* poll settle */ }
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last.slice(-400))}`);
}

function sendPython(tmuxBin: string, source: string) {
  execFileSync(tmuxBin, ['send-keys', '-t', SESSION, `python3 -c ${JSON.stringify(source)}`, 'Enter'], {
    env: sanitizePtyEnv() as NodeJS.ProcessEnv,
  });
}

describe.runIf(tmuxAvailable)('cursor-addressed tmux capture freshness real path (#1981)', () => {
  it('keeps newline scrolling fresh and treats a cursor-addressed paint as a current snapshot', () => {
    killSession();
    const tmuxBin = resolveTmuxBinary();
    execFileSync(tmuxBin, [
      'new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS),
    ], { env: sanitizePtyEnv() as NodeJS.ProcessEnv, stdio: 'ignore' });

    try {
      const newlineRows = [
        'nl-row-0-aaaaaaaaaaaaaaaa',
        'nl-row-1-bbbbbbbbbbbbbbbb',
        'nl-row-2-cccccccccccccccc',
      ];
      const newlineScrollback = `${newlineRows.join('\n')}\n`;
      sendPython(tmuxBin, `print(${JSON.stringify(newlineScrollback)}, end='')`);
      const newlineCapture = waitForCapture(
        (text) => newlineRows.every((row) => text.includes(row)),
        'newline rows in capture-pane',
      );
      expect(assessTmuxCaptureFreshness(newlineScrollback, newlineCapture)).toMatchObject({
        fresh: true,
        source: 'tmux',
      });

      const tuiRows = [
        'TUI-ROW-0-aaaaaaaaaaaaaa',
        'TUI-ROW-1-bbbbbbbbbbbbbb',
        'TUI-ROW-2-cccccccccccccc',
        'TUI-ROW-3-dddddddddddddd',
        'TUI-ROW-4-eeeeeeeeeeeeee',
      ];
      let tuiScrollback = `${ESC}[2J${ESC}[H`;
      tuiRows.forEach((row, index) => {
        tuiScrollback += `${ESC}[${index + 1};1H${row}`;
      });
      sendPython(tmuxBin, [
        'import sys',
        `sys.stdout.write(${JSON.stringify(tuiScrollback)})`,
        'sys.stdout.flush()',
      ].join(';'));
      const tuiCapture = waitForCapture(
        (text) => tuiRows.every((row) => text.includes(row)),
        'cursor-addressed rows in capture-pane',
      );
      const legacy = legacyScrollbackFreshnessToken(tuiScrollback);
      expect(tuiCapture.includes(legacy)).toBe(false);
      expect(assessTmuxCaptureFreshness(tuiScrollback, tuiCapture)).toMatchObject({
        fresh: true,
        source: 'tmux',
        fallbackReason: null,
      });
    } finally {
      killSession();
    }
  });
});
