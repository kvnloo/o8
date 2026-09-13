import { describe, it, expect } from 'vitest';
import { takeDesignFrames, takeSimBudget } from './js-cadence';
import { DESIGN_FRAME_MS } from './pipeline';

describe('takeDesignFrames', () => {
  it('banks sub-frame dts so a 540 Hz panel does not step every rAF', () => {
    let acc = 0;
    let steps = 0;
    for (let i = 0; i < 8; i += 1) {
      const next = takeDesignFrames(acc, 1000 / 540);
      acc = next.remainderMs;
      steps += next.frames;
    }
    expect(steps).toBe(0);
    expect(acc).toBeGreaterThan(0);
    expect(acc).toBeLessThan(DESIGN_FRAME_MS);
  });

  it('yields about 60 design frames per second at 540 Hz rAF', () => {
    let acc = 0;
    let frames = 0;
    for (let i = 0; i < 540; i += 1) {
      const next = takeDesignFrames(acc, 1000 / 540);
      acc = next.remainderMs;
      frames += next.frames;
    }
    expect(frames).toBeGreaterThanOrEqual(59);
    expect(frames).toBeLessThanOrEqual(61);
  });

  it('emits one design frame at 60 Hz', () => {
    expect(takeDesignFrames(0, DESIGN_FRAME_MS)).toEqual({
      frames: 1,
      remainderMs: 0,
    });
  });

  it('splits a hitch into at most the catch-up cap', () => {
    const next = takeDesignFrames(0, 500);
    expect(next.frames).toBeGreaterThanOrEqual(2);
    expect(next.frames).toBeLessThanOrEqual(3);
  });
});

describe('takeSimBudget', () => {
  it('skips draws faster than the sim ceiling', () => {
    const first = takeSimBudget(0, 1000 / 540, 120);
    expect(first.run).toBe(false);
    const second = takeSimBudget(first.remainderMs, 1000 / 540, 120);
    expect(second.run).toBe(false);
  });

  it('runs once the ceiling interval elapses', () => {
    expect(takeSimBudget(0, 1000 / 120, 120).run).toBe(true);
  });
});
