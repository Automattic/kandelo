/**
 * wlcompositor hands the host pointer's shape to the kernel
 * (DRM_IOCTL_WPK_CURSOR_SHAPE), and the client under the pointer names it.
 *
 * wlclient-test, run with WLC_CURSOR=1, names `wait` through
 * wp_cursor_shape_device_v1 before the pointer enters its window, then
 * `pointer` and no cursor surface once it has entered. The compositor's
 * CURSOR_SHAPE marker reports each shape the kernel took: the default at
 * startup, `pointer` (4), hidden (0), and the default again when the pointer
 * leaves the window. `wait` never reaches the kernel. With WLC_CURSOR=invalid
 * the client names a shape past `zoom_out` and gets the protocol error.
 *
 * Skips if the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const hasBinaries = !!compositorBin && !!clientBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// The 200×150 wlclient-test window takes the first cascade slot (160,120).
const INSIDE_X = 260;
const INSIDE_Y = 200;
const OUTSIDE_X = 1000;
const OUTSIDE_Y = 800;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

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

function withTimeout(exit: Promise<number>, ms: number, context: () => string) {
  return Promise.race([
    exit,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error(`process did not exit.\n${context()}`)), ms)),
  ]);
}

function movePointer(host: NodeKernelHost, x: number, y: number) {
  host.injectInputEvent(1, EV_ABS, ABS_X, x);
  host.injectInputEvent(1, EV_ABS, ABS_Y, y);
  host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
}

function shapes(out: string): number[] {
  return [...out.matchAll(/CURSOR_SHAPE shape=(\d+)/g)].map((m) => parseInt(m[1], 10));
}

describe("wlcompositor — wp_cursor_shape_v1 and the host pointer", () => {
  it.skipIf(!hasBinaries)(
    "takes the shape of the client under the pointer, hides it, and resets it on leave",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        expect(shapes(out.value), dump()).toEqual([1]);

        const clientExit = host.spawn(clientBytes, ["wlclient-test"], { env: ["WLC_CURSOR=1"] });
        await waitFor(out, "CURSOR_UNFOCUSED_SET", 20_000, dump);
        movePointer(host, INSIDE_X, INSIDE_Y);
        await waitFor(out, "CURSOR_HIDDEN_SET", 10_000, dump);
        movePointer(host, OUTSIDE_X, OUTSIDE_Y);

        expect(await withTimeout(clientExit, 10_000, dump), dump()).toBe(0);
        expect(out.value).toContain("CURSOR_SHAPE_OK");
        expect(await withTimeout(compExit, 10_000, dump), dump()).toBe(0);
        expect(shapes(out.value), dump()).toEqual([1, 4, 0, 1]);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );

  it.skipIf(!hasBinaries)(
    "raises invalid_shape for a shape past zoom_out",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        host.spawn(compositorBytes, ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        const clientExit = host.spawn(clientBytes, ["wlclient-test"], { env: ["WLC_CURSOR=invalid"] });
        expect(await withTimeout(clientExit, 20_000, dump), dump()).toBe(0);
        expect(out.value).toContain("CURSOR_PROTOCOL_ERROR wp_cursor_shape_device_v1 code=1");
        expect(shapes(out.value), dump()).toEqual([1]);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
