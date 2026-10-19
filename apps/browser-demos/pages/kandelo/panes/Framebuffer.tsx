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
import { useDemoIngest, useKernelHost, usePresentation, useStatus } from "../kernel-host/react";
import {
  attachLinuxMediumRawKeyboard,
  attachPointerLockMouse,
  type PointerLockMouseHandle,
} from "../../../../../host/src/framebuffer/browser-controls";
import type { FramebufferHandle } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  IngestError,
  runDemoIngest,
  stopDeviceOwner,
  waitForProcessExit,
  type IngestPhase,
} from "../../../../../web-libs/kandelo-session/src/demo-ingest";
import { useFittedCanvasStyle } from "./canvasFit";
import { useDockActions } from "./DockActions";
import {
  createTouchKeySender,
  KEY_ENTER,
  KEY_SPACE,
  TOUCH_TAP_SLOP_PX,
  TouchControls,
  useCoarsePointer,
  type TouchKeySender,
} from "./TouchControls";

const FRAMEBUFFER_REBIND_TIMEOUT_MS = 10_000;
const CAPTURE_LABELS = [
  "mouse locked · Esc to release",
  "captured · click locks mouse",
  "click to play",
  "waiting for /dev/fb0",
] as const;

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
  const ingest = useDemoIngest();
  const presentation = usePresentation();
  const coarsePointer = useCoarsePointer();
  const stageRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<FramebufferHandle | null>(null);
  const mouseRef = React.useRef<PointerLockMouseHandle | null>(null);
  const touchSenderRef = React.useRef<TouchKeySender | null>(null);
  if (touchSenderRef.current === null) {
    touchSenderRef.current = createTouchKeySender({
      sendInput: (bytes) => handleRef.current?.sendInput(bytes),
    });
  }
  const touchSender = touchSenderRef.current;
  const touchTapRef = React.useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [boundPid, setBoundPid] = React.useState<number | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [mouseCaptured, setMouseCaptured] = React.useState(false);
  const [ingestPhase, setIngestPhase] = React.useState<IngestPhase | null>(null);
  const [ingestName, setIngestName] = React.useState<string | null>(null);
  const [ingestError, setIngestError] = React.useState<string | null>(null);
  const [dragActive, setDragActive] = React.useState(false);

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

  // /dev/fb0 is single-owner: the kernel returns EBUSY on a second open. The
  // replacement emulator therefore cannot start until the outgoing one has
  // both exited *and* had its binding torn down by the kernel's exit path.
  // Those are two separate observations, so wait for both before relaunching.
  const waitForFbRelease = React.useCallback((
    pid: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const handle = handleRef.current;
    const unbound = new Promise<void>((resolve, reject) => {
      let settled = false;
      let off = () => {};
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        off();
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(
        new Error(`wait for /dev/fb0 release by pid ${pid} was cancelled`),
      );
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      if (!handle || handle.getBoundPid() !== pid) {
        finish();
        return;
      }
      off = handle.onBoundPidChange((next) => {
        if (next !== pid) finish();
      });
      if (settled) off();
    });
    return Promise.all([
      waitForProcessExit(host, pid, { signal }),
      unbound,
    ]).then(() => {});
  }, [host]);

  // A dock action replaces the program on the display. A game reading its
  // keyboard through a raw-mode terminal takes Ctrl+C as a keypress, so end
  // the /dev/fb0 owner the way Load WAD does; with no owner, interrupt the
  // shell's foreground program as other panes do.
  const stopDisplayProgram = React.useCallback(async () => {
    const pid = handleRef.current?.getBoundPid() ?? null;
    if (pid === null) {
      await host.interruptShellForeground({ timeoutMs: FRAMEBUFFER_REBIND_TIMEOUT_MS });
      return;
    }
    await stopDeviceOwner(host, pid, {
      waitForRelease: waitForFbRelease,
      timeoutMs: FRAMEBUFFER_REBIND_TIMEOUT_MS,
    });
  }, [host, waitForFbRelease]);
  const dockActions = useDockActions("fb", null, stopDisplayProgram);

  /** Resolve boundedly once some process has bound /dev/fb0 again. */
  const waitForFbBind = React.useCallback((): Promise<void> => {
    const handle = handleRef.current;
    return new Promise<void>((resolve, reject) => {
      if (!handle) {
        reject(new Error("framebuffer handle disappeared during restart"));
        return;
      }
      let settled = false;
      let off = () => {};
      const timer = window.setTimeout(() => {
        finish(new Error(
          `replacement did not bind /dev/fb0 within `
            + `${FRAMEBUFFER_REBIND_TIMEOUT_MS}ms`,
        ));
      }, FRAMEBUFFER_REBIND_TIMEOUT_MS);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        off();
        if (error) reject(error);
        else resolve();
      };
      off = handle.onBoundPidChange((next) => {
        if (next !== null) finish();
      });
      if (handle.getBoundPid() !== null) finish();
      if (settled) off();
    });
  }, []);

  const ingestFile = React.useCallback(async (file: File) => {
    if (!ingest || ingestPhase !== null) return;
    setIngestError(null);
    setIngestName(file.name);
    try {
      await runDemoIngest(host, ingest, file, {
        targetPid: handleRef.current?.getBoundPid() ?? null,
        waitForRelease: waitForFbRelease,
        onPhase: setIngestPhase,
      });
      // runDemoIngest returns as soon as the relaunch is dispatched; keep the
      // indicator up until the new process actually owns the framebuffer.
      await waitForFbBind();
    } catch (err) {
      setIngestError(
        err instanceof IngestError ? err.message
          : err instanceof Error ? err.message
          : String(err),
      );
    } finally {
      setIngestPhase(null);
      setIngestName(null);
    }
  }, [host, ingest, ingestPhase, waitForFbBind, waitForFbRelease]);

  const showCanvas = status === "running" && !error;
  const showHint = showCanvas && boundPid === null;
  const showTouchControls =
    presentation.touchControls === true && coarsePointer && showCanvas && boundPid !== null;

  // A tap on the framebuffer itself sends Enter and Space: the DOOM menu reads
  // Enter (select) and ignores Space, the game reads Space (use) and ignores
  // Enter, so one gesture covers both without overlay buttons.
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== "touch" || !showTouchControls) return;
    touchTapRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = touchTapRef.current;
    if (!start || e.pointerId !== start.pointerId) return;
    touchTapRef.current = null;
    if (!showTouchControls) return;
    const moved =
      Math.abs(e.clientX - start.x) > TOUCH_TAP_SLOP_PX ||
      Math.abs(e.clientY - start.y) > TOUCH_TAP_SLOP_PX;
    if (!moved) {
      touchSender.tap(KEY_ENTER);
      touchSender.tap(KEY_SPACE);
    }
  };
  const onCanvasPointerCancel = () => {
    touchTapRef.current = null;
  };
  const captureLabel = mouseCaptured
    ? CAPTURE_LABELS[0]
    : focused
    ? CAPTURE_LABELS[1]
    : boundPid !== null ? CAPTURE_LABELS[2] : CAPTURE_LABELS[3];
  const canvasStyle = useFittedCanvasStyle(stageRef, canvasRef, 16 / 10);
  const busy = ingestPhase !== null;
  const dockControls = React.useMemo(() => (
    <DemoSurfaceDockControls
      title={`FRAMEBUFFER · /DEV/FB0${boundPid !== null ? ` · pid ${boundPid}` : ""}`}
      status={captureLabel}
      reserve={CAPTURE_LABELS}
      active={focused || mouseCaptured}
    >
      {dockActions.controls}
      {ingest && status === "running" && (
        <IngestControl
          accept={ingest.accept}
          label={ingest.label ?? "Load file"}
          busy={busy}
          busyLabel={ingestName ? `loading ${ingestName}…` : "loading…"}
          testIdPrefix="fb"
          onFile={ingestFile}
        />
      )}
    </DemoSurfaceDockControls>
  ), [boundPid, busy, captureLabel, dockActions.controls, focused, ingest, ingestFile, ingestName, mouseCaptured, status]);

  React.useEffect(() => {
    if (!onDockControlsChange) return;
    onDockControlsChange(dockControls);
    return () => onDockControlsChange(null);
  }, [dockControls, onDockControlsChange]);

  // Drag-and-drop is an enhancement over the always-present dock button, so it
  // is wired only when the image declares an ingest capability.
  const dropHandlers = ingest && status === "running" ? {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (!busy) setDragActive(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragActive(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void ingestFile(file);
    },
  } : {};

  return (
    <div
      className="kframebuffer-surface"
      ref={stageRef}
      data-drag-active={dragActive ? "true" : "false"}
      {...dropHandlers}
    >
      <canvas
        ref={canvasRef}
        className="kframebuffer-canvas"
        tabIndex={0}
        onClick={onCanvasClick}
        onPointerDown={onCanvasPointerDown}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerCancel}
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
      {showTouchControls && <TouchControls sender={touchSender} />}
      {showHint && !focused && (
        <div style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--k-font-mono)",
          fontSize: 11,
          background: "var(--k-fb-bg)",
          color: "var(--k-text-muted)",
          pointerEvents: "none",
        }}>
          Waiting for a process to bind /dev/fb0.
        </div>
      )}
      {dragActive && !busy && (
        <div className="kframebuffer-dropzone" data-testid="fb-dropzone">
          Drop {ingest?.accept.join(" / ")} to load
        </div>
      )}
      {dockActions.toasts}
      {busy && (
        <div className="kdemo-toast" data-testid="fb-ingest-busy">
          {ingestName ? `loading ${ingestName}…` : "loading…"}
        </div>
      )}
      {ingestError && !busy && (
        <div
          className="kdemo-toast"
          data-error="true"
          data-testid="fb-ingest-error"
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
      {(error || status !== "running") && (
        <div style={{
          fontFamily: "var(--k-font-mono)",
          fontSize: 11,
          color: "var(--k-text-muted)",
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

/**
 * The display pane's dock row. The badge sits right of the actions, so a
 * badge that changes width moves every action button. `reserve` lists every
 * message the badge can show; the badge keeps the width of the widest, so
 * focusing a button (which changes the focus message) cannot slide it away
 * from the pointer.
 */
export const DemoSurfaceDockControls: React.FC<{
  title: string;
  status: string;
  reserve?: readonly string[];
  active?: boolean;
  children?: React.ReactNode;
}> = ({ title, status, reserve = [], active = false, children }) => (
  <div className="kdemo-surface-controls">
    <span className="kdemo-surface-title">{title}</span>
    <span className="kdemo-surface-spacer" />
    {children}
    <span className="kdemo-surface-badge" data-active={active ? "true" : "false"}>
      <span className="kdemo-surface-badge-text">{status}</span>
      {reserve.map((text) => (
        <span key={text} className="kdemo-surface-badge-text" data-reserve="true" aria-hidden="true">
          {text}
        </span>
      ))}
    </span>
  </div>
);

/**
 * The primary ingest path: a real <input type="file">, so it works on every
 * platform including touch, where drag-and-drop does not exist.
 */
export const IngestControl: React.FC<{
  accept: string[];
  label: string;
  busy: boolean;
  busyLabel: string;
  /** Surface that owns this control, so two panes get distinct test ids. */
  testIdPrefix: string;
  onFile: (file: File) => void;
}> = ({ accept, label, busy, busyLabel, testIdPrefix, onFile }) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(",")}
        data-testid={`${testIdPrefix}-ingest-input`}
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so re-picking the same file fires change again.
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      <button
        type="button"
        className="kdemo-surface-action"
        data-testid={`${testIdPrefix}-ingest-button`}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? busyLabel : label}
      </button>
    </>
  );
};
