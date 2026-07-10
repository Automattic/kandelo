// Framebuffer pane — paints whatever process is bound to /dev/fb0, forwards
// focused keyboard input as Linux input keycodes encoded in MEDIUMRAW, forwards
// pointer-lock mouse input to /dev/input/mice, and drains /dev/dsp audio.
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
import { useDemoIngest, useKernelHost, useStatus } from "../kernel-host/react";
import {
  attachLinuxMediumRawKeyboard,
  attachPointerLockMouse,
  type PointerLockMouseHandle,
} from "../../../../../host/src/framebuffer/browser-controls";
import type {
  AudioOutputHandle,
  FramebufferHandle,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  IngestError,
  runDemoIngest,
  waitForProcessExit,
  type IngestPhase,
} from "../../../../../web-libs/kandelo-session/src/demo-ingest";
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
  const ingest = useDemoIngest();
  const stageRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<FramebufferHandle | null>(null);
  const mouseRef = React.useRef<PointerLockMouseHandle | null>(null);
  const audioRef = React.useRef<AudioOutputHandle | null>(null);
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
    void audioRef.current?.resume();
    mouseRef.current?.requestCapture();
  };

  // /dev/fb0 is single-owner: the kernel returns EBUSY on a second open. The
  // replacement emulator therefore cannot start until the outgoing one has
  // both exited *and* had its binding torn down by the kernel's exit path.
  // Those are two separate observations, so wait for both before relaunching.
  const waitForFbRelease = React.useCallback((pid: number): Promise<void> => {
    const handle = handleRef.current;
    const unbound = new Promise<void>((resolve) => {
      if (!handle || handle.getBoundPid() !== pid) {
        resolve();
        return;
      }
      const off = handle.onBoundPidChange((next) => {
        if (next !== pid) {
          off();
          resolve();
        }
      });
    });
    return Promise.all([waitForProcessExit(host, pid), unbound]).then(() => {});
  }, [host]);

  /** Resolve once some process has bound /dev/fb0 again. */
  const waitForFbBind = React.useCallback((): Promise<void> => {
    const handle = handleRef.current;
    return new Promise<void>((resolve) => {
      if (!handle || handle.getBoundPid() !== null) {
        resolve();
        return;
      }
      const off = handle.onBoundPidChange((next) => {
        if (next !== null) {
          off();
          resolve();
        }
      });
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
  const captureLabel = mouseCaptured
    ? "mouse locked · Esc to release"
    : focused
    ? "captured · click locks mouse"
    : boundPid !== null ? "click to play" : "waiting for /dev/fb0";
  const canvasStyle = useFittedCanvasStyle(stageRef, canvasRef, 16 / 10);
  const busy = ingestPhase !== null;
  const dockControls = React.useMemo(() => (
    <DemoSurfaceDockControls
      title={`FRAMEBUFFER · /DEV/FB0${boundPid !== null ? ` · pid ${boundPid}` : ""}`}
      status={captureLabel}
      active={focused || mouseCaptured}
    >
      {ingest && status === "running" && (
        <IngestControl
          accept={ingest.accept}
          label={ingest.label ?? "Load file"}
          busy={busy}
          busyLabel={ingestName ? `loading ${ingestName}…` : "loading…"}
          onFile={ingestFile}
        />
      )}
    </DemoSurfaceDockControls>
  ), [boundPid, busy, captureLabel, focused, ingest, ingestFile, ingestName, mouseCaptured, status]);

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
      {dragActive && !busy && (
        <div className="kframebuffer-dropzone" data-testid="fb-dropzone">
          Drop {ingest?.accept.join(" / ")} to load
        </div>
      )}
      {busy && (
        <div className="kframebuffer-toast" data-testid="fb-ingest-busy">
          {ingestName ? `loading ${ingestName}…` : "loading…"}
        </div>
      )}
      {ingestError && !busy && (
        <div
          className="kframebuffer-toast"
          data-error="true"
          data-testid="fb-ingest-error"
          role="alert"
        >
          {ingestError}
          <button
            type="button"
            className="kframebuffer-toast-dismiss"
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
  children?: React.ReactNode;
}> = ({ title, status, active = false, children }) => (
  <div className="kdemo-surface-controls">
    <span className="kdemo-surface-title">{title}</span>
    <span className="kdemo-surface-spacer" />
    {children}
    <span className="kdemo-surface-badge" data-active={active ? "true" : "false"}>
      {status}
    </span>
  </div>
);

/**
 * The primary ingest path: a real <input type="file">, so it works on every
 * platform including touch, where drag-and-drop does not exist.
 */
const IngestControl: React.FC<{
  accept: string[];
  label: string;
  busy: boolean;
  busyLabel: string;
  onFile: (file: File) => void;
}> = ({ accept, label, busy, busyLabel, onFile }) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(",")}
        data-testid="fb-ingest-input"
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
        data-testid="fb-ingest-button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? busyLabel : label}
      </button>
    </>
  );
};
