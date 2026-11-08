/**
 * Browser gamepad → evdev translation and the polling source, without a
 * browser: a fake `navigator.getGamepads()` and a recording device sink.
 * The kernel side is covered by Rust unit tests and
 * `input-hotplug-evdev.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { INPUT_CODES as C, INPUT_DEVICE_DESC_LAYOUT as L } from "../src/generated/abi.js";
import {
  connectedGamepadState,
  gamepadFrame,
  standardGamepadDescription,
  standardGamepadState,
  type GamepadSnapshot,
} from "../src/input/gamepad.js";
import {
  encodeInputDeviceDescription,
  type InputDeviceConnectResult,
  type InputDeviceDescription,
  type InputDeviceRecord,
  type InputDeviceSink,
} from "../src/input/input-device.js";
import {
  BrowserGamepadSource,
  type GamepadLike,
  type GamepadWindow,
} from "../src/input/browser-gamepad-source.js";

function pad(overrides: Partial<GamepadLike> & { pressed?: number[]; values?: Record<number, number> } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const value = overrides.values?.[i] ?? (overrides.pressed?.includes(i) ? 1 : 0);
    return { pressed: value > 0.5 || (overrides.pressed?.includes(i) ?? false), value };
  });
  return {
    id: "Xbox Wireless Controller (STANDARD GAMEPAD)",
    mapping: "standard",
    index: 0,
    connected: true,
    axes: [0, 0, 0, 0],
    buttons,
    ...overrides,
  };
}

describe("standard gamepad translation", () => {
  it("reports the xpad layout by button position", () => {
    const state = standardGamepadState(pad({ pressed: [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 16] }));
    for (const code of [
      C.BTN_A, C.BTN_B, C.BTN_X, C.BTN_Y, C.BTN_TL, C.BTN_TR, C.BTN_SELECT,
      C.BTN_START, C.BTN_THUMBL, C.BTN_THUMBR, C.BTN_MODE,
    ]) {
      expect(state.keys.get(code), `code ${code}`).toBe(1);
    }
    // Left face button is BTN_X (= BTN_NORTH), top is BTN_Y, as xpad reports.
    expect(C.BTN_X).toBe(C.BTN_NORTH);
    expect(C.BTN_Y).toBe(C.BTN_WEST);
  });

  it("maps sticks, triggers and the d-pad hat with up and left negative", () => {
    const state = standardGamepadState(pad({
      axes: [-1, 1, 0.5, -0.25],
      values: { 6: 0.5, 7: 1 },
      pressed: [12, 14],
    }));
    expect(state.axes.get(C.ABS_X)).toBe(-32768);
    expect(state.axes.get(C.ABS_Y)).toBe(32767);
    expect(state.axes.get(C.ABS_RX)).toBe(16384);
    expect(state.axes.get(C.ABS_RY)).toBe(-8192);
    expect(state.axes.get(C.ABS_Z)).toBe(512);
    expect(state.axes.get(C.ABS_RZ)).toBe(1023);
    expect(state.axes.get(C.ABS_HAT0X)).toBe(-1);
    expect(state.axes.get(C.ABS_HAT0Y)).toBe(-1);
    const down = standardGamepadState(pad({ pressed: [13, 15] }));
    expect(down.axes.get(C.ABS_HAT0X)).toBe(1);
    expect(down.axes.get(C.ABS_HAT0Y)).toBe(1);
    // Opposite directions held together cancel.
    expect(standardGamepadState(pad({ pressed: [14, 15] })).axes.get(C.ABS_HAT0X)).toBe(0);
  });

  it("describes a Kandelo virtual device that starts at the pad's position", () => {
    const description = standardGamepadDescription(pad({ axes: [0.5, 0, 0, 0] }));
    expect(description.bustype).toBe(0x06);
    expect(description.vendor).toBe(0x1209);
    expect(description.product).toBe(0x0003);
    expect(description.name).toBe("Xbox Wireless Controller (STANDARD GAMEPAD)");
    const x = description.axes.find((a) => a.code === C.ABS_X)!;
    expect(x).toMatchObject({ value: 16384, minimum: -32768, maximum: 32767, fuzz: 16, flat: 128 });
    expect(description.keys).toContain(C.BTN_A);
    expect(standardGamepadDescription(pad({ id: "  " })).name).toBe("Kandelo virtual gamepad");
  });

  it("sends one frame per change and nothing for an unchanged poll", () => {
    const description = standardGamepadDescription(pad());
    const connected = connectedGamepadState(description);
    expect(gamepadFrame(connected, standardGamepadState(pad()))).toEqual([]);
    const pressed = standardGamepadState(pad({ pressed: [0], axes: [0, 0.5, 0, 0] }));
    expect(gamepadFrame(connected, pressed)).toEqual([
      { ev_type: C.EV_KEY, code: C.BTN_A, value: 1 },
      { ev_type: C.EV_ABS, code: C.ABS_Y, value: 16384 },
      { ev_type: C.EV_SYN, code: C.SYN_REPORT, value: 0 },
    ]);
    expect(gamepadFrame(pressed, standardGamepadState(pad()))).toEqual([
      { ev_type: C.EV_KEY, code: C.BTN_A, value: 0 },
      { ev_type: C.EV_ABS, code: C.ABS_Y, value: 0 },
      { ev_type: C.EV_SYN, code: C.SYN_REPORT, value: 0 },
    ]);
  });
});

describe("WpkInputDeviceDesc encoding", () => {
  const description: InputDeviceDescription = {
    name: "pad",
    bustype: 6,
    vendor: 0x1209,
    product: 3,
    version: 1,
    keys: [C.BTN_A],
    axes: [{ code: C.ABS_RZ, value: 7, minimum: 0, maximum: 1023, fuzz: 1, flat: 2, resolution: 3 }],
  };

  it("places every field at the generated layout's offsets", () => {
    const bytes = encodeInputDeviceDescription(description);
    const view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(L.size);
    expect(view.getUint16(L.idOffset + 2, true)).toBe(0x1209);
    expect(new TextDecoder().decode(bytes.subarray(L.nameOffset, L.nameOffset + 4))).toBe("pad\0");
    expect(bytes[L.keyBitsOffset + (C.BTN_A >> 3)]).toBe(1 << (C.BTN_A & 7));
    expect(bytes[L.absBitsOffset + (C.ABS_RZ >> 3)]).toBe(1 << (C.ABS_RZ & 7));
    const info = L.absinfoOffset + C.ABS_RZ * L.absinfoBytes;
    expect([0, 4, 8, 12, 16, 20].map((o) => view.getInt32(info + o, true))).toEqual([7, 0, 1023, 1, 2, 3]);
  });

  it("truncates a long name at a character boundary and keeps the NUL", () => {
    const name = "é".repeat(60); // 120 bytes of two-byte characters
    const bytes = encodeInputDeviceDescription({ ...description, name });
    const field = bytes.subarray(L.nameOffset, L.nameOffset + L.nameBytes);
    const end = field.indexOf(0);
    expect(end).toBe(78);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(field.subarray(0, end))).toBe("é".repeat(39));
  });

  it("refuses capabilities outside the bitmaps", () => {
    expect(() => encodeInputDeviceDescription({ ...description, keys: [L.keyBitsBytes * 8] })).toThrow(RangeError);
    expect(() => encodeInputDeviceDescription({ ...description, axes: [{ ...description.axes[0], code: 64 }] })).toThrow(RangeError);
  });
});

class FakeWindow implements GamepadWindow {
  pads: (GamepadLike | null)[] = [];
  frames: (() => void)[] = [];
  listeners = new Set<() => void>();
  readonly navigator = { getGamepads: () => this.pads };
  addEventListener(_type: "gamepadconnected", listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "gamepadconnected", listener: () => void) {
    this.listeners.delete(listener);
  }
  requestAnimationFrame(callback: () => void): number {
    this.frames.push(callback);
    return this.frames.length;
  }
  cancelAnimationFrame(_handle: number) {
    this.frames = [];
  }
  /** Run the pending animation frame, as the browser would. */
  tick() {
    const frames = this.frames;
    this.frames = [];
    for (const frame of frames) frame();
  }
}

