// Measurement clock helpers. Bounds are conservative: no symmetric transport
// assumption and no substitution of event-handler entry for event creation.
export type ClockSample = {
  n0: number;
  n1: number;
  b: number;
};
export type ClockBounds = {
  lo: number;
  hi: number;
  guardMs: number;
};
export function clockBounds(samples: ClockSample[], guardMs: number): ClockBounds {
  if (!samples.length || !Number.isFinite(guardMs) || guardMs < 0)
    throw new Error("invalid clock calibration");
  let lo = -Infinity, hi = Infinity;
  for (const { n0, n1, b } of samples) {
    if (![n0, n1, b].every(Number.isFinite) || n1 < n0)
      throw new Error("invalid clock sample");
    lo = Math.max(lo, b - n1 - guardMs);
    hi = Math.min(hi, b - n0 + guardMs);
  }
  if (lo > hi)
    throw new Error("clock calibration intervals do not overlap");
  return { lo, hi, guardMs };
}
export function visibleLatencyBounds(eventAt: number, previous: {
  n0: number;
} | undefined, visible: {
  n0: number;
  n1: number;
}, clock: ClockBounds) {
  if (![eventAt, visible.n0, visible.n1, clock.lo, clock.hi].every(Number.isFinite)
    || visible.n1 < visible.n0 || clock.lo > clock.hi)
    throw new Error("invalid visible observation");
  const lo = Math.max(0, (previous?.n0 ?? -Infinity) + clock.lo - eventAt);
  const hi = visible.n1 + clock.hi - eventAt;
  if (hi < lo)
    throw new Error("visible observation precedes input");
  return { lo, hi };
}
export function quantile(values: number[], p: number) {
  if (!values.length || !values.every(Number.isFinite) || !Number.isFinite(p) || p < 0 || p > 1)
    throw new Error("invalid quantile");
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(p * (sorted.length - 1))];
}
