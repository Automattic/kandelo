import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const gzipBinary = tryResolveBinary("programs/gzip.wasm");

describe.skipIf(!gzipBinary)("gzip", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: gzipBinary!,
      argv: ["gzip", "--version"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gzip");
  });

  it("compresses and decompresses via stdin/stdout", async () => {
    const compressed = await runCentralizedProgram({
      programPath: gzipBinary!,
      argv: ["gzip", "-c", "-f"],
      stdin: "hello compression world\n",
      timeout: 10_000,
    });
    expect(compressed.exitCode).toBe(0);
    expect(compressed.stdoutBytes.length).toBeGreaterThan(0);
    expect(compressed.stdoutBytes[0]).toBe(0x1f);
    expect(compressed.stdoutBytes[1]).toBe(0x8b);

    const decompressed = await runCentralizedProgram({
      programPath: gzipBinary!,
      argv: ["gzip", "-d", "-c"],
      stdinBytes: compressed.stdoutBytes,
      timeout: 10_000,
    });
    expect(decompressed.exitCode).toBe(0);
    expect(decompressed.stdout).toBe("hello compression world\n");
  });
});
