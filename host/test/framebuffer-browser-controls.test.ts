import { describe, expect, it } from "vitest";
import {
  attachLinuxMediumRawKeyboard,
  createPcmAudioScheduler,
  DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY,
  encodeKeyboardEventAsLinuxMediumRaw,
  encodeLinuxMediumRawKeyCode,
  linuxKeyCodeFromKeyboardEvent,
  scalePointerLockMouseDelta,
} from "../src/framebuffer/browser-controls.js";

describe("framebuffer browser controls", () => {
  const keyEvent = (code: string, key = "") =>
    ({ code, key }) as Pick<KeyboardEvent, "code" | "key">;

  it("maps WASD as letter keycodes, not movement aliases", () => {
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("KeyW"))).toBe(17);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("KeyA"))).toBe(30);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("KeyS"))).toBe(31);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("KeyD"))).toBe(32);

    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("ArrowUp"))).toBe(103);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("ArrowLeft"))).toBe(105);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("ArrowRight"))).toBe(106);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("ArrowDown"))).toBe(108);
  });

  it("encodes key presses and releases as Linux MEDIUMRAW bytes", () => {
    expect(encodeLinuxMediumRawKeyCode(17, true)).toEqual(new Uint8Array([17]));
    expect(encodeLinuxMediumRawKeyCode(17, false)).toEqual(new Uint8Array([0x91]));
    expect(encodeKeyboardEventAsLinuxMediumRaw(keyEvent("KeyS"), true)).toEqual(
      new Uint8Array([31]),
    );
    expect(encodeKeyboardEventAsLinuxMediumRaw(keyEvent("KeyS"), false)).toEqual(
      new Uint8Array([0x9f]),
    );
  });

  it("maps common non-letter keys sent by Doom menus", () => {
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("Escape"))).toBe(1);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("Enter"))).toBe(28);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("Space"))).toBe(57);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("F2"))).toBe(60);
    expect(linuxKeyCodeFromKeyboardEvent(keyEvent("", "w"))).toBe(17);
  });

  it("keeps focused key events in the framebuffer path and reserves Ctrl+Shift+Esc for release", () => {
    const listeners = new Map<string, Array<(event: KeyboardEvent) => void>>();
    const target = {
      addEventListener: (type: string, listener: EventListener) => {
        const existing = listeners.get(type) ?? [];
        existing.push(listener as (event: KeyboardEvent) => void);
        listeners.set(type, existing);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        const existing = listeners.get(type) ?? [];
        listeners.set(type, existing.filter((fn) => fn !== listener));
      },
    } as unknown as HTMLElement;

    const sent: number[] = [];
    let released = false;
    const keyboard = attachLinuxMediumRawKeyboard(
      target,
      { sendInput: (bytes) => sent.push(...bytes) },
      { onReleaseCapture: () => { released = true; } },
    );
    const dispatch = (
      type: "keydown" | "keyup",
      props: Partial<KeyboardEvent>,
    ) => {
      let prevented = false;
      let stopped = false;
      const event = {
        code: "",
        key: "",
        ctrlKey: false,
        shiftKey: false,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
        ...props,
      } as KeyboardEvent;
      for (const listener of listeners.get(type) ?? []) listener(event);
      return { prevented, stopped };
    };

    expect(dispatch("keydown", { code: "Unidentified", key: "Unidentified" }))
      .toEqual({ prevented: true, stopped: true });
    expect(sent).toEqual([]);

    dispatch("keydown", { code: "ControlLeft", key: "Control", ctrlKey: true });
    dispatch("keydown", { code: "ShiftLeft", key: "Shift", ctrlKey: true, shiftKey: true });
    const combo = dispatch("keydown", {
      code: "Escape",
      key: "Escape",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(combo).toEqual({ prevented: true, stopped: true });
    expect(released).toBe(true);
    expect(sent).toEqual([29, 42, 0x9d, 0xaa]);

    keyboard.close();
  });

  it("scales CSS-pixel pointer-lock movement into PS/2 deltas", () => {
    expect(scalePointerLockMouseDelta(10, -5, {
      sensitivity: 2,
      canvasWidth: 640,
      canvasHeight: 400,
      clientWidth: 320,
      clientHeight: 200,
    })).toEqual({ dx: 40, dy: 20 });
  });

  it("defaults to screen-space-ish Doom mouse scaling", () => {
    expect(DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY).toBe(4);
    expect(scalePointerLockMouseDelta(10, 2, {
      canvasWidth: 640,
      canvasHeight: 400,
      clientWidth: 640,
      clientHeight: 400,
    })).toEqual({ dx: 40, dy: -8 });
  });

  // Splitting a large displacement into legal signed-byte PS/2 packets is the
  // kernel's job now, and is covered by `mouse::tests::
  // large_displacement_splits_across_packets_preserving_total` in
  // `crates/runtime-core/src/mouse.rs` with this same 300/-260/0b101 case.

  it("keeps the retired PCM scheduler export explicitly unavailable", async () => {
    let drainCalls = 0;
    const output = createPcmAudioScheduler({
      drainAudio: async () => {
        drainCalls++;
        return { bytes: new Uint8Array(), sampleRate: 48_000, channels: 2 };
      },
    });

    expect(output.getState()).toBe("unavailable");
    await expect(output.resume()).rejects.toThrow("machine-level AudioWorklet PCM driver");
    expect(drainCalls).toBe(0);
    expect(() => output.close()).not.toThrow();
  });
});
