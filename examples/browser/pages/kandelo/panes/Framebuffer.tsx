// Framebuffer pane — paints whatever process is bound to /dev/fb0 and
// (when the canvas is focused) forwards keyboard input as AT-set-1 / Linux
// MEDIUMRAW scancodes to that process's stdin.
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
import { useKernelHost, useStatus } from "../kernel-host/react";
import type { FramebufferHandle } from "../../../../../host/src/kandelo-ui/kernel-host";
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
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<FramebufferHandle | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [boundPid, setBoundPid] = React.useState<number | null>(null);
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (status !== "running") return;
    if (!canvasRef.current) return;

    let handle: FramebufferHandle | null = null;
    let offBound: (() => void) | null = null;
    try {
      handle = host.attachFramebuffer(canvasRef.current);
      handleRef.current = handle;
      setBoundPid(handle.getBoundPid());
      offBound = handle.onBoundPidChange(setBoundPid);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      try { offBound?.(); } catch { /* noop */ }
      try { handle?.close(); } catch { /* noop */ }
      handleRef.current = null;
    };
  }, [host, status]);

  // Keyboard input → scancode bytes via the framebuffer handle. We dedup
  // autorepeat client-side because fbDOOM treats every press as a fresh
  // edge (auto-repeat would freeze the player on continuous keydown).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "running") return;
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
      sendScancodes(codes, false);
    };
    const onBlur = () => {
      // Flush held keys so the game doesn't keep walking if focus moves
      // (e.g. user clicks the shell or hits the release combo).
      for (const k of held) {
        const codes = SCANCODES[k];
        if (codes) sendScancodes(codes, false);
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
      canvas.removeEventListener("keydown", onDown);
      canvas.removeEventListener("keyup", onUp);
      canvas.removeEventListener("blur", onBlur);
      canvas.removeEventListener("focus", onFocus);
    };
  }, [status]);

  React.useEffect(() => {
    if (!autoFocus || status !== "running" || error) return;
    const handle = window.requestAnimationFrame(() => {
      canvasRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [autoFocus, error, status]);

  const onCanvasClick = () => {
    canvasRef.current?.focus();
  };

  const showCanvas = status === "running" && !error;
  const showHint = showCanvas && boundPid === null;
  const captureLabel = focused
    ? "captured · Ctrl+Shift+Esc to release"
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
      <div className="kpane-body" style={{
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
            cursor: focused ? "default" : "pointer",
            outline: focused
              ? "2px solid color-mix(in oklch, var(--k-accent) 60%, transparent)"
              : "none",
            outlineOffset: "-2px",
          }}
        />
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
