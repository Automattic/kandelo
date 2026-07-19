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
let forkImportPath: string;
let instrumentedForkImportPath: string;

function encodeU32(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function encodeString(value: string): number[] {
  const bytes = [...Buffer.from(value)];
  return [...encodeU32(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function executableWithForkImport(extraExports: string[] = []): Buffer {
  const exports = ["__abi_version", "_start", ...extraExports];
  const exportPayload = [
    ...encodeU32(exports.length),
    ...exports.flatMap((name) => [
      ...encodeString(name),
      0x00, // function export
      0x01, // defined function index; the fork import is function 0
    ]),
  ];

  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [
      0x02,
      0x60, 0x00, 0x00, // imported () -> () fork function
      0x60, 0x00, 0x01, 0x7f, // defined () -> i32 ABI marker
    ]),
    ...section(2, [
      0x01,
      ...encodeString("kernel"),
      ...encodeString("kernel_fork"),
      0x00, 0x00, // function import using type 0
    ]),
    ...section(3, [0x01, 0x01]), // one defined function using type 1
    ...section(7, exportPayload),
    ...section(10, [
      0x01,
      0x04, 0x00, 0x41, 0x12, 0x0b, // return ABI 18
    ]),
  ]);
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kandelo-wasm-artifact-validator-"));
  wasmPath = join(tempDir, "program.wasm");
  forkImportPath = join(tempDir, "fork-import.wasm");
  instrumentedForkImportPath = join(tempDir, "instrumented-fork-import.wasm");

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
  writeFileSync(forkImportPath, executableWithForkImport());
  writeFileSync(
    instrumentedForkImportPath,
    executableWithForkImport(["wpk_fork_state"]),
  );
});

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function run(expectedAbi: number, paths = [wasmPath], options: string[] = []) {
  return spawnSync(tsx, [
    validator,
    "--abi",
    String(expectedAbi),
    ...options,
    ...paths,
  ], {
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

  it("rejects an uninstrumented fork import under the default auto policy", () => {
    const result = run(18, [forkImportPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "imports kernel.kernel_fork without complete wasm-fork-instrument exports",
    );
  });

  it("accepts an uninstrumented fork import when the package disables instrumentation", () => {
    const result = run(18, [forkImportPath], [
      "--fork-instrumentation",
      "disabled",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "validated 1 program Wasm artifact(s) for Kandelo ABI 18",
    );
  });

  it("rejects instrumentation exports when the package disables instrumentation", () => {
    const result = run(18, [instrumentedForkImportPath], [
      "--fork-instrumentation",
      "disabled",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains wasm-fork-instrument exports");
  });
});
