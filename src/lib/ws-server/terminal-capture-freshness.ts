/**
 * #1981 — judge whether a tmux capture-pane snapshot is still a fresh view of
 * the in-memory scrollback tail.
 *
 * Scrolling output is newline-separated, so the last non-empty stripped line
 * of a short tail is a stable token. Cursor-addressed TUI paints (ESC[2J,
 * ESC[row;colH, no line terminators) collapse into one long stripped line;
 * slicing that byte tail spans several rendered rows and never appears in
 * capture-pane (which has real row breaks). Compare rendered rows instead.
 */

const CSI = /\x1b\[[0-9;?]*(?:[ -/]*[@-~])?/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CHARSET = /\x1b[()][0-9A-Za-z]/g;
const SINGLE = /\x1b[78MNO=>]/g;

export type TerminalResyncSource = 'tmux' | 'scrollback';

export type TerminalResyncFreshness = {
  fresh: boolean;
  source: TerminalResyncSource;
  fallbackReason: 'stale-snapshot' | null;
  token: string;
};

/** Naive barrier described in #1981 — last 80 stripped bytes, last non-empty line. */
export function legacyScrollbackFreshnessToken(scrollback: string): string {
  const stripped = stripControls(scrollback);
  const tail = stripped.slice(-80);
  return lastNonEmptyLine(tail);
}

export function stripControls(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(CHARSET, '')
    .replace(SINGLE, '');
}

export function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.replace(/\s+$/g, '');
    if (line.length > 0) return line;
  }
  return '';
}

/**
 * Walk the byte stream into painted rows: newlines advance a row; CUP/H/f
 * addresses a row; ED 2 (ESC[2J) clears the grid.
 */
export function renderedRowsFromScrollback(scrollback: string): string[] {
  const rows: string[] = [''];
  let row = 0;
  let col = 0;

  const ensureRow = (index: number) => {
    while (rows.length <= index) rows.push('');
  };

  const writeChar = (ch: string) => {
    ensureRow(row);
    const line = rows[row]!;
    if (col > line.length) {
      rows[row] = `${line}${' '.repeat(col - line.length)}${ch}`;
    } else if (col === line.length) {
      rows[row] = `${line}${ch}`;
    } else {
      rows[row] = `${line.slice(0, col)}${ch}${line.slice(col + 1)}`;
    }
    col += 1;
  };

  let i = 0;
  while (i < scrollback.length) {
    const ch = scrollback[i]!;
    if (ch === '\x1b' && scrollback[i + 1] === '[') {
      const rest = scrollback.slice(i);
      const match = rest.match(/^\x1b\[([0-9;]*)([A-Za-z])/);
      if (match) {
        const params = match[1]!;
        const cmd = match[2]!;
        const nums = params.split(';').map((part) => {
          const n = Number(part);
          return Number.isFinite(n) && part !== '' ? n : 0;
        });
        if (cmd === 'H' || cmd === 'f') {
          row = Math.max(0, (nums[0] || 1) - 1);
          col = Math.max(0, (nums[1] || 1) - 1);
          ensureRow(row);
        } else if (cmd === 'J' && (nums[0] === 2 || params === '' || params === '2')) {
          rows.splice(0, rows.length, '');
          row = 0;
          col = 0;
        } else if (cmd === 'A') {
          row = Math.max(0, row - (nums[0] || 1));
        } else if (cmd === 'B') {
          row += nums[0] || 1;
          ensureRow(row);
        } else if (cmd === 'C') {
          col += nums[0] || 1;
        } else if (cmd === 'D') {
          col = Math.max(0, col - (nums[0] || 1));
        }
        i += match[0].length;
        continue;
      }
    }
    if (ch === '\n') {
      row += 1;
      col = 0;
      ensureRow(row);
      i += 1;
      continue;
    }
    if (ch === '\r') {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === '\x1b') {
      const osc = scrollback.slice(i).match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
      if (osc) {
        i += osc[0].length;
        continue;
      }
      const csiLoose = scrollback.slice(i).match(/^\x1b\[[0-9;?]*(?:[ -/]*[@-~])?/);
      if (csiLoose) {
        i += csiLoose[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    writeChar(ch);
    i += 1;
  }

  return rows.map((line) => line.replace(/\s+$/g, ''));
}

export function freshnessTokenFromScrollback(scrollback: string): string {
  const rows = renderedRowsFromScrollback(scrollback);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]) return rows[i]!;
  }
  return lastNonEmptyLine(stripControls(scrollback));
}

export function assessTmuxCaptureFreshness(
  scrollback: string,
  captureText: string,
): TerminalResyncFreshness {
  const token = freshnessTokenFromScrollback(scrollback);
  if (!token) {
    return { fresh: true, source: 'tmux', fallbackReason: null, token: '' };
  }
  const captureLines = captureText.split(/\r\n|\n|\r/).map((line) => line.replace(/\s+$/g, ''));
  const tokenInCapture = captureText.includes(token) || captureLines.includes(token);
  if (tokenInCapture) {
    return { fresh: true, source: 'tmux', fallbackReason: null, token };
  }

  const painted = renderedRowsFromScrollback(scrollback).filter(Boolean);
  if (painted.length > 0 && painted.every((row) => captureLines.some((line) => line.includes(row)))) {
    return { fresh: true, source: 'tmux', fallbackReason: null, token };
  }

  return {
    fresh: false,
    source: 'scrollback',
    fallbackReason: 'stale-snapshot',
    token,
  };
}

export function selectTerminalResyncSource(
  scrollback: string,
  captureText: string,
): TerminalResyncSource {
  return assessTmuxCaptureFreshness(scrollback, captureText).source;
}

/** Production reveal seam used by sendDashTerminalReveal. */
export function composeDashTerminalReveal(scrollback: string, captureText: string) {
  const freshness = assessTmuxCaptureFreshness(scrollback, captureText);
  const payload = freshness.source === 'tmux' && captureText ? captureText : scrollback;
  return { ...freshness, payload };
}
