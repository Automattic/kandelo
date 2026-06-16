/**
 * Phase C2 end-to-end gate for the combined SDL2 demo.  Runs
 * `programs/sdl2_demo.wasm` (KMSDRM video + ALSA audio + evdev input)
 * inside the centralised kernel under NodeKernelHost; asserts both
 * the 5 s timeout path and the ESC-quits-early path.
 *
 * The ESC variant uses `NodeKernelHost.injectInputEvent` to push a
 * KEY_ESC press + SYN_REPORT roughly 1.5 s into the run — the same
 * shape `BrowserInputSource` will emit at Phase C3.  Asserts the demo
 * exits with code 0 noticeably before the 5 s timeout and labels its
 * exit as "esc", proving the evdev→SDL_KEYDOWN→main-loop pump cycle
 * actually closes the loop.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const programBinary = tryResolveBinary("programs/sdl2_demo.wasm");

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_ESC = 1;

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

describe("SDL2 demo — video + audio + input combined", () => {
  it.skipIf(!programBinary)(
    "drives the SDL2 main loop end-to-end without crashing (5 s timeout exit)",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["sdl2_demo"],
        timeout: 15_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("sdl2_demo: SDL_Init OK");
      expect(result.stdout).toMatch(/sdl2_demo: OK frames=\d+ elapsed=\d+ ms exit=timeout/);
      expect(result.stderr).not.toContain("FAIL:");
      // `frames` is main-loop tick count, not rasterised frame count
      // (GLES2 commands are encoded through the cmdbuf but the kernel-
      // side canvas readback isn't asserted here). >0 proves the loop
      // ran at least once.
      const m = result.stdout.match(/frames=(\d+)/);
      expect(m, `frames= not found in stdout: ${result.stdout}`).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThan(0);
    },
    20_000,
  );

  it.skipIf(!programBinary)(
    "exits early on ESC keydown injected via evdev",
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
        host.setInputCanvasDims(320, 240);

        const exitPromise = host.spawn(programBytes, ["sdl2_demo"]);

        // Wait until SDL2 has finished init — that's the earliest
        // point an evdev event will be picked up by SDL_PumpEvents.
        await waitFor(stdout, "sdl2_demo: SDL_Init OK", 10_000);

        // Give the main loop a few iterations so the audio device is
        // open and the first frame has flipped, then inject ESC.
        await new Promise((r) => setTimeout(r, 250));
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
        expect(stdout.value).toMatch(/sdl2_demo: OK frames=\d+ elapsed=\d+ ms exit=esc/);
        const m = stdout.value.match(/elapsed=(\d+) ms/);
        expect(m, `elapsed= not found in stdout: ${stdout.value}`).not.toBeNull();
        // Should have quit well under the 5 000 ms timeout — give a
        // 3 500 ms upper bound to swallow Node.js/runner jitter.
        expect(Number(m![1])).toBeLessThan(3_500);
      } finally {
        await host.destroy();
      }
    },
    20_000,
  );
});
