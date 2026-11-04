import assert from "node:assert/strict";
import { clockBounds, visibleLatencyBounds, nativeVisibleLatencyBounds, quantile } from "./clock-bounds.js";
const c = clockBounds([{ n0: 100, n1: 110, b: 205 }, { n0: 120, n1: 122, b: 221 }], 0);
assert.deepEqual(c, { lo: 99, hi: 101, guardMs: 0 });
// Input created at browser time 210, handler entry at 230. The late handler
// must not erase twenty milliseconds from the measured latency.
assert.deepEqual(visibleLatencyBounds(210, { n0: 125 }, { n0: 140, n1: 145 }, c), { lo: 14, hi: 36 });
assert.equal(visibleLatencyBounds(230, { n0: 125 }, { n0: 140, n1: 145 }, c).hi, 16);
assert.throws(() => clockBounds([{ n0: 0, n1: 1, b: 10 }, { n0: 10, n1: 11, b: 40 }], 0), /do not overlap/);
assert.throws(() => visibleLatencyBounds(500, undefined, { n0: 140, n1: 145 }, c), /precedes input/);
assert.throws(() => clockBounds([{ n0: 10, n1: 9, b: 20 }], 0), /invalid clock sample/);
assert.throws(() => quantile([1, NaN], .5), /invalid quantile/);
assert.throws(() => quantile([1, 2], NaN), /invalid quantile/);
assert.throws(() => quantile([], .5), /invalid quantile/);
console.log("asymmetric clock bounds, event-origin queue delay, censored visibility and invalid-clock refusal: PASS");

// A response first displayed at native time 125 can be delivered as a later
// captured frame at 150. Its true latency (25) must remain inside the bounds;
// clock-only bounds [49,51] would silently exclude it.
const coalesced = nativeVisibleLatencyBounds(200, 110, 150, { lo: 99, hi: 101 });
assert.deepEqual(coalesced, { lo: 9, hi: 51 });
assert(coalesced.lo <= 25 && coalesced.hi >= 25);
assert.deepEqual(nativeVisibleLatencyBounds(200, undefined, 150, { lo: 99, hi: 101 }), { lo: 0, hi: 51 });
assert.deepEqual(nativeVisibleLatencyBounds(200, 99, 150, { lo: 99, hi: 101 }), { lo: 0, hi: 51 });
assert.throws(() => nativeVisibleLatencyBounds(200, 151, 150, { lo: 99, hi: 101 }), /invalid native/);
assert.throws(() => nativeVisibleLatencyBounds(300, 110, 150, { lo: 99, hi: 101 }), /precedes input/);
assert.throws(() => nativeVisibleLatencyBounds(NaN, 110, 150, { lo: 99, hi: 101 }), /invalid native/);
assert.throws(() => nativeVisibleLatencyBounds(200, 110, 150, { lo: 102, hi: 101 }), /invalid native/);
console.log('native capture coalescing retains first-visibility uncertainty: PASS');
