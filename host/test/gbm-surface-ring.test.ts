import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";

const programBinary = resolveBinary("programs/gbm_surface_smoke.wasm");

describe("libgbm surface before rendering", () => {
  it(
    "requires a produced frame before a front buffer can be locked",
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
