import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/dri-modeset.wasm");

const SUMMARY = /modeset OK frames=(\d+) w=(\d+) h=(\d+)/;

describe("dri modeset — page-flip + vblank round-trip via libdrm wrappers", () => {
  it.skipIf(!programBinary)(
    "completes 5 PageFlip → drmHandleEvent cycles end-to-end",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["modeset", "5"],
        timeout: 5_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      const m = result.stdout.match(SUMMARY);
      expect(m, `no summary. stdout=${result.stdout}`).not.toBeNull();
      expect(parseInt(m![1], 10)).toBe(5);
      expect(parseInt(m![2], 10)).toBeGreaterThan(0);
      expect(parseInt(m![3], 10)).toBeGreaterThan(0);
      expect(result.stderr).not.toContain("FAIL:");
    },
  );
});
