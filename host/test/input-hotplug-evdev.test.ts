/**
 * End-to-end gate for host-described (hot-plugged) evdev devices on the
 * Node host. `input-gamepad-smoke` scans `/dev/input`, the host connects a
 * standard gamepad through `NodeKernelHost.connectInputDevice` — the same
 * call `BrowserGamepadSource` makes in the browser — and the fixture reads
 * its identity, capabilities and records through the ordinary syscalls,
 * then observes the disconnect.
 *
 * The fixture prints a READY marker before each phase and then waits on
 * kernel state (the node appearing, a record, the hang-up), so the host acts
 * on the marker and the fixture observes the result through its syscalls.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { INPUT_CODES as C } from "../src/generated/abi.js";
import {
  connectedGamepadState,
  gamepadFrame,
  standardGamepadDescription,
  standardGamepadState,
  type GamepadSnapshot,
} from "../src/input/gamepad";

const fixtureBinary = tryResolveBinary("programs/input-gamepad-smoke.wasm");
const ENODEV = 19;
const ENOENT = 2;

function pad(pressed: number[] = [], axes = [0, 0, 0, 0]): GamepadSnapshot {
  return {
    id: "Test Pad (STANDARD GAMEPAD)",
    mapping: "standard",
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: pressed.includes(i),
      value: pressed.includes(i) ? 1 : 0,
    })),
  };
}

async function waitFor(stdout: { value: string }, needle: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\nstdout so far:\n${stdout.value}`);
}

function field(stdout: string, name: string): string {
  const m = stdout.match(new RegExp(`^${name}=(.*)$`, "m"));
  expect(m, `missing ${name} in:\n${stdout}`).not.toBeNull();
  return m![1];
}

describe("hot-plugged evdev device — Node host", () => {
  it.skipIf(!fixtureBinary)(
    "appears, describes itself, delivers records, and hangs up on disconnect",
    async () => {
      const file = readFileSync(fixtureBinary!);
      const program = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
      const stdout = { value: "" };
      const stderr = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { stdout.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { stderr.value += new TextDecoder().decode(data); },
      });
      try {
        await host.init();
        const exit = host.spawn(program, ["input-gamepad-smoke"]);

        await waitFor(stdout, "READY:connect\n", 10_000);
        const description = standardGamepadDescription(pad([], [0.5, 0, 0, 0]));
        const result = await host.connectInputDevice("pad", description);
        expect(result).toEqual({ ok: true, device: 2 });
        // A key is a single connection.
        expect(await host.connectInputDevice("pad", description)).toEqual({
          ok: false,
          reason: "duplicate-key",
        });

        await waitFor(stdout, "READY:events\n", 10_000);
        const frame = gamepadFrame(
          connectedGamepadState(description),
          standardGamepadState(pad([0], [-1, 0, 0, 0])),
        );
        host.injectInputDeviceEvents("pad", frame);

        await waitFor(stdout, "READY:disconnect\n", 10_000);
        host.disconnectInputDevice("pad");

        const code = await Promise.race([
          exit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`fixture timed out\n${stdout.value}\n${stderr.value}`)), 30_000)),
        ]);
        expect(code, `stdout=${stdout.value}\nstderr=${stderr.value}`).toBe(0);
        const out = stdout.value;

        // Node appears and disappears; the directory mtime never goes back.
        expect(field(out, "before_nodes")).toBe("event0,event1,");
        expect(field(out, "connected_nodes")).toBe("event0,event1,event2,");
        expect(field(out, "disconnected_nodes")).toBe("event0,event1,");
        const mtimes = ["before", "connected", "disconnected"].map((t) => Number(field(out, `${t}_mtime`)));
        expect(mtimes[0]).toBeGreaterThan(0);
        expect(mtimes[1]).toBeGreaterThanOrEqual(mtimes[0]);
        expect(mtimes[2]).toBeGreaterThanOrEqual(mtimes[1]);

        // Identity and capabilities, as an evdev consumer reads them.
        expect(field(out, "name")).toBe("Test Pad (STANDARD GAMEPAD)");
        expect(field(out, "id")).toBe("0006:1209:0003:0001");
        expect(out).toContain("types key=1 abs=1 rel=0");
        expect(out).toContain("keys a=1 b=1 x=1 y=1 start=1 left=0");
        expect(out).toContain("axes x=1 y=1 rz=1 hat0x=1");
        expect(out).toContain("abs_x value=16384 min=-32768 max=32767 fuzz=16 flat=128");

        // One frame: BTN_A down, ABS_X to the left edge, SYN_REPORT.
        expect(out).toContain(`ev0 type=${C.EV_KEY} code=${C.BTN_A} value=1`);
        expect(out).toContain(`ev1 type=${C.EV_ABS} code=${C.ABS_X} value=-32768`);
        expect(out).toContain(`ev2 type=${C.EV_SYN} code=${C.SYN_REPORT} value=0`);
        expect(out).not.toContain("ev3 ");
        expect(field(out, "abs_x_now")).toBe("-32768");
        expect(out).toContain("pressed a=1 b=0");

        // After disconnect: hung up, ENODEV, and the path is gone.
        expect(out).toContain("poll ready=1 hup=1 err=1");
        expect(out).toContain(`read_after n=-1 errno=${ENODEV}`);
        expect(out).toContain(`ioctl_after r=-1 errno=${ENODEV}`);
        expect(out).toContain(`reopen fd=-1 errno=${ENOENT}`);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
