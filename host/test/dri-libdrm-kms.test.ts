import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/libdrm-kms-smoke.wasm");

describe("dri libdrm KMS wrappers", () => {
  it.skipIf(!programBinary)(
    "GetResources/GetConnector/GetEncoder/GetCrtc/AddFB2/RmFB + SetMaster/DropMaster round-trip",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["libdrm-kms-smoke"],
        timeout: 5_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout.trim()).toBe("OK");
      expect(result.stderr).not.toContain("FAIL:");
    },
  );
});