type SinkCall =
  | { op: "connect"; key: string; description: InputDeviceDescription }
  | { op: "disconnect"; key: string }
  | { op: "events"; key: string; records: InputDeviceRecord[] };

class RecordingSink implements InputDeviceSink {
  calls: SinkCall[] = [];
  result: InputDeviceConnectResult = { ok: true, device: 2 };
  connectInputDevice(key: string, description: InputDeviceDescription) {
    this.calls.push({ op: "connect", key, description });
    return Promise.resolve(this.result);
  }
  disconnectInputDevice(key: string) {
    this.calls.push({ op: "disconnect", key });
  }
  injectInputDeviceEvents(key: string, records: InputDeviceRecord[]) {
    this.calls.push({ op: "events", key, records });
  }
}

describe("BrowserGamepadSource", () => {
  it("plugs in a revealed pad, forwards changes, and unplugs it when it goes", async () => {
    const win = new FakeWindow();
    const sink = new RecordingSink();
    const connected: number[] = [];
    const disconnected: string[] = [];
    const source = new BrowserGamepadSource(win, {
      onConnected: (_pad, device) => connected.push(device),
      onDisconnected: (p) => disconnected.push(p.id),
    });
    source.start(sink);
    expect(sink.calls).toEqual([]);
    expect(win.frames).toHaveLength(0); // nothing to poll yet

    win.pads = [pad()];
    for (const l of win.listeners) l();
    win.tick();
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ op: "connect", key: "gamepad:0:1" });
    await Promise.resolve();
    expect(connected).toEqual([2]);

    win.tick(); // unchanged: no frame
    expect(sink.calls).toHaveLength(1);

    win.pads = [pad({ pressed: [0] })];
    win.tick();
    expect(sink.calls[1]).toEqual({
      op: "events",
      key: "gamepad:0:1",
      records: [
        { ev_type: C.EV_KEY, code: C.BTN_A, value: 1 },
        { ev_type: C.EV_SYN, code: C.SYN_REPORT, value: 0 },
      ],
    });

    win.pads = [null];
    win.tick();
    expect(sink.calls[2]).toEqual({ op: "disconnect", key: "gamepad:0:1" });
    expect(disconnected).toEqual(["Xbox Wireless Controller (STANDARD GAMEPAD)"]);
    expect(win.frames).toHaveLength(0); // polling stops with no pads
  });

  it("delivers buttons held at connect as the first frame's presses", () => {
    const win = new FakeWindow();
    const sink = new RecordingSink();
    win.pads = [pad({ pressed: [9] })];
    new BrowserGamepadSource(win).start(sink);
    expect(sink.calls.map((c) => c.op)).toEqual(["connect", "events"]);
    expect((sink.calls[1] as { records: InputDeviceRecord[] }).records[0]).toEqual({
      ev_type: C.EV_KEY, code: C.BTN_START, value: 1,
    });
  });

  it("treats a different pad in the same slot as a new device", () => {
    const win = new FakeWindow();
    const sink = new RecordingSink();
    win.pads = [pad()];
    new BrowserGamepadSource(win).start(sink);
    win.pads = [pad({ id: "Other pad" })];
    win.tick();
    expect(sink.calls.map((c) => [c.op, c.key])).toEqual([
      ["connect", "gamepad:0:1"],
      ["disconnect", "gamepad:0:1"],
      ["connect", "gamepad:0:2"],
    ]);
  });

  it("reports a non-standard pad instead of inventing a layout", () => {
    const win = new FakeWindow();
    const sink = new RecordingSink();
    const unsupported: string[] = [];
    win.pads = [pad({ mapping: "", id: "Flight stick" })];
    new BrowserGamepadSource(win, { onUnsupported: (p) => unsupported.push(p.id) }).start(sink);
    win.tick();
    expect(sink.calls).toEqual([]);
    expect(unsupported).toEqual(["Flight stick"]);
  });

  it("stops sending for a refused pad and reports why", async () => {
    const win = new FakeWindow();
    const sink = new RecordingSink();
    sink.result = { ok: false, reason: "kernel-refused", errno: 28 };
    const refused: unknown[] = [];
    win.pads = [pad()];
    new BrowserGamepadSource(win, { onRefused: (_p, r) => refused.push(r) }).start(sink);
    await Promise.resolve();
    expect(refused).toEqual([{ ok: false, reason: "kernel-refused", errno: 28 }]);
    win.pads = [pad({ pressed: [0] })];
    win.tick();
    expect(sink.calls.map((c) => c.op)).toEqual(["connect"]);
  });

  it("unplugs everything it connected when stopped", () => {
    const win = new FakeWindow();
    const sink = new RecordingSink();
    win.pads = [pad(), pad({ index: 1, id: "Second pad" })];
    const source = new BrowserGamepadSource(win);
    source.start(sink);
    source.stop();
    expect(sink.calls.filter((c) => c.op === "disconnect").map((c) => c.key)).toEqual([
      "gamepad:0:1",
      "gamepad:1:2",
    ]);
    expect(win.listeners.size).toBe(0);
    expect(win.frames).toHaveLength(0);
  });
});
