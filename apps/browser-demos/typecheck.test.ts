import assert from "node:assert/strict";
import test from "node:test";
import { auditTypecheckCoverage, browserAuthoredSourceFiles, browserNodeCapabilityFailures } from "./scripts/typecheck.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";


const complete = () => ({ inventoryRoots: ["/app/pages/main.ts", "/app/lib/contract.test.ts"],
  browserRoots: ["/app/pages/main.ts"], nodeTestRoots: ["/app/lib/contract.test.ts", "/app/tool.test.ts"],
  nodeUnitTests: ["/app/lib/contract.test.ts", "/app/tool.test.ts"] });

test("the compiler contexts cover the source inventory and the complete Node unit runner", () => {
  assert.doesNotThrow(() => auditTypecheckCoverage(complete()));
});
test("an excluded production source cannot produce a green typecheck", () => {
  assert.throws(() => auditTypecheckCoverage({ ...complete(), browserRoots: [] }), /unchecked browser source:.*main.ts/);
});
test("a Node unit test outside the browser source roots cannot disappear", () => {
  assert.throws(() => auditTypecheckCoverage({ ...complete(), nodeTestRoots: ["/app/lib/contract.test.ts"] }), /unchecked Node test:.*tool.test.ts/);
});
test("Node tests cannot masquerade as checked browser roots", () => {
  assert.throws(() => auditTypecheckCoverage({ ...complete(), browserRoots: complete().inventoryRoots }), /Node test assigned to browser context/);
});


test("Node declarations do not grant Node runtime capabilities to browser-authored roots", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-capability-"));
  const require = createRequire(import.meta.url);
  try {
    const bad = join(root, "browser-bad.ts"), good = join(root, "browser-good.ts"), shared = join(root, "shared-host.ts");
    writeFileSync(bad, 'import { readFileSync } from "node:fs"; export const data = [Buffer.from("x"), globalThis.process.pid, globalThis["process"].pid, setImmediate(() => {}), setTimeout(() => {}, 1).unref()];');
    writeFileSync(good, 'export const value = () => { const process = {pid: 1}; const Buffer = {from: (value: string) => value}; return [process.pid, Buffer.from("x")]; }; export const timer = setTimeout(() => {}, 1);');
    writeFileSync(shared, 'export { readFileSync } from "node:fs"; export const runtime = process.version;');
    const program = ts.createProgram([bad, good, shared], { noEmit: true, strict: true,
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ["node"], typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], skipLibCheck: true });
    assert.deepEqual(ts.getPreEmitDiagnostics(program), [], "the Node-enabled compiler alone admits these sources");
    assert.deepEqual(browserNodeCapabilityFailures(program, [good]), []);
    const failures = browserNodeCapabilityFailures(program, [bad, good]);
    for (const value of ["module node:fs", "value Buffer", "value process", "value setImmediate", "value unref"])
      assert.ok(failures.some(message => message.includes(value)), value);
    assert.ok(failures.every(message => message.includes("browser-bad.ts")), "local names and shared host branches keep their own capabilities");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("browser capability checks include imported app modules without policing shared host Node branches", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-browser-transitive-"));
  const require = createRequire(import.meta.url);
  try {
    const app = join(root, "app");
    mkdirSync(app);
    const entry = join(app, "entry.ts"), imported = join(app, "dependency.ts"), shared = join(root, "shared-host.ts");
    writeFileSync(entry, 'import "./dependency.js"; import "../shared-host.js";');
    writeFileSync(imported, 'export const forbidden = process.version;');
    writeFileSync(shared, 'export const nodeBranch = process.version;');
    const program = ts.createProgram([entry], { noEmit: true, strict: true,
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ["node"], typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], skipLibCheck: true });
    assert.deepEqual(ts.getPreEmitDiagnostics(program), []);
    const sources = browserAuthoredSourceFiles(program, app);
    assert.deepEqual(new Set(sources), new Set([entry, imported]));
    const failures = browserNodeCapabilityFailures(program, sources);
    assert.ok(failures.some(message => /dependency.ts.*Node-only value process/.test(message)));
    assert.ok(failures.every(message => message.includes("dependency.ts")), "shared host branches are outside the app capability domain");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
