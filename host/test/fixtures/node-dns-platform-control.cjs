'use strict';
const assert = require('node:assert/strict');
const dns = require('node:dns');
const nativePerf = require('node:perf_hooks');
const util = require('node:util');
const asyncHooks = require('node:async_hooks');
const { createDnsPlatform } = require('./node-dns-platform.cjs');
const target = require('../../../packages/registry/node-compat/target.json');
assert.equal(process.versions.node, target.version);
const subject = createDnsPlatform();
const name = process.argv[2];
function errorFields(e) {
  return { name: e.name, code: e.code, message: e.message, errno: e.errno,
    syscall: e.syscall, hostname: e.hostname, keys: Object.keys(e) };
}
function thrown(fn) { try { fn(); } catch (e) { return errorFields(e); } throw Error('Expected throw'); }
async function literals(api) {
  const events = [];
  const result = new Promise(resolve => {
    const req = api.lookup('127.0.0.1', (err, address, family) => {
      assert.equal(err, null); events.push(['callback', address, family]); resolve();
    });
    events.push(['return', Object.keys(req)]);
  });
  Promise.resolve().then(() => events.push(['promise']));
  await result;
  return events;
}
async function observe(perf, api) {
  let finish;
  const delivered = new Promise(resolve => { finish = resolve; });
  const observer = new perf.PerformanceObserver((list, owner) => {
    assert.equal(owner, observer);
    const entries = list.getEntries();
    if (!entries.length) return;
    const entry = entries[0];
    assert(entry instanceof perf.PerformanceEntry);
    assert.equal(entry.entryType, 'dns');
    assert.equal(entry.name, 'lookupService');
    assert.equal(entry.detail.host, '127.0.0.1');
    assert.equal(entry.detail.port, 80);
    assert.equal(typeof entry.detail.hostname, 'string');
    assert.equal(typeof entry.detail.service, 'string');
    assert(entry.startTime >= 0 && entry.duration >= 0);
    assert(entry.startTime <= perf.performance.now());
    assert.deepEqual(list.getEntriesByName('lookupService'), entries);
    assert.deepEqual(list.getEntriesByType('dns'), entries);
    assert.deepEqual(entry.toJSON(), { name: entry.name, entryType: 'dns',
      startTime: entry.startTime, duration: entry.duration, detail: entry.detail });
    observer.disconnect(); finish();
  });
  observer.observe({ type: 'dns' });
  await api.lookupService('127.0.0.1', 80);
  await delivered;
  assert.deepEqual(observer.takeRecords(), []);
}
async function main() {
  if (name === 'literalTimingAndOptions') {
    // Begin each comparison on an ordinary task so nextTick has the same phase.
    const run = api => new Promise((resolve, reject) => setImmediate(() => literals(api).then(resolve, reject)));
    assert.deepEqual(await run(subject.api), await run(dns));
    for (const family of [0, 4, 6]) for (const all of [false, true]) {
      assert.deepEqual(await subject.promises.lookup('::1', { family, all }), await dns.promises.lookup('::1', { family, all }));
    }
    for (const order of ['ipv4first', 'ipv6first', 'verbatim']) {
      subject.api.setDefaultResultOrder(order);
      assert.equal(subject.promises.getDefaultResultOrder(), order);
    }
    assert.deepEqual(subject.api.lookup[subject.values.util.customPromisifyArgs], ['address', 'family']);
    assert.deepEqual(await subject.values.util.promisify(subject.api.lookup)('127.0.0.1'),
      await util.promisify(dns.lookup)('127.0.0.1'));
  } else if (name === 'nativeLookupAndService') {
    for (const order of ['ipv4first', 'ipv6first', 'verbatim']) {
      assert.deepEqual(await subject.promises.lookup('localhost', { all: true, order }),
        await dns.promises.lookup('localhost', { all: true, order }));
    }
    assert.deepEqual(await subject.promises.lookupService('127.0.0.1', 80), await dns.promises.lookupService('127.0.0.1', 80));
    let req;
    const done = new Promise((resolve, reject) => {
      req = subject.api.lookupService('127.0.0.1', 80, (error, host, service) => {
        try {
          assert.equal(error, null); assert.equal(typeof host, 'string'); assert.equal(typeof service, 'string');
          assert(req.getAsyncId() > 0); assert.equal(req.getProviderType(), asyncHooks.asyncWrapProviders.GETNAMEINFOREQWRAP);
          resolve();
        } catch (e) { reject(e); }
      });
      assert(req.getAsyncId() > 0);
    });
    await done;
    // Native MakeCallback drains microtasks before the C++ ReqWrap destructor.
    // Observe retirement after that callback scope unwinds into the check phase.
    await new Promise(setImmediate);
    assert.equal(req.getAsyncId(), -1);
    assert.equal(req.getProviderType(), 0);
  } else if (name === 'errorAndValidation') {
    for (const args of [[1], ['x\0y'], ['x', { family: 'bad' }], ['x', { hints: 100 }], ['x', { order: 'bad' }]]) {
      assert.deepEqual(thrown(() => subject.promises.lookup(...args)), thrown(() => dns.promises.lookup(...args)));
    }
    for (const args of [[], ['localhost', 80, () => {}], ['127.0.0.1', -1, () => {}], ['127.0.0.1', 80, false]]) {
      assert.deepEqual(thrown(() => subject.api.lookupService(...args)), thrown(() => dns.lookupService(...args)));
    }
    assert.deepEqual(thrown(() => subject.promises.lookup('x', { family: 'IPv4' })),
      thrown(() => dns.promises.lookup('x', { family: 'IPv4' })));
  } else if (name === 'observerAndPublicEntries') {
    assert.deepEqual(subject.perf.api.PerformanceObserver.supportedEntryTypes, ['dns', 'function', 'mark', 'measure', 'resource']);
    assert(Object.isFrozen(subject.perf.api.PerformanceObserver.supportedEntryTypes));
    await observe(subject.perf.api, subject.promises);
    await observe(nativePerf, dns.promises);
    assert.equal(subject.perf.api.performance.mark('x', { startTime: 1 }).startTime, 1);
    subject.perf.api.performance.clearMarks('x');
  } else throw Error('Unknown DNS control');
}
main().then(() => {
  subject.close();
  console.log(JSON.stringify({ case: name, passed: true,
    scope: 'Pinned candidate DNS/observer algorithms over real native Node request/OS/clock boundaries; no guest conformance' }));
}, error => { subject.close(); console.error(error); process.exitCode = 1; });
