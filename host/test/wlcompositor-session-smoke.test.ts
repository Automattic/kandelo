/**
 * `wlcompositor PROGRAM [ARG...]` runs PROGRAM as the whole session, as cage
 * does: the compositor spawns it once its socket is bound, kiosk-maximizes
 * its window, and exits with its status.
 *
 *   - wlclient-test as the session connects through WAYLAND_DISPLAY, gets a
 *     maximized window, takes a key and a click, and exits 0; the compositor
 *     exits 0 with it.
 *   - `dash -c 'exit 3'` as the session never connects; the compositor still
 *     reaps it and exits 3.
 *
 * Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { pointerAbs } from "./support/pointer-abs";

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const dashBin = tryResolveBinary("programs/dash.wasm");
const hasBinaries = !!compositorBin && !!clientBin && !!dashBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const POINT_X = 100;
const POINT_Y = 75;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
const KEY_A = 30;
const BTN_LEFT = 0x110;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  ref: { value: string },
  needle: string | RegExp,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const hit = () =>
    typeof needle === "string" ? ref.value.includes(needle) : needle.test(ref.value);
  while (Date.now() < deadline) {
    if (hit()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${needle}.\n${context()}`);
}

function withTimeout(exit: Promise<number>, ms: number, context: () => string) {
  return Promise.race([
    exit,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error(`compositor did not exit.\n${context()}`)), ms)),
  ]);
}

describe("wlcompositor — a program on the command line is the session", () => {
  it.skipIf(!hasBinaries)(
    "spawns the client, maximizes its window, and exits with its status",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clientBytes = loadBytes(clientBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
        execProgramBytes: { [clientBin!]: clientBytes },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        const compExit = host.spawn(compositorBytes, ["wlcompositor", clientBin!], {});

        await waitFor(out, "WLC_KIOSK on", 20_000, dump);
        await waitFor(out, /SESSION ".*wlclient-test\.wasm" pid=\d+/, 20_000, dump);
        await waitFor(out, "CLIENT_READY\n", 20_000, dump);
        await waitFor(out, /WM_STATE maximized "[^"]*" w=\d+ h=\d+/, 5_000, dump);

        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_ABS, ABS_X, pointerAbs(POINT_X, CANVAS_W));
        host.injectInputEvent(1, EV_ABS, ABS_Y, pointerAbs(POINT_Y, CANVAS_H));
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(1, EV_KEY, BTN_LEFT, 1);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);

        expect(await withTimeout(compExit, 25_000, dump), dump()).toBe(0);
        expect(out.value).toContain("CLIENT_OK");
        expect(out.value).toContain("SESSION_EXIT status=0");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    90_000,
  );

  it.skipIf(!hasBinaries)(
    "exits with the status of a session that never connects",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const dashBytes = loadBytes(dashBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
        execProgramBytes: { [dashBin!]: dashBytes },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        const compExit = host.spawn(
          compositorBytes, ["wlcompositor", dashBin!, "-c", "exit 3"], {});

        expect(await withTimeout(compExit, 40_000, dump), dump()).toBe(3);
        expect(out.value).toContain("SESSION_EXIT status=3");
        expect(out.value).not.toContain("CLIENT_CONNECTED");
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    90_000,
  );
});
