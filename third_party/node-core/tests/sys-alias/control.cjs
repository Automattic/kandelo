'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../../../..');
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'packages/registry/node-compat/bootstrap.js'), 'utf8');
const factories = Function(bundle + ';return {sys:_createNodeSysPlatform,warning:_createNodeWarningPlatform};')();
const setup = bootstrap.slice(bootstrap.indexOf('const _nodeSys ='), bootstrap.indexOf('let _nodeDomain, _nodeFfi;'));
const getter = bootstrap.match(/    get sys\(\) \{ return _nodeSys.load\(\); \},/)[0];
function candidate(options) {
  let proc, registry;
  const fixture = require(path.join(root, 'host/test/fixtures/node-module-records.cjs'));
  const api = fixture.create({ skipESMResolver: true, configureBuiltins(builtins, boundary, values) {
    registry = builtins; proc = boundary;
    // Real generated warning algorithms consume explicit native EventEmitter,
    // tick, filesystem and console boundaries. This is not guest execution.
    Object.setPrototypeOf(proc, EventEmitter.prototype); EventEmitter.call(proc);
    Object.assign(proc, { moduleLoadList: [], nextTick: process.nextTick.bind(process),
      pid: process.pid, release: process.release, argv0: process.argv0, stderr: process.stderr,
      env: { ...process.env } });
    const warning = factories.warning({ process: proc, values, fs, path,
      cliOptions: options, getConsole: () => console });
    warning.install();
    const context = { process: proc, _nodeValues: values, _builtinModules: builtins,
      _createNodeSysPlatform: factories.sys,
      _nodeNative: { evalScriptAsFunction: (source, filename, line) => {
        assert.equal(line, 1); return vm.runInThisContext(source, { filename });
      } } };
    vm.createContext(context);
    const descriptor = vm.runInContext(setup + ';Object.getOwnPropertyDescriptor({' + getter + '},"sys")', context);
    Object.defineProperty(builtins, 'sys', descriptor);
  } });
  const req = api.Module.createRequire(path.join(root, 'sys-control-main.cjs'));
  return { proc, registry, Module: api.Module, req };
}
function native() { return { proc: process, Module: require('node:module'), req: require }; }
async function child(mode, name) {
  const options = {
    noWarnings: name === 'no-warnings', noDeprecation: name === 'no-deprecation',
    throwDeprecation: name === 'throw-deprecation', traceDeprecation: name === 'trace-deprecation',
    disableWarnings: name === 'disable-code' ? ['DEP0025'] : [],
  };
  const api = mode === 'native' ? native() : candidate(options);
  const { proc, req, Module } = api;
  const util = req('node:util');
  const listCount = () => proc.moduleLoadList.filter(row => row === 'NativeModule sys').length;
  assert.equal(listCount(), 0);
  const warningEvents = [], immediate = [];
  proc.on('warning', warning => warningEvents.push({ name: warning.name, code: warning.code,
    message: warning.message, hasRealSysOrigin: /node:sys:\d+:\d+/.test(warning.stack),
    firstOrigin: warning.stack?.split('\n')[1]?.trim() }));
  if (name === 'metadata') {
    const before = listCount();
    const metadata = [Module.isBuiltin('sys'), Module.isBuiltin('node:sys'),
      Module.builtinModules.includes('sys'), Module.builtinModules.includes('node:sys')];
    assert.deepEqual(metadata, [true, true, true, false]);
    assert.equal(listCount(), before); return { metadata, loadCount: listCount(), warningCount: 0 };
  }
  if (name === 'reentrant' || name === 'retry' || name === 'override') {
    let calls = 0, recursiveIdentity = false;
    proc.emitWarning = function(...args) {
      assert.equal(this, proc); immediate.push(args); calls++;
      if (name === 'reentrant') { recursiveIdentity = req('node:sys') === util; assert.equal(listCount(), 0); }
      if (name === 'retry' && calls === 1) throw new Error('diagnostic warning owner throws');
    };
    if (name === 'retry') {
      assert.throws(() => req('sys'), /diagnostic warning owner throws/);
      assert.equal(listCount(), 0);
    }
    assert.equal(req('sys'), util); assert.equal(req('node:sys'), util);
    assert.equal(listCount(), 1);
    assert.equal(calls, name === 'retry' ? 2 : 1);
    for (const args of immediate) assert.deepEqual(args,
      ['sys is deprecated. Use `node:util` instead.', 'DeprecationWarning', 'DEP0025']);
    return { calls, recursiveIdentity, exactArguments: immediate, loadCount: listCount() };
  }
  if (name === 'cache-poison') {
    const fake = { poisoned: true };
    Module._cache.util = { exports: fake, loaded: true };
    Module._cache.sys = { exports: fake, loaded: true };
    assert.equal(req('sys'), fake); assert.equal(listCount(), 0);
    assert.equal(req('node:sys'), util); assert.equal(listCount(), 1);
    assert.equal(req('util'), fake); assert.equal(req('node:util'), util);
    delete Module._cache.sys; delete Module._cache.util;
    assert.equal(req('sys'), util);
  } else if (name === 'throw-deprecation') {
    const failure = new Promise(resolve => process.once('uncaughtException', err => resolve({
      name: err.name, code: err.code, message: err.message,
      hasRealSysOrigin: /node:sys:\d+:\d+/.test(err.stack),
    })));
    assert.equal(req('node:sys'), util); assert.equal(listCount(), 1);
    const thrown = await failure;
    assert.deepEqual(thrown, { name: 'DeprecationWarning', code: 'DEP0025',
      message: 'sys is deprecated. Use `node:util` instead.', hasRealSysOrigin: true });
    return { thrown, warnings: warningEvents, loadCount: listCount() };
  } else {
    const first = req(name === 'node-first' ? 'node:sys' : 'sys');
    assert.equal(first, util); assert.equal(req('node:sys'), first); assert.equal(req('sys'), first);
    assert.equal(proc.getBuiltinModule('sys'), first); assert.equal(proc.getBuiltinModule('node:sys'), first);
    const key = Symbol('sys identity');
    Object.defineProperty(first, key, { value: 73, enumerable: false, configurable: true });
    assert.equal(Object.getOwnPropertyDescriptor(util, key).value, 73);
    delete util[key];
    assert.deepEqual(Reflect.ownKeys(first), Reflect.ownKeys(util));
    for (const key of Reflect.ownKeys(util)) assert.deepEqual(Object.getOwnPropertyDescriptor(first, key), Object.getOwnPropertyDescriptor(util, key));
  }
  const syncWarningCount = warningEvents.length;
  assert.equal(syncWarningCount, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listCount(), 1);
  const expected = name === 'no-deprecation' ? 0 : 1;
  assert.equal(warningEvents.length, expected);
  for (const warning of warningEvents) {
    assert.equal(warning.name, 'DeprecationWarning'); assert.equal(warning.code, 'DEP0025');
    assert.equal(warning.message, 'sys is deprecated. Use `node:util` instead.');
    assert.equal(warning.hasRealSysOrigin, true);
  }
  return { identity: true, syncWarningCount, warnings: warningEvents.map(({firstOrigin,...record}) => record),
    loadCount: listCount(), realOriginFrames: warningEvents.map(record => record.firstOrigin) };
}
exports.candidate = candidate;
if (require.main === module) {
if (process.argv[2] === 'child') {
  child(process.argv[3], process.argv[4]).then(value => console.log(JSON.stringify(value)),
    err => { console.error(err); process.exitCode = 1; });
} else {
  const out = path.resolve(process.argv[2]); fs.mkdirSync(out, { recursive: true });
  const results = [];
  const names = ['metadata', 'bare-first', 'node-first', 'reentrant', 'retry', 'override', 'cache-poison',
    'no-warnings', 'no-deprecation', 'throw-deprecation', 'trace-deprecation', 'disable-code', 'env-no-warnings'];
  for (const name of names) {
    const result = { name };
    for (const mode of ['native', 'candidate']) {
      const flags = ['--expose-internals'];
      if (mode === 'native') {
        if (['no-warnings', 'no-deprecation', 'throw-deprecation', 'trace-deprecation'].includes(name)) flags.push('--' + name);
        if (name === 'disable-code') flags.push('--disable-warning=DEP0025');
      }
      const env = { ...process.env }; delete env.NODE_NO_WARNINGS;
      if (name === 'env-no-warnings') env.NODE_NO_WARNINGS = '1';
      const command = [process.execPath, ...flags, __filename, 'child', mode, name];
      const run = cp.spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 10000, env });
      fs.writeFileSync(path.join(out, name + '-' + mode + '.stdout'), run.stdout || '');
      fs.writeFileSync(path.join(out, name + '-' + mode + '.stderr'), run.stderr || '');
      result[mode] = { command, exit: run.status, signal: run.signal, error: run.error?.message };
      try { result[mode].value = JSON.parse(run.stdout); } catch (err) { result[mode].parseError = err.message; }
      result[mode].warningPrinted = (run.stderr || '').includes('[DEP0025]');
    }
    try {
      assert.equal(result.native.exit, 0); assert.equal(result.candidate.exit, 0);
      const normalize = value => { const {realOriginFrames,...rest} = value; return rest; };
      assert.deepEqual(normalize(result.candidate.value), normalize(result.native.value));
      assert.equal(result.candidate.warningPrinted, result.native.warningPrinted);
      result.status = 'pass';
    } catch (error) { result.status = 'fail'; result.failure = error.message; }
    results.push(result);
  }
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report = { scope: 'Actual generated sys/cache/warning owners and production registry/loader over explicit native VM/fs/EventEmitter/tick/util boundaries; no guest conformance',
    node: process.version, binary: process.execPath, nodeSha256: sha(process.execPath),
    pass: results.filter(row => row.status === 'pass').length, fail: results.filter(row => row.status === 'fail').length,
    results, productSetup: 0, compilations: 0, overallSuites: 0 };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({pass:report.pass,fail:report.fail,results:results.map(({name,status,failure})=>({name,status,failure}))},null,2));
  process.exitCode = report.fail ? 1 : 0;
}

}
