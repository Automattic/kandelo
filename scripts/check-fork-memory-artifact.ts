/** Validate only controlled benchmark artifacts, outside measured processes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeWasmForkArtifactContractFailures } from "../host/src/constants";
import createGcStore from "../crates/fork-instrument/tests/fixtures/gc_recipe_host.mjs";
import createTableJournal from "../crates/fork-instrument/tests/fixtures/table_record_host.cjs";

const bytes = readFileSync(process.argv[2]);
const module = new WebAssembly.Module(bytes);
assert.deepEqual(
  describeWasmForkArtifactContractFailures(Uint8Array.from(bytes).buffer),
  [],
);
const directory = mkdtempSync(join(tmpdir(), "fork-memory-artifact-"));
try {
  const source = join(directory, "transit.wat");
  const output = join(directory, "transit.wasm");
  writeFileSync(source, '(module (table (export "transit") 128 anyref))');
  execFileSync("wasm-as", ["--all-features", source, "-o", output]);
  const transit = new WebAssembly.Instance(new WebAssembly.Module(
    readFileSync(output),
  )).exports.transit;
  const tables = createTableJournal(false, false);
  const store = createGcStore(module, transit, false, {
    memory: () => new WebAssembly.Memory({
      initial: 256,
      maximum: 65_536,
      shared: true,
    }),
    bind(getInstance, memory) {
      const imports = tables.bind(getInstance, memory);
      imports.kernel = { kernel_fork: () => 13 };
      return imports;
    },
  });
  const run = store.instantiate();
  const exports = run.instance.exports;
  (exports.wpk_fork_module_bootstrap as () => void)();
  // Arithmetic fixtures have no source exports. Their first local function
  // has original ordinal 1 after the kernel import, in both fixed catalogs.
  const invoke = exports.root ??
    (exports.__wpk_fork_function_catalog as WebAssembly.Table).get(1);
  assert.equal(typeof invoke, "function");
  assert.equal((invoke as () => number)(), 13);
  assert.equal((exports.wpk_fork_state as () => number)(), 0);
  run.assertReleased();
  console.log(JSON.stringify({ valid: true, normalResult: 13 }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
