// Framebuffer pane — paints whatever process is bound to /dev/fb0, forwards
// focused keyboard input as AT-set-1 / Linux MEDIUMRAW scancodes, forwards
// pointer-lock mouse input to /dev/input/mice, and drains /dev/dsp audio.
//
// Painting: host.attachFramebuffer(canvas) returns a FramebufferHandle; the
// host owns the requestAnimationFrame loop and BGRA→RGBA swizzle (see
// host/src/framebuffer/canvas-renderer.ts).
//
// Input: DOM keydown/keyup → scancode byte. Press-encoding is standard
// Linux MEDIUMRAW (bit 7 clear for press, set for release). Released on
// blur to keep the held set in sync.
//
// Focus management: canvas is tabindex=0 + click-to-focus. Ctrl+Shift+Esc
// is intercepted (NOT forwarded) and blurs the canvas — gives users a
// guaranteed way out.

import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import type {
  AudioOutputHandle,
  FramebufferHandle,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { PaneHead } from "./PaneHead";

const ICON = (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="2" width="10" height="7.5" rx="1" />
    <path d="M4 11h5M6.5 9.5v1.5" />
  </svg>
);

// DOM KeyboardEvent.code → Linux input keycode. For common PC keys, Linux
// MEDIUMRAW scancode numbers and evdev KEY_* codes share the same values.
const SCANCODES: Record<string, readonly number[]> = {
  Escape: [1],
  Digit1: [2], Digit2: [3], Digit3: [4], Digit4: [5], Digit5: [6],
  Digit6: [7], Digit7: [8], Digit8: [9], Digit9: [10], Digit0: [11],
  Minus: [12], Equal: [13], Backspace: [14], Tab: [15],
  KeyQ: [16], KeyW: [17], KeyE: [18], KeyR: [19], KeyT: [20],
  KeyY: [21], KeyU: [22], KeyI: [23], KeyO: [24], KeyP: [25],
  BracketLeft: [26], BracketRight: [27], Enter: [28], ControlLeft: [29],
  KeyA: [30], KeyS: [31], KeyD: [32], KeyF: [33], KeyG: [34],
  KeyH: [35], KeyJ: [36], KeyK: [37], KeyL: [38], Semicolon: [39],
  Quote: [40], Backquote: [41], ShiftLeft: [42], Backslash: [43],
  KeyZ: [44], KeyX: [45], KeyC: [46], KeyV: [47], KeyB: [48],
  KeyN: [49], KeyM: [50], Comma: [51], Period: [52], Slash: [53],
  ShiftRight: [54], NumpadMultiply: [55], AltLeft: [56], Space: [57],
  CapsLock: [58], F1: [59], F2: [60], F3: [61], F4: [62], F5: [63],
  F6: [64], F7: [65], F8: [66], F9: [67], F10: [68],
  ControlRight: [97], AltRight: [100],
  ArrowUp: [103], ArrowLeft: [105], ArrowRight: [106], ArrowDown: [108],
};

// DOM KeyboardEvent.code → Linux evdev KEY_* code. Keep this distinct from
// the stdin map so future terminal scancode quirks do not leak into evdev.
const EVDEV_KEYCODES: Record<string, number> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39,
  Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57,
  CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  ControlRight: 97, AltRight: 100,
  ArrowUp: 103, ArrowLeft: 105, ArrowRight: 106, ArrowDown: 108,
};

export interface FramebufferProps {
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
  autoFocus?: boolean;
}

