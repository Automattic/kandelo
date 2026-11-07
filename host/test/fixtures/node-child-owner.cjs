'use strict';
// Actual spawn/lifecycle source. Native Node process, stream and environment
// boundaries are explicit host controls; this does not execute the guest JSAPI.
const fs = require('node:fs'), path = require('node:path'), native = require('node:child_process');
const events = require('node:events'), stream = require('node:stream'), util = require('node:util');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'packages/registry/node-compat/bootstrap.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const factories = Function(bundle + ';return {values:_createNodeValuesPlatform,primordials:_createNodePrimordials};')();
const valuesFactory = factories.values;
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); if (a < 0 || b < a) throw Error('Missing child source section'); return source.slice(a, b); }
const ChildProcess = Function('events', section('child_process.ChildProcess = (function () {', '// ============================================================\n// crypto module').replace('child_process.ChildProcess =', 'const ChildProcess =') + ';return ChildProcess;')(events);
exports.close = async function close(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL'); await closed;
  }
};
exports.create = function create(options = {}) {
  const values = valuesFactory({ process, Buffer, util, inspection: util, os: require('node:os'),
    signals: require('node:os').constants.signals, getDOMException: () => DOMException });
  const children = new Map(), controls = [], waitTokens = new Map();
  function spawn(file, argv, env, actions, cwd, extra) {
    if (options.spawnError) throw options.spawnError;
    if (actions.some(a => a.op !== 'open' || a.path !== '/dev/null')) throw Error('Only actual ignored stdio is in this host control');
    const environment = Object.fromEntries(env.map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const child = native.spawn(file, argv.slice(1), { env: environment, stdio: 'ignore', cwd, detached: extra.detached });
    const completion = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    children.set(child.pid, { child, completion }); return child.pid;
  }
  const boundary = {
    isNativeError: util.types.isNativeError,
    __kandeloWaitPid(pid) {
      const owned = children.get(pid);
      const completion = options.waitError ? Promise.reject(options.waitError) : owned.completion;
      waitTokens.set(completion, owned.child); return completion;
    },
    __kandeloKill(pid, signal) {
      process.kill(pid, signal); return 0;
    },
    socketRef(token, referenced) {
      const child = waitTokens.get(token); if (!child) throw Error('Wrong wait operation token');
      controls.push(referenced); if (referenced) child.ref(); else child.unref();
    },
    __kandeloFdClose() { throw Error('No fd owned by this ignored-stdio control'); },
  };
  const scope = { ChildProcess };
  const code = section('    function _spawn(command, args, options) {', '    function exec(command, options, cb) {');
  const api = Function('events', 'stream', 'Buffer', 'process', '_nn', '_spawnWithPath', '_nodeValues', 'child_process', '_childPrimordials', '_nodeFsStats', code + ';return {spawn:_spawn,runWithCallback:_runWithCallback};')
    (events, stream, Buffer, process, boundary, spawn, values, scope, factories.primordials(), require('internal/fs/utils'));
  return { ...api, ChildProcess, controls, children,
    async close() {
      for (const { child } of children.values()) {
        await exports.close(child);
      }
    } };
};
