// Modeset pane — mirrors the Framebuffer pane: never spawns the renderer,
// only attaches an OffscreenCanvas + stats SAB for the kernel-worker's
// vblank pump. Stats slot layout is set by tickVblank in kernel-worker.ts.

import * as React from "react";
import { useDemoIngest, useKernelHost, usePresentation, useStatus } from "../kernel-host/react";
import {
  KMS_PRIMARY_CRTC,
  type KmsDisplayHandle,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  runDemoIngest,
  type IngestPhase,
} from "../../../../../web-libs/kandelo-session/src/demo-ingest";
import { describeClipboardPasteFailure } from "../../../../../web-libs/kandelo-session/src/clipboard-paste";
import { injectChunkedMouseMotion, type MouseEventSink } from "@host/framebuffer/browser-controls";
import { pointerButtons } from "@host/input/pointer-buttons";
import { DemoSurfaceDockControls, IngestControl } from "./Framebuffer";
import { useDockActions } from "./DockActions";
import { useFittedCanvasStyle } from "./canvasFit";

// modeset.c hardcodes 1920×1080 (CANVAS_W/CANVAS_H). The kernel-side
// auto-attach resizes the OffscreenCanvas drawing buffer to match the
// FB before `getContext("webgl2")`. The placeholder HTMLCanvas in the
// main thread keeps whatever `width`/`height` we set BEFORE
// `transferControlToOffscreen()` only until the worker commits a
// differently-sized bitmap — Chrome then reflects the committed size
// back into the placeholder attributes (observed: the webgl2-scanout
// presenter's display-sized buffer shows up in `canvas.width`). The
// pointer math therefore maps through the kernel-reported scanout
// dims (stats slots 2/3, `fbDims` below). These constants only seed the
// canvas; input waits for the guest's actual scanout dimensions.
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
  presentCount: number;
  lastFrameUs: number;
  /** Vblank-pump presenter id from stats slot 7: 1 = legacy 2d blit,
   *  2 = WebGL2 scanout presenter, 3 = program-owned WebGL2 (the app —
   *  e.g. a GPU compositor — renders the canvas itself; pump stood
   *  down), 0 = pump not painting this canvas. */
  renderer: number;
}

const ZERO_STATS: KmsStats = {
  width: 0,
  height: 0,
  commitCount: 0,
  presentCount: 0,
  lastFrameUs: 0,
  renderer: 0,
};

const RENDERER_LABELS: Record<number, string> = { 1: "2d", 2: "webgl2", 3: "webgl2-gl" };

