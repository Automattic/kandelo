// Framebuffer pane — paints whatever process is bound to /dev/fb0, forwards
// focused keyboard/mouse input according to the active demo presentation, and
// drains /dev/dsp audio.
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
// guaranteed way out without a DOOM-bound key collision.

import * as React from "react";
import { useKernelHost, usePresentation, useStatus } from "../kernel-host/react";
import {
  attachPointerLockMouse,
  injectChunkedMouseMotion,
  type PointerLockMouseHandle,
} from "../../../../../host/src/framebuffer/browser-controls";
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

// DOM KeyboardEvent.code → Linux input keycode.
//
// WASD aliases to arrow scancodes so the gamer-default movement keys work.
// Cheats containing W/A/S/D letters won't fire as a result — DOOM's cheat
// state machine sees KEY_*ARROW, not KEY_W/A/S/D. Cheats that avoid those
// letters (IDCLEV01, IDMUS, IDBEHOLD*) still work; "iddqd" and friends
// would need a fresh keyboard binding. We picked WASD movement as the
// primary tradeoff since it's the user-facing default for nearly every
// FPS, and DOOM's cheat letters mostly cluster around the right hand.
const SCANCODES: Record<string, readonly number[]> = {
  Escape: [1],
  Digit1: [2], Digit2: [3], Digit3: [4], Digit4: [5], Digit5: [6],
  Digit6: [7], Digit7: [8], Digit8: [9], Digit9: [10], Digit0: [11],
  Minus: [12], Equal: [13], Backspace: [14], Tab: [15],
  KeyQ: [16], KeyE: [18], KeyR: [19], KeyT: [20],
  KeyY: [21], KeyU: [22], KeyI: [23], KeyO: [24], KeyP: [25],
  BracketLeft: [26], BracketRight: [27], Enter: [28], ControlLeft: [29],
  KeyF: [33], KeyG: [34],
  KeyH: [35], KeyJ: [36], KeyK: [37], KeyL: [38], Semicolon: [39],
  Quote: [40], Backquote: [41], ShiftLeft: [42], Backslash: [43],
  KeyZ: [44], KeyX: [45], KeyC: [46], KeyV: [47], KeyB: [48],
  KeyN: [49], KeyM: [50], Comma: [51], Period: [52], Slash: [53],
  ShiftRight: [54], NumpadMultiply: [55], AltLeft: [56], Space: [57],
  CapsLock: [58], F1: [59], F2: [60], F3: [61], F4: [62], F5: [63],
  F6: [64], F7: [65], F8: [66], F9: [67], F10: [68],
  ControlRight: [97], AltRight: [100],
  // Arrows + WASD movement aliases — both map to Linux KEY_*ARROW
  // (KEY_UP=103, KEY_DOWN=108, KEY_LEFT=105, KEY_RIGHT=106). fbDOOM's
  // input layer dispatches movement on the arrow keys; this lets WASD
  // muscle memory drive the player.
  ArrowUp:    [103], KeyW: [103],
  ArrowDown:  [108], KeyS: [108],
  ArrowLeft:  [105], KeyA: [105],
  ArrowRight: [106], KeyD: [106],
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
  const presentation = usePresentation();
  const inputMode = presentation.framebufferInput ?? "relative-scancode";
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<FramebufferHandle | null>(null);
  const mouseRef = React.useRef<PointerLockMouseHandle | null>(null);
  const audioRef = React.useRef<AudioOutputHandle | null>(null);
  const releaseTimersRef = React.useRef<number[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [boundPid, setBoundPid] = React.useState<number | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [mouseCaptured, setMouseCaptured] = React.useState(false);
  const [visibleCursor, setVisibleCursor] = React.useState({ x: 0, y: 0, shown: false });

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

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "running") return;
    if (inputMode !== "relative-scancode") return;

    const mouse = attachPointerLockMouse(
      canvas,
      {
        injectMouseEvent: (dx, dy, buttons) => {
          handleRef.current?.sendMouseEvent(dx, dy, buttons);
        },
      },
      {
        requestPointerLockOnClick: false,
        getEnabled: () => handleRef.current?.getBoundPid() !== null,
        onCaptureChange: setMouseCaptured,
      },
    );
    mouseRef.current = mouse;
    return () => {
      mouse.close();
      mouseRef.current = null;
      setMouseCaptured(false);
    };
  }, [inputMode, status]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "running") return;
    if (inputMode !== "absolute-text") return;

    setMouseCaptured(false);
    let buttons = 0;
    let lastX = Math.floor(canvas.width / 2);
    let lastY = Math.floor(canvas.height / 2);
    const buttonBit = (button: number) => (button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0);

    const releaseButtons = () => {
      if (buttons === 0) return;
      buttons = 0;
      handleRef.current?.sendMouseEvent(0, 0, 0);
    };
    const canvasPoint = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
      const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
      return {
        x: Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) * scaleX))),
        y: Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - rect.top) * scaleY))),
      };
    };
    const updateVisibleCursor = (event: PointerEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      setVisibleCursor({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        shown: true,
      });
    };
    const hideVisibleCursor = () => setVisibleCursor((cursor) => ({ ...cursor, shown: false }));
    const sendChunkedMotion = (dx: number, dy: number) => {
      const handle = handleRef.current;
      if (!handle) return;
      injectChunkedMouseMotion({
        injectMouseEvent: (stepX, stepY, stepButtons) => {
          handle.sendMouseEvent(stepX, stepY, stepButtons);
        },
      }, dx, dy, buttons);
    };
    const syncPointerPosition = (event: PointerEvent, forceAbsolute = false) => {
      const point = canvasPoint(event);
      if (forceAbsolute) {
        sendChunkedMotion(-(canvas.width + 512), canvas.height + 512);
        sendChunkedMotion(point.x, -point.y);
        lastX = point.x;
        lastY = point.y;
        return;
      }
      const dx = point.x - lastX;
      const dy = lastY - point.y;
      lastX = point.x;
      lastY = point.y;
      if (dx === 0 && dy === 0) return;
      sendChunkedMotion(dx, dy);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      updateVisibleCursor(event);
      syncPointerPosition(event);
    };
    const onPointerEnter = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      updateVisibleCursor(event);
    };
    const onPointerLeave = () => {
      if (buttons === 0) hideVisibleCursor();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      const bit = buttonBit(event.button);
      if (bit === 0) return;
      event.preventDefault();
      updateVisibleCursor(event);
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      syncPointerPosition(event, true);
      buttons |= bit;
      handleRef.current?.sendMouseEvent(0, 0, buttons);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      const bit = buttonBit(event.button);
      if (bit === 0) return;
      event.preventDefault();
      updateVisibleCursor(event);
      syncPointerPosition(event);
      buttons &= ~bit;
      handleRef.current?.sendMouseEvent(0, 0, buttons);
      if (buttons === 0 && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };
    const onPointerCancel = (event: PointerEvent) => {
      releaseButtons();
      hideVisibleCursor();
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };
    const onBlur = () => {
      releaseButtons();
      hideVisibleCursor();
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    canvas.addEventListener("pointerenter", onPointerEnter);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("blur", onBlur);
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      releaseButtons();
      hideVisibleCursor();
      canvas.removeEventListener("pointerenter", onPointerEnter);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("blur", onBlur);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [boundPid, inputMode, status]);

  // Keyboard input → scancode bytes via the framebuffer handle. We dedup
  // autorepeat client-side because fbDOOM treats every press as a fresh
  // edge (auto-repeat would freeze the player on continuous keydown).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "running") return;

    if (inputMode === "absolute-text") {
      const special: Record<string, number> = {
        Backspace: 8,
        Tab: 9,
        Enter: 13,
        Escape: 27,
        ArrowLeft: 28,
        ArrowRight: 29,
        ArrowUp: 30,
        ArrowDown: 31,
        Delete: 127,
      };
      const onDown = (event: KeyboardEvent) => {
        if (event.metaKey || event.altKey) return;
        const code = special[event.key] ?? (event.key.length === 1 ? event.key.codePointAt(0) : undefined);
        if (code === undefined || code > 255) return;
        event.preventDefault();
        handleRef.current?.sendInput(new Uint8Array([code]));
      };
      const onBlur = () => setFocused(false);
      const onFocus = () => setFocused(true);
      canvas.addEventListener("keydown", onDown);
      canvas.addEventListener("blur", onBlur);
      canvas.addEventListener("focus", onFocus);
      return () => {
        canvas.removeEventListener("keydown", onDown);
        canvas.removeEventListener("blur", onBlur);
        canvas.removeEventListener("focus", onFocus);
      };
    }

    const held = new Set<string>();

    const sendScancodes = (codes: readonly number[], pressed: boolean) => {
      const h = handleRef.current;
      if (!h) return;
      // Press: bit 7 clear; release: bit 7 set. Linux MEDIUMRAW.
      const bytes = new Uint8Array(codes.length);
      for (let i = 0; i < codes.length; i++) {
        bytes[i] = pressed ? codes[i] & 0x7f : codes[i] | 0x80;
      }
      h.sendInput(bytes);
    };
    const sendReleaseScancodes = (codes: readonly number[]) => {
      const timer = window.setTimeout(() => {
        releaseTimersRef.current = releaseTimersRef.current.filter((id) => id !== timer);
        if (handleRef.current?.getBoundPid() === null) return;
        sendScancodes(codes, false);
      }, 16);
      releaseTimersRef.current.push(timer);
    };

    const isReleaseCombo = (e: KeyboardEvent) =>
      e.ctrlKey && e.shiftKey && e.code === "Escape";

    const onDown = (e: KeyboardEvent) => {
      if (isReleaseCombo(e)) {
        // Intercept BEFORE forwarding so DOOM never sees the combo.
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
      sendScancodes(codes, true);
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
      sendReleaseScancodes(codes);
    };
    const onBlur = () => {
      // Flush held keys so the game doesn't keep walking if focus moves
      // (e.g. user clicks the shell or hits the release combo).
      for (const k of held) {
        const codes = SCANCODES[k];
        if (codes) sendScancodes(codes, false);
      }
      held.clear();
      mouseRef.current?.releaseCapture();
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
  }, [inputMode, status]);

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
    if (inputMode === "relative-scancode") {
      mouseRef.current?.requestCapture();
    }
  };

  const showCanvas = status === "running" && !error;
  const showHint = showCanvas && boundPid === null;
  const captureLabel = inputMode === "absolute-text"
    ? focused
      ? "focused · visible mouse"
      : boundPid !== null ? "click to focus" : "waiting for /dev/fb0"
    : mouseCaptured
    ? "mouse locked · Esc to release"
    : focused
    ? "captured · click locks mouse"
    : boundPid !== null ? "click to play" : "waiting for /dev/fb0";

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
            color: focused || mouseCaptured ? "var(--k-accent)" : "var(--k-text-faint)",
            padding: "2px 6px",
            borderRadius: 3,
            background: focused || mouseCaptured
              ? "color-mix(in oklch, var(--k-accent) 14%, transparent)"
              : "transparent",
            border: focused || mouseCaptured
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
            cursor: inputMode === "absolute-text"
              ? "none"
              : inputMode === "relative-scancode" && mouseCaptured ? "none" : focused ? "default" : "pointer",
            outline: focused || mouseCaptured
              ? "2px solid color-mix(in oklch, var(--k-accent) 60%, transparent)"
              : "none",
            outlineOffset: "-2px",
          }}
        />
        {showCanvas && inputMode === "absolute-text" && visibleCursor.shown && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: visibleCursor.x,
              top: visibleCursor.y,
              width: 0,
              height: 0,
              pointerEvents: "none",
              zIndex: 3,
            }}
          >
            <div style={{
              width: 17,
              height: 23,
              background: "#fff",
              clipPath: "polygon(0 0, 0 78%, 22% 60%, 36% 100%, 52% 94%, 38% 56%, 66% 56%)",
              filter: "drop-shadow(1px 0 0 #000) drop-shadow(0 1px 0 #000) drop-shadow(-1px 0 0 #000) drop-shadow(0 -1px 0 #000)",
            }} />
          </div>
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
