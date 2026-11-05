import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const load = name => new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
const original = new WebAssembly.Instance(load('./original.wasm'), { h: { fork: () => 17 } });
assert.equal(original.exports.checkpoint(), 17);
const provider = load('./provider.wasm');
const imports = { h: { fork: () => 17 } };
for (const entry of WebAssembly.Module.imports(provider)) {
  const namespace = imports[entry.module] ??= {};
  if (entry.name in namespace) continue;
  if (entry.kind === 'global') namespace[entry.name] = entry.name.includes('generation') ? 0n : 7;
  else if (entry.kind === 'table') namespace[entry.name] = new WebAssembly.Table({ element: entry.name === '__wpk_fork_ref_gc_transit' ? 'anyref' : 'anyfunc', initial: 128 });
  else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
  else if (entry.kind === 'function') namespace[entry.name] = () => { throw new Error(`unexpected ${entry.name}`); };
  else throw new Error(`unexpected import ${entry.name}`);
}
const instance = new WebAssembly.Instance(provider, imports);
const harvest = instance.exports.__wpk_fork_static_root_harvest;
if (process.argv[4] === 'Walrus') {
  // The unchanged oracle tries table.init on an already-dropped declared
  // segment. The root is unobservable in the original module; record its bug.
  assert.equal(instance.exports.__wpk_fork_static_root_catalog.length, 1);
  assert.throws(harvest, WebAssembly.RuntimeError);
} else {
  assert.equal(instance.exports.__wpk_fork_static_root_catalog.length, 0);
  harvest();
  harvest();
}
instance.exports.wpk_fork_module_bootstrap();
assert.equal(instance.exports.checkpoint(), 17);
