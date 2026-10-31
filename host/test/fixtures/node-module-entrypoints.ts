export const nodeModuleEntryFiles: Record<string, string> = {
  'main.cjs': String.raw`
const assert = require('node:assert/strict');
assert.equal(require.main, module);
assert.equal(module.id, '.');
assert.equal(module.loaded, false);
assert.equal(require.cache[__filename], module);
assert.equal(process.mainModule, module);
assert.equal(require('./child.cjs').main, module);
let completed = false;
setTimeout(async () => {
  const ns = await import('./café helper.mjs');
  assert.equal(ns.value, 7);
  completed = true;
}, 5);
process.on('exit', code => {
  assert.equal(code, 0);
  assert.equal(completed, true);
  assert.equal(module.loaded, true);
  console.log('node-cjs-entry-ok');
});
`,
  'child.cjs': String.raw`
const assert = require('node:assert/strict');
assert.equal(require.main.loaded, false);
exports.main = require.main;
`,
  'café helper.mjs': 'export const value = 7;\n',
  'side.mjs': 'globalThis.__entrySideEffect = (globalThis.__entrySideEffect || 0) + 1;\n',
  'cycle-a.mjs': String.raw`
import { other } from './cycle-b.mjs';
export let value = 1;
export function read() { return other() + value; }
export function update() { value = 2; }
`,
  'cycle-b.mjs': String.raw`
import { value } from './cycle-a.mjs';
export function other() { return value * 2; }
`,
  'payload.cjs': 'globalThis.__payloadRuns = (globalThis.__payloadRuns || 0) + 1; exports.answer = 42;\n',
  'late.cjs': 'globalThis.__resolveExecuted = (globalThis.__resolveExecuted || 0) + 1; exports.value = 9;\n',
  'failing.cjs': 'throw new Error("expected CJS load failure");\n',
  'esm-main.mjs': String.raw`
import './side.mjs';
import assert, { strictEqual as equal } from 'node:assert';
import { createRequire } from 'node:module';
import { read, update } from './cycle-a.mjs';
import payload, { answer } from './payload.cjs';
export const exportedValue = 42;
equal(globalThis.__entrySideEffect, 1);
equal(globalThis.__payloadRuns, 1);
equal(answer, 42);
equal(payload.answer, 42);
equal('import.meta.url', 'import.meta.url');
assert.ok(import.meta.url.endsWith('/esm-main.mjs'));
equal(read(), 3); update(); equal(read(), 6);
const require = createRequire(import.meta.url);
equal(require.main, undefined);
equal(require('./payload.cjs'), payload);
equal(globalThis.__payloadRuns, 1);
equal(globalThis.__resolveExecuted, undefined);
assert.ok(import.meta.resolve('./late.cjs').startsWith('file:'));
equal(import.meta.resolve('node:assert'), 'node:assert');
equal(globalThis.__resolveExecuted, undefined);
const late = await import('./late.cjs');
equal(late.default.value, 9);
equal(globalThis.__resolveExecuted, 1);
await assert.rejects(import('./failing.cjs'), /expected CJS load failure/);
await new Promise(resolve => setTimeout(resolve, 5));
process.on('exit', code => { equal(code, 0); console.log('node-esm-entry-ok'); });
`,
  'unsettled.mjs': 'await new Promise(() => {});\n',
  'failure.mjs': 'throw false;\n',
};

export const nodeModuleEntryCommand = 'set -eu\nmkdir -p /tmp/node-entrypoints\n' +
  Object.entries(nodeModuleEntryFiles).map(([name, source]) =>
    `cat > '/tmp/node-entrypoints/${name}' <<'JS'\n${source}\nJS\n`).join('') +
  `node /tmp/node-entrypoints/main.cjs
node /tmp/node-entrypoints/esm-main.mjs
if node /tmp/node-entrypoints/unsettled.mjs; then exit 1; else test "$?" -eq 13; fi
if node /tmp/node-entrypoints/failure.mjs; then exit 1; else test "$?" -eq 1; fi
printf 'node-module-entry-status-ok\\n'
`;
