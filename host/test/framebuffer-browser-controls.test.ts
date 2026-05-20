import { describe, expect, it } from "vitest";
import {
  DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY,
  injectChunkedMouseMotion,
  scalePointerLockMouseDelta,
  type MouseEventSink,
} from "../src/framebuffer/browser-controls.js";

describe("framebuffer browser controls", () => {
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

  it("splits large mouse movement into legal signed-byte PS/2 packets", () => {
    const packets: Array<{ dx: number; dy: number; buttons: number }> = [];
    const sink: MouseEventSink = {
      injectMouseEvent: (dx, dy, buttons) => {
        packets.push({ dx, dy, buttons });
      },
    };

    injectChunkedMouseMotion(sink, 300, -260, 0b101);

    expect(packets).toEqual([
      { dx: 127, dy: -128, buttons: 0b101 },
      { dx: 127, dy: -128, buttons: 0b101 },
      { dx: 46, dy: -4, buttons: 0b101 },
    ]);
  });
});
