/** Public timer programs run unchanged by the pinned oracle and all hosts. */
export const nodeTimerCases = [
  { name: 'unref-only', source: `
const assert = require('assert');
const fail = () => { throw Error('unreferenced work kept the process alive'); };
const timeout = setTimeout(fail, 0);
assert.strictEqual(timeout.hasRef(), true);
assert.strictEqual(timeout.unref(), timeout);
assert.strictEqual(timeout.hasRef(), false);
setInterval(fail, 1000).unref();
const immediate = setImmediate(fail).unref();
assert.strictEqual(immediate.hasRef(), false);
process.on('exit', () => console.log('node-timers-unref-only-ok'));
` },
  { name: 'mixed-references', source: `
const assert = require('assert');
let timeoutRan = false, intervalRan = false, finished = false;
setTimeout(() => { timeoutRan = true; }, 1).unref();
const interval = setInterval(() => { intervalRan = true; clearInterval(interval); }, 1).unref();
const keeper = setInterval(() => {
  if (timeoutRan && intervalRan) { clearInterval(keeper); finished = true; }
}, 2);
process.on('exit', () => { assert(finished); console.log('node-timers-mixed-references-ok'); });
` },
  { name: 'entered-timer-batch', source: `
const assert = require('assert'); const seen = [];
setTimeout(() => seen.push('ref'), 1);
setTimeout(() => seen.push('unref'), 1).unref();
// Both deadlines must be eligible when the referenced turn starts.
const start = Date.now(); while (Date.now() - start < 10) {}
process.on('exit', () => { assert.deepStrictEqual(seen,['ref','unref']); console.log('node-timers-entered-timer-batch-ok'); });
` },
  { name: 'self-cancel', source: `
const assert = require('assert');
let count = 0;
const timer = setInterval(function(a, b) {
  assert.strictEqual(this, timer); assert.deepStrictEqual([a,b], [17,'arg']);
  count++; clearInterval(this); assert(this._destroyed);
}, 1, 17, 'arg');
process.on('exit', () => { assert.strictEqual(count, 1); console.log('node-timers-self-cancel-ok'); });
` },
  { name: 'refresh', source: `
const assert = require('assert');
let count = 0, old;
const timer = setTimeout(function() {
  assert.strictEqual(this, timer); count++;
  if (count === 1) {
    old = +timer;
    queueMicrotask(() => {
      assert.strictEqual(timer.hasRef(), true);
      assert.strictEqual(timer.refresh(), timer);
      assert.notStrictEqual(+timer, old);
    });
  } else { assert.strictEqual(count, 2); }
}, 1);
process.on('exit', () => { assert.strictEqual(count, 2); console.log('node-timers-refresh-ok'); });
` },
  { name: 'cancel-handles', source: `
const assert = require('assert');
const fail = () => { throw Error('cancelled timer fired'); };
const a = setTimeout(fail, 1); const number = +a;
assert.strictEqual(typeof number, 'number'); clearTimeout(String(number));
assert.strictEqual(a.refresh(), a); assert(a._destroyed); assert.strictEqual(a.hasRef(), true);
const b = setInterval(fail, 1); clearTimeout(b);
const c = setTimeout(fail, 1); clearInterval(c);
const d = setTimeout(fail, 1); assert.strictEqual(d.close(), d);
const e = setTimeout(fail, 1); e[Symbol.dispose]();
const f = setImmediate(fail); f[Symbol.dispose](); assert(f._destroyed); assert.strictEqual(f.hasRef(), false);
f.ref(); assert.strictEqual(f.hasRef(), false);
for (const value of [null, undefined, {}, '', 0]) { clearTimeout(value); clearImmediate(value); }
process.on('exit', () => console.log('node-timers-cancel-handles-ok'));
` },
  { name: 'immediate-turns', source: `
const assert = require('assert');
const seen = []; let final = false;
const a = setImmediate(function(value) {
  assert.strictEqual(this, a); assert.strictEqual(value, 42);
  seen.push('a'); queueMicrotask(() => seen.push('microtask'));
  setImmediate(() => {
    assert.deepStrictEqual(seen, ['a','microtask','b','unref']); final = true;
    setImmediate(() => { throw Error('new unref immediate entered another turn'); }).unref();
  });
}, 42);
setImmediate(() => { seen.push('b'); assert.deepStrictEqual(seen, ['a','microtask','b']); });
setImmediate(() => seen.push('unref')).unref();
process.on('exit', () => { assert(final); console.log('node-timers-immediate-turns-ok'); });
` },
  { name: 'monotonic-clock', source: `
const assert = require('assert');
const original = Date.now; Date.now = () => -1000000;
let done = false;
setTimeout(() => { Date.now = original; done = true; }, 5);
process.on('exit', () => { assert(done); console.log('node-timers-monotonic-clock-ok'); });
` },
  { name: 'warnings-validation', source: `
const assert = require('assert');
process.removeAllListeners('warning'); const warnings = [];
process.on('warning', warning => warnings.push([warning.name,warning.message]));
for (const delay of [NaN,NaN,-1,-2,Infinity,2147483648]) {
  const t = setTimeout(() => { throw Error('cancelled normalized timer fired'); }, delay);
  assert.strictEqual(t._idleTimeout, 1); clearTimeout(t);
}
for (const fn of [setTimeout,setInterval,setImmediate]) {
  for (const cb of [undefined,null,false,1,'source',{}]) assert.throws(() => fn(cb), { code:'ERR_INVALID_ARG_TYPE' });
}
assert.throws(() => setTimeout(() => {}, 1n), TypeError);
assert.throws(() => setTimeout(() => {}, Symbol()), TypeError);
process.on('exit', () => {
  assert.deepStrictEqual(warnings.map(w => w[0]), ['TimeoutNaNWarning','TimeoutNegativeWarning','TimeoutOverflowWarning','TimeoutOverflowWarning']);
  assert(warnings.every(w => w[1].includes('Timeout duration was set to 1.')));
  console.log('node-timers-warnings-validation-ok');
});
` },
  { name: 'promises', source: `
const assert = require('assert'); const timers = require('timers');
const p = require('timers/promises'); const { promisify } = require('util');
let done = false;
(async () => {
  assert.strictEqual(timers.promises, p);
  assert.strictEqual(promisify(timers.setTimeout), p.setTimeout);
  assert.strictEqual(promisify(timers.setImmediate), p.setImmediate);
  assert.strictEqual(await p.setTimeout(1, 42), 42);
  assert.strictEqual(await p.setImmediate('value'), 'value');
  await p.scheduler.yield(); await p.scheduler.wait(1);
  assert.throws(() => p.scheduler.wait.call({}, 1), {code:'ERR_INVALID_THIS'});
  for (const options of [null,false,[],{ref:1},{signal:null}]) await assert.rejects(p.setTimeout(1,0,options), {code:'ERR_INVALID_ARG_TYPE'});
  await assert.rejects(p.setTimeout('1'), {code:'ERR_INVALID_ARG_TYPE'});
  const controller = new AbortController();
  const wait = p.setTimeout(10000,'bad',{signal:controller.signal});
  controller.abort(false);
  await assert.rejects(wait, {name:'AbortError',code:'ABORT_ERR',cause:false});
  await assert.rejects(p.setImmediate(0,{signal:controller.signal}), {name:'AbortError',code:'ABORT_ERR',cause:false});
  let count = 0;
  for await (const value of p.setInterval(1, 'tick')) { assert.strictEqual(value,'tick'); if (++count===2) break; }
  const ctl = new AbortController(); const iterator = p.setInterval(10000,0,{signal:ctl.signal});
  const next = iterator.next(); ctl.abort(17);
  await assert.rejects(next, {name:'AbortError',code:'ABORT_ERR',cause:17});
  done = true;
})();
process.on('exit', () => { assert(done); console.log('node-timers-promises-ok'); });
` },
  { name: 'unref-promises', source: `
const p = require('timers/promises');
p.setTimeout(10000,0,{ref:false}).then(() => { throw Error('unref promise timer fired'); });
p.setImmediate(0,{ref:false}).then(() => { throw Error('unref promise immediate fired'); });
const iterator = p.setInterval(10000,0,{ref:false}); iterator.next().then(() => { throw Error('unref promise interval fired'); });
process.on('exit', () => console.log('node-timers-unref-promises-ok'));
` },
];
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export const nodeTimerExpected = nodeTimerCases.map(c => `node-timers-${c.name}-ok`);
export const nodeTimerCommand = 'set -eu\n' + nodeTimerCases.map(c =>
  `node -e ${quote(c.source)}\n`).join('');
