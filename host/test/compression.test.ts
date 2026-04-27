/**
 * Tests for compression utilities running on the wasm-posix-kernel.
 * Each tool is tested for basic compress/decompress or version output.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const gzipBinary = tryResolveBinary("programs/gzip.wasm");
const bzip2Binary = tryResolveBinary("programs/bzip2.wasm");
const xzBinary = tryResolveBinary("programs/xz.wasm");
const zstdBinary = tryResolveBinary("programs/zstd.wasm");
const zipBinary = tryResolveBinary("programs/zip.wasm");
const unzipBinary = tryResolveBinary("programs/unzip.wasm");

const hasGzip = !!gzipBinary;
const hasBzip2 = !!bzip2Binary;
const hasXz = !!xzBinary;
const hasZstd = !!zstdBinary;
const hasZip = !!zipBinary;
const hasUnzip = !!unzipBinary;

describe.skipIf(!hasGzip)("gzip", () => {
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
    // Compress
    const compressed = await runCentralizedProgram({
      programPath: gzipBinary!,
      argv: ["gzip", "-c", "-f"],
      stdin: "hello compression world\n",
      timeout: 10_000,
    });
    expect(compressed.exitCode).toBe(0);
    expect(compressed.stdoutBytes.length).toBeGreaterThan(0);
    // gzip magic number
    expect(compressed.stdoutBytes[0]).toBe(0x1f);
    expect(compressed.stdoutBytes[1]).toBe(0x8b);

    // Decompress
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

describe.skipIf(!hasBzip2)("bzip2", () => {
  it("reports version", async () => {
    // bzip2 --version writes to stderr and exits 0
    const result = await runCentralizedProgram({
      programPath: bzip2Binary!,
      argv: ["bzip2", "--version"],
      timeout: 10_000,
    });
    // bzip2 --version may exit 0 or write to stderr
    expect(result.stdout + result.stderr).toContain("bzip2");
  });

  // Note: bzip2 round-trip test skipped — bzip2 unconditionally refuses to
  // write compressed data when isatty(stdout)=1, and the kernel defaults
  // stdout to terminal mode. Works correctly via tar -j (pipe, isatty=0).
});

describe.skipIf(!hasXz)("xz", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: xzBinary!,
      argv: ["xz", "--version"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("xz");
  });

  // Note: xz round-trip test skipped — xz refuses to write compressed data
  // when isatty(stdout)=1, and the kernel defaults stdout to terminal mode.
  // Works correctly via tar -J (pipe, isatty=0).
});

describe.skipIf(!hasZstd)("zstd", () => {
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
    // zstd magic: 28 B5 2F FD
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

describe.skipIf(!hasZip)("zip", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: zipBinary!,
      argv: ["zip", "--version"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Zip");
  });
});

describe.skipIf(!hasUnzip)("unzip", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: unzipBinary!,
      argv: ["unzip", "--version"],
      timeout: 10_000,
    });
    // unzip --version may exit non-zero but prints version info
    expect(result.stdout + result.stderr).toContain("UnZip");
  });
});
