/**
 * End-to-end gate for `programs/sdl2.wasm` (KMSDRM video + ALSA audio +
 * evdev input) run inside the centralised kernel under NodeKernelHost.
 * It drives the binary with injected input events and asserts on the
 * stdout breadcrumbs each subsystem emits — see the inline expectations
 * below for the exact behaviors covered (source-resolution fallback,
 * editor + atlas init, debounced recompile, F5 reload, synth + FFT
 * upload, mute, sound-shader render, wheel scroll, preset cycle).
 *
 * Node has no real GL context, so host_gl_query returns -1: shader
 * compiles take the headless "empty info log" branch and sound readback
 * is all-zero (audible=0). Visual/audible gates live in the Playwright
 * spec; the pure editor logic has its own native unit test in
 * host/test/sdl2-editor-unit.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/sdl2.wasm");

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const REL_WHEEL = 0x08; /* mouse-wheel notch on /dev/input/event1 */
const SYN_REPORT = 0x00;
const KEY_ESC = 1;
const KEY_F5 = 63;
const KEY_A = 30;  /* linux/input-event-codes.h: typing 'a' */
const KEY_LEFTCTRL = 29;
const KEY_M = 50;  /* Ctrl+M toggles audio mute */
const KEY_F2 = 60; /* F2 switches the editor to the sound shader */
const KEY_L = 38;  /* Ctrl+L cycles to the next shader preset */

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

describe("SDL2 playground — editor + audio + sound-shader end-to-end", () => {
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
         * After KEY_A, wait for the recompile breadcrumb itself rather
         * than sleeping a fixed 300 ms: on a slow CI runner the app's
         * init can outlast wall-clock sleeps, so every queued key would
         * drain in one SDL_PollEvent burst — and the F2 mode switch
         * below cancels a still-pending debounce (last_edit_ts = 0),
         * which is correct app behavior. Only injecting the next key
         * after the recompile logs keeps the debounce observable at any
         * loop speed. */
        await waitFor(stdout, "sdl2: editor loaded", 5_000);
        await waitFor(stdout, "sdl2: text-atlas baked", 5_000);

        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_A, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        /* AUTO_RECOMPILE_DEBOUNCE_MS=250 fires inside the main loop. */
        await waitFor(stdout, "sdl2: editor recompile", 10_000);

        host.injectInputEvent(0, EV_KEY, KEY_F5, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_F5, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 100));

        /* Ctrl+M toggles the audio mute. Hold LeftCtrl, tap M, release. */
        host.injectInputEvent(0, EV_KEY, KEY_LEFTCTRL, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_M, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_M, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_LEFTCTRL, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 100));

        /* Phase 6: F2 switches to the sound shader, which compiles +
         * renders + reads back the FBO. Under headless Node GL the
         * readback is all-zero, so it reports audible=0 and audio falls
         * back to the synth — but the mode switch and render path run. */
        host.injectInputEvent(0, EV_KEY, KEY_F2, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_F2, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 150));

        /* Mouse-wheel scroll on /dev/input/event1: SDL turns REL_WHEEL
         * into SDL_MOUSEWHEEL, and (pointer defaults to the editor pane at
         * x=0) main.c scrolls the editor and logs the notch count. */
        host.injectInputEvent(1, EV_REL, REL_WHEEL, -1);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 50));

        /* Ctrl+L exercises the preset-cycle path (readdir of
         * /usr/share/shaders/<mode>). The NodeKernelHost rootfs stages no
         * preset files, so this must surface the graceful "list empty"
         * branch rather than crashing or hanging. */
        host.injectInputEvent(0, EV_KEY, KEY_LEFTCTRL, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_L, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 10));
        host.injectInputEvent(0, EV_KEY, KEY_L, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_LEFTCTRL, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await new Promise((r) => setTimeout(r, 50));

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
        /* Phase 5: the chip synth initializes against the granted audio
         * spec, and the per-frame FFT spectrum upload (iAudio) runs even
         * under the headless Node GL stub. */
        expect(stdout.value).toMatch(/sdl2: audio synth rate=\d+ ch=\d+/);
        expect(stdout.value).toMatch(/sdl2: audio spectrum uploaded bins=128/);
        /* Ctrl+M toggled the mute. */
        expect(stdout.value).toContain("sdl2: audio muted");
        /* Phase 6: the sound-shader pipeline initialized, and F2 switched
         * to sound mode and ran a render+readback dispatch. The track is
         * rendered as multiple time-tiles (Phase 7); under the headless GL
         * stub every tile's readback is silent (audible=0). */
        expect(stdout.value).toMatch(/sdl2: sound-shader init fbo=\d+x\d+ tiles=\d+/);
        expect(stdout.value).toMatch(/sdl2: sound-source=builtin-sine/);
        expect(stdout.value).toContain("sdl2: edit-mode=sound");
        expect(stdout.value).toMatch(
          /sdl2: sound-shader render frames=\d+ tiles=\d+ audible=\d/,
        );
        /* Mouse-wheel scroll: REL_WHEEL on event1 reaches the editor. */
        expect(stdout.value).toMatch(/sdl2: editor scroll wheel=-?\d+/);
        /* Ctrl+L ran the preset-cycle path. With no staged presets in the
         * Node rootfs it reports the empty list; with presets it loads one. */
        expect(stdout.value).toMatch(/sdl2: preset (load=|list empty)/);
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
