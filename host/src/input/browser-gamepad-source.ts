/**
 * `BrowserGamepadSource` — plugs the page's gamepads into a Kandelo machine.
 *
 * The Gamepad API exists only on the window (not in workers) and is polled:
 * `navigator.getGamepads()` returns snapshots, and browsers reveal a pad only
 * after the user presses one of its buttons. This source polls once per
 * animation frame while any pad is known, connects each standard-mapped pad
 * as a new `/dev/input/eventN` (see `gamepad.ts` for the layout), sends one
 * `SYN_REPORT` frame per changed poll, and unplugs the device when the pad
 * disappears.
 *
 * A pad without the standard mapping has no known layout, so it is not
 * connected; `onUnsupported` reports it instead of inventing one.
 */
import {
  connectedGamepadState,
  gamepadFrame,
  isStandardGamepad,
  standardGamepadDescription,
  standardGamepadState,
  type GamepadEvdevState,
  type GamepadSnapshot,
} from "./gamepad.js";
import type {
  InputDeviceConnectResult,
  InputDeviceSink,
  InputDeviceSource,
} from "./input-device.js";

/** The window surface the source uses; a fake one drives the tests. */
export interface GamepadWindow {
  readonly navigator: { getGamepads(): ReadonlyArray<GamepadLike | null> };
  addEventListener(type: "gamepadconnected", listener: () => void): void;
  removeEventListener(type: "gamepadconnected", listener: () => void): void;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
}

export interface GamepadLike extends GamepadSnapshot {
  readonly index: number;
  readonly connected: boolean;
}

export interface GamepadEventInfo {
  index: number;
  id: string;
}

export interface BrowserGamepadSourceOptions {
  /** A pad became `/dev/input/event<device>`. */
  onConnected?(pad: GamepadEventInfo, device: number): void;
  /** The kernel or host refused the pad; it is not plugged in. */
  onRefused?(pad: GamepadEventInfo, result: Exclude<InputDeviceConnectResult, { ok: true }>): void;
  /** The pad does not use the standard mapping, so it is not plugged in. */
  onUnsupported?(pad: GamepadEventInfo & { mapping: string }): void;
  /** A connected pad went away and was unplugged. */
  onDisconnected?(pad: GamepadEventInfo): void;
}

interface TrackedPad {
  /** Unique per connection, so a pad replugged at one index is a new device. */
  key: string | null;
  id: string;
  /** What the kernel holds, as of the last frame sent. */
  state: GamepadEvdevState | null;
  /** Connect refused or mapping unsupported: stop sending until it is replugged. */
  ignored: boolean;
}

export class BrowserGamepadSource implements InputDeviceSource {
  readonly #window: GamepadWindow;
  readonly #options: BrowserGamepadSourceOptions;
  readonly #pads = new Map<number, TrackedPad>();
  #sink: InputDeviceSink | null = null;
  #frame: number | null = null;
  #connections = 0;
  readonly #onGamepadConnected = () => this.#schedule();

  constructor(target: GamepadWindow, options: BrowserGamepadSourceOptions = {}) {
    this.#window = target;
    this.#options = options;
  }

  start(sink: InputDeviceSink): void {
    if (this.#sink) this.stop();
    this.#sink = sink;
    this.#window.addEventListener("gamepadconnected", this.#onGamepadConnected);
    // Pads revealed before the machine started are already listed.
    this.poll();
  }

  stop(): void {
    const sink = this.#sink;
    this.#sink = null;
    this.#window.removeEventListener("gamepadconnected", this.#onGamepadConnected);
    if (this.#frame !== null) {
      this.#window.cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    for (const pad of this.#pads.values()) {
      if (pad.key !== null) sink?.disconnectInputDevice(pad.key);
    }
    this.#pads.clear();
  }

  #schedule(): void {
    if (this.#sink === null || this.#frame !== null) return;
    this.#frame = this.#window.requestAnimationFrame(() => {
      this.#frame = null;
      this.poll();
    });
  }

  /** Read every pad once and forward what changed. Public for tests. */
  poll(): void {
    const sink = this.#sink;
    if (sink === null) return;
    const seen = new Set<number>();
    for (const pad of this.#window.navigator.getGamepads()) {
      if (!pad || !pad.connected) continue;
      seen.add(pad.index);
      let tracked = this.#pads.get(pad.index);
      if (tracked && tracked.id !== pad.id) {
        // A different pad took this slot between polls.
        this.#unplug(pad.index, tracked);
        tracked = undefined;
      }
      if (!tracked) {
        tracked = this.#plug(sink, pad);
        this.#pads.set(pad.index, tracked);
      }
      if (tracked.ignored || tracked.key === null || tracked.state === null) continue;
      const next = standardGamepadState(pad);
      const records = gamepadFrame(tracked.state, next);
      tracked.state = next;
      if (records.length > 0) sink.injectInputDeviceEvents(tracked.key, records);
    }
    for (const [index, tracked] of this.#pads) {
      if (!seen.has(index)) this.#unplug(index, tracked);
    }
    if (this.#pads.size > 0) this.#schedule();
  }

  #plug(sink: InputDeviceSink, pad: GamepadLike): TrackedPad {
    const info = { index: pad.index, id: pad.id };
    if (!isStandardGamepad(pad)) {
      this.#options.onUnsupported?.({ ...info, mapping: pad.mapping });
      return { key: null, id: pad.id, state: null, ignored: true };
    }
    const description = standardGamepadDescription(pad);
    const key = `gamepad:${pad.index}:${++this.#connections}`;
    const tracked: TrackedPad = {
      key,
      id: pad.id,
      state: connectedGamepadState(description),
      ignored: false,
    };
    void sink.connectInputDevice(key, description).then(
      (result) => {
        if (result.ok) {
          this.#options.onConnected?.(info, result.device);
        } else {
          tracked.ignored = true;
          this.#options.onRefused?.(info, result);
        }
      },
      (error: unknown) => {
        tracked.ignored = true;
        this.#options.onRefused?.(info, {
          ok: false,
          reason: "host-error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return tracked;
  }

  #unplug(index: number, tracked: TrackedPad): void {
    this.#pads.delete(index);
    if (tracked.key === null) return;
    this.#sink?.disconnectInputDevice(tracked.key);
    if (!tracked.ignored) this.#options.onDisconnected?.({ index, id: tracked.id });
  }
}
