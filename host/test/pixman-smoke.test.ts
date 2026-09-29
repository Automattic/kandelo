/**
 * PR19 gate: the wasm32 pixman port (packages/registry/pixman)
 * rasterizes with its generic C paths against the kernel.
 *
 * Runs `pixman_smoke.wasm` (programs/pixman_smoke.c) under the
 * centralized kernel: an a8r8g8b8 fill and an OP_OVER composite from a
 * solid source — the operations fcft performs for every glyph
 * (docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md §4).
 *
 * The binary is built by scripts/build-programs.sh (which resolves
 * pixman and links its archive). Absent the binary the test skips,
 * matching the other program smoke tests.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const pixmanSmokeBinary = tryResolveBinary("programs/pixman_smoke.wasm");
const hasBinary = !!pixmanSmokeBinary;

describe("pixman — fill + composite on the kernel", () => {
  it.skipIf(!hasBinary)(
    "fills a8r8g8b8 and composites a solid OP_OVER",
    async () => {
      const result = await runCentralizedProgram({
        programPath: pixmanSmokeBinary!,
        argv: ["pixman_smoke"],
        timeout: 20_000,
      });

      expect(
        result.exitCode,
        `pixman_smoke exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      expect(result.stdout).toContain("[FILL] px=0xff0000ff");
      expect(result.stdout).toContain("[OVER] px=0xffff0000");
      expect(result.stdout).toContain("PIXMAN_SMOKE_OK");
    },
    25_000,
  );
});
