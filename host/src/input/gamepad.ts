/**
 * Browser `"standard"` gamepad → Linux evdev translation.
 *
 * The W3C Gamepad API's standard mapping is modeled on the Xbox 360
 * controller, so the virtual device reports the layout of Linux's `xpad`
 * driver for that pad: four face buttons as `BTN_A`/`BTN_B`/`BTN_X`/`BTN_Y`
 * by position (bottom/right/left/top), analog triggers on `ABS_Z`/`ABS_RZ`,
 * the d-pad as the `ABS_HAT0X`/`ABS_HAT0Y` hat, and sticks on
 * `ABS_X`/`ABS_Y`/`ABS_RX`/`ABS_RY` with up and left negative. Software that
 * understands an `xpad` pad, including SDL's evdev auto-mapping for a
 * non-Sony vendor, understands this one.
 *
 * The device says what it is: a Kandelo virtual device (`BUS_VIRTUAL`,
 * vendor 0x1209) named after the browser's `Gamepad.id`. It does not claim
 * the physical pad's USB identity, since its layout is the browser's
 * standard mapping and not that pad's own report.
 *
 * Everything here is a pure function of a gamepad snapshot so both hosts
 * and tests share it; `BrowserGamepadSource` does the polling.
 */
import {
  INPUT_BUS_VIRTUAL,
  INPUT_CODES,
  KANDELO_INPUT_VENDOR,
} from "../generated/abi.js";
import type {
  InputAbsAxis,
  InputDeviceDescription,
  InputDeviceRecord,
} from "./input-device.js";

const C = INPUT_CODES;

/** Product id of the virtual standard gamepad (keyboard 1, pointer 2). */
export const VIRTUAL_GAMEPAD_PRODUCT = 0x0003;
export const VIRTUAL_GAMEPAD_VERSION = 0x0001;

const STICK_MIN = -32768;
const STICK_MAX = 32767;
const TRIGGER_MAX = 1023;

/** The parts of a DOM `Gamepad` the translation reads. */
export interface GamepadSnapshot {
  readonly id: string;
  readonly mapping: string;
  readonly buttons: ReadonlyArray<{ readonly pressed: boolean; readonly value: number }>;
  readonly axes: ReadonlyArray<number>;
}

/** Standard-mapping button index → evdev key, for digital buttons. */
const BUTTON_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, C.BTN_A],
  [1, C.BTN_B],
  [2, C.BTN_X],
  [3, C.BTN_Y],
  [4, C.BTN_TL],
  [5, C.BTN_TR],
  [8, C.BTN_SELECT],
  [9, C.BTN_START],
  [10, C.BTN_THUMBL],
  [11, C.BTN_THUMBR],
  [16, C.BTN_MODE],
];

const STICK_AXES: ReadonlyArray<readonly [number, number]> = [
  [0, C.ABS_X],
  [1, C.ABS_Y],
  [2, C.ABS_RX],
  [3, C.ABS_RY],
];

/** Evdev state of the virtual pad: key code → 0/1, axis code → value. */
export interface GamepadEvdevState {
  readonly keys: ReadonlyMap<number, number>;
  readonly axes: ReadonlyMap<number, number>;
}

