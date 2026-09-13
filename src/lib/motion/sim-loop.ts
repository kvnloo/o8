import { JS_SIM_MAX_HZ } from './pipeline';
import { takeSimBudget } from './js-cadence';

export interface SimLoopOptions {
  maxHz?: number;
  pauseWhenHidden?: boolean;
  reducedMotion?: boolean;
  raf?: (callback: FrameRequestCallback) => number;
  caf?: (handle: number) => void;
  now?: () => number;
  hidden?: () => boolean;
}

export interface SimLoopHandle {
  stop: () => void;
}

/**
 * Display-synced simulation loop for canvas/WebGL. CSS compositor animations
 * should NOT go through here — they already vsync in Core Animation / GTK.
 *
 * `draw(nowMs, dtMs)` sees wall-clock time so motion speed is independent of
 * the panel's Hertz. `maxHz` (default 120) is the sim ceiling.
 */
export function startSimLoop(
  draw: (nowMs: number, dtMs: number) => void,
  options: SimLoopOptions = {},
): SimLoopHandle {
  const raf = options.raf ?? (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => setTimeout(() => callback(options.now?.() ?? Date.now()), 16) as unknown as number);
  const caf = options.caf ?? (typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame.bind(window)
    : (handle: number) => clearTimeout(handle));
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const hidden = options.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  const maxHz = options.maxHz ?? JS_SIM_MAX_HZ;
  const pauseWhenHidden = options.pauseWhenHidden !== false;

  if (options.reducedMotion) {
    draw(now(), 0);
    return { stop() {} };
  }

  let handle = 0;
  let stopped = false;
  let last = now();
  let acc = 0;

  const tick: FrameRequestCallback = (ts) => {
    if (stopped) return;
    handle = raf(tick);
    const t = Number.isFinite(ts) ? ts : now();
    const rawDt = t - last;
    last = t;
    if (pauseWhenHidden && hidden()) {
      acc = 0;
      return;
    }
    const dt = rawDt > 0 && rawDt < 250 ? rawDt : 1000 / maxHz;
    const budget = takeSimBudget(acc, dt, maxHz);
    acc = budget.remainderMs;
    if (budget.run) draw(t, dt);
  };

  handle = raf(tick);
  return {
    stop() {
      stopped = true;
      caf(handle);
    },
  };
}
