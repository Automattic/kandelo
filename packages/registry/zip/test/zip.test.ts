import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const zipBinary = tryResolveBinary("programs/zip.wasm");

describe.skipIf(!zipBinary)("zip", () => {
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
