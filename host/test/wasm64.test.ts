/**
 * Tests for wasm64 (memory64) process support.
 * Verifies that the host runtime correctly handles wasm64 binaries
 * with 64-bit pointers and memory64.
 */
import { describe, test, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { detectPtrWidth } from "../src/constants";
import { resolveBinary } from "../src/binary-resolver";
import { readFileSync } from "node:fs";

function loadWasm(relPath: string): ArrayBuffer {
  const buf = readFileSync(resolveBinary(relPath));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("wasm64 process support", () => {
  test("detectPtrWidth identifies wasm64 binary", () => {
    const bytes = loadWasm("programs/wasm64/hello64.wasm");
    expect(detectPtrWidth(bytes)).toBe(8);
  });

  test("detectPtrWidth identifies wasm32 binary", () => {
    // Use a known wasm32 program binary
    const bytes = loadWasm("programs/fork-exec.wasm");
    expect(detectPtrWidth(bytes)).toBe(4);
  });

  test("hello64: LP64 type sizes", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/wasm64/hello64.wasm"),
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sizeof(long) = 8");
    expect(result.stdout).toContain("sizeof(void*) = 8");
    expect(result.stdout).toContain("sizeof(size_t) = 8");
    expect(result.stdout).toContain("sizeof(intptr_t) = 8");
  });
});
