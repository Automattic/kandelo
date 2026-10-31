// Deliberately use independent checks: a broken assert must not validate itself.
export const nodeAssertionSource = `
const subject = require('assert');
const strict = require('assert/strict');
const util = require('util');
function check(value, label) { if (!value) throw Error(label); }
function fails(fn, label) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  check(error && error.code === 'ERR_ASSERTION', label);
}
check(strict === subject.strict && strict !== subject, 'strict module identity');
fails(() => strict.equal(1, '1'), 'strict alias');
fails(() => subject.strictEqual(0, -0), 'signed zero');
subject.strictEqual(NaN, NaN);
fails(() => subject.throws(() => { throw Error('actual'); }, /expected/), 'regex mismatch');
fails(() => subject.throws(() => { throw Error('actual'); }, TypeError), 'constructor mismatch');
fails(() => subject.throws(() => { throw { code: 'OTHER' }; }, { code: 'EXPECTED' }), 'error fields');
fails(() => subject.throws(() => { throw Error('x'); }, () => false), 'predicate mismatch');
subject.throws(() => { throw Error('actual'); }, { message: /actual/, name: 'Error' });
check(!util.isDeepStrictEqual({ a: undefined }, { b: undefined }), 'undefined keys');
check(!util.isDeepStrictEqual(new Map([['a', 1]]), new Map([['a', 2]])), 'map values');
check(!util.isDeepStrictEqual(new Set([1]), new Set([2])), 'set members');
check(!util.isDeepStrictEqual(new Date(1), new Date(2)), 'dates');
check(!util.isDeepStrictEqual(new Error('a'), new Error('b')), 'error messages');
check(!util.isDeepStrictEqual(new Uint8Array([1]), new Uint8Array([2])), 'view bytes');
check(!util.isDeepStrictEqual(Promise.resolve(1), Promise.resolve(1)), 'distinct promises');
const a = {}; a.self = a;
const b = {}; b.self = b;
check(util.isDeepStrictEqual(a, b), 'cycles');
for (const value of [null, 1, {}, Object.create(Promise.prototype), { [Symbol.toStringTag]: 'Promise' }]) {
  check(!util.types.isPromise(value), 'promise brand');
}
const promise = Promise.resolve(1);
Object.defineProperties(promise, {
  then: { get() { throw Error('brand observed then'); } },
  constructor: { get() { throw Error('brand observed constructor'); } },
});
check(util.types.isPromise(promise), 'real promise brand');
check(!util.types.isPromise(new Proxy(promise, {})), 'proxy promise');
const foreign = require('vm').runInNewContext('({ promise: Promise.resolve(1), fake: Object.create(Promise.prototype) })');
check(util.types.isPromise(foreign.promise) && !util.types.isPromise(foreign.fake), 'foreign promise brand');
(async () => {
  await subject.rejects(Promise.reject(Error('actual')), /actual/);
  let rejected = false;
  try { await subject.rejects(Promise.reject(Error('actual')), /expected/); }
  catch (error) { rejected = error.code === 'ERR_ASSERTION'; }
  check(rejected, 'rejection matcher');
  console.log('node-assertion-semantics-ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

export const nodeAssertionCommand = `set -eu
cat > /tmp/node-assertion-semantics.cjs <<'JS'
${nodeAssertionSource}
JS
node /tmp/node-assertion-semantics.cjs
`;
