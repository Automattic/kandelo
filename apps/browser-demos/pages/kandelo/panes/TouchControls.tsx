// Touch control overlay for keyboard-driven framebuffer demos: arrow cluster
// bottom-left, fire (LeftCtrl) bottom-right, Esc top-left. Each button sends
// Linux MEDIUMRAW press/release bytes through the same sink as the physical
// keyboard path in Framebuffer.tsx.

import * as React from "react";
import { encodeLinuxMediumRawKeyCode } from "../../../../../host/src/framebuffer/browser-controls";

// Hold a press at least ~2 fbDOOM tics before its release; clients that latch
// key state once per tic would otherwise drain the press and release together
// and never see the key.
const KEY_HOLD_MS = 50;

export const TOUCH_TAP_SLOP_PX = 10;

const KEY_ESCAPE = 1;
export const KEY_ENTER = 28;
const KEY_LEFTCTRL = 29;
export const KEY_SPACE = 57;
const KEY_UP = 103;
const KEY_LEFT = 105;
const KEY_RIGHT = 106;
const KEY_DOWN = 108;

export interface TouchKeySink {
  sendInput(bytes: Uint8Array): void;
}

export interface TouchKeySender {
  press(keyCode: number): void;
  release(keyCode: number): void;
  tap(keyCode: number): void;
  releaseAll(): void;
}

export function createTouchKeySender(sink: TouchKeySink): TouchKeySender {
  const pressedAt = new Map<number, number>();
  const releaseTimers = new Map<number, ReturnType<typeof globalThis.setTimeout>>();

  const emit = (keyCode: number, pressed: boolean) => {
    const bytes = encodeLinuxMediumRawKeyCode(keyCode, pressed);
    if (bytes) sink.sendInput(bytes);
  };

  const press = (keyCode: number) => {
    const timer = releaseTimers.get(keyCode);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      releaseTimers.delete(keyCode);
      emit(keyCode, false);
    }
    if (pressedAt.has(keyCode)) return;
    pressedAt.set(keyCode, performance.now());
    emit(keyCode, true);
  };

  const release = (keyCode: number) => {
    const at = pressedAt.get(keyCode);
    if (at === undefined) return;
    pressedAt.delete(keyCode);
    const heldMs = performance.now() - at;
    if (heldMs >= KEY_HOLD_MS) {
      emit(keyCode, false);
      return;
    }
    const timer = globalThis.setTimeout(() => {
      releaseTimers.delete(keyCode);
      emit(keyCode, false);
    }, KEY_HOLD_MS - heldMs);
    releaseTimers.set(keyCode, timer);
  };

  const tap = (keyCode: number) => {
    press(keyCode);
    release(keyCode);
  };

  const releaseAll = () => {
    for (const timer of releaseTimers.values()) globalThis.clearTimeout(timer);
    for (const keyCode of releaseTimers.keys()) emit(keyCode, false);
    releaseTimers.clear();
    for (const keyCode of pressedAt.keys()) emit(keyCode, false);
    pressedAt.clear();
  };

  return { press, release, tap, releaseAll };
}

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = React.useState(
    () => window.matchMedia("(pointer: coarse)").matches,
  );
  React.useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

export interface TouchControlsProps {
  sender: TouchKeySender;
}

export const TouchControls: React.FC<TouchControlsProps> = ({ sender }) => {
  React.useEffect(() => () => sender.releaseAll(), [sender]);

  const button = (keyCode: number, label: string, className: string) => (
    <div
      className={`ktouch-btn ${className}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        sender.press(keyCode);
      }}
      onPointerUp={() => sender.release(keyCode)}
      onPointerCancel={() => sender.release(keyCode)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </div>
  );

  return (
    <div className="ktouch-controls">
      {button(KEY_ESCAPE, "MENU", "ktouch-menu")}
      <div className="ktouch-dpad">
        {button(KEY_UP, "▲", "ktouch-up")}
        {button(KEY_LEFT, "◀", "ktouch-left")}
        {button(KEY_DOWN, "▼", "ktouch-down")}
        {button(KEY_RIGHT, "▶", "ktouch-right")}
      </div>
      {button(KEY_LEFTCTRL, "FIRE", "ktouch-fire")}
    </div>
  );
};