/** Whether the translation applies: only the standard mapping has a known layout. */
export function isStandardGamepad(pad: Pick<GamepadSnapshot, "mapping">): boolean {
  return pad.mapping === "standard";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stickValue(axis: number | undefined): number {
  const v = Number.isFinite(axis) ? clamp(axis as number, -1, 1) : 0;
  return v < 0 ? Math.round(v * -STICK_MIN) : Math.round(v * STICK_MAX);
}

function button(pad: GamepadSnapshot, index: number) {
  return pad.buttons[index];
}

function pressed(pad: GamepadSnapshot, index: number): number {
  return button(pad, index)?.pressed ? 1 : 0;
}

function triggerValue(pad: GamepadSnapshot, index: number): number {
  const b = button(pad, index);
  if (!b) return 0;
  const v = Number.isFinite(b.value) ? clamp(b.value, 0, 1) : b.pressed ? 1 : 0;
  return Math.round(v * TRIGGER_MAX);
}

/** The evdev state a standard-mapped snapshot reports. */
export function standardGamepadState(pad: GamepadSnapshot): GamepadEvdevState {
  const keys = new Map<number, number>();
  for (const [index, code] of BUTTON_KEYS) keys.set(code, pressed(pad, index));
  const axes = new Map<number, number>();
  for (const [index, code] of STICK_AXES) axes.set(code, stickValue(pad.axes[index]));
  axes.set(C.ABS_Z, triggerValue(pad, 6));
  axes.set(C.ABS_RZ, triggerValue(pad, 7));
  // Hat axes: up and left are -1, as Linux reports a d-pad hat.
  axes.set(C.ABS_HAT0X, pressed(pad, 15) - pressed(pad, 14));
  axes.set(C.ABS_HAT0Y, pressed(pad, 13) - pressed(pad, 12));
  return { keys, axes };
}

function axis(
  code: number,
  value: number,
  minimum: number,
  maximum: number,
  fuzz: number,
  flat: number,
): InputAbsAxis {
  return { code, value, minimum, maximum, fuzz, flat, resolution: 0 };
}

/**
 * Describe the virtual pad for `kernel_input_device_connect`. Axis values
 * start at the pad's current position, so `EVIOCGABS` is right from the
 * first query; held buttons arrive as the first frame's presses, as on Linux.
 */
export function standardGamepadDescription(pad: GamepadSnapshot): InputDeviceDescription {
  const state = standardGamepadState(pad);
  const at = (code: number) => state.axes.get(code) ?? 0;
  return {
    name: pad.id.trim() === "" ? "Kandelo virtual gamepad" : pad.id,
    bustype: INPUT_BUS_VIRTUAL,
    vendor: KANDELO_INPUT_VENDOR,
    product: VIRTUAL_GAMEPAD_PRODUCT,
    version: VIRTUAL_GAMEPAD_VERSION,
    keys: BUTTON_KEYS.map(([, code]) => code),
    axes: [
      // Sticks: xpad's fuzz and dead zone.
      ...STICK_AXES.map(([, code]) => axis(code, at(code), STICK_MIN, STICK_MAX, 16, 128)),
      axis(C.ABS_Z, at(C.ABS_Z), 0, TRIGGER_MAX, 0, 0),
      axis(C.ABS_RZ, at(C.ABS_RZ), 0, TRIGGER_MAX, 0, 0),
      axis(C.ABS_HAT0X, at(C.ABS_HAT0X), -1, 1, 0, 0),
      axis(C.ABS_HAT0Y, at(C.ABS_HAT0Y), -1, 1, 0, 0),
    ],
  };
}

/** The state the kernel holds right after connect: axes as described, no keys down. */
export function connectedGamepadState(
  description: InputDeviceDescription,
): GamepadEvdevState {
  return {
    keys: new Map(description.keys.map((code) => [code, 0])),
    axes: new Map(description.axes.map((a) => [a.code, a.value])),
  };
}

/**
 * The records that move the device from `previous` to `next`: one record per
 * changed key or axis, closed by `SYN_REPORT`. An unchanged poll is empty.
 */
export function gamepadFrame(
  previous: GamepadEvdevState,
  next: GamepadEvdevState,
): InputDeviceRecord[] {
  const records: InputDeviceRecord[] = [];
  for (const [code, value] of next.keys) {
    if (previous.keys.get(code) !== value) {
      records.push({ ev_type: C.EV_KEY, code, value });
    }
  }
  for (const [code, value] of next.axes) {
    if (previous.axes.get(code) !== value) {
      records.push({ ev_type: C.EV_ABS, code, value });
    }
  }
  if (records.length > 0) {
    records.push({ ev_type: C.EV_SYN, code: C.SYN_REPORT, value: 0 });
  }
  return records;
}
