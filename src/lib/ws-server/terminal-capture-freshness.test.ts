import { describe, expect, it } from 'vitest';
import {
  assessTmuxCaptureFreshness,
  composeDashTerminalReveal,
  freshnessTokenFromScrollback,
  legacyScrollbackFreshnessToken,
  renderedRowsFromScrollback,
} from './terminal-capture-freshness';

const ESC = '\x1b';

function cursorPaint(rows: string[]): string {
  let out = `${ESC}[2J${ESC}[H`;
  rows.forEach((row, index) => {
    out += `${ESC}[${index + 1};1H${row}`;
  });
  return out;
}

function newlinePaint(rows: string[]): string {
  return `${rows.join('\n')}\n`;
}

function captureFromRows(rows: string[]): string {
  return `${rows.join('\n')}\n`;
}

describe('terminal capture freshness (#1981)', () => {
  it('keeps newline-scrolling output fresh under both legacy and rendered tokens', () => {
    const rows = [
      'alpha-scroll-line-aaaaaaaa',
      'bravo-scroll-line-bbbbbbbb',
      'charlie-scroll-line-cccccc',
    ];
    const scrollback = newlinePaint(rows);
    const capture = captureFromRows(rows);
    const legacy = legacyScrollbackFreshnessToken(scrollback);
    expect(capture.includes(legacy)).toBe(true);
    expect(assessTmuxCaptureFreshness(scrollback, capture)).toMatchObject({
      fresh: true,
      source: 'tmux',
      fallbackReason: null,
    });
  });

  it('witnesses the pre-fix RED: cursor-addressed paint is stale under the 80-char line token', () => {
    const rows = [
      'ROW0-cursor-addressed-aaaa',
      'ROW1-cursor-addressed-bbbb',
      'ROW2-cursor-addressed-cccc',
      'ROW3-cursor-addressed-dddd',
      'ROW4-cursor-addressed-eeee',
    ];
    const scrollback = cursorPaint(rows);
    const capture = captureFromRows(rows);
    const legacy = legacyScrollbackFreshnessToken(scrollback);
    expect(legacy.length).toBeGreaterThan(0);
    expect(capture.includes(legacy)).toBe(false);
    expect(legacy.includes('ROW')).toBe(true);
  });

  it('treats the same cursor-addressed paint as a fresh tmux snapshot', () => {
    const rows = [
      'ROW0-cursor-addressed-aaaa',
      'ROW1-cursor-addressed-bbbb',
      'ROW2-cursor-addressed-cccc',
      'ROW3-cursor-addressed-dddd',
      'ROW4-cursor-addressed-eeee',
    ];
    const scrollback = cursorPaint(rows);
    const capture = captureFromRows(rows);
    expect(renderedRowsFromScrollback(scrollback).filter(Boolean)).toEqual(rows);
    expect(freshnessTokenFromScrollback(scrollback)).toBe(rows[rows.length - 1]);
    expect(assessTmuxCaptureFreshness(scrollback, capture)).toMatchObject({
      fresh: true,
      source: 'tmux',
      fallbackReason: null,
    });
  });

  it('still reports stale-snapshot when the capture is actually behind', () => {
    const scrollback = cursorPaint(['LIVE-ROW-AAAAAAAA', 'LIVE-ROW-BBBBBBBB']);
    const capture = captureFromRows(['OLD-ROW-AAAAAAAA', 'OLD-ROW-BBBBBBBB']);
    expect(assessTmuxCaptureFreshness(scrollback, capture)).toMatchObject({
      fresh: false,
      source: 'scrollback',
      fallbackReason: 'stale-snapshot',
    });
    expect(composeDashTerminalReveal(scrollback, capture)).toMatchObject({
      source: 'scrollback',
      fallbackReason: 'stale-snapshot',
      payload: scrollback,
    });
  });
});
