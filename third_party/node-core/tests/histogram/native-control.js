'use strict';
import { createHistogram, createSlidingWindowHistogram, importHistogram } from 'node:perf_hooks';
const options = { lowest: 1, highest: 1000000, figures: 2, halfLife: 4, threshold: 2048 };
// Read the pinned wrapper's actual native owner only to observe raw add and
// subtract dropped counts. Public RecordableHistogram methods discard them.
const handle = h => h[Object.getOwnPropertySymbols(h).find(s => s.description === 'kHandle')];
const out = (key, value) => console.log(`${key}\t${JSON.stringify(value, (_, v) =>
  typeof v === 'bigint' ? String(v) : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)}`);
async function summary(name, h) {
  out(name + '.numberIntegers', [h.count, h.min, h.max, h.exceeds, h.resetCount]);
  out(name + '.counts', [h.countBigInt, h.minBigInt, h.maxBigInt, h.exceedsBigInt, BigInt(h.resetCount)]);
  out(name + '.stats', [h.mean, h.stddev, h.skewness, h.kurtosis, h.ewmaMean, h.ewmaStddev, h.ewmaErrorRate]);
  const ps = [1, 25, 50, 90, 99, 100];
  out(name + '.percentilesAt', Array.from(h.percentilesAt(ps).values(), String));
  out(name + '.percentile', ps.map(p => h.percentileBigInt(p)));
  out(name + '.cdf', [-1, 0, 1, 100, 2048, 1000000].map(v => h.cdf(v)));
  out(name + '.countAt', [-1, 0, 1, 100, 2048, 1000000].map(v => String(h.countAt(v))));
  const ci = h.meanCI(); out(name + '.meanCI', [ci.mean, ci.lower, ci.upper]);
  const pci = h.percentileCI(50); out(name + '.percentileCI', [pci.value, pci.lower, pci.upper].map(String));
  out(name + '.percentiles', Array.from(h.percentiles));
  out(name + '.linearBuckets', Array.from(h.linearBuckets(25000)));
  out(name + '.logBuckets', Array.from(h.logBuckets(1000, 2)));
  out(name + '.export', Buffer.from(h.export()).toString('hex'));
  for (const [mode, dequantize] of ['none', 'hdr', 'all'].entries()) {
    const r = await h.qrde({ probabilities: [0, .1, .25, .5, .9, 1], dequantize, cache: true });
    out(name + '.qrde' + mode, [
      ...Array.from(r.quantiles, (v, i) => [i, v]),
      ...Array.from(r.densities, (v, i) => [i + 100, v]),
      [200, r.corrections], [201, Number(r.count)], [202, r.bucketCount],
    ]);
  }
}
const make = values => { const h = createHistogram(options); values.forEach(v => h.record(v)); return h; };
function pair(name, a, b) {
  const w = a.welchTest(b), m = a.mannWhitneyTest(b);
  out(name, [a.ksTest(b), a.cohensD(b), a.cliffsD(b), w.tStatistic,
    w.degreesOfFreedom, w.pValue, w.confidenceInterval.lower, w.confidenceInterval.upper,
    m.uStatistic, m.zScore, m.pValue]);
}
function layoutSummary(name, h) {
  out(name + '.numberIntegers', [h.count, h.min, h.max, h.exceeds]);
  out(name + '.counts', [h.countBigInt, h.minBigInt, h.maxBigInt, h.exceedsBigInt]);
  out(name + '.percentile', [1, 50, 99, 100].map(p => h.percentileBigInt(p)));
  out(name + '.stats', [h.mean, h.stddev]);
  out(name + '.export', Buffer.from(h.export()).toString('hex'));
}
async function main() {
  if (process.argv[2] === '--import') {
    let h;
    try { h = importHistogram(Buffer.from(process.argv[3], 'hex')); }
    catch { out('invalid', true); return; }
    out('import.numberIntegers', [h.count, h.min, h.max]);
    out('import.counts', [h.countBigInt, h.minBigInt, h.maxBigInt]);
    out('import.export', Buffer.from(h.export()).toString('hex')); return;
  }
  const empty = make([]); await summary('empty', empty);
  await summary('one', make([7]));
  await summary('constant', make([7, 7, 7, 7]));
  const a = make([0, 1, 1, 7, 13, 63, 512, 1023, 1024, 2047, 2048, 4095, 8191, 99999]);
  a.record(10000000); await summary('a', a);
  const b = make([1, 2, 2, 8, 64, 513, 1025, 4096, 9999]); await summary('b', b);
  pair('pair.ab', a, b); pair('pair.self', a, a); pair('pair.empty', a, empty);
  const snap = a.snapshot(); a.record(42); a.record(10000000);
  await summary('snapshot', snap); await summary('diff', a.diff(snap));
  const errors = [];
  try { snap.diff(a); } catch (e) { if (e.code !== 'ERR_INVALID_ARG_VALUE') throw e; errors.push('not-earlier'); }
  a.reset();
  try { a.diff(snap); } catch (e) { if (e.code !== 'ERR_INVALID_STATE') throw e; errors.push('reset'); }
  try { a.diff(createHistogram({ highest: 10000, figures: 3 })); }
  catch (e) { if (e.code !== 'ERR_INVALID_ARG_VALUE') throw e; errors.push('incompatible'); }
  out('diff.errors', errors);
  const corrected = make([]); corrected.recordCorrected(1000, 100);
  corrected.recordCorrected(10000000, 100); await summary('corrected', corrected);
  const add = importHistogram(snap.export());
  // Import intentionally excludes exceeds/reset/timing. Recreate this add
  // owner through recording to retain the snapshot's exceeds and EWMA state.
  const addActual = make([0, 1, 1, 7, 13, 63, 512, 1023, 1024, 2047, 2048, 4095, 8191, 99999]);
  addActual.record(10000000);
  out('add.dropped', [handle(addActual).add(handle(b))]); await summary('add', addActual);
  out('add.self.dropped', [handle(addActual).add(handle(addActual))]); await summary('add.self', addActual);
  out('subtract.dropped', [handle(addActual).subtract(handle(b))]); await summary('subtract', addActual);
  out('subtract.self.dropped', [handle(addActual).subtract(handle(addActual))]); await summary('subtract.self', addActual);
  out('subtract.negative.dropped', [handle(addActual).subtract(handle(b))]); await summary('subtract.negative', addActual);
  await summary('roundtrip', add);
  const emptyRoundtrip = importHistogram(empty.export());
  emptyRoundtrip.record(100); await summary('empty-roundtrip-first-record', emptyRoundtrip);
  const w = createSlidingWindowHistogram({ lowest: 1, highest: 1000000, figures: 2, chunks: 2, recordsPerChunk: 3 });
  w.record(1); w.record(2); w.record(10000000); await summary('window.first', w.snapshot());
  w.record(4); w.record(5); w.record(6); const ws = w.snapshot(); await summary('window.full', ws);
  w.record(7); await summary('window.rotated', w.snapshot());
  w.reset(); await summary('window.reset', w.snapshot()); await summary('window.independent', ws);
  const shared = make([3]), sharedClone = structuredClone(shared);
  sharedClone.record(5); await summary('shared-clone', shared);
  const high = createHistogram({ lowest: 1000n, highest: 9223372036854775807n, figures: 3 });
  for (const v of [0n, 1n, 999n, 1000n, 1001n, 1048576n, 9007199254740991n,
    9007199254740992n, 9223372036854775807n]) high.record(v);
  layoutSummary('layout.int64', high);
  for (let figures = 1; figures <= 5; figures++) {
    const h = createHistogram({ lowest: 8, highest: 10000000, figures });
    for (const v of [0, 1, 1234, 65537, 9999999, 10000000]) h.record(v);
    layoutSummary('layout.figures' + figures, h);
  }
  const narrow = createHistogram({ lowest: 1, highest: 10000, figures: 1 });
  out('narrow.add.dropped', [handle(narrow).add(handle(snap))]); layoutSummary('narrow.add', narrow);
  const upper = createHistogram({ lowest: 1, highest: 1000000, figures: 2 });
  out('layout.upper.accepted', [1000000, 1000001, 1048575, 1048576].map(v => {
    const count = upper.count; upper.record(v); return Number(upper.count !== count);
  }));
  layoutSummary('layout.upper', upper);
  const dense = createHistogram({ lowest: 1, highest: 10000000, figures: 3 });
  for (let i = 1; i <= 2048; i++)
    for (let repeat = 0; repeat < 64; repeat++) dense.record(i * 4093);
  await summary('dense', dense);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
