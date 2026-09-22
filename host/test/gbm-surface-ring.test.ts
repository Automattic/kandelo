import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/gbm_surface_smoke.wasm");

describe("libgbm 2-BO surface ring", () => {
  it.skipIf(!programBinary)(
    "lock/release/has_free_buffers transitions match mesa semantics",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["gbm_surface_smoke"],
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
