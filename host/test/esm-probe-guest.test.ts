/**
 * Probe: does spidermonkey-node support REAL native ESM (minified import + export,
 * multi-module graph) — via dynamic import() and via a .mjs main? Settles whether
 * "spidermonkey-node has no real ESM" is accurate. Throwaway.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { runCentralizedProgram } from "./centralized-test-helper";

const DIR = process.env.ESM_PROBE_DIR ?? "/tmp/cc-inspect/esm_probe";

function image(): Uint8Array | Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  ensureDirRecursive(fs, "/app");
  for (const f of ["a.mjs", "b.mjs", "main.cjs", "mainmod.mjs", "a2.mjs", "main2.cjs"]) {
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
  const ready = nodeWasm != null && existsSync(join(DIR, "b.mjs"));

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
});
