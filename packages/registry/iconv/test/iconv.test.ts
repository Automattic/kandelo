/**
 * iconv(1) must convert between codesets and report characters it cannot
 * convert. The replaced posix-utils-lite iconv copied its input unchanged
 * and exited 0 whatever -f and -t named.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const iconv = tryResolveBinary("programs/iconv.wasm");

function runIconv(args: string[], input: Uint8Array) {
  return runCentralizedProgram({
    programPath: iconv!,
    argv: ["iconv", ...args],
    env: ["PATH=/usr/bin:/bin"],
    stdinBytes: input,
    timeout: 30_000,
  });
}

// "café\n" in UTF-8: the é is the two bytes C3 A9.
const CAFE_UTF8 = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a]);

describe.skipIf(!iconv)("iconv", () => {
  it("converts UTF-8 to ISO-8859-1 and back", async () => {
    const latin1 = await runIconv(["-f", "UTF-8", "-t", "ISO-8859-1"], CAFE_UTF8);
    expect(latin1.stderr).toBe("");
    expect(latin1.exitCode).toBe(0);
    expect([...latin1.stdoutBytes]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);

    const utf8 = await runIconv(["-f", "ISO-8859-1", "-t", "UTF-8"], latin1.stdoutBytes);
    expect(utf8.exitCode).toBe(0);
    expect([...utf8.stdoutBytes]).toEqual([...CAFE_UTF8]);
  });

  it("converts to UTF-16BE", async () => {
    const result = await runIconv(["-f", "UTF-8", "-t", "UTF-16BE"], CAFE_UTF8);
    expect(result.exitCode).toBe(0);
    expect([...result.stdoutBytes]).toEqual([0, 0x63, 0, 0x61, 0, 0x66, 0, 0xe9, 0, 0x0a]);
  });

  it("fails on an unconvertible character unless -c is given", async () => {
    const strict = await runIconv(["-f", "UTF-8", "-t", "ASCII"], CAFE_UTF8);
    expect(strict.exitCode).not.toBe(0);
    expect(strict.stderr).toContain("cannot convert");

    const lenient = await runIconv(["-c", "-f", "UTF-8", "-t", "ASCII"], CAFE_UTF8);
    expect(new TextDecoder().decode(lenient.stdoutBytes)).toBe("caf\n");
  });

  it("rejects an unknown codeset", async () => {
    const result = await runIconv(["-f", "UTF-8", "-t", "NO-SUCH-CODESET"], CAFE_UTF8);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdoutBytes.byteLength).toBe(0);
  });

  it("lists the codesets it supports", async () => {
    const result = await runIconv(["-l"], new Uint8Array());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\bUTF-8\b/);
    expect(result.stdout).toMatch(/\bISO-8859-1\b/);
  });
});
