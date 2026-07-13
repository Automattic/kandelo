// Modeset pane — mirrors the Framebuffer pane: never spawns the renderer,
// only attaches an OffscreenCanvas + stats SAB for the kernel-worker's
// vblank pump. Stats slot layout is set by tickVblank in kernel-worker.ts.

import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import type { KmsDisplayHandle } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { injectChunkedMouseMotion, type MouseEventSink } from "@host/framebuffer/browser-controls";
import { DemoSurfaceDockControls } from "./Framebuffer";
import { useFittedCanvasStyle } from "./canvasFit";

// modeset.c hardcodes 1920×1080 (CANVAS_W/CANVAS_H). The kernel-side
// auto-attach resizes the OffscreenCanvas drawing buffer to match the
// FB before `getContext("webgl2")`, but the placeholder HTMLCanvas in
// the main thread keeps whatever `width`/`height` we set BEFORE
// `transferControlToOffscreen()`. We need correct attribute dims here
// so the pointer scaling math (`canvas.width / rect.width`) matches
// the framebuffer the wasm program actually paints into.
const MODESET_FB_W = 1920;
const MODESET_FB_H = 1080;

export interface ModesetProps {
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
  /** CRTC to bind the canvas to. Defaults to 1 (the single CRTC the
   *  kernel currently advertises via MODE_GETRESOURCES). */
  crtcId?: number;
}

interface KmsStats {
  width: number;
  height: number;
  commitCount: number;
  lastFrameUs: number;
}

const ZERO_STATS: KmsStats = {
  width: 0,
  height: 0,
  commitCount: 0,
  lastFrameUs: 0,
};

