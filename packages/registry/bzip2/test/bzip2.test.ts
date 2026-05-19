import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const bzip2Binary = tryResolveBinary("programs/bzip2.wasm");

describe.skipIf(!bzip2Binary)("bzip2", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: bzip2Binary!,
      argv: ["bzip2", "--version"],
      timeout: 10_000,
    });
    expect(result.stdout + result.stderr).toContain("bzip2");
  });

  // bzip2 refuses to write compressed data when stdout is a terminal. The
  // round-trip path is covered through tar -j, which uses pipe semantics.
});
