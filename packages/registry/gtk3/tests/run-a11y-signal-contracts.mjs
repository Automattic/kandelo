import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Invoke each extracted GTK a11y handler through its signal's connected-
// handler machine type (instance, params..., user_data), as GLib's C
// marshallers do. Original definitions must trap; repaired ones must receive
// every argument, including closure data, unchanged.
const [work, optimization] = process.argv.slice(2);
const { cases } = JSON.parse(readFileSync(join(work, 'inventory.json'), 'utf8'));
for (const state of ['before', 'after']) {
  const bytes = readFileSync(join(work, `${state}-O${optimization}.wasm`));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  for (const [index, { source, handler, signal, arity }] of cases.entries()) {
    const label = `${source} ${handler} (${signal})`;
    if (state === 'before') {
      assert.throws(() => instance.exports.run_case(index),
        error => error instanceof WebAssembly.RuntimeError
          && /signature mismatch|signature does not match|indirect call/i.test(error.message),
        `original ${label} must reproduce the indirect signature trap`);
    } else {
      assert.equal(instance.exports.run_case(index), arity, `repaired ${label} must accept all ${arity} arguments`);
      for (let arg = 0; arg < arity; ++arg) {
        assert.equal(instance.exports.recorded_arg(arg), 0x1000 + index * 16 + arg, `repaired ${label} argument ${arg}`);
      }
    }
  }
  console.log(`Wasm32 -O${optimization}: ${state} ${cases.length}/${cases.length} `
    + (state === 'before' ? 'expected signature traps' : 'handlers receive instance, params and closure data'));
}
