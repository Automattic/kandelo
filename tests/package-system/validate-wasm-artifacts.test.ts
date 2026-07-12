import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const validator = join(repoRoot, "scripts", "validate-wasm-artifacts.ts");
const tsx = join(repoRoot, "host", "node_modules", ".bin", "tsx");
let tempDir: string;
let wasmPath: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kandelo-wasm-artifact-validator-"));
  wasmPath = join(tempDir, "program.wasm");

  // Minimal module exporting one () -> i32 function as both the ABI marker
  // and _start. The function returns ABI 18.
  writeFileSync(wasmPath, Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x1a, 0x02,
    0x0d, ...Buffer.from("__abi_version"), 0x00, 0x00,
    0x06, ...Buffer.from("_start"), 0x00, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x12, 0x0b,
  ]));
});

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function run(expectedAbi: number, paths = [wasmPath]) {
  return spawnSync(tsx, [validator, "--abi", String(expectedAbi), ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("validate-wasm-artifacts", () => {
  it("accepts an executable with the expected constant ABI marker", () => {
    const result = run(18);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("validated 1 program Wasm artifact(s) for Kandelo ABI 18");
  });

  it("rejects a stale ABI marker", () => {
    const result = run(17);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ABI 18, expected 17");
  });

  it("rejects a missing artifact", () => {
    const missing = join(tempDir, "missing.wasm");
    const result = run(18, [missing]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing file: ${missing}`);
  });
});