export const Modeset: React.FC<ModesetProps> = ({ crtcId = KMS_PRIMARY_CRTC, onDockControlsChange }) => {
  const host = useKernelHost();
  const status = useStatus();
  const presentation = usePresentation();
  const ingest = useDemoIngest();
  const [ingestPhase, setIngestPhase] = React.useState<IngestPhase | null>(null);
  const [ingestName, setIngestName] = React.useState<string | null>(null);
  const [ingestError, setIngestError] = React.useState<string | null>(null);
  // A paste gesture over the machine that never reached the guest (the
  // `clipboard` runtime feature). Shown until dismissed or replaced.
  const [pasteError, setPasteError] = React.useState<string | null>(null);
  React.useEffect(
    () => host.subscribeClipboardPasteFailures((failure) => {
      setPasteError(describeClipboardPasteFailure(failure));
    }),
    [host],
  );
  const stageRef = React.useRef<HTMLDivElement>(null);
  const slotRef = React.useRef<HTMLDivElement>(null);
  const handleRef = React.useRef<KmsDisplayHandle | null>(null);
  // The same handle as state, for effects that must start once it exists
  // (the stats drain); input callbacks read handleRef.
  const [handle, setHandle] = React.useState<KmsDisplayHandle | null>(null);
  const [canvas, setCanvas] = React.useState<HTMLCanvasElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<KmsStats>(ZERO_STATS);
  // The flip counter tells a dock action when its replacement is drawing.
  const readPresentCount = React.useCallback(() => {
    const counters = handleRef.current?.stats;
    return counters ? Atomics.load(counters, 0) : 0;
  }, []);
  const dockActions = useDockActions("kms", status === "running" ? stats.presentCount : null,
    undefined, readPresentCount);

  // Mount the host's display canvas for this CRTC rather than rendering one:
  // a program's WebGL context is bound to that canvas for good, so a
  // remounted pane must show the same element (see
  // KernelHost.kmsDisplayCanvas). The slot is React-childless, so React
  // never reconciles the canvas; on unmount the canvas leaves with the old
  // slot, and the next mount's appendChild moves it here.
  //
  // The size is the wasm program's framebuffer, set before
  // `transferControlToOffscreen()`: the placeholder HTMLCanvas keeps it as
  // its `.width`/`.height` after transfer, and the OffscreenCanvas inherits
  // it too. The drawing buffer must be 1920×1080 so
  // `glViewport(0, 0, 1920, 1080)` covers the full surface. (The pointer
  // scaler does NOT read `canvas.width` — it maps through the live scanout
  // dims in stats slots 2/3, `fbDims` below.)
  React.useLayoutEffect(() => {
    if (status !== "booting" && status !== "running") return;
    const slot = slotRef.current;
    if (!slot) return;
    const display = host.kmsDisplayCanvas(crtcId, { width: MODESET_FB_W, height: MODESET_FB_H });
    display.classList.add("kmodeset-canvas");
    display.tabIndex = 0;
    const cursor = host.kmsCursorCanvas(crtcId);
    cursor.classList.add("kmodeset-cursor");
    cursor.setAttribute("aria-hidden", "true");
    if (display.parentNode !== slot) slot.replaceChildren(display, cursor);
    setCanvas(display);
  }, [host, status, crtcId]);

  // Attach the canvas as soon as we have one and the kernel is up. The pane
  // mounts during boot (MachineView) — hidden, but laid out — so attaching
  // then lets the display report its size before the machine's command
  // starts a mode-picking client.
  React.useEffect(() => {
    if (status !== "booting" && status !== "running") return;
    if (!canvas) return;
    if (handleRef.current) return;

    try {
      const attached = host.attachKmsDisplay(canvas, crtcId);
      if (!attached) {
        setError("Kernel does not expose kmsAttachCanvas (older ABI?)");
        return;
      }
      handleRef.current = attached;
      setHandle(attached);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }

    return () => {
      handleRef.current?.close();
      handleRef.current = null;
      setHandle(null);
    };
  }, [host, status, crtcId, canvas]);

  // Forward pointer motion + buttons into the kernel's `/dev/input/mice`.
  // Pointer events cover mouse, touch, and pen with one listener set; a
  // touch acts as a left-button mouse. The wasm side has no
  // absolute-cursor input — it integrates int8 deltas from PS/2 packets
  // — so we mirror the wasm cursor estimate here (centered at the FB
  // midpoint, matching modeset.c's initial `cursor_x/y = CANVAS_W/H / 2`)
  // and snap it to the OS pointer on pointerenter (or a touch press)
  // with a synthetic teleport delta. Browser Y grows down, PS/2 dy is
  // positive-up, so flip once in `sendDelta`. Large jumps get chunked
  // into legal i8 packets — without that, a fast drag wraps
  // `(int8_t)pkt[1]` and `drain_mouse()` interprets it as the opposite
  // direction.
  React.useEffect(() => {
    if (status !== "running") return;
    if (!canvas) return;

    let prevCanvasX: number | null = null;
    let prevCanvasY: number | null = null;
    let wasmCursorX = MODESET_FB_W / 2;
    let wasmCursorY = MODESET_FB_H / 2;
    let buttons = 0;
    let activePointerId: number | null = null;
    const sink: MouseEventSink = {
      injectMouseEvent: (dx, dy, bts) => {
        handleRef.current?.sendMouseEvent(dx, dy, bts);
      },
    };
    // The framebuffer dimensions the pointer math must map into. Do NOT
    // read `canvas.width` here: after `transferControlToOffscreen()` the
    // placeholder's width/height reflect whatever bitmap the worker last
    // committed — under the webgl2-scanout presenter that's the DISPLAY
    // size, not the framebuffer. The kernel publishes the real scanout
    // dims in stats slots 2/3. Before the first frame there is no valid
    // input coordinate space, even if layout emits pointerenter.
    const fbDims = () => {
      const s = handleRef.current?.stats;
      const w = s && Atomics.load(s, 2);
      const h = s && Atomics.load(s, 3);
      return w && h && w > 0 && h > 0 ? { w, h } : null;
    };
    const toCanvasCoords = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const dims = fbDims();
      if (!dims || rect.width <= 0 || rect.height <= 0) return null;
      // The framebuffer keeps its aspect ratio inside the element with
      // letterbox bars — via CSS `object-fit: contain` when the bitmap
      // is fb-sized (2d / GL-owned modes), or via the webgl2-scanout
      // presenter's GL viewport when the bitmap tracks the display
      // size. Both letterbox the framebuffer into the element with the
      // same contain math, so one mapping covers every mode: map
      // through the fitted content box, clamping bar-area pointers to
      // the nearest framebuffer edge.
      const { w: fbW, h: fbH } = dims;
      const scale = Math.min(rect.width / fbW, rect.height / fbH);
      const offX = rect.left + (rect.width - fbW * scale) / 2;
      const offY = rect.top + (rect.height - fbH * scale) / 2;
      const clamp = (v: number, max: number) =>
        Math.min(Math.max(v, 0), max);
      return {
        x: clamp((clientX - offX) / scale, fbW - 1),
        y: clamp((clientY - offY) / scale, fbH - 1),
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
    // Absolute-position pointer feed for evdev consumers (SDL2's
    // KMSDRM backend reads `/dev/input/event1`, which the PS/2
    // `sendMouseEvent` path above does NOT reach). `toCanvasCoords`
    // already maps the OS pointer into framebuffer pixels (0..width-1),
    // matching the kernel's inclusive ABS_X/Y bounds. SDL scales those
    // bounds to inclusive display pixels. modeset.c ignores
    // event1 (it reads PS/2 /dev/input/mice), so feeding both is safe.
    let lastAbsX = wasmCursorX;
    let lastAbsY = wasmCursorY;
    const sendAbs = (canvasX: number, canvasY: number) => {
      lastAbsX = canvasX;
      lastAbsY = canvasY;
      handleRef.current?.sendPointerAbs(canvasX, canvasY, buttons);
    };
    const updatePointer = (e: PointerEvent, phase: "down" | "move" | "up", allowPresses: boolean) => {
      const c = toCanvasCoords(e.clientX, e.clientY);
      if (!c) return;
      const next = pointerButtons(buttons, e, phase, allowPresses);
      // Deliver the new position before the button edge in both feeds.
      handlePointerAt(c.x, c.y);
      if (next !== buttons) {
        buttons = next;
        handleRef.current?.sendMouseEvent(0, 0, buttons);
      }
      if (e.buttons === 0) activePointerId = null;
      sendAbs(c.x, c.y);
    };
    const onPointerEnter = (e: PointerEvent) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      if (e.pointerType === "touch") return;
      updatePointer(e, "move", false);
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      if (e.pointerType === "touch") return;
      prevCanvasX = null;
      prevCanvasY = null;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      if (e.pointerType === "touch" && e.pointerId !== activePointerId) return;
      updatePointer(e, "move", e.pointerId === activePointerId);
    };
    const onPointerDown = (e: PointerEvent) => {
      // One pointer owns a gesture. Another finger, pen, or hovering mouse
      // must not overwrite its position or clear its button snapshot.
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      activePointerId = e.pointerId;
      e.preventDefault();
      // Return keyboard focus from dock controls to the guest surface.
      // The image-declared evdev source scopes capture to this surface.
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      updatePointer(e, "down", true);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      if (e.pointerType === "touch") {
        if (e.pointerId !== activePointerId) return;
        prevCanvasX = null;
        prevCanvasY = null;
      }
      e.preventDefault();
      updatePointer(e, "up", false);
      activePointerId = null;
    };
    const releasePointer = () => {
      activePointerId = null;
      prevCanvasX = null;
      prevCanvasY = null;
      if (buttons === 0) return;
      buttons = 0;
      handleRef.current?.sendMouseEvent(0, 0, 0);
      // SDL reads evdev, independently of the legacy PS/2 stream. Both
      // devices must observe the release, at the last pointer position.
      sendAbs(lastAbsX, lastAbsY);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      releasePointer();
    };
    const onLostPointerCapture = (e: PointerEvent) => {
      if (e.pointerId === activePointerId) releasePointer();
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener("pointerenter", onPointerEnter);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    // Pointer capture routes up/cancel to the canvas even when the
    // pointer is released outside it, so button state clears without a
    // document-level mouseup listener.
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("lostpointercapture", onLostPointerCapture);
    window.addEventListener("blur", releasePointer);
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      releasePointer();
      canvas.removeEventListener("pointerenter", onPointerEnter);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      window.removeEventListener("blur", releasePointer);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [status, canvas]);

  // Drain the stats SAB at 4 Hz. The numbers are advisory; rAF would
  // re-render every blit, which is overkill for a status panel.
  React.useEffect(() => {
    if (!handle) return;
    const tick = () => {
      const s = handle.stats;
      setStats({
        width: Atomics.load(s, 2),
        height: Atomics.load(s, 3),
        commitCount: Atomics.load(s, 5),
        presentCount: Atomics.load(s, 0),
        lastFrameUs: Atomics.load(s, 6),
        renderer: s.length > 7 ? Atomics.load(s, 7) : 0,
      });
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [handle]);

  // Laid out whenever it is attached (booting too): its ResizeObserver is how
  // the display reports its size before the machine's command picks a video
  // mode. While booting the pane's slot is hidden, so nothing shows early.
  const showCanvas = (status === "booting" || status === "running") && !error;
  const hasFrame = stats.width > 0 && stats.height > 0;
  // Fit to the live scanout aspect, not the 16:9 constant: a program that
  // takes the connector's mode renders at the pane's aspect, and fitting
  // that into a fixed 16:9 box would letterbox and stretch it. The
  // constants remain the pre-first-frame fallback.
  const canvasStyle = useFittedCanvasStyle(
    stageRef,
    canvas,
    hasFrame ? stats.width / stats.height : MODESET_FB_W / MODESET_FB_H,
  );
  // React does not render the canvas, so it cannot style it either.
  React.useLayoutEffect(() => {
    if (!canvas) return;
    canvas.style.width = typeof canvasStyle.width === "string" ? canvasStyle.width : "";
    canvas.style.height = typeof canvasStyle.height === "string" ? canvasStyle.height : "";
    // The guest owns the pointer: motion is forwarded into the kernel's
    // pointer device, and a guest that draws its own cursor would stack a
    // second arrow under the browser's, the two drifting apart whenever
    // the guest's cursor and the OS pointer disagree. A guest that draws
    // no cursor declares `hostPointer` so the browser keeps drawing one.
    canvas.style.cursor = presentation.hostPointer ? "default" : "none";
    const cursor = host.kmsCursorCanvas(crtcId);
    cursor.style.width = canvas.style.width;
    cursor.style.height = canvas.style.height;
  }, [canvas, canvasStyle, presentation.hostPointer, host, crtcId]);
  const statusLabel = hasFrame
    ? `${stats.width}×${stats.height} · ${stats.commitCount} flips · ${stats.lastFrameUs}µs` +
      (RENDERER_LABELS[stats.renderer] ? ` · ${RENDERER_LABELS[stats.renderer]}` : "")
    : "waiting for PAGE_FLIP";

  const busy = ingestPhase !== null;
  const ingestFile = React.useCallback(async (file: File) => {
    if (!ingest || ingestPhase !== null) return;
    setIngestError(null);
    setIngestName(file.name);
    try {
      // No targetPid: an upload here adds files the running program reads on
      // its next directory scan. The KMS program holds DRM master for the
      // whole session, so stopping and relaunching it would cost the user
      // their place for no gain.
      await runDemoIngest(host, ingest, file, { onPhase: setIngestPhase });
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : String(err));
    } finally {
      setIngestPhase(null);
      setIngestName(null);
    }
  }, [host, ingest, ingestPhase]);

  const dockControls = React.useMemo(() => (
    <DemoSurfaceDockControls
      title={`MODESET · /DEV/DRI/CARD0 · CRTC ${crtcId}`}
      status={statusLabel}
      active={hasFrame}
    >
      {dockActions.controls}
      {ingest && status === "running" && (
        <IngestControl
          accept={ingest.accept}
          label={ingest.label ?? "Load file"}
          busy={busy}
          busyLabel={ingestName ? `loading ${ingestName}…` : "loading…"}
          testIdPrefix="kms"
          onFile={ingestFile}
        />
      )}
    </DemoSurfaceDockControls>
  ), [busy, crtcId, dockActions.controls, hasFrame, ingest, ingestFile, ingestName, status, statusLabel]);

  React.useEffect(() => {
    if (!onDockControlsChange) return;
    onDockControlsChange(dockControls);
    return () => onDockControlsChange(null);
  }, [dockControls, onDockControlsChange]);

  return (
    <div className="kmodeset-surface">
      <div className="kmodeset-stage" ref={stageRef}>
        {/* Holds the host's display canvas (mounted above); `contents`
            keeps the canvas a direct flex item of the stage. */}
        <div
          ref={slotRef}
          className="kmodeset-canvas-slot"
          style={{ display: showCanvas ? "contents" : "none" }}
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
        {dockActions.toasts}
        {busy && (
          <div className="kdemo-toast" data-testid="kms-ingest-busy">
            {ingestName ? `loading ${ingestName}…` : "loading…"}
          </div>
        )}
        {ingestError && !busy && (
          <div
            className="kdemo-toast"
            data-error="true"
            data-testid="kms-ingest-error"
            role="alert"
          >
            {ingestError}
            <button
              type="button"
              className="kdemo-toast-dismiss"
              onClick={() => setIngestError(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {pasteError && !busy && !ingestError && (
          <div
            className="kdemo-toast"
            data-error="true"
            data-testid="kms-paste-error"
            role="alert"
          >
            {pasteError}
            <button
              type="button"
              className="kdemo-toast-dismiss"
              onClick={() => setPasteError(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
