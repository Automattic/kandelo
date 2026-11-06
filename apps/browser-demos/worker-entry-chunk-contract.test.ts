import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build as viteBuild, loadConfigFromFile, type PluginOption } from "vite";
import { assertTerminalWorkerEntries, type WorkerChunkEvidence } from "./vite/worker-entry-exports";

const appRoot = dirname(fileURLToPath(import.meta.url));
const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, join(appRoot, "vite.config.ts"), undefined, "silent");
assert.ok(loaded);
const config = loaded.config;

function workerPluginOptions(): PluginOption[] {
  const create = config.worker?.plugins;
  assert.ok(typeof create === "function");
  return create();
}
function chunk(fileName: string, overrides: Partial<WorkerChunkEvidence> = {}): WorkerChunkEvidence {
  return { type: "chunk", isEntry: false, facadeModuleId: null, fileName,
    imports: [], dynamicImports: [], importedBindings: {}, ...overrides };
}
function entry(fileName: string, facade = "/worker-entry.ts"): WorkerChunkEvidence {
  return chunk(fileName, { isEntry: true, facadeModuleId: facade });
}

test("each browser worker is emitted as one terminal chunk", () => {
  const output = config.worker?.rollupOptions?.output;
  assert.ok(output !== undefined && !Array.isArray(output));
  assert.equal(output.inlineDynamicImports, true);
});
test("stripped worker entries use their final emitted filename", () => {
  assert.throws(() => assertTerminalWorkerEntries(new Set(["/worker-entry.ts"]), {
    "worker-entry-a1b2.js": entry("worker-entry-a1b2.js"),
    "zip.js": chunk("zip.js", { imports: ["worker-entry-a1b2.js"], importedBindings: { "worker-entry-a1b2.js": ["r"] } }),
  }), /imports worker entry .* whose exports are stripped/u);
});
test("dynamic imports of stripped worker entries are rejected", () => {
  assert.throws(() => assertTerminalWorkerEntries(new Set(["/worker-entry.ts"]), {
    "worker-entry.js": entry("worker-entry.js"),
    "zip.js": chunk("zip.js", { dynamicImports: ["worker-entry.js"] }),
  }), /imports worker entry .* whose exports are stripped/u);
});
test("side-effect-only imports of stripped worker entries are rejected", () => {
  assert.throws(() => assertTerminalWorkerEntries(new Set(["/worker-entry.ts"]), {
    "worker-entry.js": entry("worker-entry.js"),
    "side-effect.js": chunk("side-effect.js", { imports: ["worker-entry.js"], importedBindings: { "worker-entry.js": [] } }),
  }), /imports worker entry .* whose exports are stripped/u);
});
test("static reverse edges without binding metadata fail closed", () => {
  assert.throws(() => assertTerminalWorkerEntries(new Set(["/worker-entry.ts"]), {
    "worker-entry.js": entry("worker-entry.js"),
    "unknown-bindings.js": chunk("unknown-bindings.js", { imports: ["worker-entry.js"], importedBindings: undefined }),
  }), /does not report imported bindings for stripped worker entry/u);
});
test("stripped entry identities must resolve uniquely", () => {
  assert.throws(() => assertTerminalWorkerEntries(new Set(["/worker-entry.ts"]), {
    "worker-entry-one.js": entry("worker-entry-one.js"),
    "worker-entry-two.js": entry("worker-entry-two.js"),
  }), /stripped worker entry .* resolves to multiple emitted chunks/u);
});
test("a recorded stripped facade must still have an emitted entry", () => {
  assert.throws(() => assertTerminalWorkerEntries(new Set(["/missing.ts"]), {}), /has no emitted entry chunk/u);
});
async function realWorkerBundle(reverseEdge = false) {
  // Drive the actual Vite adapter with real output objects. An external self
  // import deliberately creates a non-terminal graph for the negative control;
  // no native handle or bundler metadata is fabricated by the fixture.
  const root = mkdtempSync(join(tmpdir(), "kandelo-worker-graph-"));
  try {
    const source = join(root, "worker-entry.ts");
    writeFileSync(source, `${reverseEdge ? 'import("worker-entry.js");' : ""}export const fixture = true; globalThis.postMessage("worker-entry-control");`);
    return await viteBuild({ configFile: false, logLevel: "silent", plugins: workerPluginOptions(),
      build: { write: false, minify: false,
        lib: { entry: source, formats: ["es"], fileName: () => "worker-entry.js" },
        rollupOptions: { external: ["worker-entry.js"] },
      } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("terminal worker entries still have synthetic exports removed", async () => {
  const result = await realWorkerBundle();
  const outputs = Array.isArray(result) ? result : [result];
  assert.equal(outputs.length, 1);
  const output = outputs[0];
  assert.ok(output && "output" in output);
  const emitted = output.output.find(item => item.type === "chunk");
  assert.ok(emitted && emitted.type === "chunk");
  assert.match(emitted.code, /postMessage\("worker-entry-control"\)/u);
  assert.doesNotMatch(emitted.code, /\bexport\s/u);
});
test("the real Vite adapter refuses an emitted reverse edge", async () => {
  await assert.rejects(realWorkerBundle(true), /imports worker entry .* whose exports are stripped/u);
});
