'use strict';
// Candidate mock/clock/reporting owners over actual native Node engine, file,
// VM, timer and stream dependencies. No guest harness or four-host claim.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const nativeTest = require('node:test');
const nativeReporters = require('node:test/reporters');
const { internalBinding } = require('internal/test/binding');
const root = path.resolve(__dirname, '../../..');
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factory = Function(bundle + ';return _createNodeTestingPlatform;')();
const candidate = process.argv[3] === 'native-reference' ? { api: nativeTest, require } : factory({
  process, values: { errors: require('internal/errors'), validators: require('internal/validators'),
    util: require('internal/util'), require },
  assert: require('node:assert'), comparisons: require('internal/util/comparisons'),
  types: require('node:util').types, inspection: require('internal/util/inspect'),
  eventTarget: require('internal/event_target'), assertUtils: require('internal/assert/utils'),
  getCallerLocation: internalBinding('util').getCallerLocation,
  events: require('node:events'), abort: require('internal/abort_controller'), async: require('node:async_hooks'),
  timers: require('node:timers'), timerPromises: require('node:timers/promises'),
  path, fs, fsUtils: require('internal/fs/utils'), os: require('node:os'),
  url: require('internal/url'), Module: require('node:module'), vm: require('node:vm'),
  diagnostics: require('node:diagnostics_channel'), queueMicrotask,
  stream: require('node:stream'), streamRequire: require, getOptionValue: require('internal/options').getOptionValue,
});
function outcome(fn) { try { return { value: fn() }; } catch (error) { return { name: error.name, code: error.code, message: error.message }; } }
const cases = {
  functionRecordsAndRestoration() {
    function run(mock) {
      function original(value) { this.value = value; return value * 2; }
      const fn = mock.fn(original, function(value) { return this.tag + value; }, { times: 2 });
      const receiver = { tag: 10 }; const first = fn.call(receiver, 2);
      fn.mock.mockImplementationOnce(() => { throw Error('deliberate'); }, 1);
      let thrown; try { fn.call(receiver, 3); } catch (error) { thrown = error.message; }
      const lastReceiver = {}; const restored = fn.call(lastReceiver, 4);
      const calls = fn.mock.calls.map(c => ({ args: c.arguments, error: c.error?.message, result: c.result,
        target: c.target?.name, sameReceiver: c.this === receiver, stackIsError: c.stack instanceof Error }));
      const copied = fn.mock.calls; copied.length = 0;
      const count = fn.mock.callCount(); mock.reset();
      const ctor = mock.fn(function Item(value) { this.value = value; });
      const value = new ctor(7); const target = ctor.mock.calls[0].target === ctor;
      mock.reset(); return { first, thrown, restored, last: lastReceiver.value, calls, count, value: value.value, target };
    }
    assert.deepEqual(run(candidate.api.mock), run(nativeTest.mock));
  },
  descriptorAndPropertyOwnership() {
    function run(mock) {
      const inherited = { method(value) { return value + 1; } };
      const object = Object.create(inherited); let value = 3;
      Object.defineProperty(object, 'access', { configurable: true, enumerable: false,
        get() { return value; }, set(next) { value = next; } });
      const before = Object.getOwnPropertyDescriptor(object, 'access');
      const method = mock.method(object, 'method', () => 20, { times: 1 });
      const first = object.method(), next = object.method(2);
      const get = mock.getter(object, 'access', () => 9); const got = object.access;
      mock.restoreAll(); const after = Object.getOwnPropertyDescriptor(object, 'access');
      const descriptors = ['enumerable', 'configurable', 'get', 'set'].every(k => before[k] === after[k]);
      const property = mock.property({ a: 4 }, 'a', 8); const read = property.a; property.a = 12;
      const counts = { calls: method.mock.callCount(), gets: get.mock.callCount(), accesses: property.mock.accessCount() };
      mock.reset(); return { first, next, got, descriptors, read, counts };
    }
    assert.deepEqual(run(candidate.api.mock), run(nativeTest.mock));
  },
  async virtualClockAndCleanup() {
    async function run(mock) {
      const original = { date: Date, timeout: setTimeout, immediate: setImmediate };
      mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'scheduler.wait', 'AbortSignal.timeout'], now: 100 });
      try {
        const events = []; const signal = AbortSignal.timeout(7);
        signal.addEventListener('abort', () => events.push(['abort', Date.now()]));
        setTimeout(() => events.push(['timeout', Date.now()]), 5);
        const repeat = setInterval(() => events.push(['interval', Date.now()]), 3);
        setImmediate(() => events.push(['immediate', Date.now()]));
        const wait = require('node:timers/promises').scheduler.wait(6).then(() => events.push(['wait', Date.now()]));
        mock.timers.tick(3); clearInterval(repeat);
        mock.timers.setTime(106); const beforeTick = events.slice();
        mock.timers.tick(1); await wait;
        return { events, beforeTick, now: Date.now(), aborted: signal.aborted };
      } finally {
        mock.reset(); assert.equal(Date, original.date); assert.equal(setTimeout, original.timeout); assert.equal(setImmediate, original.immediate);
      }
    }
    assert.deepEqual(await run(candidate.api.mock), await run(nativeTest.mock));
  },
  async reporterDataAndStream() {
    const records = [
      { type: 'test:pass', data: { name: 'fixture pass', nesting: 0, testNumber: 1, testId: 1, tags: [], details: { duration_ms: 1 } } },
      { type: 'test:plan', data: { nesting: 0, count: 1 } },
      { type: 'test:diagnostic', data: { nesting: 0, message: 'fixture diagnostic', level: 'info' } },
    ];
    for (const name of ['tap', 'dot', 'junit']) {
      async function render(api) { let text = ''; for await (const value of api[name](Readable.from(records))) text += value; return text; }
      assert.equal(await render(candidate.reporters), await render(nativeReporters));
    }
    const { TestsStream } = candidate.require('internal/test_runner/tests_stream');
    const stream = new TestsStream(); const events = []; stream.on('test:pass', data => events.push(data));
    stream.ok(0, { file: '/fixture.js', line: 1, column: 2 }, 1, 'manual record', { duration_ms: 0 }, {}, 1, undefined, ['tag']);
    stream.push(null); const values = []; for await (const value of stream) values.push(value);
    assert.equal(values[0].type, 'test:pass'); assert.equal(events[0], values[0].data); assert.deepEqual(events[0].tags, ['tag']);
  },
  monotonicProcessClock() {
    const createClock = Function(bundle + ';return _createNodeProcessClock;')();
    const values = { validators: require('internal/validators'), errors: require('internal/errors') };
    const real = process.hrtime.bigint;
    const clock = createClock({ native: { hrtime: real }, getValues: () => values });
    const before = real(), original = Date.now;
    let tuple, direct;
    try { Date.now = () => { throw Error('wall clock must not supply hrtime'); }; tuple = clock.hrtime(); direct = clock.hrtime.bigint(); }
    finally { Date.now = original; }
    const after = real(), tupleNs = BigInt(tuple[0]) * 1000000000n + BigInt(tuple[1]);
    assert.ok(tupleNs >= before && tupleNs <= after); assert.ok(direct >= tupleNs && direct <= after);
    const fixed = createClock({ native: { hrtime: () => 1250000000n }, getValues: () => values });
    assert.deepEqual(fixed.hrtime(), [1, 250000000]); assert.deepEqual(fixed.hrtime([0, 750000000]), [0, 500000000]);
    for (const value of [null, false, 0, '', {}, [], [1], [1, 2, 3]])
      assert.deepEqual(outcome(() => clock.hrtime(value)), outcome(() => process.hrtime(value)));
  },
  defaultOptionState() {
    const reader = Function(bundle + ';return _createNodeTestOptionReader;')()({
      cliOptions: {}, values: { errors: require('internal/errors') },
    });
    const actual = require('internal/options').getOptionValue;
    const fields = JSON.parse(fs.readFileSync(path.join(root, 'third_party/node-core/sources.json'), 'utf8')).testingPlatform.optionDefaultFields;
    for (const name of Object.keys(fields)) assert.deepEqual(reader(name), actual(name), name);
    assert.equal(reader('--test-reporter'), reader('--test-reporter'));
    assert.throws(() => reader('--unknown-test-owner'), { code: 'ERR_NOT_IMPLEMENTED' });
  },
  publicDefaultExecution() {
    candidate.api('default public sync', context => context.assert.strictEqual(6 * 7, 42));
    candidate.api('default public async', async context => {
      await new Promise(resolve => setImmediate(resolve));
      context.assert.deepStrictEqual({ answer: 42 }, { answer: 42 });
    });
    candidate.api.skip('default public skipped', () => { throw Error('skipped body'); });
  },
  publicDeliberateFailure() {
    candidate.api('deliberate public failure', context => context.assert.strictEqual('actual', 'expected'));
  },
  async executionHierarchyHooksAndCleanup() {
    const { createTestTree } = candidate.require('internal/test_runner/harness');
    const config = { ...candidate.require('internal/test_runner/utils').parseCommandLine(), cwd: process.cwd() };
    const tree = createTestTree({ entryFile: __filename, loc: [1, 1, __filename] }, config);
    const records = []; const drain = (async () => { for await (const item of tree.reporter) records.push(item); })();
    const order = []; const object = { read: () => 'original' };
    candidate.api.before(() => order.push('before'));
    candidate.api.after(() => order.push('after'));
    candidate.api.beforeEach(() => order.push('beforeEach'));
    candidate.api.afterEach(() => order.push('afterEach'));
    const parent = candidate.api('parent', async context => {
      assert.equal(candidate.api.getTestContext(), context);
      order.push('parent');
      context.mock.method(object, 'read', () => 'mock');
      context.assert.strictEqual(object.read(), 'mock');
      context.plan(1);
      await context.test('child', child => {
        assert.equal(candidate.api.getTestContext(), child);
        order.push('child');
        child.assert.deepStrictEqual([1, 2], [1, 2]);
      });
    });
    const skipped = candidate.api.skip('skip', () => { throw Error('skip body ran'); });
    const todo = candidate.api.todo('todo');
    const expected = candidate.api.expectFailure('expected', () => { throw Error('intentional'); });
    await Promise.all([parent, skipped, todo, expected]);
    await tree.harness.teardown(); await drain;
    assert.equal(object.read(), 'original');
    assert.deepEqual(order, ['before', 'beforeEach', 'parent', 'beforeEach', 'child', 'afterEach', 'afterEach', 'beforeEach', 'afterEach', 'beforeEach', 'afterEach', 'after']);
    const results = records.filter(item => item.type === 'test:pass' || item.type === 'test:fail');
    assert.deepEqual(results.map(item => [item.data.name, item.type, item.data.skip, item.data.todo, item.data.expectFailure]), [
      ['child', 'test:pass', undefined, undefined, undefined],
      ['parent', 'test:pass', undefined, undefined, undefined],
      ['skip', 'test:pass', true, undefined, undefined],
      ['todo', 'test:pass', undefined, true, undefined],
      ['expected', 'test:pass', undefined, undefined, true],
    ]);
    const summary = records.find(item => item.type === 'test:summary');
    assert.equal(summary.data.success, true);
    if (process.argv[3] !== 'native-reference')
      assert.throws(() => candidate.api.run(), { code: 'ERR_NOT_IMPLEMENTED' });
    assert.equal(candidate.api.mock.module, undefined);
  },
};
(async () => { const name = process.argv[2]; assert.equal(typeof cases[name], 'function'); await cases[name]();
 console.log(JSON.stringify({ case: name,
   ...(name.startsWith('public') ? { registered: true } : { passed: true }),
   scope: 'Candidate testing tree/mock/clock/report owners with actual native dependencies; not guest/four-host conformance' }));
})().catch(error => { try { candidate.api.mock.reset(); nativeTest.mock.reset(); } catch {} console.error(error); process.exitCode = 1; });
