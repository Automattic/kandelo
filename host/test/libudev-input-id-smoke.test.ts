/**
 * PR5b gate for the libudev shim + input_id classification. Spawns
 * `libudev_input_id_smoke` in the centralized kernel. The fixture mirrors
 * libinput's path backend: it stat()s each virtual evdev node, hands only
 * the resulting st_rdev to udev_device_new_from_devnum('c', rdev), and
 * reads back the ID_INPUT* classification.
 *
 * This proves the whole PR5b chain end to end: the ABI-v17 rdev fix
 * (event0/event1 stat with distinct char 13:64 / 13:65), the shim's
 * devnum→devnode recovery, and the input_id classification (event0 →
 * keyboard, event1 → mouse). No event injection is needed — the
 * classification reads only the static EVIOCGBIT/EVIOCGPROP capabilities.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const fixtureBinary = tryResolveBinary("programs/libudev_input_id_smoke.wasm");

describe("libudev shim — input_id classification", () => {
  it.skipIf(!fixtureBinary)(
    "classifies event0 as keyboard and event1 as mouse via the real udev API",
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

        const exitCode = await Promise.race([
          host.spawn(programBytes, ["libudev_input_id_smoke"], {}),
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

        // Distinct rdevs prove the ABI-v17 fix: char 13:64 = 3392,
        // 13:65 = 3393.
        expect(stdout.value).toContain("/dev/input/event0 rdev=3392");
        expect(stdout.value).toContain("/dev/input/event1 rdev=3393");

        // Devnode recovered from the devnum alone.
        expect(stdout.value).toContain("event0 devnode=/dev/input/event0");
        expect(stdout.value).toContain("event1 devnode=/dev/input/event1");

        expect(stdout.value).toContain("LIBUDEV_INPUT_ID_SMOKE_OK");
        expect(stdout.value).not.toContain("FAIL");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
