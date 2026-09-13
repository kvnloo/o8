import { describe, it, expect } from 'vitest';
import { compositorForPlatform } from './pipeline';
import { keepWaitingForPaint, PAINT_WAIT_DEADLINE_MS } from './paint-deadline';

describe('compositorForPlatform', () => {
  it('maps macOS to Core Animation + Metal', () => {
    expect(compositorForPlatform('macos')).toEqual({
      compositor: 'core-animation',
      gpuBackend: 'metal',
    });
    expect(compositorForPlatform('darwin')).toEqual({
      compositor: 'core-animation',
      gpuBackend: 'metal',
    });
  });

  it('maps Linux to WebKitGTK + EGL', () => {
    expect(compositorForPlatform('linux')).toEqual({
      compositor: 'webkitgtk',
      gpuBackend: 'egl',
    });
  });
});

describe('keepWaitingForPaint', () => {
  it('does not use a raw frame count, so 540 Hz cannot trip the deadline early', () => {
    const elapsedAt540For600Frames = 600 * (1000 / 540);
    expect(elapsedAt540For600Frames).toBeLessThan(PAINT_WAIT_DEADLINE_MS);
    expect(keepWaitingForPaint(elapsedAt540For600Frames, false, false)).toBe(true);
  });

  it('stops once painted or crashed, or when the wall clock expires', () => {
    expect(keepWaitingForPaint(100, true, false)).toBe(false);
    expect(keepWaitingForPaint(100, false, true)).toBe(false);
    expect(keepWaitingForPaint(PAINT_WAIT_DEADLINE_MS + 1, false, false)).toBe(false);
  });
});
