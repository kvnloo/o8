import { describe, it, expect } from 'vitest';
import { startSimLoop } from './sim-loop';

describe('startSimLoop', () => {
  it('draws once and stops under reduced motion', () => {
    let draws = 0;
    const loop = startSimLoop(() => { draws += 1; }, { reducedMotion: true });
    expect(draws).toBe(1);
    loop.stop();
    expect(draws).toBe(1);
  });
});
