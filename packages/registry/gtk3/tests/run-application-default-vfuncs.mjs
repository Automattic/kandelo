import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [work, optimization] = process.argv.slice(2);
const { slots } = JSON.parse(readFileSync(join(work, 'inventory.json'), 'utf8'));
for (const state of ['before', 'after']) {
  const bytes = readFileSync(join(work, `${state}-O${optimization}.wasm`));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  for (const [index, name] of slots.entries()) {
    if (state === 'before') {
      assert.throws(() => instance.exports.run_case(index),
        error => error instanceof WebAssembly.RuntimeError && /signature mismatch|signature does not match|indirect call/i.test(error.message),
        `original ${name} must demonstrate its indirect signature trap`);
    } else {
      assert.equal(instance.exports.run_case(index), 0,
        `repaired ${name} must preserve no-op / zero result and caller state`);
    }
  }
  console.log(`Wasm32 -O${optimization}: ${state} ${slots.length}/${slots.length} ${state === 'before' ? 'expected signature traps' : 'typed defaults preserve semantics'}`);
}
