/**
 * B5 end-to-end gate for the evdev path. Spawns `input-evdev-smoke`
 * inside the centralized kernel, then drives `kernel_input_event`
 * from the host via `NodeKernelHost.injectInputEvent` — same shape a
 * real `BrowserInputSource` will use at Phase C.
 *
 * The fixture gates each phase on a stdin byte so the host injects
 * events AFTER the fixture has opened the matching device. `push_event`
 * fans out at injection time, so an OFD must already exist.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const fixtureBinary = tryResolveBinary("programs/input-evdev-smoke.wasm");

const CANVAS_W = 1024;
const CANVAS_H = 768;

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const SYN_REPORT = 0x00;
const SYN_DROPPED = 0x03;
const KEY_A = 30;
const REL_X = 0x00;
const RING_CAP = 1024;

const KICK = new Uint8Array([0x0a]);

async function waitFor(
  stdoutRef: { value: string },
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdoutRef.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)}.\n` +
      `stdout so far:\n${stdoutRef.value}`,
  );
}

describe("evdev — end-to-end key + pointer + ring overflow", () => {
  it.skipIf(!fixtureBinary)(
    "round-trips keyboard + pointer events and surfaces SYN_DROPPED on overflow",
    async () => {
      const fileBuf = readFileSync(fixtureBinary!);
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
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        let pid = 0;
        const exitPromise = host.spawn(programBytes, ["input-evdev-smoke"], {
          onStarted: (p) => {
            pid = p;
          },
        });

        // Phase 1 — keyboard.
        await waitFor(stdout, "READY:kbd\n", 10_000);
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.appendStdinData(pid, KICK);

        // Phase 2 — pointer.
        await waitFor(stdout, "READY:ptr\n", 10_000);
        host.injectInputEvent(1, EV_REL, REL_X, 5);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        host.appendStdinData(pid, KICK);

        // Phase 3 — overflow on event0. Push 1100 KEY_A toggles; the
        // ring caps at 1024, latches dropped, and the next read
        // prepends a synthesised SYN_DROPPED.
        await waitFor(stdout, "READY:overflow\n", 10_000);
        for (let i = 0; i < 1100; i++) {
          host.injectInputEvent(0, EV_KEY, KEY_A, i & 1);
        }
        host.appendStdinData(pid, KICK);

        const exitCode = await Promise.race([
          exitPromise,
          new Promise<number>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `fixture timed out\nstdout:\n${stdout.value}\nstderr:\n${stderr.value}`,
                  ),
                ),
              30_000,
            ),
          ),
        ]);
        expect(
          exitCode,
          `stdout=${stdout.value}\nstderr=${stderr.value}`,
        ).toBe(0);

        // EVIOCGNAME returns the kernel-supplied device names.
        expect(stdout.value).toContain("kbd_name=wpk virtual keyboard");

        // EVIOCGABS(ABS_X) on event1 reports canvas_w - 1.
        expect(stdout.value).toMatch(
          new RegExp(`ptr_abs_x_max=${CANVAS_W - 1}\\b`),
        );

        // Phase 1: KEY_A down + SYN_REPORT, in that order, with
        // monotonic-non-decreasing CLOCK_MONOTONIC timestamps.
        const kev0 = stdout.value.match(
          /kbd_ev0 type=(\d+) code=(\d+) value=(-?\d+) tv_sec=(-?\d+) tv_usec=(-?\d+)/,
        );
        const kev1 = stdout.value.match(
          /kbd_ev1 type=(\d+) code=(\d+) value=(-?\d+) tv_sec=(-?\d+) tv_usec=(-?\d+)/,
        );
        expect(kev0, `missing kbd_ev0 in:\n${stdout.value}`).not.toBeNull();
        expect(kev1, `missing kbd_ev1 in:\n${stdout.value}`).not.toBeNull();
        expect(parseInt(kev0![1], 10)).toBe(EV_KEY);
        expect(parseInt(kev0![2], 10)).toBe(KEY_A);
        expect(parseInt(kev0![3], 10)).toBe(1);
        expect(parseInt(kev1![1], 10)).toBe(EV_SYN);
        expect(parseInt(kev1![2], 10)).toBe(SYN_REPORT);
        const ts0 =
          BigInt(kev0![4]) * 1_000_000n + BigInt(parseInt(kev0![5], 10));
        const ts1 =
          BigInt(kev1![4]) * 1_000_000n + BigInt(parseInt(kev1![5], 10));
        expect(ts1 >= ts0).toBe(true);

        // Phase 2: REL_X=+5 + SYN_REPORT.
        const pev0 = stdout.value.match(
          /ptr_ev0 type=(\d+) code=(\d+) value=(-?\d+)/,
        );
        const pev1 = stdout.value.match(
          /ptr_ev1 type=(\d+) code=(\d+) value=(-?\d+)/,
        );
        expect(pev0, `missing ptr_ev0 in:\n${stdout.value}`).not.toBeNull();
        expect(pev1, `missing ptr_ev1 in:\n${stdout.value}`).not.toBeNull();
        expect(parseInt(pev0![1], 10)).toBe(EV_REL);
        expect(parseInt(pev0![2], 10)).toBe(REL_X);
        expect(parseInt(pev0![3], 10)).toBe(5);
        expect(parseInt(pev1![1], 10)).toBe(EV_SYN);
        expect(parseInt(pev1![2], 10)).toBe(SYN_REPORT);

        // Phase 3 overflow: SYN_DROPPED first, then the surviving 1024
        // ring records (the most recent of the 1100 pushed before the
        // ring saturated). Total = 1 synth + 1024 = 1025.
        const ov = stdout.value.match(
          /ov_count=(\d+) ov_syn_dropped_at=(-?\d+) ov_real=(\d+) ov_last_type=(\d+) ov_last_code=(\d+)/,
        );
        expect(ov, `missing ov_ line in:\n${stdout.value}`).not.toBeNull();
        expect(parseInt(ov![1], 10)).toBe(RING_CAP + 1);
        expect(parseInt(ov![2], 10)).toBe(0);
        expect(parseInt(ov![3], 10)).toBe(RING_CAP);
        // Last surviving record is an EV_KEY/KEY_A (the toggles we
        // pushed), not a stray SYN.
        expect(parseInt(ov![4], 10)).toBe(EV_KEY);
        expect(parseInt(ov![5], 10)).toBe(KEY_A);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
