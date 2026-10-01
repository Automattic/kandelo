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
import {
  useDemoCheckpoint,
  useDemoIngest,
  useDemoLibrary,
  useKernelHost,
  usePresentation,
  useStatus,
} from "../kernel-host/react";
import { LibraryDrawer, type LibraryPick } from "./Library";
import { DockIconButton, PowerIcon, ResetIcon, SaveStateIcon } from "./DockIconButton";
import {
  attachLinuxMediumRawKeyboard,
  attachPointerLockMouse,
  type PointerLockMouseHandle,
} from "../../../../../host/src/framebuffer/browser-controls";
import type {
  BootDescriptor,
  DemoIngestSource,
  FramebufferHandle,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { DemoLibraryConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import {
  IngestError,
  runDemoIngest,
  startDemoProgram,
  stopDemoProgram,
  waitForProcessExit,
  type IngestFileLike,
  type IngestPhase,
} from "../../../../../web-libs/kandelo-session/src/demo-ingest";
import {
  createCheckpointBootInputs,
  INGEST_PATH_PARAMETER,
} from "../../../../../web-libs/kandelo-session/src/demo-checkpoint";
import { composeShareDescriptor } from "../../../../../web-libs/kandelo-session/src/share-link";
import { encodeBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import { useFittedCanvasStyle } from "./canvasFit";
import {
  createTouchKeySender,
  KEY_ENTER,
  KEY_SPACE,
  TOUCH_TAP_SLOP_PX,
  TouchControls,
  useCoarsePointer,
  type TouchKeySender,
} from "./TouchControls";

const FRAMEBUFFER_LAUNCH_TIMEOUT_MS = 60_000;
const SAVED_NOTICE_MS = 2_000;

/** What the dock names as running: a title, and the library group it is in. */
interface LoadedContent {
  title: string;
  group?: string;
}

/**
 * What a freshly booted machine runs, as far as its boot says: a library
 * file the boot link delivered, an image file it named by path, or the
 * image's declared default. Null when none of those says.
 */
function bootedContent(
  library: DemoLibraryConfig | null,
  descriptor: BootDescriptor,
): LoadedContent | null {
  if (!library) return null;
  const input = descriptor.boot.inputs?.find((entry) => entry.id === library.inputId);
  if (input) return { title: input.filename };
  const path = descriptor.boot.parameters?.[INGEST_PATH_PARAMETER];
  const named = library.bundled?.find((entry) =>
    typeof path === "string" ? entry.path === path : entry.default === true);
  return named ? { title: named.title, ...(named.group ? { group: named.group } : {}) } : null;
}

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
  const library = useDemoLibrary();
  const checkpoint = useDemoCheckpoint();
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [content, setContent] = React.useState<LoadedContent | null>(
    () => bootedContent(library, host.getBootDescriptor()),
  );
  const [control, setControl] = React.useState<string | null>(null);
  const [stateSaved, setStateSaved] = React.useState(false);
  // Power off is a state of the machine the dock put it in, distinct from
  // "nothing has bound /dev/fb0 yet" while it boots.
  const [poweredOff, setPoweredOff] = React.useState(false);
  const [hasBound, setHasBound] = React.useState(false);
  // The address-bar fragment that holds a checkpoint of this machine's
  // current content: one Save state wrote, or the link this page booted from
  // when that link carried a checkpoint.
  const savedHashRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!checkpoint || !window.location.hash.startsWith("#k1=")) return;
    const booted = host.getBootDescriptor().boot.inputs ?? [];
    if (booted.some((input) => input.id === checkpoint.inputId)) {
      savedHashRef.current ??= window.location.hash;
    }
  }, [checkpoint, host]);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
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
      const onBound = (pid: number | null) => {
        setBoundPid(pid);
        if (pid !== null) {
          setHasBound(true);
          setPoweredOff(false);
        }
      };
      onBound(handle.getBoundPid());
      offBound = handle.onBoundPidChange(onBound);
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

  /**
   * Watch a program start, from before its command is dispatched, until a
   * new process owns /dev/fb0. Started first so no event is missed.
   *
   * WHY not just a timeout: how long a start takes depends on the image's
   * launcher, on fetching a lazy program the first time, and on the network,
   * so a short limit fails real starts (a 10 s one failed SNES on WebKit), and
   * a long one leaves a launcher that refused a file "loading" for a minute.
   * The start has failed when every process spawned since the watch began
   * has exited without binding, and that is reported at once.
   */
  const watchFbLaunch = React.useCallback((): { done: Promise<void>; cancel: () => void } => {
    const handle = handleRef.current;
    let cancel = () => {};
    const done = new Promise<void>((resolve, reject) => {
      if (!handle) {
        reject(new Error("framebuffer handle disappeared during restart"));
        return;
      }
      const previous = handle.getBoundPid();
      const alive = new Set<number>();
      let spawned = false;
      let settled = false;
      let offBound = () => {};
      let offProcs = () => {};
      const timer = window.setTimeout(() => finish(new Error(
        `nothing took /dev/fb0 within ${FRAMEBUFFER_LAUNCH_TIMEOUT_MS / 1000} s `
          + "of starting the program; the terminal shows its output",
      )), FRAMEBUFFER_LAUNCH_TIMEOUT_MS);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        offBound();
        offProcs();
        if (error) reject(error);
        else resolve();
      };
      cancel = () => finish(new Error("cancelled"));
      offBound = handle.onBoundPidChange((next) => {
        if (next !== null && next !== previous) finish();
      });
      // Events for a short-lived process may arrive exit-first, so an exit
      // seen before its spawn is remembered rather than left "alive" forever.
      const exited = new Set<number>();
      offProcs = host.subscribeProcessEvents((event) => {
        if (event.kind === "spawn") {
          spawned = true;
          if (!exited.delete(event.pid)) alive.add(event.pid);
        } else if (event.kind === "exit") {
          if (!alive.delete(event.pid)) {
            exited.add(event.pid);
            return;
          }
        } else {
          return;
        }
        if (spawned && alive.size === 0 && handle.getBoundPid() === null) {
          finish(new Error(
            "the program exited without taking /dev/fb0; the terminal shows its output",
          ));
        }
      });
    });
    done.catch(() => {});
    return { done, cancel };
  }, [host]);

  const ingestFile = React.useCallback(async (
    file: IngestFileLike,
    source?: DemoIngestSource,
    loaded?: LoadedContent,
  ) => {
    if (!ingest || ingestPhase !== null || control !== null) return;
    setIngestError(null);
    setIngestName(file.name);
    const launch = ingest.onLoad ? watchFbLaunch() : null;
    try {
      await runDemoIngest(host, ingest, file, {
        targetPid: handleRef.current?.getBoundPid() ?? null,
        waitForRelease: waitForFbRelease,
        onPhase: setIngestPhase,
        ...(source ? { source } : {}),
      });
      setContent(loaded ?? { title: file.name });
      // A checkpoint in the address bar belongs to what ran before;
      // reloading it would restore that, not this.
      if (savedHashRef.current !== null && window.location.hash === savedHashRef.current) {
        const url = new URL(window.location.href);
        url.hash = "";
        window.history.replaceState(window.history.state, "", url.href);
      }
      savedHashRef.current = null;
      // runDemoIngest returns as soon as the relaunch is dispatched; keep the
      // indicator up until the new process actually owns the framebuffer.
      await launch?.done;
    } catch (err) {
      setIngestError(
        err instanceof IngestError ? err.message
          : err instanceof Error ? err.message
          : String(err),
      );
      throw err;
    } finally {
      launch?.cancel();
      setIngestPhase(null);
      setIngestName(null);
    }
  }, [control, host, ingest, ingestPhase, watchFbLaunch, waitForFbRelease]);

  const closeLibrary = React.useCallback(() => setLibraryOpen(false), []);

  const pickFromLibrary = React.useCallback(async (pick: LibraryPick) => {
    await ingestFile({
      name: pick.name,
      size: pick.bytes.byteLength,
      arrayBuffer: async () => Uint8Array.from(pick.bytes).buffer,
    }, pick.source, {
      title: (pick.source.kind === "image"
        ? library?.bundled?.find((entry) =>
          pick.source.kind === "image" && entry.path === pick.source.path)?.title
        : undefined) ?? pick.name,
      ...(pick.group ? { group: pick.group } : {}),
    });
    setLibraryOpen(false);
  }, [ingestFile, library]);

  /** One dock control at a time; its failure is shown like an ingest's. */
  const runControl = React.useCallback(async (label: string, step: () => Promise<void>) => {
    if (control !== null || ingestPhase !== null) return;
    setControl(label);
    setIngestError(null);
    try {
      await step();
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : String(err));
    } finally {
      setControl(null);
    }
  }, [control, ingestPhase]);

  const startWatched = async () => {
    if (!ingest) return;
    const launch = watchFbLaunch();
    try {
      await startDemoProgram(host, ingest);
      await launch.done;
    } finally {
      launch.cancel();
    }
  };

  // Reset and power act on the program the image's ingest restarts, which is
  // whatever owns /dev/fb0. They use the same stop and start an ingest does.
  const reset = () => void runControl("resetting…", async () => {
    const pid = handleRef.current?.getBoundPid() ?? null;
    if (!ingest || pid === null) return;
    await stopDemoProgram(host, pid, { waitForRelease: waitForFbRelease });
    await startWatched();
  });

  const togglePower = () => void runControl(
    boundPid === null ? "powering on…" : "powering off…",
    async () => {
      const pid = handleRef.current?.getBoundPid() ?? null;
      if (!ingest) return;
      if (pid !== null) {
        await stopDemoProgram(host, pid, { waitForRelease: waitForFbRelease });
        setPoweredOff(true);
      } else {
        await startWatched();
      }
    },
  );

  // Save state: the same checkpoint link Share builds, written into the
  // address bar in place, so reloading or bookmarking the page restores it.
  const saveState = () => void runControl("saving state…", async () => {
    if (!checkpoint) return;
    const descriptor = host.getBootDescriptor();
    const linked = composeShareDescriptor(descriptor, {
      checkpoint: await createCheckpointBootInputs(host, checkpoint, descriptor.boot),
    })!;
    const { fragment } = await encodeBootDescriptor(linked);
    const url = new URL(window.location.href);
    url.hash = fragment;
    window.history.replaceState(window.history.state, "", url.href);
    savedHashRef.current = url.hash;
    setStateSaved(true);
  });
  React.useEffect(() => {
    if (!stateSaved) return;
    const timer = window.setTimeout(() => setStateSaved(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [stateSaved]);

  const switchGroup = (group: string) => {
    const entry = library?.bundled?.find((candidate) => candidate.group === group);
    if (!entry || busy) return;
    void (async () => {
      let bytes: Uint8Array;
      try {
        bytes = await host.readFile(entry.path);
      } catch (err) {
        setIngestError(`could not read ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await ingestFile(
        {
          name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
          size: bytes.byteLength,
          arrayBuffer: async () => Uint8Array.from(bytes).buffer,
        },
        { kind: "image", path: entry.path },
        { title: entry.title, group },
      );
    })().catch(() => {});
  };

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
    ? "mouse locked · Esc to release"
    : focused
    ? "captured · click locks mouse"
    : boundPid !== null ? "click to play" : "waiting for /dev/fb0";
  const canvasStyle = useFittedCanvasStyle(stageRef, canvasRef, 16 / 10);
  const busy = ingestPhase !== null || control !== null;
  const running = status === "running";
  const switchable = library?.groups.filter((group) =>
    library.bundled?.some((entry) => entry.group === group.label)) ?? [];
  const busyLabel = control ?? (ingestName ? `loading ${ingestName}…` : "loading…");
  const dockStatus = busy
    ? busyLabel
    : stateSaved
      ? "state saved to link"
      : poweredOff && boundPid === null
        ? "powered off"
        : captureLabel;
  const dockControls = React.useMemo(() => (
    <DemoSurfaceDockControls
      title={`FRAMEBUFFER · /DEV/FB0${boundPid !== null ? ` · pid ${boundPid}` : ""}`}
      status={dockStatus}
      active={focused || mouseCaptured}
    >
      {ingest && running && switchable.length > 1 && (
        <div className="kfb-system-switcher" role="group" aria-label="Switch to">
          {switchable.map((group) => (
            <button
              key={group.label}
              type="button"
              aria-pressed={content?.group === group.label}
              data-testid={`fb-group-${group.label}`}
              disabled={busy}
              title={`Load ${group.label}'s included file`}
              onClick={() => { if (content?.group !== group.label) switchGroup(group.label); }}
            >
              {group.label}
            </button>
          ))}
        </div>
      )}
      {ingest && running && content && (
        <span className="kfb-current-rom" title={content.title} data-testid="fb-current-content">
          <span>NOW</span>
          {content.title}
        </span>
      )}
      {ingest?.onLoad && running && (
        <div className="kfb-icon-pill" role="group" aria-label="Machine controls">
          <DockIconButton
            label={boundPid === null ? "Power on" : "Power off"}
            icon={PowerIcon}
            testId="fb-power"
            active={boundPid !== null}
            disabled={busy || (boundPid === null && !hasBound)}
            onClick={togglePower}
          />
          <DockIconButton
            label="Reset"
            icon={ResetIcon}
            testId="fb-reset"
            disabled={busy || boundPid === null}
            onClick={reset}
          />
          {checkpoint && (
            <DockIconButton
              label={stateSaved ? "State saved to the address bar" : "Save state to the address bar"}
              icon={SaveStateIcon}
              testId="fb-save-state"
              disabled={busy || boundPid === null}
              onClick={saveState}
            />
          )}
        </div>
      )}
      {ingest && running && (
        <div className="kfb-load-rom-split" role="group" aria-label={ingest.label ?? "Load file"}>
          <input
            ref={fileInputRef}
            type="file"
            accept={ingest.accept.join(",")}
            data-testid="fb-ingest-input"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so re-picking the same file fires change again.
              e.target.value = "";
              if (file) void ingestFile(file).catch(() => {});
            }}
          />
          <button
            type="button"
            className={library ? "kfb-load-rom" : "kfb-load-rom kfb-load-rom-only"}
            data-testid="fb-ingest-button"
            disabled={busy}
            title={`${ingest.label ?? "Load file"} (or drop one onto the screen)`}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy && ingestPhase !== null ? busyLabel : library ? "From file…" : ingest.label ?? "Load file"}
          </button>
          {library && (
            <button
              type="button"
              className="kfb-load-rom-archive"
              data-testid="fb-library-button"
              disabled={busy}
              aria-haspopup="dialog"
              aria-expanded={libraryOpen}
              onClick={() => setLibraryOpen(true)}
            >
              Search
            </button>
          )}
        </div>
      )}
    </DemoSurfaceDockControls>
    // The control callbacks close over state already listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [boundPid, busy, busyLabel, checkpoint, content, dockStatus, focused, hasBound, ingest, ingestPhase, library, libraryOpen, mouseCaptured, running, stateSaved, switchable.length]);

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
      if (file) void ingestFile(file).catch(() => {});
    },
  } : {};

  return (
    <div
      className="kframebuffer-surface"
      ref={stageRef}
      data-drag-active={dragActive ? "true" : "false"}
      {...dropHandlers}
    >
      {ingest && library && (
        <LibraryDrawer
          open={libraryOpen}
          library={library}
          ingest={ingest}
          {...(content?.group ? { group: content.group } : {})}
          disabled={busy}
          onClose={closeLibrary}
          onPick={pickFromLibrary}
        />
      )}
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
    {/* WHY the badge comes before the actions: its text changes as the
        display gains and loses focus, and pressing an action blurs the
        display. With the actions after it they stay anchored to the right
        edge; before this, the release of a press landed on whichever button
        had slid under the pointer, and the click went nowhere (WebKit). */}
    <span className="kdemo-surface-badge" data-active={active ? "true" : "false"}>
      {status}
    </span>
    {children}
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