export const Framebuffer: React.FC<FramebufferProps> = ({ dragProps, onCollapse, onMaximize, isMax, autoFocus = false }) => {
  const host = useKernelHost();
  const status = useStatus();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const handleRef = React.useRef<FramebufferHandle | null>(null);
  const audioRef = React.useRef<AudioOutputHandle | null>(null);
  const releaseTimersRef = React.useRef<number[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [boundPid, setBoundPid] = React.useState<number | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [hostCursor, setHostCursor] = React.useState({ visible: false, x: 0, y: 0 });

  React.useEffect(() => {
    if (status !== "running") return;
    if (!canvasRef.current) return;

    let handle: FramebufferHandle | null = null;
    let offBound: (() => void) | null = null;
    let cancelled = false;
    try {
      handle = host.attachFramebuffer(canvasRef.current);
      handleRef.current = handle;
      setBoundPid(handle.getBoundPid());
      offBound = handle.onBoundPidChange(setBoundPid);
      setError(null);
      void handle.startAudio().then((audio) => {
        if (cancelled) {
          audio?.close();
          return;
        }
        audioRef.current = audio;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      cancelled = true;
      try { audioRef.current?.close(); } catch { /* noop */ }
      audioRef.current = null;
      try { offBound?.(); } catch { /* noop */ }
      try { handle?.close(); } catch { /* noop */ }
      handleRef.current = null;
    };
  }, [host, status]);

  // Keyboard input → scancode bytes via stdin and key edges via evdev. We
  // dedup autorepeat client-side so framebuffer clients receive clean
  // physical key edges.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "running") return;
    const held = new Set<string>();

    const sendScancodes = (domCode: string, codes: readonly number[], pressed: boolean) => {
      const h = handleRef.current;
      if (!h) return;
      // Press: bit 7 clear; release: bit 7 set. Linux MEDIUMRAW.
      const bytes = new Uint8Array(codes.length);
      for (let i = 0; i < codes.length; i++) {
        bytes[i] = pressed ? codes[i] & 0x7f : codes[i] | 0x80;
      }
      h.sendInput(bytes);
      const evdevCode = EVDEV_KEYCODES[domCode];
      if (evdevCode !== undefined) h.sendKeyEvent(evdevCode, pressed);
    };
    const sendReleaseScancodes = (domCode: string, codes: readonly number[]) => {
      const timer = window.setTimeout(() => {
        releaseTimersRef.current = releaseTimersRef.current.filter((id) => id !== timer);
        if (handleRef.current?.getBoundPid() === null) return;
        sendScancodes(domCode, codes, false);
      }, 16);
      releaseTimersRef.current.push(timer);
    };

    const isReleaseCombo = (e: KeyboardEvent) =>
      e.ctrlKey && e.shiftKey && e.code === "Escape";

    const onDown = (e: KeyboardEvent) => {
      if (isReleaseCombo(e)) {
        // Intercept before forwarding so the release shortcut remains host-side.
        e.preventDefault();
        e.stopPropagation();
        canvas.blur();
        return;
      }
      const codes = SCANCODES[e.code];
      if (!codes) return;
      e.preventDefault();
      if (held.has(e.code)) return;
      held.add(e.code);
      sendScancodes(e.code, codes, true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (isReleaseCombo(e)) {
        e.preventDefault();
        return;
      }
      const codes = SCANCODES[e.code];
      if (!codes) return;
      e.preventDefault();
      held.delete(e.code);
      sendReleaseScancodes(e.code, codes);
    };
    const onBlur = () => {
      // Flush held keys so clients do not keep seeing a pressed key if focus
      // moves (e.g. user clicks the shell or hits the release combo).
      for (const k of held) {
        const codes = SCANCODES[k];
        if (codes) sendScancodes(k, codes, false);
      }
      held.clear();
      setFocused(false);
    };
    const onFocus = () => setFocused(true);

    canvas.addEventListener("keydown", onDown);
    canvas.addEventListener("keyup", onUp);
    canvas.addEventListener("blur", onBlur);
    canvas.addEventListener("focus", onFocus);
    return () => {
      for (const timer of releaseTimersRef.current) window.clearTimeout(timer);
      releaseTimersRef.current = [];
      canvas.removeEventListener("keydown", onDown);
      canvas.removeEventListener("keyup", onUp);
      canvas.removeEventListener("blur", onBlur);
      canvas.removeEventListener("focus", onFocus);
    };
  }, [status]);

  // Mouse input → /dev/input/mice via the framebuffer handle.
  //
  // For the desktop-style Kandelo pane, prefer the host OS cursor position:
  // map the browser pointer's CSS-pixel coordinates into framebuffer pixels,
  // then send the relative delta needed to move the guest cursor there. This
  // keeps pointer feel invariant when the canvas is CSS-scaled. Pointer Lock
  // remains supported as a fallback/capture path and is scaled by the same
  // framebuffer/CSS ratio.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || status !== "running") return;
    let mouseButtons = 0;
    let residualLockX = 0;
    let residualLockY = 0;
    let residualWheelY = 0;
    let pendingButtonTimer: number | null = null;
    let pendingButtonButtons: number | null = null;
    let pendingReleaseButtons: number | null = null;
    const buttonBit = (button: number) => button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
    const sendMouse = (dx: number, dy: number, buttons: number) => {
      handleRef.current?.sendMouseEvent(dx, dy, buttons);
    };
    const sendWheel = (delta: number) => {
      handleRef.current?.sendMouseWheelEvent(delta);
    };
    const isBound = () => typeof handleRef.current?.getBoundPid() === "number";
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const wholeDelta = (v: number) => v < 0 ? Math.ceil(v) : Math.floor(v);
    const updateHostCursor = (e: MouseEvent, visible = true) => {
      const body = bodyRef.current;
      if (!body || document.pointerLockElement === canvas || !isBound()) {
        setHostCursor((prev) => prev.visible ? { ...prev, visible: false } : prev);
        return;
      }
      const bodyRect = body.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const x = clamp(e.clientX, canvasRect.left, canvasRect.right) - bodyRect.left;
      const y = clamp(e.clientY, canvasRect.top, canvasRect.bottom) - bodyRect.top;
      setHostCursor({ visible, x, y });
    };
    const framebufferScale = () => {
      const rect = canvas.getBoundingClientRect();
      return {
        rect,
        sx: rect.width > 0 ? canvas.width / rect.width : 1,
        sy: rect.height > 0 ? canvas.height / rect.height : 1,
      };
    };
    const syncAbsolutePointer = (e: MouseEvent, forceReset = false) => {
      if (!isBound()) return;
      const { rect, sx, sy } = framebufferScale();
      const targetX = clamp(Math.round((e.clientX - rect.left) * sx), 0, Math.max(0, canvas.width - 1));
      const targetY = clamp(Math.round((e.clientY - rect.top) * sy), 0, Math.max(0, canvas.height - 1));
      handleRef.current?.sendPointerPosition(targetX, targetY, mouseButtons, { reset: forceReset });
    };
    const clearPendingButtonEdge = () => {
      if (pendingButtonTimer !== null) {
        window.clearTimeout(pendingButtonTimer);
        pendingButtonTimer = null;
      }
      pendingButtonButtons = null;
      pendingReleaseButtons = null;
    };
    const schedulePendingRelease = (buttons: number) => {
      pendingButtonTimer = window.setTimeout(() => {
        pendingButtonTimer = null;
        sendMouse(0, 0, buttons);
      }, 16);
    };
    const flushPendingButtonEdge = () => {
      pendingButtonTimer = null;
      const buttons = pendingButtonButtons;
      pendingButtonButtons = null;
      if (buttons === null) return;
      sendMouse(0, 0, buttons);
      if (pendingReleaseButtons !== null) {
        const releaseButtons = pendingReleaseButtons;
        pendingReleaseButtons = null;
        schedulePendingRelease(releaseButtons);
      }
    };
    const schedulePendingButtonEdge = (buttons: number) => {
      if (pendingButtonTimer !== null) window.clearTimeout(pendingButtonTimer);
      pendingButtonButtons = buttons;
      pendingButtonTimer = window.setTimeout(flushPendingButtonEdge, 16);
    };
    const releaseButtons = () => {
      clearPendingButtonEdge();
      if (mouseButtons === 0) return;
      mouseButtons = 0;
      sendMouse(0, 0, 0);
    };
    const onMove = (e: MouseEvent) => {
      if (!isBound()) return;
      updateHostCursor(e);
      if (document.pointerLockElement !== canvas) {
        syncAbsolutePointer(e);
        return;
      }
      const { sx, sy } = framebufferScale();
      const scaledX = e.movementX * sx + residualLockX;
      const scaledY = -(e.movementY * sy) + residualLockY;
      const dx = wholeDelta(scaledX);
      const dy = wholeDelta(scaledY);
      residualLockX = scaledX - dx;
      residualLockY = scaledY - dy;
      if (dx === 0 && dy === 0) return;
      sendMouse(dx, dy, mouseButtons);
    };
    const onDown = (e: MouseEvent) => {
      if (!isBound()) return;
      updateHostCursor(e);
      const bit = buttonBit(e.button);
      if (bit === 0) return;
      e.preventDefault();
      const pointerLocked = document.pointerLockElement === canvas;
      if (!pointerLocked) syncAbsolutePointer(e, true);
      mouseButtons |= bit;
      if (pointerLocked) {
        sendMouse(0, 0, mouseButtons);
      } else {
        schedulePendingButtonEdge(mouseButtons);
      }
    };
    const onUp = (e: MouseEvent) => {
      if (!isBound()) return;
      updateHostCursor(e);
      const bit = buttonBit(e.button);
      if (bit === 0) return;
      e.preventDefault();
      mouseButtons &= ~bit;
      if (pendingButtonButtons !== null) {
        pendingReleaseButtons = mouseButtons;
        return;
      }
      sendMouse(0, 0, mouseButtons);
    };
    const onWheel = (e: WheelEvent) => {
      if (!isBound()) return;
      const scale =
        e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 / 100 :
        e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 3 :
        1;
      residualWheelY += e.deltaY * scale;
      const ticks = wholeDelta(residualWheelY);
      if (ticks === 0) return;
      residualWheelY -= ticks;
      sendWheel(-ticks);
      e.preventDefault();
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onPointerLockChange = () => {
      setHostCursor((prev) => prev.visible ? { ...prev, visible: false } : prev);
      if (document.pointerLockElement !== canvas) releaseButtons();
    };
    const onEnter = (e: MouseEvent) => updateHostCursor(e);
    const onLeave = () => {
      setHostCursor((prev) => prev.visible ? { ...prev, visible: false } : prev);
      if (document.pointerLockElement !== canvas) releaseButtons();
    };

    canvas.addEventListener("mouseenter", onEnter);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    return () => {
      releaseButtons();
      clearPendingButtonEdge();
      setHostCursor((prev) => prev.visible ? { ...prev, visible: false } : prev);
      canvas.removeEventListener("mouseenter", onEnter);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
    };
  }, [boundPid, status]);

  React.useEffect(() => {
    if (!autoFocus || status !== "running" || error) return;
    const handle = window.requestAnimationFrame(() => {
      canvasRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [autoFocus, error, status]);

  const onCanvasClick = () => {
    canvasRef.current?.focus();
    void audioRef.current?.resume();
  };

  const showCanvas = status === "running" && !error;
  const showHint = showCanvas && boundPid === null;
  const captureLabel = focused
    ? "focused · Ctrl+Shift+Esc to release"
    : boundPid !== null ? "click to focus" : "waiting for /dev/fb0";

  return (
    <div className="kpane">
      <PaneHead
        icon={ICON}
        title={`FRAMEBUFFER · /DEV/FB0${boundPid !== null ? ` · pid ${boundPid}` : ""}`}
        dragProps={dragProps}
        onCollapse={onCollapse}
        onMaximize={onMaximize}
        isMax={isMax}
        right={
          <span style={{
            fontFamily: "var(--k-font-mono)",
            fontSize: 10,
            color: focused ? "var(--k-accent)" : "var(--k-text-faint)",
            padding: "2px 6px",
            borderRadius: 3,
            background: focused
              ? "color-mix(in oklch, var(--k-accent) 14%, transparent)"
              : "transparent",
            border: focused
              ? "1px solid color-mix(in oklch, var(--k-accent) 30%, transparent)"
              : "1px solid var(--k-border)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontWeight: 600,
          }}>
            {captureLabel}
          </span>
        }
      />
      <div ref={bodyRef} className="kpane-body" style={{
        background: "var(--k-fb-bg)",
        color: "var(--k-fb-text)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        position: "relative",
      }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onClick={onCanvasClick}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            imageRendering: "pixelated",
            background: "var(--k-fb-bg)",
            display: showCanvas ? "block" : "none",
            cursor: boundPid !== null ? "none" : "pointer",
            outline: focused
              ? "2px solid color-mix(in oklch, var(--k-accent) 60%, transparent)"
              : "none",
            outlineOffset: "-2px",
          }}
        />
        {showCanvas && boundPid !== null && hostCursor.visible && (
          <svg
            data-testid="framebuffer-host-cursor"
            aria-hidden="true"
            width="24"
            height="28"
            viewBox="0 0 24 28"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transform: `translate(${hostCursor.x - 2.5}px, ${hostCursor.y - 1.5}px)`,
              pointerEvents: "none",
              zIndex: 2,
              filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.35))",
            }}
          >
            <path
              d="M2.5 1.5v21.2l5.3-5.2 3.4 8.4 4.2-1.8-3.5-8.2h7.6L2.5 1.5Z"
              fill="white"
              stroke="black"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M4.4 5.8v12.4l3.9-3.8 3.2 7.7 1.1-.5-3.3-7.7h5.1L4.4 5.8Z"
              fill="black"
            />
          </svg>
        )}
        {showHint && !focused && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--k-font-mono)",
            fontSize: 11,
            color: "color-mix(in oklch, var(--k-fb-text) 60%, transparent)",
            pointerEvents: "none",
          }}>
            Waiting for a process to bind /dev/fb0.
          </div>
        )}
        {(error || status !== "running") && (
          <div style={{
            fontFamily: "var(--k-font-mono)",
            fontSize: 11,
            color: "color-mix(in oklch, var(--k-fb-text) 60%, transparent)",
            textAlign: "center",
            padding: 24,
          }}>
            {error
              ? <>attachFramebuffer failed: {error}</>
              : <>Waiting for the kernel to reach 'running'.</>}
          </div>
        )}
      </div>
    </div>
  );
};
