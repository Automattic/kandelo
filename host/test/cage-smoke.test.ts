/**
 * cage, the wlroots kiosk compositor, runs a Wayland client as its whole
 * session on card0 and routes libinput input to it.
 *
 * cage is upstream software on upstream libraries, so this exercises the
 * platform the way a Linux desktop does:
 *
 *   - libseat's noop backend opens /dev/dri/card0 and the evdev nodes;
 *   - wlroots finds the card through libudev-zero, which walks /sys, and
 *     libdrm resolves the card's node type and name through /sys too;
 *   - the udev monitor is an AF_NETLINK NETLINK_KOBJECT_UEVENT socket;
 *   - the DRM backend reads the CRTC, encoder, connector, primary plane
 *     and their properties, then modesets and page-flips through the
 *     legacy KMS interface;
 *   - the pixman renderer composites into DRM dumb buffers, and reads the
 *     client's wl_shm pool by mapping its PRIME fd;
 *   - cage forks and execs the client, and exits with its status.
 *
 * The client (programs/wlcompositor/wlclient-test.c) proves the path from
 * its side: it gets a configure, a frame callback and a presentation
 * feedback after a real page flip, the compositor's keymap, and the key
 * and button the host injects into the evdev devices.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, hasSession, sessionRootfs } from "./wlroots-session";

const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const hasBinaries = hasSession("cage") && !!clientBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const CLIENT_PATH = "/usr/bin/wlclient-test";

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
const KEY_A = 30;
const BTN_LEFT = 0x110;

async function waitFor(
  ref: { value: string },
  needle: string,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\n${context()}`);
}

describe("cage — a wlroots kiosk compositor runs a client session", () => {
  it.skipIf(!hasBinaries)(
    "the client maps on a page flip, receives a key and a button, and cage exits with its status",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        rootfsImage: await sessionRootfs("cage", [
          { path: CLIENT_PATH, bytes: new Uint8Array(readFileSync(clientBin!)), mode: 0o755 },
        ]),
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const cageExit = host.spawn(compositorBytes("cage"), ["cage", "--", CLIENT_PATH], {
          env: [...WLROOTS_ENV, "PATH=/usr/bin"],
        });

        await waitFor(out, "CLIENT_READY\n", 30_000, dump);
        expect(out.value).toContain("BOUND_ALL");
        expect(out.value).toContain("CONFIGURED");
        expect(out.value).toContain("PRESENTATION_CLOCK id=1");
        expect(out.value).toMatch(/PRESENTED sec=\d+ nsec=\d+ refresh=\d+ seq=\d+/);

        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_ABS, ABS_X, 40);
        host.injectInputEvent(1, EV_ABS, ABS_Y, 40);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, 1);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);

        const cageCode = await Promise.race([
          cageExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`cage timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(cageCode, `cage exit.\n${dump()}`).toBe(0);
        expect(out.value).toMatch(/KEYMAP format=1 size=\d+ ok=1/);
        expect(out.value).toContain(`GOT_KEY key=${KEY_A} state=1`);
        expect(out.value).toContain(`GOT_BTN button=${BTN_LEFT} state=1`);
        expect(out.value).toContain("CLIENT_OK");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    90_000,
  );
});
