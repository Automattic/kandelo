import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const xzBinary = tryResolveBinary("programs/xz.wasm");

describe.skipIf(!xzBinary)("xz", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: xzBinary!,
      argv: ["xz", "--version"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("xz");
  });

  // xz refuses to write compressed data when stdout is a terminal. The
  // round-trip path is covered through tar -J, which uses pipe semantics.
});
