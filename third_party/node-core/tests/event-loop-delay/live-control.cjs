'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { primordials } = require('internal/test/binding');
const root = path.resolve(__dirname, '../..');
const native = require(process.env.ELD_CONTROL_ADDON);
const values = { errors: require('internal/errors'), validators: require('internal/validators'), util: require('internal/util') };
const cloneProtocol = require('internal/worker/js_transferable');
function factory(file, name, marker, reference) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.equal(source.split(marker).length, 2);
  return vm.runInThisContext(`(function(_createNodePrimordials) {
    ${source.replace(marker, fs.readFileSync(path.join(root, reference), 'utf8'))}
    return ${name};
  })`)(() => primordials);
}
const histogram = factory('histogram-platform-adapter.js', '_createNodeHistogramPlatform',
  '/* NODE_HISTOGRAM_PUBLIC_WRAPPER */', 'upstream/histogram-reference/lib/internal/histogram.js')({
    native, values, cloneProtocol, types: require('internal/util/types'), util: require('node:util') });
const candidate = factory('event-loop-delay-platform-adapter.js', '_createNodeEventLoopDelayPlatform',
  '/* NODE_EVENT_LOOP_DELAY_PUBLIC_WRAPPER */', 'upstream/event-loop-delay-reference/lib/internal/perf/event_loop_delay.js')({
    native, values, cloneProtocol, histogram });
const reference = require('node:perf_hooks');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const data = h => ({ count: String(h.countBigInt), min: String(h.minBigInt),
  max: String(h.maxBigInt), mean: h.mean, exceeds: String(h.exceedsBigInt), resetCount: h.resetCount });
function outcome(fn) { try { return fn(); } catch (e) { return { name: e.name, code: e.code, message: e.message }; } }
async function main() {
  if (process.argv[2] === '--idle') {
    const api = process.argv[3] === 'candidate' ? candidate : reference;
    const h = api.monitorEventLoopDelay({ samplePerIteration: process.argv[4] === 'iteration', resolution: 5 });
    h.enable();
    process.once('beforeExit', () => console.log(JSON.stringify({ count: String(h.countBigInt), enabledAgain: h.enable() })));
    return;
  }
  let optionCases = 0;
  for (const options of [null, 1, { samplePerIteration: 1 }, { resolution: 0 },
    { samplePerIteration: true, resolution: 0 }, { resolution: NaN },
    { resolution: 1.1 }, { lowest: 0 }, { highest: 1 }, { figures: 6 },
    { lowest: 9223372036854775807n, highest: 9223372036854775807n }]) {
    assert.deepEqual(outcome(() => candidate.monitorEventLoopDelay(options)),
      outcome(() => reference.monitorEventLoopDelay(options))); optionCases++;
  }
  const report = { optionCases, modes: [], engine: 'native Node26.13 libuv host control; not Kandelo loop integration' };
  for (const iteration of [false, true]) {
    const options = { samplePerIteration: iteration, resolution: 5 };
    const a = reference.monitorEventLoopDelay(options), b = candidate.monitorEventLoopDelay(options);
    for (const h of [a, b]) {
      assert.equal(h.count, 0); assert.equal(h.disable(), false);
      assert.equal(h.enable(), true); assert.equal(h.enable(), false);
    }
    assert.equal(native.eventLoopDelayOperation('references', b[histogram.kHandle]).value, 0);
    await delay(25);
    const until = process.hrtime.bigint() + 30000000n;
    while (process.hrtime.bigint() < until) {} // actual blocking JS, no fake sample
    await delay(20);
    for (const h of [a, b]) {
      assert.equal(h.disable(), true); assert.equal(h.disable(), false);
      assert(h.countBigInt > 0n); assert(h.minBigInt > 0n); assert(h.maxBigInt >= 20000000n);
    }
    const frozenA = a.countBigInt, frozenB = b.countBigInt;
    await delay(15); assert.equal(a.countBigInt, frozenA); assert.equal(b.countBigInt, frozenB);
    if (iteration) assert.equal(a.countBigInt, b.countBigInt);
    else assert(Math.abs(Number(a.countBigInt - b.countBigInt)) <= 1);
    report.modes.push({ iteration, reference: data(a), candidate: data(b), unreferenced: true, disabledFrozen: true });
    for (const h of [a, b]) { h.reset(); assert.equal(h.count, 0); assert.equal(h.enable(), true); }
    await delay(20);
    for (const h of [a, b]) { assert(h.count > 0); assert.equal(h[Symbol.dispose](), undefined); assert.equal(h.disable(), false); }
    const raw = native.eventLoopDelayOperation('material', b[histogram.kHandle]).value;
    const alias = new histogram.ClonedHistogram(native.histogramOperation('share', raw).value);
    assert.equal(alias.countBigInt, b.countBigInt); assert.equal(alias.enable, undefined);
    assert.equal(alias.disable, undefined);
  }
  const a = reference.monitorEventLoopDelay({ resolution: 5 }), b = candidate.monitorEventLoopDelay({ resolution: 5 });
  a.enable(); b.enable(); await delay(25); a.disable(); b.disable(); await delay(45);
  a.enable(); b.enable(); await delay(10); a.disable(); b.disable();
  assert(a.maxBigInt >= 40000000n && b.maxBigInt >= 40000000n);
  report.restartGap = { reference: data(a), candidate: data(b) };
  report.cloneTransport = 'native material alias only; real engine clone callbacks unvalidated';
  fs.writeFileSync(path.join(process.env.ELD_CONTROL_OUT, 'live-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
