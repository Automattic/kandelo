import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const zstdBinary = tryResolveBinary("programs/zstd.wasm");

describe.skipIf(!zstdBinary)("zstd", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: zstdBinary!,
      argv: ["zstd", "--version"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("Zstandard");
  });

  it("compresses and decompresses via stdin/stdout", async () => {
    const compressed = await runCentralizedProgram({
      programPath: zstdBinary!,
      argv: ["zstd", "-c"],
      stdin: "hello zstd world\n",
      timeout: 10_000,
    });
    expect(compressed.exitCode).toBe(0);
    expect(compressed.stdoutBytes.length).toBeGreaterThan(0);
    expect(compressed.stdoutBytes[0]).toBe(0x28);
    expect(compressed.stdoutBytes[1]).toBe(0xb5);

    const decompressed = await runCentralizedProgram({
      programPath: zstdBinary!,
      argv: ["zstd", "-d", "-c"],
      stdinBytes: compressed.stdoutBytes,
      timeout: 10_000,
    });
    expect(decompressed.exitCode).toBe(0);
    expect(decompressed.stdout).toBe("hello zstd world\n");
  });
});
