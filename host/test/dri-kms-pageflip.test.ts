import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/kms-pageflip-smoke.wasm");

const EVENT_LINE = /event type=(\d+) length=(\d+) user_data=0x([0-9a-f]+) seq=(\d+) crtc=(\d+)/;

describe("dri kms page-flip → vblank event round-trip", () => {
  it.skipIf(!programBinary)(
    "PAGE_FLIP delivers DRM_EVENT_FLIP_COMPLETE via poll(POLLIN) + read",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["kms-pageflip-smoke"],
        timeout: 5_000,
      });

      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      const m = result.stdout.match(EVENT_LINE);
      expect(m, `no event line. stdout=${result.stdout}`).not.toBeNull();
      expect(parseInt(m![1], 10)).toBe(2); // DRM_EVENT_FLIP_COMPLETE
      expect(parseInt(m![2], 10)).toBe(32);
      expect(BigInt("0x" + m![3])).toBe(0xdeadbeefcafe1234n);
      expect(parseInt(m![4], 10)).toBeGreaterThanOrEqual(1);
      expect(parseInt(m![5], 10)).toBe(1);
    },
  );
});
