'use strict';
// Actual production adapter/frontend over the identified portable Context
// component. This does not execute native-wasi.cpp or guest WebAssembly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const os = require('node:os');
assert.equal(process.version, 'v26.13.0');
const repo = path.resolve(__dirname, '../../../..');
const binding = require(process.env.WASI_OWNER_COMPONENT);
const getter = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer').get;
const Constructor = binding.initialize(memory => new Uint8Array(Reflect.apply(getter, memory, [])));
const adapter = fs.readFileSync(path.join(repo, 'packages/registry/spidermonkey/node-compat/adapter.js'), 'utf8');
const a = adapter.indexOf('    const _nodeNative = {');
const b = adapter.indexOf('\n\n    const entryPath =', a);
const c = adapter.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;');
const d = adapter.indexOf('    // The deadline heap owns', c);
assert(a >= 0 && b > a && c >= 0 && d > c);
let calls = 0;
let failure;
const native = {
  wasiConstructor(...args) {
    assert.equal(this, native);
    assert.deepEqual(args, []);
    ++calls;
    if (failure) throw failure;
    return Constructor;
  },
};
const actual = Function('native', 'workerEnvironment', adapter.slice(c, d) + adapter.slice(a, b) + '\nreturn _nodeNative;')(native, null);
assert.equal(actual.wasiConstructor(), Constructor);
assert.equal(calls, 1);
const marker = new Error('original native constructor failure');
failure = marker;
assert.throws(() => actual.wasiConstructor(), error => error === marker);
failure = undefined;
assert.equal(calls, 2);
const bundle = fs.readFileSync(path.join(repo, 'third_party/node-core/node-core.js'), 'utf8');
const factory = Function(bundle + '\nreturn {values:_createNodeValuesPlatform, create:_createNodeWasiPlatform};')();
const values = factory.values({process, Buffer, util, inspection: util, os: {}, signals: os.constants.signals});
const {WASI} = factory.create({native: actual, values});
assert.equal(calls, 2, 'loading public source does not construct the native class');
assert.throws(() => new WASI({version: 'unknown'}), {code: 'ERR_INVALID_ARG_VALUE'});
assert.equal(calls, 2);
const first = new WASI({version: 'preview1', args: ['actual']});
const second = new WASI({version: 'unstable'});
assert.equal(calls, 3, 'one actual constructor is cached for this public module');
assert.equal(second.getImportObject().wasi_unstable, second.wasiImport);
assert.equal(first.wasiImport.args_sizes_get(-1, 0), 28);
const memory = new WebAssembly.Memory({initial: 1});
first.initialize({exports: {memory}});
assert.equal(first.wasiImport.args_sizes_get(0, 4), 0);
assert.equal(new DataView(memory.buffer).getUint32(0, true), 1);
assert.throws(() => first.initialize({exports: {memory}}), {code: 'ERR_WASI_ALREADY_STARTED'});
assert.equal(first.getImportObject().wasi_snapshot_preview1, first.wasiImport);
console.log(JSON.stringify({groups: 4, actualCuratedAdapter: true, actualPortableContext: true, productionSMExecuted: false}));
