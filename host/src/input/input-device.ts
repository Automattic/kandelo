/**
 * Host-described evdev devices: `/dev/input/event2` and up.
 *
 * `event0` (keyboard) and `event1` (pointer) exist for the life of the
 * machine. Other input hardware comes and goes: a browser reveals a gamepad
 * only after the user presses one of its buttons, and it can disconnect at any
 * time. The host describes such a device the way Linux `uinput`'s legacy
 * `struct uinput_user_dev` does (a name, an `input_id`, the key codes it can
 * emit, and its absolute axes), and the kernel creates the node, owns its
 * observable state, and removes it on disconnect.
 *
 * The description crosses into the kernel as a `WpkInputDeviceDesc`
 * (`shared::input`). Its layout comes from the generated ABI, so this encoder
 * cannot drift from the Rust struct.
 */
import { INPUT_DEVICE_DESC_LAYOUT } from "../generated/abi.js";

/** One `struct input_absinfo` for an axis the device has. */
export interface InputAbsAxis {
  /** `ABS_*` code, below `INPUT_DEVICE_DESC_LAYOUT.absCount`. */
  code: number;
  /** The axis position when the device connects. */
  value: number;
  minimum: number;
  maximum: number;
  fuzz: number;
  flat: number;
  resolution: number;
}

export interface InputDeviceDescription {
  /** Reported by `EVIOCGNAME`. Truncated to whole UTF-8 characters. */
  name: string;
  bustype: number;
  vendor: number;
  product: number;
  version: number;
  /** `EV_KEY` codes the device can emit. */
  keys: readonly number[];
  /** `EV_ABS` axes the device has. */
  axes: readonly InputAbsAxis[];
}

/** One evdev record for a host-described device; the kernel stamps the time. */
export interface InputDeviceRecord {
  ev_type: number;
  code: number;
  value: number;
}

/**
 * The outcome of connecting a device. `device` is the `N` of
 * `/dev/input/eventN`. A refusal carries the kernel's errno: `EINVAL` for an
 * invalid description, `ENOSPC` when every evdev number is in use, `ENOMEM`
 * when the kernel cannot admit the device state. `unsupported` means the
 * kernel has no device-connect export; `host-error` that the request failed
 * before reaching the kernel.
 */
export type InputDeviceConnectResult =
  | { ok: true; device: number }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "kernel-refused"; errno: number }
  | { ok: false; reason: "duplicate-key" }
  | { ok: false; reason: "host-error"; message: string };

/**
 * The longest name prefix that fits the descriptor with its terminating NUL,
 * cut at a character boundary so the guest never sees a split UTF-8 sequence.
 */
function encodeName(name: string): Uint8Array {
  const limit = INPUT_DEVICE_DESC_LAYOUT.nameBytes - 1;
  const encoder = new TextEncoder();
  let bytes = encoder.encode(name);
  if (bytes.byteLength <= limit) return bytes;
  let end = limit;
  // Back up over continuation bytes (10xxxxxx) to the start of a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  bytes = bytes.subarray(0, end);
  return bytes;
}

function setBit(view: Uint8Array, offset: number, bytes: number, bit: number): void {
  const index = bit >> 3;
  if (!Number.isInteger(bit) || bit < 0 || index >= bytes) {
    throw new RangeError(`input device capability ${bit} is out of range`);
  }
  view[offset + index] |= 1 << (bit & 7);
}

/** Encode a description as the kernel's `WpkInputDeviceDesc`. */
export function encodeInputDeviceDescription(
  description: InputDeviceDescription,
): Uint8Array {
  const layout = INPUT_DEVICE_DESC_LAYOUT;
  const out = new Uint8Array(layout.size);
  const view = new DataView(out.buffer);
  view.setUint16(layout.idOffset, description.bustype, true);
  view.setUint16(layout.idOffset + 2, description.vendor, true);
  view.setUint16(layout.idOffset + 4, description.product, true);
  view.setUint16(layout.idOffset + 6, description.version, true);
  out.set(encodeName(description.name), layout.nameOffset);
  for (const key of description.keys) {
    setBit(out, layout.keyBitsOffset, layout.keyBitsBytes, key);
  }
  for (const axis of description.axes) {
    setBit(out, layout.absBitsOffset, layout.absBitsBytes, axis.code);
    const base = layout.absinfoOffset + axis.code * layout.absinfoBytes;
    view.setInt32(base, axis.value, true);
    view.setInt32(base + 4, axis.minimum, true);
    view.setInt32(base + 8, axis.maximum, true);
    view.setInt32(base + 12, axis.fuzz, true);
    view.setInt32(base + 16, axis.flat, true);
    view.setInt32(base + 20, axis.resolution, true);
  }
  return out;
}

/** What a device source drives: the host's device API, on either host. */
export interface InputDeviceSink {
  /**
   * Plug a device in under a host-chosen `key`. Records sent for `key` after
   * this call are ordered behind the connect; if the kernel refuses it, they
   * are dropped.
   */
  connectInputDevice(
    key: string,
    description: InputDeviceDescription,
  ): Promise<InputDeviceConnectResult>;
  /** Unplug `key`. Its node disappears; open descriptors fail with `ENODEV`. */
  disconnectInputDevice(key: string): void;
  /** Deliver one or more `SYN_REPORT` frames for `key`. */
  injectInputDeviceEvents(key: string, records: InputDeviceRecord[]): void;
}

/** A producer of host-described devices, such as `BrowserGamepadSource`. */
export interface InputDeviceSource {
  start(sink: InputDeviceSink): void;
  /** Stop producing and unplug every device this source connected. */
  stop(): void;
}
