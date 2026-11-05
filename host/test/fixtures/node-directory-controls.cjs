'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const candidate = require('./node-directory-platform.cjs').create();
const root = fs.mkdtempSync(path.join(tmpdir(), 'kandelo-directory-source-'));
function error(error) {
  return { name: error.name, code: error.code, message: error.message, syscall: error.syscall,
    path: Buffer.isBuffer(error.path) ? error.path.toString('hex') : error.path };
}
function sync(fn) { try { return { value: fn() }; } catch (e) { return { error: error(e) }; } }
async function settled(fn) { try { return { value: await fn() }; } catch (e) { return { error: error(e) }; } }
function callback(api, name, args) {
  return new Promise(resolve => {
    let returned = false;
    const result = api[name](...args, function(...values) {
      assert.equal(returned, true, 'actual native operation completes asynchronously');
      resolve(values[0] ? { error: error(values[0]) } : { value: values[1], argc: values.length });
    });
    assert.equal(result, undefined); returned = true;
  });
}
const tests = {
  async validation() {
    const missing = path.join(root, 'absent', 'file');
    for (const options of [null, false, [], { recursive: 1 }, { recursive: null }, { mode: -1 },
      { mode: 'no' }, { mode: null }, 0, 0o755, '700']) {
      const before = candidate.calls.length;
      const expected = sync(() => fs.mkdirSync(missing, options));
      assert.deepEqual(sync(() => candidate.api.mkdirSync(missing, options)), expected);
      if (expected.error?.syscall === undefined) assert.equal(candidate.calls.length, before);
      assert.deepEqual(await settled(() => candidate.promises.mkdir(missing, options)),
        await settled(() => fs.promises.mkdir(missing, options)));
    }
    for (const input of [null, {}, 1, 'a\0b', Buffer.from([97, 0, 98])])
      for (const name of ['mkdirSync', 'unlinkSync', 'rmdirSync'])
        assert.deepEqual(sync(() => candidate.api[name](input)), sync(() => fs[name](input)));
    for (const name of ['mkdir', 'unlink', 'rmdir'])
      assert.deepEqual(sync(() => candidate.api[name](missing, 1)), sync(() => fs[name](missing, 1)));
  },
  async mkdir() {
    const leaf = path.join(root, 'a', 'b', 'c');
    assert.equal(candidate.api.mkdirSync(leaf, { recursive: true, mode: 0o750 }), path.join(root, 'a'));
    assert.equal(candidate.api.mkdirSync(leaf, { recursive: true }), undefined);
    const zero = path.join(root, 'zero');
    candidate.api.mkdirSync(zero, { mode: 0 });
    assert.equal(fs.statSync(zero).mode & 0o777, 0);
    const url = pathToFileURL(path.join(root, 'url', 'child'));
    assert.equal(await candidate.promises.mkdir(url, { recursive: true }), path.join(root, 'url'));
    const raw = Buffer.concat([Buffer.from(root + '/raw-'), Buffer.from([0xff])]);
    const rawActual = sync(() => candidate.api.mkdirSync(raw, { recursive: true }));
    if (!rawActual.error) candidate.api.rmdirSync(raw);
    const rawExpected = sync(() => fs.mkdirSync(raw, { recursive: true }));
    assert.deepEqual(rawActual, rawExpected);
    if (!rawExpected.error) assert(fs.statSync(raw).isDirectory());
    fs.writeFileSync(path.join(root, 'file'), 'data');
    for (const p of [path.join(root, 'file'), path.join(root, 'file', 'child')]) {
      assert.deepEqual(sync(() => candidate.api.mkdirSync(p, { recursive: true })), sync(() => fs.mkdirSync(p, { recursive: true })));
      assert.deepEqual(await settled(() => candidate.promises.mkdir(p, { recursive: true })), await settled(() => fs.promises.mkdir(p, { recursive: true })));
    }
  },
  async callbacks() {
    const p = path.join(root, 'a', 'b');
    const result = await callback(candidate.api, 'mkdir', [p, { recursive: true }]);
    fs.rmSync(path.join(root, 'a'), { recursive: true });
    assert.deepEqual(result, await callback(fs, 'mkdir', [p, { recursive: true }]));
    for (const name of ['unlink', 'rmdir']) {
      const missing = path.join(root, 'missing');
      assert.deepEqual(await callback(candidate.api, name, [missing]), await callback(fs, name, [missing]));
    }
    assert(candidate.calls.every(call => call.async));
  },
  async removal() {
    const file = path.join(root, 'file'), dir = path.join(root, 'dir');
    fs.writeFileSync(file, 'data'); fs.mkdirSync(dir);
    assert.deepEqual(sync(() => candidate.api.rmdirSync(file)), sync(() => fs.rmdirSync(file)));
    assert(fs.existsSync(file));
    assert.deepEqual(sync(() => candidate.api.unlinkSync(dir)), sync(() => fs.unlinkSync(dir)));
    assert(fs.existsSync(dir));
    await candidate.promises.unlink(file); await candidate.promises.rmdir(dir);
    assert(!fs.existsSync(file)); assert(!fs.existsSync(dir));
    fs.mkdirSync(dir); const link = path.join(root, 'link'); fs.symlinkSync(dir, link);
    candidate.api.unlinkSync(link); assert(fs.existsSync(dir));
    fs.writeFileSync(path.join(dir, 'kept'), 'data');
    assert.deepEqual(await settled(() => candidate.promises.rmdir(dir)), await settled(() => fs.promises.rmdir(dir)));
    assert(fs.existsSync(path.join(dir, 'kept')));
  },
  async removedOption() {
    for (const options of [{ recursive: false }, { recursive: true }, { recursive: null }, { recursive: 0 }, [], null, false]) {
      assert.deepEqual(sync(() => candidate.api.rmdirSync(root, options)), sync(() => fs.rmdirSync(root, options)));
      assert.deepEqual(sync(() => candidate.api.rmdir(root, options, () => {})), sync(() => fs.rmdir(root, options, () => {})));
      assert.deepEqual(await settled(() => candidate.promises.rmdir(root, options)), await settled(() => fs.promises.rmdir(root, options)));
    }
  },
};
Promise.resolve().then(() => tests[process.argv[2]]()).then(() => {
  console.log(JSON.stringify({ passed: true, scenario: process.argv[2], calls: candidate.calls }));
}).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  // Only this fixture owns the temporary host directory; restore mode-zero
  // children so cleanup works under an ordinary development user's authority.
  const zero = path.join(root, 'zero'); if (fs.existsSync(zero)) fs.chmodSync(zero, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});
