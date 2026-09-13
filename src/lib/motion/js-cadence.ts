import { DESIGN_FRAME_MS, MAX_CATCHUP_MS } from './pipeline';

/**
 * Fold a real-frame `dt` into 60 Hz design ticks.
 *
 * At 540 Hz, `dt` is ~1.85 ms — not enough for one design frame, so this
 * returns 0 and banks the remainder. At 60 Hz it returns 1. A 33 ms hitch
 * returns 2. Catch-up is capped so returning from `document.hidden` cannot
 * dump hundreds of ticks in one React commit.
 */
export function takeDesignFrames(
  accumulatorMs: number,
  dtMs: number,
  options: { maxFrames?: number; frameMs?: number; maxCatchupMs?: number } = {},
): { frames: number; remainderMs: number } {
  const frameMs = options.frameMs ?? DESIGN_FRAME_MS;
  const maxCatchupMs = options.maxCatchupMs ?? MAX_CATCHUP_MS;
  const maxFrames = options.maxFrames ?? Math.max(1, Math.floor(maxCatchupMs / frameMs));
  const dt = Number.isFinite(dtMs) ? Math.max(0, Math.min(dtMs, maxCatchupMs)) : 0;
  const acc = Number.isFinite(accumulatorMs) ? Math.max(0, accumulatorMs) + dt : dt;
  if (frameMs <= 0) return { frames: 0, remainderMs: acc };
  const raw = Math.floor(acc / frameMs);
  const frames = Math.min(maxFrames, raw);
  return { frames, remainderMs: acc - frames * frameMs };
}

/**
 * Skip-too-soon gate for canvas/WebGL simulation. One draw per budget,
 * remainder kept so 540 Hz rAF does not fill-rate the GPU 540 times a second.
 */
export function takeSimBudget(
  accumulatorMs: number,
  dtMs: number,
  maxHz: number,
): { run: boolean; remainderMs: number } {
  const hz = Number.isFinite(maxHz) && maxHz > 0 ? maxHz : 60;
  const minFrame = 1000 / hz;
  const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
  const acc = (Number.isFinite(accumulatorMs) ? Math.max(0, accumulatorMs) : 0) + dt;
  if (acc < minFrame) return { run: false, remainderMs: acc };
  return { run: true, remainderMs: acc % minFrame };
}
