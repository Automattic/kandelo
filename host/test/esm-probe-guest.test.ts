/**
 * Probe: does spidermonkey-node support REAL native ESM (minified import + export,
 * multi-module graph) — via dynamic import() and via a .mjs main? Settles whether
 * "spidermonkey-node has no real ESM" is accurate. This is the durable regression
 * guard for the three platform patches it exercises: 0015 (bare-specifier
 * resolution), 0016 (import.meta population), and 0017 (`using` / Explicit
 * Resource Management support).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
};

function stageFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "esm-probe-"));
  for (const [name, content] of Object.entries(FIXTURES)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

const DIR = stageFixtures();

function image(): Uint8Array | Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  ensureDirRecursive(fs, "/app");
  for (const f of Object.keys(FIXTURES)) {
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
});
