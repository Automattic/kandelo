import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [wasmPath, sectionsPath] = process.argv.slice(2);
const moduleBytes = readFileSync(wasmPath);
const sections = readFileSync(sectionsPath, 'utf8');
const module = new WebAssembly.Module(moduleBytes);
const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
const imports = { env: { memory } };

for (const entry of WebAssembly.Module.imports(module)) {
  if (entry.kind === 'function') {
    imports[entry.module] ??= {};
    imports[entry.module][entry.name] = () => 0;
  }
}

const instance = new WebAssembly.Instance(module, imports);
const table = instance.exports.__indirect_function_table;

for (const [name, input, expected] of [['c_target', 5, 10], ['weighted', 5, 12], ['cross_weighted', 5, 13], ['call_function_pointer', 5, 8]]) {
  const match = sections.match(new RegExp(`elem\\[(\\d+)\\] = ref\\.func:\\d+ <${name}>`));
  assert.ok(match, `missing table entry for ${name}`);
  assert.equal(table.get(Number(match[1]))(input), expected);
}

const tlsMatch = sections.match(/elem\[(\d+)\] = ref\.func:\d+ <tls_weighted>/);
assert.ok(tlsMatch, 'missing TLS function table entry');
const tlsIndex = Number(tlsMatch[1]);
instance.exports.__wasm_init_tls(0x300000);
assert.equal(table.get(tlsIndex)(5), 12);
assert.equal(table.get(tlsIndex)(5), 13);
const secondInstance = new WebAssembly.Instance(module, imports);
secondInstance.exports.__wasm_init_tls(0x310000);
assert.equal(secondInstance.exports.__indirect_function_table.get(tlsIndex)(5), 12);
assert.equal(table.get(tlsIndex)(5), 14);

assert.ok(instance.exports.__heap_base.value > 0);
console.log('Go-linked C functions execute with initialized data and per-instance TLS');
