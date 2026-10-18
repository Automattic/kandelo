/**
 * PR19 gate: the wasm32 utf8proc port (packages/registry/utf8proc)
 * normalizes, case-maps, and segments against the kernel.
 *
 * Runs `utf8proc_smoke.wasm` (programs/utf8proc_smoke.c) under the
 * centralized kernel: NFC composition, tolower, and grapheme-break
 * checks — the calls fcft and foot make
 * (docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md §4).
 *
 * The binary is built by scripts/build-programs.sh (which resolves
 * utf8proc and links its archive). Absent the binary the test skips,
 * matching the other program smoke tests.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const utf8procSmokeBinary = tryResolveBinary("programs/utf8proc_smoke.wasm");
const hasBinary = !!utf8procSmokeBinary;

describe("utf8proc — normalize + case map + grapheme break on the kernel", () => {
  it.skipIf(!hasBinary)(
    "NFC-composes, lowercases, and segments graphemes",
    async () => {
      const result = await runCentralizedProgram({
        programPath: utf8procSmokeBinary!,
        argv: ["utf8proc_smoke"],
        timeout: 20_000,
      });

      expect(
        result.exitCode,
        `utf8proc_smoke exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      expect(result.stdout).toContain("[NFC] len=2");
      expect(result.stdout).toContain("[LOWER] 0x00e9");
      expect(result.stdout).toContain("[GRAPHEME] ok");
      expect(result.stdout).toContain("UTF8PROC_SMOKE_OK");
    },
    25_000,
  );
});
