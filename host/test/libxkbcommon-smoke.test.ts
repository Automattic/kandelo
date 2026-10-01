/**
 * PR4 gate: the wasm32 libxkbcommon port (packages/registry/libxkbcommon)
 * compiles a keymap and translates keyboard input against the kernel.
 *
 * Runs `xkb_smoke.wasm` (programs/xkb_smoke.c) under the centralized
 * kernel. The program compiles a self-contained TEXT_V1 keymap with
 * xkb_keymap_new_from_string, then drives an xkb_state to turn keycodes +
 * modifiers into keysyms and UTF-8 — the exact path a Wayland client uses
 * on the keymap it receives from the compositor over the wl_keyboard fd
 * (docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5).
 *
 * The binary is built by scripts/build-programs.sh (which resolves
 * libxkbcommon and links its archive). Absent the binary — e.g. a bare
 * checkout where build-programs.sh hasn't run in the dev shell — the test
 * skips, matching the other program smoke tests.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const xkbSmokeBinary = tryResolveBinary("programs/xkb_smoke.wasm");
const hasBinary = !!xkbSmokeBinary;

describe("libxkbcommon — keymap compile + state translation on the kernel", () => {
  it.skipIf(!hasBinary)(
    "compiles a TEXT_V1 keymap and maps keycodes+modifiers to keysyms/UTF-8",
    async () => {
      const result = await runCentralizedProgram({
        programPath: xkbSmokeBinary!,
        argv: ["xkb_smoke"],
        timeout: 20_000,
      });

      expect(
        result.exitCode,
        `xkb_smoke exited non-zero. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);

      // The xkbcomp scanner + bison parser + AST builder compiled the keymap.
      expect(result.stdout).toContain("COMPILE ok");
      // Base level and Shift level select the right keysym + UTF-8.
      expect(result.stdout).toContain("BASE ok sym=0x61 utf8=a");
      expect(result.stdout).toContain("SHIFT ok sym=0x41 utf8=A");
      // Keysym name/UTF-8 round-trip on a non-ASCII symbol.
      expect(result.stdout).toContain("KEYSYM ok EuroSign=0x20ac utf8=€");
      expect(result.stdout).toContain("XKB_SMOKE_OK");
    },
    25_000,
  );
});
