'use strict';
const assert = require('node:assert/strict');
const reference = require('node:perf_hooks');
module.exports = async function edges(candidate) {
  let checked = 0;
  function normalized(fn) {
    try { return { value: fn() }; }
    catch (e) { return { error: { name: e.name, code: e.code, message: e.message } }; }
  }
  function same(label, fn) {
    assert.deepEqual(normalized(() => fn(candidate)), normalized(() => fn(reference)), label); checked++;
  }
  for (const options of [null, 1, 'x', { lowest: 0 }, { lowest: -1n },
    { lowest: 9223372036854775808n }, { lowest: 5n, highest: 9n },
    { highest: 0 }, { highest: 9223372036854775808n }, { figures: 0 },
    { figures: 6 }, { figures: 1.5 }, { halfLife: -1 }, { threshold: -1 }]) {
    same('invalid options ' + String(options), api => api.createHistogram(options));
  }
  for (const input of [null, {}, [], new Uint16Array(1), Buffer.from([0]), new Uint8Array()])
    same('import type/format', api => api.importHistogram(input));
  for (const value of [-1, -1n, 1.5, NaN, Infinity, 9007199254740992, 9223372036854775808n])
    same('record range ' + String(value), api => api.createHistogram().record(value));
  for (const interval of [0, -1, 0n, -1n, 9223372036854775808n]) {
    same('corrected interval ' + String(interval), api => api.createHistogram().recordCorrected(typeof interval === 'bigint' ? 10n : 10, interval));
  }
  for (const value of [0, -1, 101, NaN, Infinity, '50'])
    same('percentile range ' + String(value), api => api.createHistogram().percentile(value));
  for (const value of [NaN, Infinity, -Infinity, .5, -1.2]) {
    same('cdf conversion ' + String(value), api => { const h = api.createHistogram(); h.record(0); h.record(10); return [h.cdf(value), h.countAt(value)]; });
  }
  for (const confidence of [0, 1, NaN, -1, 1.1, '0.95'])
    same('confidence validation', api => api.createHistogram().meanCI({ confidence }));
  for (const options of [{}, { chunks: 0, recordsPerChunk: 1 }, { chunks: 1025, recordsPerChunk: 1 },
    { chunks: 1 }, { chunks: 1, recordsPerChunk: 1, chunkDuration: 1 },
    { chunks: 1, chunkDuration: 0 }, { chunks: 1, recordsPerChunk: 0 }])
    same('window options', api => api.createSlidingWindowHistogram(options));
  for (const options of [{ bins: 0 }, { bins: 1001 }, { probabilities: [0, 1, 1] },
    { probabilities: [.1, 1] }, { probabilities: [0, NaN, 1] }, { dequantize: 'bad' },
    { cache: 1 }, { bins: 1, probabilities: [0, 1] }])
    same('QRDE synchronous validation', api => api.createHistogram().qrde(options));
  for (const name of ['count', 'min', 'max', 'mean', 'stddev', 'ewmaMean'])
    same('invalid branded getter ' + name, api => { const h = api.createHistogram(); return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(h)), name).get.call({}); });
  same('independent snapshot and readonly API', api => {
    const h = api.createHistogram(); h.record(7); const snapshot = h.snapshot(); h.record(10);
    return [snapshot.countBigInt, h.countBigInt, typeof snapshot.record, typeof snapshot.add,
      Object.getPrototypeOf(snapshot).constructor.name, Object.getPrototypeOf(h).constructor.name];
  });
  same('view-offset CBOR import', api => {
    const h = api.createHistogram(); h.record(123456); const bytes = h.export();
    const buffer = Buffer.alloc(bytes.length + 20); buffer.set(bytes, 7);
    const result = api.importHistogram(buffer.subarray(7, 7 + bytes.length));
    return [result.countBigInt, result.maxBigInt, Buffer.from(result.export()).toString('hex')];
  });
  const shape = result => ({ count: result.count, bucketCount: result.bucketCount,
    quantiles: Array.from(result.quantiles), densities: Array.from(result.densities),
    nullPrototype: Object.getPrototypeOf(result) === null,
    arrays: [result.probabilities, result.quantiles, result.densities].every(v => v instanceof Float64Array) });
  for (const api of [candidate, reference]) {
    const h = api.createHistogram(); h.record(1); h.record(10);
    const promise = h.qrde({ bins: 2, cache: true }); h.reset(); h.record(999);
    const result = await promise;
    assert.equal(result.count, 2n); assert.equal(Object.getPrototypeOf(result), null);
  }
  const a = candidate.createHistogram(), b = reference.createHistogram();
  for (const h of [a, b]) for (const n of [0, 7, 7, 31, 1024]) h.record(n);
  assert.deepEqual(shape(await a.qrde({ bins: 3, cache: true })), shape(await b.qrde({ bins: 3, cache: true })));
  checked += 3;
  return { edgeComparisons: checked, qrdeSnapshotAndNullPrototype: true,
    nativeCloneTransport: 'not tested by N-API transport control' };
};
