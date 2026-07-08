/**
 * PR5a gate for the libevdev wasm32 port. Spawns `libevdev_smoke` inside
 * the centralized kernel and drives `kernel_input_event` from the host —
 * the same shape a real BrowserInputSource uses. The fixture builds a
 * libevdev from each of the two virtual evdev nodes (which runs the
 * EVIOCG* capability probing internally), then decodes host-injected
 * events through libevdev_next_event + libevdev's name lookups.
 *
 * Each phase gates on a stdin byte so the host injects only after the
 * fixture has opened the matching device (push_event fans out at
 * injection time — an OFD must already exist). Same harness as
 * host/test/input-evdev.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const fixtureBinary = tryResolveBinary("programs/libevdev_smoke.wasm");

const CANVAS_W = 1024;
const CANVAS_H = 768;

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const SYN_REPORT = 0x00;
const KEY_A = 30;
const REL_X = 0x00;

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

describe("libevdev — capability probe + event decode", () => {
  it.skipIf(!fixtureBinary)(
    "probes both virtual devices and decodes injected key + pointer events",
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
        const exitPromise = host.spawn(programBytes, ["libevdev_smoke"], {
          onStarted: (p) => {
            pid = p;
          },
        });

        // Phase 1 — keyboard (event0).
        await waitFor(stdout, "READY:kbd\n", 10_000);
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.appendStdinData(pid, KICK);

        // Phase 2 — pointer (event1).
        await waitFor(stdout, "READY:ptr\n", 10_000);
        host.injectInputEvent(1, EV_REL, REL_X, 5);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
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

        // libevdev_new_from_fd's EVIOCG* probe surfaces the kernel device
        // names and the advertised capabilities.
        expect(stdout.value).toContain("kbd_name=wpk virtual keyboard");
        expect(stdout.value).toContain("ptr_name=wpk virtual pointer");
        expect(stdout.value).toContain("kbd_has_type=1 kbd_has_code=1");
        expect(stdout.value).toContain("ptr_has_type=1 ptr_has_code=1");

        // Phase 1: KEY_A down then SYN_REPORT, decoded with libevdev's name
        // lookups.
        expect(stdout.value).toContain(
          `kbd_ev0 type=${EV_KEY} code=${KEY_A} value=1 type_name=EV_KEY code_name=KEY_A`,
        );
        expect(stdout.value).toContain(
          `kbd_ev1 type=${EV_SYN} code=${SYN_REPORT} value=0 type_name=EV_SYN code_name=SYN_REPORT`,
        );

        // Phase 2: REL_X=+5 then SYN_REPORT.
        expect(stdout.value).toContain(
          `ptr_ev0 type=${EV_REL} code=${REL_X} value=5 type_name=EV_REL code_name=REL_X`,
        );
        expect(stdout.value).toContain(
          `ptr_ev1 type=${EV_SYN} code=${SYN_REPORT} value=0 type_name=EV_SYN code_name=SYN_REPORT`,
        );

        expect(stdout.value).toContain("LIBEVDEV_SMOKE_OK");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
