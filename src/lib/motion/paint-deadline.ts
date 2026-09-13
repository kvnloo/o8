/** Time budget for "has the dashboard painted?" — never a raw rAF frame count. */
export const PAINT_WAIT_DEADLINE_MS = 10_000;

export function keepWaitingForPaint(
  elapsedMs: number,
  painted: boolean,
  crashed: boolean,
): boolean {
  if (crashed || painted) return false;
  return elapsedMs < PAINT_WAIT_DEADLINE_MS;
}
