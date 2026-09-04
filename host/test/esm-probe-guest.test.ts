/**
 * Probe: does spidermonkey-node support REAL native ESM (minified import + export,
 * multi-module graph) — via dynamic import() and via a .mjs main? Settles whether
 * "spidermonkey-node has no real ESM" is accurate. This is the durable regression
 * guard for the three platform patches it exercises: 0015 (bare-specifier
 * resolution), 0016 (import.meta population), and 0017 (`using` / Explicit
 * Resource Management support).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { runCentralizedProgram } from "./centralized-test-helper";

// Inlined fixture contents — kept tiny and minified to match the shape of a
// real bundled Bun/esbuild output (no whitespace between tokens). Written to
// a fresh mkdtempSync temp dir per test run so this test is self-contained:
// previously the fixtures lived only at /tmp/cc-inspect/esm_probe, which is
// uncommitted and does not survive a fresh checkout, so every case silently
// skipped instead of running.
const FIXTURES: Record<string, string> = {
  "a.mjs": 'export const x=42;export function f(){return "hi"}',
  "b.mjs": 'import{x,f}from"/app/a.mjs";export const y=x+1;export function g(){return f()+"!"}',
  "main.cjs":
    '(async()=>{try{const m=await import("/app/b.mjs");console.log("ESMOK",m.y,m.g());}catch(e){console.log("ESMERR",(e&&e.message)||e);}})();',
  "mainmod.mjs": 'import{x}from"/app/a.mjs";console.log("MJSMAIN",x);',
  "a2.mjs": 'import{readFileSync}from"fs";export const ok=typeof readFileSync==="function";',
  "main2.cjs":
    '(async()=>{try{const m=await import("/app/a2.mjs");console.log("BARE",m.ok);}catch(e){console.log("BAREERR",(e&&e.message)||e);}})();',
  "meta.mjs": "export const info=[import.meta.url,import.meta.dirname,typeof import.meta.require];",
  "mainmeta.cjs":
    '(async()=>{try{const m=await import("/app/meta.mjs");console.log("META",m.info.join("|"));}catch(e){console.log("METAERR",(e&&e.message)||e);}})();',
  "using.mjs":
    "export function run(){class R{[Symbol.dispose](){globalThis.__d=(globalThis.__d||0)+1;}}{using r=new R();}return globalThis.__d;}",
  "mainusing.cjs":
    '(async()=>{try{const m=await import("/app/using.mjs");console.log("USING",m.run());}catch(e){console.log("USINGERR",(e&&e.message)||e);}})();',
  "dep.mjs": "export const v=41;",
  "node_modules/epkg/package.json": '{"type":"module","main":"index.js"}',
  "node_modules/epkg/index.js": 'import{v}from"/app/dep.mjs";export const w=v+1;export default "epkgdefault";',
  // The bare dynamic import() lives in a genuine native ES module
  // (dynhost.mjs), not directly in the CJS main: only a referrer compiled by
  // the native module loader (CompileModule) carries the script-path private
  // data __kandeloResolveBare needs to walk node_modules from the right
  // directory. A classic/CJS script executed via the shell's
  // evalScriptAsFunction helper never registers that private data (only the
  // shell's own top-level RunFile path does), so a bare specifier dynamically
  // imported directly from CJS always resolves with a null referrer. This
  // mirrors the real Claude Code shape: a lazily-loaded ESM chunk performing
  // `import()` of a bare specifier from within already-native ESM code.
  "dynhost.mjs":
    '(async()=>{try{const m=await import("epkg");console.log("DYN",m.w,m.default);}catch(e){console.log("DYNERR",(e&&e.message)||e);}})();',
  "maindyn.cjs":
    '(async()=>{try{await import("/app/dynhost.mjs");}catch(e){console.log("DYNERR",(e&&e.message)||e);}})();',
  // /app is a type:module package so the bare `.js` fixtures below are ES
  // modules (require() must detect this and route through the native loader
  // instead of CJS-wrapping them).
  "package.json": '{"type":"module"}',
  // require() of an ESM .js: returns the module namespace (named + default).
  "e.js": 'export const y=43;export default "edefault";',
  "maincjs.cjs":
    '(()=>{try{const m=require("/app/e.js");console.log("REQ",m.y,m.default);}catch(e){console.log("REQERR",(e&&e.message)||e);}})();',
  // require() of an ESM with top-level await: must throw ERR_REQUIRE_ASYNC_MODULE.
  "tla.js": 'export const z=await Promise.resolve(7);',
  "maintla.cjs":
    '(()=>{try{require("/app/tla.js");console.log("TLA no throw");}catch(e){console.log("TLACODE",e&&e.code,(e&&e.message)||e);}})();',
  // require() and import() of the same path must share ONE native-registry
  // instance (a===b and a shared, single-evaluated counter).
  "counter.js": 'let n=0;export function inc(){return ++n;}',
  "maindedup.cjs":
    '(async()=>{try{const a=require("/app/counter.js");const b=await import("/app/counter.js");console.log("DEDUP",a.inc(),b.inc(),a===b);}catch(e){console.log("DEDUPERR",(e&&e.message)||e);}})();',
  // Reverse order: import() first, THEN require() the same path. This is the
  // dominant real ordering (import() is the common route, require(esm) rare),
  // so lock the symmetry — both directions must hit the one native-registry
  // instance (shared counter, a===b), not just require-then-import.
  "counter2.js": 'let n=0;export function inc(){return ++n;}',
  "maindedup2.cjs":
    '(async()=>{try{const b=await import("/app/counter2.js");const a=require("/app/counter2.js");console.log("DEDUPREV",b.inc(),a.inc(),a===b);}catch(e){console.log("DEDUPREVERR",(e&&e.message)||e);}})();',
};

function stageFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "esm-probe-"));
  for (const [name, content] of Object.entries(FIXTURES)) {
    const dest = join(dir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
  }
  return dir;
}

const DIR = stageFixtures();

function image(): Uint8Array | Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  ensureDirRecursive(fs, "/app");
  for (const f of Object.keys(FIXTURES)) {
    const sub = dirname(f);
    if (sub !== ".") ensureDirRecursive(fs, `/app/${sub}`);
    writeVfsBinary(fs, `/app/${f}`, new Uint8Array(readFileSync(join(DIR, f))), 0o644);
  }
  return fs.saveImage();
}

describe("spidermonkey-node ESM probe", () => {
  const nodeWasm =
    tryResolveBinary("programs/spidermonkey-node.wasm") ??
    (() => {
      const pkg = join(__dirname, "../../packages/registry/spidermonkey/bin/node.wasm");
      return existsSync(pkg) ? pkg : null;
    })();
  const ready = nodeWasm != null;

  async function runOne(mainPath: string) {
    const img = await image();
    return runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", mainPath],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
  }

  it.runIf(ready)("dynamic import() of a minified ESM graph", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/main.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("DYN STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    // Path-specifier native ESM must keep working (regression guard).
    expect(r.stdout).toContain("ESMOK 43 hi!");
  }, 90_000);

  it.runIf(ready)("native ESM resolves a bare Node builtin specifier", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/main2.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("BARE STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("BARE true");
  }, 90_000);

  it.runIf(ready)("native ESM import.meta is populated (url/dirname/require)", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/mainmeta.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("META STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toMatch(/META file:\/\/\/app\/meta\.mjs\|\/app\|function/);
  }, 90_000);

  it.runIf(ready)(".mjs main with minified import", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/mainmod.mjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("MJSMAIN STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
  }, 90_000);

  it.runIf(ready)("engine parses and runs `using` (Explicit Resource Management)", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/mainusing.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("USING STDOUT:", JSON.stringify(r.stdout.trim()), "STDERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("USING 1");
  }, 90_000);

  it.runIf(ready)("dynamic import() of a bare ESM package loads as a module", async () => {
    const img = await image();
    const r = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "/app/maindyn.cjs"],
      rootfsImage: img,
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log("DYN OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("DYN 42 epkgdefault");
    expect(r.stdout).not.toContain("DYNERR");
  }, 90_000);

  it.runIf(ready)("require() of an ESM .js returns its namespace", async () => {
    const r = await runOne("/app/maincjs.cjs");
    // eslint-disable-next-line no-console
    console.log("REQ OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("REQ 43 edefault");
  }, 90_000);

  it.runIf(ready)("require() of an ESM module with top-level await throws ERR_REQUIRE_ASYNC_MODULE", async () => {
    const r = await runOne("/app/maintla.cjs");
    // eslint-disable-next-line no-console
    console.log("TLA OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("TLACODE ERR_REQUIRE_ASYNC_MODULE");
  }, 90_000);

  it.runIf(ready)("require() and import() of the same path share one instance", async () => {
    const r = await runOne("/app/maindedup.cjs");
    // eslint-disable-next-line no-console
    console.log("DEDUP OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("DEDUP 1 2 true");
  }, 90_000);

  it.runIf(ready)("import() then require() of the same path share one instance", async () => {
    const r = await runOne("/app/maindedup2.cjs");
    // eslint-disable-next-line no-console
    console.log("DEDUPREV OUT:", JSON.stringify(r.stdout.trim()), "ERR:", r.stderr.trim().split("\n").slice(-6).join(" | "));
    expect(r.stdout).toContain("DEDUPREV 1 2 true");
  }, 90_000);
});
