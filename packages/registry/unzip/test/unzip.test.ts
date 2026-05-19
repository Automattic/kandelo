import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const unzipBinary = tryResolveBinary("programs/unzip.wasm");

describe.skipIf(!unzipBinary)("unzip", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: unzipBinary!,
      argv: ["unzip", "--version"],
      timeout: 10_000,
    });
    expect(result.stdout + result.stderr).toContain("UnZip");
  });
});