export const Modeset: React.FC<ModesetProps> = ({ crtcId = 1, onDockControlsChange }) => {
  const host = useKernelHost();
  const status = useStatus();
  const stageRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<KmsDisplayHandle | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<KmsStats>(ZERO_STATS);

  // Attach the canvas as soon as we have one and the kernel is up.
  React.useEffect(() => {
    if (status !== "running") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (handleRef.current) return;

    // Match the wasm program's framebuffer dims BEFORE
    // `transferControlToOffscreen()`. The placeholder HTMLCanvas keeps
    // these as its `.width`/`.height` attribute values after transfer;
    // the OffscreenCanvas inherits them too. Both matter:
    //   - The pointer scaler reads `canvas.width / rect.width` to map
    //     CSS deltas to framebuffer pixels. Default 300/150 would mean
    //     the cursor crawls at ~1/6 speed and Pavel's splats clump.
    //   - The OffscreenCanvas drawing buffer must be 1920×1080 so
    //     `glViewport(0, 0, 1920, 1080)` covers the full surface.
    if (canvas.width !== MODESET_FB_W) canvas.width = MODESET_FB_W;
    if (canvas.height !== MODESET_FB_H) canvas.height = MODESET_FB_H;

    try {
      const handle = host.attachKmsDisplay(canvas, crtcId);
      if (!handle) {
        setError("Kernel does not expose kmsAttachCanvas (older ABI?)");
        return;
      }
      handleRef.current = handle;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }

    return () => {
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [host, status, crtcId]);

  // Forward mouse motion + buttons into the kernel's `/dev/input/mice`.
  // The wasm side has no absolute-cursor input — it integrates int8
  // deltas from PS/2 packets — so we mirror the wasm cursor estimate
  // here (centered at the FB midpoint, matching modeset.c's initial
  // `cursor_x/y = CANVAS_W/H / 2`) and snap it to the OS pointer on
  // mouseenter with a synthetic teleport delta. Browser Y grows down,
  // PS/2 dy is positive-up, so flip once in `sendDelta`. Large jumps
  // get chunked into legal i8 packets — without that, a fast drag
  // wraps `(int8_t)pkt[1]` and `drain_mouse()` interprets it as the
  // opposite direction.
  React.useEffect(() => {
    if (status !== "running") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let prevCanvasX: number | null = null;
    let prevCanvasY: number | null = null;
    let wasmCursorX = MODESET_FB_W / 2;
    let wasmCursorY = MODESET_FB_H / 2;
    let buttons = 0;
    const buttonBit = (button: number) =>
      button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
    const sink: MouseEventSink = {
      injectMouseEvent: (dx, dy, bts) => {
        handleRef.current?.sendMouseEvent(dx, dy, bts);
      },
    };
    const toCanvasCoords = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.width > 0 ? ((clientX - rect.left) * canvas.width) / rect.width : 0,
        y: rect.height > 0 ? ((clientY - rect.top) * canvas.height) / rect.height : 0,
      };
    };
    const sendDelta = (dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return;
      injectChunkedMouseMotion(sink, dx, -dy, buttons);
      wasmCursorX += dx;
      wasmCursorY += dy;
    };
    const handlePointerAt = (canvasX: number, canvasY: number) => {
      if (prevCanvasX === null || prevCanvasY === null) {
        sendDelta(Math.round(canvasX - wasmCursorX), Math.round(canvasY - wasmCursorY));
      } else {
        sendDelta(Math.round(canvasX - prevCanvasX), Math.round(canvasY - prevCanvasY));
      }
      prevCanvasX = canvasX;
      prevCanvasY = canvasY;
    };
    const onMouseEnter = (e: MouseEvent) => {
      const c = toCanvasCoords(e.clientX, e.clientY);
      handlePointerAt(c.x, c.y);
    };
    const onMouseLeave = () => {
      prevCanvasX = null;
      prevCanvasY = null;
    };
    const onMouseMove = (e: MouseEvent) => {
      const c = toCanvasCoords(e.clientX, e.clientY);
      handlePointerAt(c.x, c.y);
    };
    const onMouseDown = (e: MouseEvent) => {
      const bit = buttonBit(e.button);
      if (bit === 0) return;
      e.preventDefault();
      buttons |= bit;
      handleRef.current?.sendMouseEvent(0, 0, buttons);
    };
    const onMouseUp = (e: MouseEvent) => {
      const bit = buttonBit(e.button);
      if (bit === 0) return;
      e.preventDefault();
      buttons &= ~bit;
      handleRef.current?.sendMouseEvent(0, 0, buttons);
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener("mouseenter", onMouseEnter);
    canvas.addEventListener("mouseleave", onMouseLeave);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("contextmenu", onContextMenu);
    // mouseup on the document so a release outside the canvas still
    // clears button state — matches fbDOOM's pointer-lock controls.
    const doc = canvas.ownerDocument;
    doc.addEventListener("mouseup", onMouseUp);
    return () => {
      canvas.removeEventListener("mouseenter", onMouseEnter);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("contextmenu", onContextMenu);
      doc.removeEventListener("mouseup", onMouseUp);
    };
  }, [status]);

  // Drain the stats SAB at 4 Hz. The numbers are advisory; rAF would
  // re-render every blit, which is overkill for a status panel.
  React.useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const tick = () => {
      const s = handle.stats;
      setStats({
        width: Atomics.load(s, 2),
        height: Atomics.load(s, 3),
        commitCount: Atomics.load(s, 5),
        lastFrameUs: Atomics.load(s, 6),
      });
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [status, error]);

  const showCanvas = status === "running" && !error;
  const hasFrame = stats.width > 0 && stats.height > 0;
  const canvasStyle = useFittedCanvasStyle(stageRef, canvasRef, MODESET_FB_W / MODESET_FB_H);
  const statusLabel = hasFrame
    ? `${stats.width}×${stats.height} · ${stats.commitCount} flips · ${stats.lastFrameUs}µs`
    : "waiting for PAGE_FLIP";
  const dockControls = React.useMemo(() => (
    <DemoSurfaceDockControls
      title={`MODESET · /DEV/DRI/CARD0 · CRTC ${crtcId}`}
      status={statusLabel}
      active={hasFrame}
    />
  ), [crtcId, hasFrame, statusLabel]);

  React.useEffect(() => {
    if (!onDockControlsChange) return;
    onDockControlsChange(dockControls);
    return () => onDockControlsChange(null);
  }, [dockControls, onDockControlsChange]);

  return (
    <div className="kmodeset-surface">
      <div className="kmodeset-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="kmodeset-canvas"
          style={{
            ...canvasStyle,
            display: showCanvas ? "block" : "none",
          }}
        />
        {showCanvas && !hasFrame && (
          <div className="kmodeset-waiting" role="status" aria-live="polite">
            <div className="kmodeset-waiting-line">Waiting for PAGE_FLIP on CRTC {crtcId}</div>
            <div className="kmodeset-waiting-line kmodeset-waiting-secondary">
              Run <code>modeset</code> from the shell.
            </div>
          </div>
        )}
        {(error || status !== "running") && (
          <div className="kmodeset-waiting" role="status" aria-live="polite">
            {error
              ? <>attachKmsDisplay failed: {error}</>
              : <>Waiting for the kernel to reach 'running'.</>}
          </div>
        )}
      </div>
    </div>
  );
};
