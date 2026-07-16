// Framebuffer pane — paints whatever process is bound to /dev/fb0, forwards
// focused keyboard input as Linux input keycodes encoded in MEDIUMRAW, forwards
// pointer-lock mouse input to /dev/input/mice. PCM output is machine-level.
//
// Painting: host.attachFramebuffer(canvas) returns a FramebufferHandle; the
// host owns the requestAnimationFrame loop and BGRA→RGBA swizzle (see
// host/src/framebuffer/canvas-renderer.ts).
//
// Input: DOM keydown/keyup → Linux input keycode byte. Press-encoding is
// standard Linux MEDIUMRAW (bit 7 clear for press, set for release). Released
// on blur to keep the held set in sync.
//
// Focus management: canvas is tabindex=0 + click-to-focus. While focused and
// bound, the framebuffer process receives keyboard events; click another pane
// or press Ctrl+Shift+Esc to move focus back to the UI.

import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import {
  attachLinuxMediumRawKeyboard,
  attachPointerLockMouse,
  type PointerLockMouseHandle,
} from "../../../../../host/src/framebuffer/browser-controls";
import type { FramebufferHandle } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { useFittedCanvasStyle } from "./canvasFit";

export interface FramebufferProps {
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
  autoFocus?: boolean;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
}

export const Framebuffer: React.FC<FramebufferProps> = ({ autoFocus = false, onDockControlsChange }) => {
  const host = useKernelHost();
  const status = useStatus();
  const stageRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<FramebufferHandle | null>(null);
  const mouseRef = React.useRef<PointerLockMouseHandle | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [boundPid, setBoundPid] = React.useState<number | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [mouseCaptured, setMouseCaptured] = React.useState(false);

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

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "running") return;

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
  }, [status]);

  // Keyboard input → Linux MEDIUMRAW bytes via the framebuffer handle. The
  // helper captures the focused canvas's key stream and leaves interpretation
  // to the framebuffer process.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (status !== "running") return;
    const keyboard = attachLinuxMediumRawKeyboard(
      canvas,
      {
        sendInput: (bytes) => handleRef.current?.sendInput(bytes),
      },
      {
        getEnabled: () => handleRef.current?.getBoundPid() !== null,
        onReleaseCapture: () => canvas.blur(),
        releaseDelayMs: 16,
      },
    );
    const onBlur = () => {
      mouseRef.current?.releaseCapture();
      setFocused(false);
    };
    const onFocus = () => setFocused(true);

    canvas.addEventListener("blur", onBlur);
    canvas.addEventListener("focus", onFocus);
    return () => {
      keyboard.close();
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
    void host.resumeAudio().catch(() => {});
    mouseRef.current?.requestCapture();
  };

  const showCanvas = status === "running" && !error;
  const showHint = showCanvas && boundPid === null;
  const captureLabel = mouseCaptured
    ? "mouse locked · Esc to release"
    : focused
    ? "captured · click locks mouse"
    : boundPid !== null ? "click to play" : "waiting for /dev/fb0";
  const canvasStyle = useFittedCanvasStyle(stageRef, canvasRef, 16 / 10);
  const dockControls = React.useMemo(() => (
    <DemoSurfaceDockControls
      title={`FRAMEBUFFER · /DEV/FB0${boundPid !== null ? ` · pid ${boundPid}` : ""}`}
      status={captureLabel}
      active={focused || mouseCaptured}
    />
  ), [boundPid, captureLabel, focused, mouseCaptured]);

  React.useEffect(() => {
    if (!onDockControlsChange) return;
    onDockControlsChange(dockControls);
    return () => onDockControlsChange(null);
  }, [dockControls, onDockControlsChange]);

  return (
    <div className="kframebuffer-surface" ref={stageRef}>
      <canvas
        ref={canvasRef}
        className="kframebuffer-canvas"
        tabIndex={0}
        onClick={onCanvasClick}
        style={{
          ...canvasStyle,
          display: showCanvas ? "block" : "none",
          cursor: mouseCaptured ? "none" : focused ? "default" : "pointer",
          outline: focused || mouseCaptured
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
  );
};

export const DemoSurfaceDockControls: React.FC<{
  title: string;
  status: string;
  active?: boolean;
}> = ({ title, status, active = false }) => (
  <div className="kdemo-surface-controls">
    <span className="kdemo-surface-title">{title}</span>
    <span className="kdemo-surface-badge" data-active={active ? "true" : "false"}>
      {status}
    </span>
  </div>
);
