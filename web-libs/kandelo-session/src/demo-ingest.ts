// Reusable "bring your own file" ingest for demos that consume a single
// author-declared input file — a NES ROM, a DOOM WAD, a disk image.
//
// The capability is declared in the VFS image (`/etc/kandelo/demo.json` →
// `ingest`) and executed here. Nothing in this module knows what the bytes
// mean, and no part of the uploaded file other than its bytes influences what
// happens: the destination is the config's fixed `targetPath`, and the
// relaunch command is the config's author-provided `onLoad.restart`.
//
// Restarting matters because the interesting consumers hold a single-owner
// device. `/dev/fb0` returns EBUSY on a second open (kernel
// `acquire_fb0_or_busy`), so a new instance cannot start until the old one has
// exited and the kernel's exit path has released the binding.

import type { DemoIngestConfig } from "./demo-config";
import type { KernelHost } from "./kernel-host";

/** POSIX SIGTERM. Default disposition terminates a process with no handler. */
export const SIGTERM = 15;

export type IngestRejection =
  | "extension"
  | "too-large"
  | "empty"
  | "write-failed"
  | "restart-failed";

/** A rejection the UI is expected to show the user verbatim. */
export class IngestError extends Error {
  readonly reason: IngestRejection;
  constructor(reason: IngestRejection, message: string) {
    super(message);
    this.name = "IngestError";
    this.reason = reason;
  }
}

export type IngestPhase = "validating" | "writing" | "stopping" | "starting" | "done";

/** Minimal file shape — a DOM `File` satisfies it; tests can pass a literal. */
export interface IngestFileLike {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RunDemoIngestOptions {
  /**
   * The process to stop before relaunching, or null if nothing is running.
   * Callers resolve this from whatever owns the resource — the framebuffer
   * pane passes the current /dev/fb0 holder.
   */
  targetPid?: number | null;
  /**
   * Resolves once the stopped process has released what the replacement needs.
   * Defaults to "the pid emitted an exit event". The framebuffer pane passes a
   * stricter wait that also observes the /dev/fb0 unbind, because the exit
   * event and the device release are two separate observations and relaunching
   * between them would hit EBUSY.
   */
  waitForRelease?: (pid: number) => Promise<void>;
  onPhase?: (phase: IngestPhase) => void;
  /** How long to wait for the old process to go away. */
  stopTimeoutMs?: number;
}

/** Lowercase extension of a filename, including the dot. "" when none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Check a candidate file against the declared policy. Pure and synchronous, so
 * the UI can reject before reading a single byte off disk.
 */
export function validateIngestFile(ingest: DemoIngestConfig, file: IngestFileLike): void {
  const ext = extensionOf(file.name);
  if (!ingest.accept.includes(ext)) {
    throw new IngestError(
      "extension",
      `${file.name || "file"}: expected ${ingest.accept.join(" or ")}`,
    );
  }
  if (file.size <= 0) {
    throw new IngestError("empty", `${file.name}: file is empty`);
  }
  if (file.size > ingest.maxBytes) {
    throw new IngestError(
      "too-large",
      `${file.name}: ${formatBytes(file.size)} exceeds the ` +
      `${formatBytes(ingest.maxBytes)} limit`,
    );
  }
}

/**
 * Validate, write to the declared path, then hand off to a fresh process.
 *
 * Ordering is deliberate: the write happens *before* the running process is
 * signalled. A rejected or failed write then leaves the current program
 * untouched and on screen, rather than killing it and leaving a blank pane.
 */
export async function runDemoIngest(
  host: KernelHost,
  ingest: DemoIngestConfig,
  file: IngestFileLike,
  options: RunDemoIngestOptions = {},
): Promise<void> {
  const {
    targetPid = null,
    waitForRelease,
    onPhase = () => {},
    stopTimeoutMs = 10_000,
  } = options;

  onPhase("validating");
  validateIngestFile(ingest, file);
  const bytes = new Uint8Array(await file.arrayBuffer());

  onPhase("writing");
  try {
    await host.writeFile(ingest.targetPath, bytes, 0o644);
  } catch (err) {
    throw new IngestError(
      "write-failed",
      `could not write ${ingest.targetPath}: ${errorText(err)}`,
    );
  }

  if (!ingest.onLoad) {
    onPhase("done");
    return;
  }

  if (targetPid !== null) {
    onPhase("stopping");
    // Start watching before signalling, or a fast exit lands before we listen.
    // A caller-supplied wait owns its own teardown; ours must clean up.
    const exitWatch = waitForRelease ? null : abortableWaitForProcessExit(host, targetPid);
    const released = waitUntil(
      waitForRelease ? waitForRelease(targetPid) : exitWatch!.promise,
      stopTimeoutMs,
      `process ${targetPid} did not exit within ${stopTimeoutMs}ms`,
    );
    // If signalProcess throws we never await `released`; keep its eventual
    // timeout rejection from surfacing as an unhandled rejection.
    released.catch(() => {});
    try {
      // An already-dead pid resolves false; the release wait then settles on
      // its own (the exit already happened) or times out truthfully.
      await host.signalProcess(targetPid, SIGTERM);
      await released;
    } catch (err) {
      throw new IngestError(
        "restart-failed",
        `wrote ${ingest.targetPath} but could not stop pid ${targetPid}: ${errorText(err)}`,
      );
    } finally {
      exitWatch?.cancel();
    }
  }

  onPhase("starting");
  // Fire-and-forget, exactly like `presentation.autoCommand`: the command runs
  // a long-lived foreground program, so it never returns to a shell prompt and
  // awaiting it would hang. Callers observe the restart by watching the
  // resource get reacquired.
  void host.runShellCommand(ingest.onLoad.restart).catch(() => {});
  onPhase("done");
}

/** Resolve when `pid` emits an exit event. */
export function waitForProcessExit(host: KernelHost, pid: number): Promise<void> {
  return new Promise((resolve) => {
    const off = host.subscribeProcessEvents((event) => {
      if (event.kind === "exit" && event.pid === pid) {
        off();
        resolve();
      }
    });
  });
}

function waitUntil<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Cancellable variant of the process-exit wait, so a timed-out ingest doesn't
 *  leave a process-event listener attached for the life of the session. */
function abortableWaitForProcessExit(
  host: KernelHost,
  pid: number,
): { promise: Promise<void>; cancel: () => void } {
  let off = () => {};
  const promise = new Promise<void>((resolve) => {
    off = host.subscribeProcessEvents((event) => {
      if (event.kind === "exit" && event.pid === pid) {
        off();
        resolve();
      }
    });
  });
  return { promise, cancel: () => off() };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
