import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveRootfsArtifact } from "../src/node-kernel-host";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";

const programBinary = resolveBinary("programs/gbm_surface_smoke.wasm");
// WHY: source-checkout provenance checks are artifact preparation. Keep the
// existing deadline on kernel boot, the guest operation and teardown by
// preparing the verified image alongside the program before the test starts.
const rootfsImage = readFileSync(resolveRootfsArtifact().selectedPath);

describe("libgbm surface before rendering", () => {
  it(
    "requires a produced frame before a front buffer can be locked",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        rootfsImage,
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
