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

for (const [name, input, expected] of [['c_target', 5, 10], ['weighted', 5, 12]]) {
  const match = sections.match(new RegExp(`elem\\[(\\d+)\\] = ref\\.func:\\d+ <${name}>`));
  assert.ok(match, `missing table entry for ${name}`);
  assert.equal(table.get(Number(match[1]))(input), expected);
}

assert.ok(instance.exports.__heap_base.value > 0);
console.log('Go-linked C functions execute with initialized C data');
