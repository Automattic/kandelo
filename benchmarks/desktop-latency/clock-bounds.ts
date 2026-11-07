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

// A captured native frame proves the response is visible by its display time.
// Capture can coalesce earlier frames: only a preceding non-response frame
// bounds first visibility from below. Do not turn a capture timestamp into
// an exact first-display timestamp by applying clock uncertainty alone.
export function nativeVisibleLatencyBounds(eventAt: number, previousNonResponse: number | undefined,
  visibleDisplay: number, nativeToSource: { lo: number; hi: number }) {
  if (![eventAt, visibleDisplay, nativeToSource.lo, nativeToSource.hi].every(Number.isFinite)
    || nativeToSource.lo > nativeToSource.hi
    || (previousNonResponse !== undefined && (!Number.isFinite(previousNonResponse) || previousNonResponse > visibleDisplay)))
    throw new Error('invalid native visibility observation');
  const lo = Math.max(0, previousNonResponse === undefined ? 0 : previousNonResponse + nativeToSource.lo - eventAt);
  const hi = visibleDisplay + nativeToSource.hi - eventAt;
  if (hi < lo)
    throw new Error('native visible observation precedes input');
  return { lo, hi };
}


/** A late upper endpoint alone is not evidence that the observer caught a
 * known stall. Existing browser/native guards sum to 2.25ms; a wider capture
 * gap cannot enlarge that allowance. Missing informative pixels is uncertain. */
export function qualifyInjectedDelayBounds(bounds:{lo:number;hi:number},expectedMs:number,clockToleranceMs:number) {
  if(![bounds.lo,bounds.hi,expectedMs,clockToleranceMs].every(Number.isFinite)||bounds.lo<0||bounds.hi<bounds.lo||expectedMs<=clockToleranceMs||clockToleranceMs<0||clockToleranceMs>2.25)
    throw Error('Invalid injected-delay bounds or clock tolerance');
  const requiredLowerMs=expectedMs-clockToleranceMs;
  return {status:bounds.lo>=requiredLowerMs?'qualified' as const:'uncertain' as const,
    requiredLowerMs,bounds,expectedMs,clockToleranceMs};
}
