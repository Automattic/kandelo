// Run unchanged as a native CJS file and through the ordinary guest shell.
export const nodeGlobalScopeSource = String.raw`
const assert = require('node:assert/strict');
const enumerable = new Set(['global','clearImmediate','setImmediate',
  'clearInterval','clearTimeout','setInterval','setTimeout','queueMicrotask',
  'structuredClone','atob','btoa','performance','fetch','crypto',
  'navigator','sessionStorage']);
assert.deepStrictEqual(Object.keys(globalThis).filter(k => !enumerable.has(k)), []);
for (const name of ['options','load','evaluate','print','quit','os','scriptArgs',
  'scriptPath','drainJobQueue','setJitCompilerOption','GLOBAL',
  '__filename','__dirname','module','exports','require','__kandeloNodeNative']) {
  assert.equal(Object.hasOwn(globalThis, name), false, name);
}
for (const name of ['Buffer','process','URL','URLSearchParams','console',
  'AbortController','AbortSignal','Event','TextEncoder','TextDecoder','Blob',
  'Headers','Response','ReadableStream']) {
  const d = Object.getOwnPropertyDescriptor(globalThis, name);
  assert.equal(d.enumerable, false, name);
  assert.equal(d.configurable, true, name);
  if (name === 'process' || name === 'Buffer') {
    assert.equal(typeof d.get, 'function', name);
    assert.equal(typeof d.set, 'function', name);
    const original = globalThis[name];
    try { globalThis[name] = null; assert.equal(globalThis[name], null); }
    finally { globalThis[name] = original; }
  } else { assert.equal(d.writable, true, name); }
}
assert.equal(Object.prototype.toString.call(globalThis), '[object global]');
assert.equal(require('node:process'), process);
assert.equal(require('node:buffer').Buffer, Buffer);
console.log('node-global-scope-ok');
`;

export const nodeGlobalScopeCommand = `set -eu
cat > /tmp/node-global-scope.cjs <<'JS'
${nodeGlobalScopeSource}
JS
node /tmp/node-global-scope.cjs
node -e 'if(typeof require!=="function"||typeof module!=="object"||Object.keys(globalThis).includes("print"))throw Error("eval globals");setTimeout(()=>console.log("node-global-eval-ok"),1)'
`;
