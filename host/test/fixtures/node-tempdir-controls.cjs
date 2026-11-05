'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const candidate = require('./node-tempdir-platform.cjs').create();
const root = fs.mkdtempSync(path.join(tmpdir(), 'kandelo-tempdir-source-'));
const originalCwd = process.cwd();
function caught(fn) {
  try { fn(); return { returned: true }; }
  catch (e) { return { name: e.name, code: e.code, message: e.message, path: e.path, syscall: e.syscall }; }
}
async function rejected(fn) {
  try { await fn(); return { returned: true }; }
  catch (e) { return { name: e.name, code: e.code, message: e.message, path: e.path, syscall: e.syscall }; }
}
function callback(api, prefix, options) {
  return new Promise((resolve, reject) => {
    let returned = false;
    assert.equal(api.mkdtemp(prefix, options, (error, value) => {
      assert(returned, 'real FS request must complete asynchronously');
      if (error) reject(error); else resolve(value);
    }), undefined);
    returned = true;
  });
}
function checkDirectory(result, prefix) {
  assert.equal(typeof result, 'string');
  assert.equal(result.slice(0, prefix.length), prefix);
  assert.equal(result.length, prefix.length + 6);
  assert(fs.statSync(result).isDirectory());
  assert.equal(fs.statSync(result).mode & 0o777, 0o700 & ~process.umask());
}
const tests = {
  async validation() {
    for (const prefix of [undefined, null, false, true, 0, 1, {}, [], Symbol('path'), 'a\0b', Buffer.from([97, 0])]) {
      assert.deepEqual(caught(() => candidate.api.mkdtempSync(prefix)), caught(() => fs.mkdtempSync(prefix)));
      assert.deepEqual(caught(() => candidate.api.mkdtemp(prefix, () => {})), caught(() => fs.mkdtemp(prefix, () => {})));
      assert.deepEqual(await rejected(() => candidate.promises.mkdtemp(prefix)), await rejected(() => fs.promises.mkdtemp(prefix)));
    }
    for (const callback of [undefined, null, false, 42, {}])
      assert.deepEqual(caught(() => candidate.api.mkdtemp(root, {}, callback)), caught(() => fs.mkdtemp(root, {}, callback)));
    for (const options of [false, true, 1, { encoding: 'invalid' }]) {
      assert.deepEqual(caught(() => candidate.api.mkdtempSync(root, options)), caught(() => fs.mkdtempSync(root, options)));
      assert.deepEqual(await rejected(() => candidate.promises.mkdtemp(root, options)), await rejected(() => fs.promises.mkdtemp(root, options)));
    }
    assert.equal(candidate.calls.length, 0, 'validation must precede native work');
  },
  async creation() {
    const prefix = path.join(root, 'space-é-');
    const names = [candidate.api.mkdtempSync(prefix), await callback(candidate.api, pathToFileURL(prefix)),
      await candidate.promises.mkdtemp(Buffer.from(prefix)), ...await Promise.all(Array.from({ length: 50 }, () => candidate.promises.mkdtemp(prefix)))];
    assert.equal(new Set(names).size, names.length);
    names.forEach(name => checkDirectory(name, prefix));
    assert(candidate.calls.some(call => !call.async));
    assert(candidate.calls.some(call => call.async));
    const missing = path.join(root, 'missing', 'prefix-');
    assert.deepEqual(caught(() => candidate.api.mkdtempSync(missing)), caught(() => fs.mkdtempSync(missing)));
    function normalize(error) {
      assert.equal(error.path.slice(0, missing.length), missing);
      assert.equal(error.path.length, missing.length + 6);
      assert(error.message.includes(error.path));
      return { ...error, path: missing + '<suffix>', message: error.message.replace(error.path, missing + '<suffix>') };
    }
    assert.deepEqual(normalize(await rejected(() => candidate.promises.mkdtemp(missing))),
      normalize(await rejected(() => fs.promises.mkdtemp(missing))));
  },
  async encoding() {
    const prefix = path.join(root, 'é-');
    for (const encoding of ['buffer', 'utf8', 'latin1', 'ascii', 'hex', 'base64', 'base64url', 'ucs2']) {
      for (const variant of ['sync', 'callback', 'promise']) {
        const before = new Set(fs.readdirSync(root));
        const result = variant === 'sync' ? candidate.api.mkdtempSync(prefix, encoding) :
          variant === 'callback' ? await callback(candidate.api, prefix, { encoding }) :
          await candidate.promises.mkdtemp(prefix, { encoding });
        const actualName = fs.readdirSync(root).find(name => !before.has(name));
        const bytes = Buffer.from(path.join(root, actualName));
        if (encoding === 'buffer') {
          assert(candidate.Buffer.isBuffer(result));
          assert.deepEqual([...result], [...bytes]);
        } else assert.equal(result, bytes.toString(encoding));
      }
    }
    const publicFrom = candidate.Buffer.from, publicToString = candidate.Buffer.prototype.toString;
    try {
      candidate.Buffer.from = candidate.Buffer.prototype.toString = () => { throw Error('mutable public codec'); };
      const result = candidate.api.mkdtempSync(prefix, 'buffer');
      assert(fs.statSync(Buffer.from(result)).isDirectory());
      checkDirectory(await candidate.promises.mkdtemp(prefix), prefix);
    } finally { candidate.Buffer.from = publicFrom; candidate.Buffer.prototype.toString = publicToString; }
  },
  async disposal() {
    process.chdir(root);
    const sync = candidate.api.mkdtempDisposableSync('sync-');
    const promise = await candidate.promises.mkdtempDisposable('promise-');
    assert.equal(Object.getPrototypeOf(sync), Object.prototype);
    assert.equal(Object.getPrototypeOf(promise), null);
    assert.deepEqual(Reflect.ownKeys(sync), ['path', 'remove', Symbol.dispose]);
    assert.deepEqual(Reflect.ownKeys(promise), ['path', 'remove', Symbol.asyncDispose]);
    for (const [record, symbol] of [[sync, Symbol.dispose], [promise, Symbol.asyncDispose]]) {
      const full = path.join(root, record.path);
      fs.mkdirSync(path.join(full, 'nested')); fs.writeFileSync(path.join(full, 'nested', 'data'), 'keep until disposed');
      fs.symlinkSync(root, path.join(full, 'external'));
      process.chdir(originalCwd);
      await record[symbol](); await record.remove();
      assert(!fs.existsSync(full)); assert(fs.existsSync(root));
    }
  },
  async removalErrors() {
    assert.notEqual(process.getuid(), 0, 'permission fixture requires an unprivileged native control');
    for (const variant of ['sync', 'promise']) {
      const parent = fs.mkdtempSync(path.join(root, 'parent-'));
      const record = variant === 'sync' ? candidate.api.mkdtempDisposableSync(path.join(parent, 'child-')) :
        await candidate.promises.mkdtempDisposable(path.join(parent, 'child-'));
      fs.chmodSync(parent, 0o500);
      try {
        if (variant === 'sync') assert.throws(() => record.remove(), { code: 'EACCES' });
        else await assert.rejects(record.remove(), { code: 'EACCES' });
      } finally { fs.chmodSync(parent, 0o700); }
      await record.remove(); assert(!fs.existsSync(record.path));
    }
  },
  async vfs() {
    const events = [];
    const marker = path.join(root, 'virtual');
    candidate.truncation.vfsState.handlers = {
      mkdtempSync(prefix, options) { events.push(['sync', prefix, options]); return marker; },
      mkdtemp(prefix, options) { events.push(['async', prefix, options]); return Promise.resolve(marker); },
    };
    assert.equal(candidate.api.mkdtempSync('virtual:', 'buffer'), marker);
    assert.equal(await callback(candidate.api, 'virtual:', 'buffer'), marker);
    assert.equal(await candidate.promises.mkdtemp('virtual:', 'buffer'), marker);
    assert.equal(events.length, 3); assert.equal(candidate.calls.length, 0);
    candidate.truncation.vfsState.handlers = null;
  },
  async warning() {
    // Let the explicitly loaded native internal-binding preload warning
    // finish before observing warnings produced by the candidate API.
    await new Promise(resolve => setImmediate(resolve));
    const warnings = [];
    process.on('warning', warning => warnings.push(warning.message));
    for (const prefix of [path.join(root, 'X'), Buffer.from(path.join(root, 'X'))])
      candidate.api.mkdtempSync(prefix);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(warnings, ['mkdtemp() templates ending with X are not portable. For details see: https://nodejs.org/api/fs.html']);
  },
};
(async () => {
  const name = process.argv[2]; assert.equal(typeof tests[name], 'function');
  try { await tests[name](); console.log(JSON.stringify({ name, passed: true })); }
  finally { process.chdir(originalCwd); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
