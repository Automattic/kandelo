/**
 * PR5b gate for the mtdev stub. Spawns `mtdev_smoke` in the centralized
 * kernel. The fixture proves both halves of the mtdev contract without
 * libinput present: libmtdev.a links (the five symbols libinput
 * references resolve), and the kernel's virtual pointer is not a
 * protocol-A multitouch device, so `evdev_need_mtdev()` is false and the
 * stub is never actually entered.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const fixtureBinary = tryResolveBinary("programs/mtdev_smoke.wasm");

describe("mtdev stub — links and is not needed for our devices", () => {
  it.skipIf(!fixtureBinary)(
    "resolves the mtdev symbols and confirms the pointer is not protocol-A",
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
          host.spawn(programBytes, ["mtdev_smoke"], {}),
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

        expect(stdout.value).toContain("mtdev_linked=1");
        // The virtual pointer advertises plain ABS_X/ABS_Y, none of the
        // ABS_MT_* multitouch axes → evdev_need_mtdev() is false.
        expect(stdout.value).toContain("evdev_need_mtdev=0");
        expect(stdout.value).toContain("MTDEV_SMOKE_OK");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
