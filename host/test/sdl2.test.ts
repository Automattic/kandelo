/**
 * End-to-end gate for the SDL2 playground binary at its Phase 4 shape
 * (viewport-split with a live editor on the left pane, VFS-loaded user
 * shader on the right pane, 250 ms debounced auto-recompile on every
 * keystroke, Ctrl+S writes /home/shaders/image/current.frag, no
 * self-timeout). Runs `programs/sdl2.wasm` (KMSDRM video + ALSA audio
 * + evdev input) inside the centralised kernel under NodeKernelHost;
 * asserts:
 *   - the ESC-quits path still works,
 *   - the shader-source resolution chain still falls through to the
 *     built-in PLASMA_SRC fallback under NodeKernelHost (no VFS
 *     staging),
 *   - the editor module loads the source on init and emits the
 *     `sdl2: editor loaded N chars` diagnostic,
 *   - the font atlas bake completes (`sdl2: text-atlas baked=...`),
 *   - injecting a typing keystroke triggers the debounced
 *     auto-recompile path (`sdl2: editor recompile ...`),
 *   - F5 keydown still surfaces the "user file not readable" path.
 * Visual gates for the plasma drift and the editor text rendering
 * live in the Playwright spec — Node has no real GL context, so
 * `host_gl_query` returns -1 and the renderer's WARN-on-status-zero
 * stash fires (non-fatal) for every program.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/sdl2.wasm");

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_ESC = 1;
const KEY_F5 = 63;
const KEY_A = 30;  /* linux/input-event-codes.h: typing 'a' */

async function waitFor(
  stdoutRef: { value: string },
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdoutRef.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)}.\n` +
      `stdout so far:\n${stdoutRef.value}`,
  );
}

describe("SDL2 playground — editor + VFS + auto-recompile (Phase 4)", () => {
  it.skipIf(!programBinary)(
    "loads the editor, bakes the atlas, debounces recompile on type, exits on ESC",
    async () => {
      const fileBuf = readFileSync(programBinary!);
      const programBytes = fileBuf.buffer.slice(
        fileBuf.byteOffset,
        fileBuf.byteOffset + fileBuf.byteLength,
      );

      const stdout = { value: "" };
      const stderr = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => {
          stdout.value += new TextDecoder().decode(data);
        },
        onStderr: (_pid, data) => {
          stderr.value += new TextDecoder().decode(data);
        },
      });

      try {
        await host.init();
        host.setInputCanvasDims(1280, 720);

        const exitPromise = host.spawn(programBytes, ["sdl2"]);

        await waitFor(stdout, "sdl2: SDL_Init OK", 10_000);

        /* Wait long enough for the editor and atlas init to log,
         * then inject:
         *   1. a typing key (KEY_A) so the debounce timer arms,
         *   2. F5 to exercise the "user file missing" branch,
         *   3. ESC to quit.
         * The 300 ms gap after KEY_A guarantees the
         * AUTO_RECOMPILE_DEBOUNCE_MS=250 deadline fires inside the
         * main loop before ESC tears the process down. */
        await waitFor(stdout, "sdl2: editor loaded", 5_000);
        await waitFor(stdout, "sdl2: text-atlas baked", 5_000);

        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_A, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 300));

        host.injectInputEvent(0, EV_KEY, KEY_F5, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_F5, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 100));

        host.injectInputEvent(0, EV_KEY, KEY_ESC, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_ESC, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);

        const exitCode = await Promise.race<number>([
          exitPromise,
          new Promise<number>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `ESC quit timed out.\nstdout=${stdout.value}\nstderr=${stderr.value}`,
                  ),
                ),
              8_000,
            ),
          ),
        ]);
        expect(
          exitCode,
          `stdout=${stdout.value} stderr=${stderr.value}`,
        ).toBe(0);
        expect(stdout.value).toContain("sdl2: SDL_Init OK");
        expect(stdout.value).toMatch(/sdl2: OK frames=\d+ elapsed=\d+ ms exit=esc/);
        expect(stderr.value).not.toContain("FAIL:");
        /* NodeKernelHost's rootfs has neither current.frag nor the
         * staged preset, so the source chain must fall through to the
         * built-in fallback. The Playwright path stages the preset
         * and exercises the VFS leg. */
        expect(stdout.value).toContain("sdl2: shader-source=builtin-plasma");
        /* Editor + atlas init signals. */
        expect(stdout.value).toMatch(/sdl2: editor loaded \d+ chars/);
        expect(stdout.value).toMatch(/sdl2: text-atlas baked=-?\d+/);
        /* Typing fires the debounced auto-recompile path. */
        expect(stdout.value).toMatch(/sdl2: editor recompile/);
        /* F5 against a missing user file must surface as a WARN, not
         * a crash: the binary stays alive long enough for ESC. */
        expect(stderr.value).toMatch(
          /WARN: F5: \/home\/shaders\/image\/current\.frag not readable/,
        );
        /* frames>0 proves the main loop ran at least one render pass. */
        const m = stdout.value.match(/frames=(\d+)/);
        expect(m, `frames= not found in stdout: ${stdout.value}`).not.toBeNull();
        expect(Number(m![1])).toBeGreaterThan(0);
      } finally {
        await host.destroy();
      }
    },
    20_000,
  );
});
