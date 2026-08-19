/**
 * PR5c end-to-end gate for the REAL libinput 1.25.0 path backend. Spawns
 * `libinput_smoke` inside the centralized kernel, then drives
 * `kernel_input_event` from the host — the same shape a real
 * `BrowserInputSource` uses.
 *
 * This exercises the full PR5a+PR5b+PR5c chain through real libinput:
 * libinput_path_add_device("/dev/input/event0") runs stat() → st_rdev
 * recovery → udev_device_new_from_devnum → input_id classification (libudev
 * shim) → evdev_device_new → libevdev capability probe → device accepted,
 * and libinput_dispatch()'s epoll loop reads a host-injected EV_KEY off the
 * kernel evdev ring and decodes it into a LIBINPUT_EVENT_KEYBOARD_KEY.
 *
 * The fixture gates the key phase on a stdin byte so the host injects only
 * after the device is open (push_event fans out at injection time — an OFD
 * must already exist).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const fixtureBinary = tryResolveBinary("programs/libinput_smoke.wasm");

const CANVAS_W = 1024;
const CANVAS_H = 768;

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_A = 30;

// libinput.h enum values (stable public ABI).
const LIBINPUT_EVENT_KEYBOARD_KEY = 300;
const LIBINPUT_KEY_STATE_PRESSED = 1;

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

describe("libinput — path backend accepts a device and decodes a key", () => {
  it.skipIf(!fixtureBinary)(
    "add_device(event0) → DEVICE_ADDED, then a host-injected EV_KEY → KEYBOARD_KEY",
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
        const exitPromise = host.spawn(programBytes, ["libinput_smoke"], {
          onStarted: (p) => {
            pid = p;
          },
        });

        // The device is accepted (add_device returned non-NULL) and the
        // DEVICE_ADDED event drained before the fixture prints READY:key.
        await waitFor(stdout, "READY:key\n", 15_000);

        // Inject a KEY_A press on event0; SYN_REPORT flushes it through
        // libevdev into libinput.
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
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

        // The path backend recovered the kernel-supplied device name.
        expect(stdout.value).toContain("dev_name=wpk virtual keyboard");

        // add_device queued exactly one DEVICE_ADDED before READY:key.
        const added = stdout.value.match(/added_count=(\d+)/);
        expect(added, `missing added_count in:\n${stdout.value}`).not.toBeNull();
        expect(parseInt(added![1], 10)).toBeGreaterThanOrEqual(1);

        // The injected key surfaced as a KEYBOARD_KEY (type 300) for KEY_A
        // (30) in the pressed state — proving libinput's epoll loop read the
        // evdev ring and libevdev decoded it.
        const kev = stdout.value.match(
          /key_ev\d+ type=(\d+) key=(\d+) state=(\d+)/,
        );
        expect(kev, `missing key_ev line in:\n${stdout.value}`).not.toBeNull();
        expect(parseInt(kev![1], 10)).toBe(LIBINPUT_EVENT_KEYBOARD_KEY);
        expect(parseInt(kev![2], 10)).toBe(KEY_A);
        expect(parseInt(kev![3], 10)).toBe(LIBINPUT_KEY_STATE_PRESSED);

        expect(stdout.value).toContain("LIBINPUT_SMOKE_OK");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
