import type { LazyDownloadEvent } from "../../host/src/vfs/memory-fs";
import { KANDELO_SHELL_CONFIG_PATH } from
  "../../web-libs/kandelo-session/src/shell-config";
import {
  createHomebrewGuestLifecyclePhaseOneScript,
  createHomebrewGuestLifecyclePhaseTwoScript,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
  type HomebrewGuestLifecycleRevisions,
} from "./homebrew_guest_lifecycle_contract";
import {
  assertNoRepeatedLazyDownloads,
  assertNoUnexpectedHostDiagnostics,
  completedLazyDownloadUrls,
  omitCompletedClosedLazyAssets,
  parseHomebrewGuestLifecycleShellConfig,
} from "./homebrew_guest_lifecycle_runtime_contract";
import type {
  HomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";

export const HOMEBREW_GUEST_LIFECYCLE_ENV = [
  "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
  "HOME=/home/user",
  "USER=user",
  "LOGNAME=user",
  "SHELL=/bin/bash",
  "TERM=dumb",
  "TMPDIR=/tmp",
  "HOMEBREW_NO_ANALYTICS=1",
  "HOMEBREW_NO_AUTO_UPDATE=1",
  "HOMEBREW_NO_ENV_HINTS=1",
  "HOMEBREW_NO_INSTALL_FROM_API=1",
  "GIT_TERMINAL_PROMPT=0",
] as const;

export type HomebrewGuestLifecyclePhase = "phase-one" | "phase-two";

export interface HomebrewGuestLifecycleMachine {
  readonly lazyDownloads: readonly LazyDownloadEvent[];
  readonly diagnostics: readonly string[];
  start(): Promise<void>;
  readFile(path: string): Promise<Uint8Array | null>;
  runShellScript(options: {
    shellPath: string;
    shellArgv0: string;
    script: string;
    marker: string;
    label: string;
    timeoutMs: number;
  }): Promise<void>;
  exportRootfsImage(): Promise<Uint8Array>;
  destroy(): Promise<void>;
}

export interface HomebrewGuestLifecycleRunResult {
  exportedImageBytes: number;
  exportedImageSha256?: string;
  phaseOneCompletedUrls: ReadonlySet<string>;
  phaseOneLazyDownloads: readonly LazyDownloadEvent[];
  phaseTwoLazyDownloads: readonly LazyDownloadEvent[];
}

export async function runHomebrewGuestLifecycleProcess(options: {
  label: string;
  timeoutMs: number;
  spawn: () => Promise<{ pid: number; exit: Promise<number> }>;
  terminate: (pid: number, exitCode: number) => Promise<void>;
}): Promise<number> {
  let pid: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // WHY: start one clock before requesting the VFS-owned executable. The
  // worker read, Wasm compile, spawn acknowledgement, and process lifetime
  // all spend the same operation budget; a stalled acknowledgement must not
  // leave this adapter running after the lifecycle tears its machine down.
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(
            `${options.label} timed out after ${options.timeoutMs}ms`,
          ),
        ),
      options.timeoutMs,
    );
  });
  try {
    const spawned = await Promise.race([options.spawn(), timedOut]);
    pid = spawned.pid;
    return await Promise.race([spawned.exit, timedOut]);
  } catch (error) {
    if (pid !== undefined) {
      await options.terminate(pid, 124).catch(() => {});
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function runHomebrewGuestLifecycle(options: {
  runtime: HomebrewGuestLifecycleRuntimeInputs;
  revisions: HomebrewGuestLifecycleRevisions;
  /** One absolute deadline shared by initialization, both phases, and reboot. */
  deadlineMs: number;
  hashExportedImage?: (image: Uint8Array) => Promise<string>;
  createMachine: (
    runtime: HomebrewGuestLifecycleRuntimeInputs,
    phase: HomebrewGuestLifecyclePhase,
  ) => HomebrewGuestLifecycleMachine;
}): Promise<HomebrewGuestLifecycleRunResult> {
  assertUsableDeadline(options.deadlineMs);
  const phaseOneMachine = options.createMachine(
    options.runtime,
    "phase-one",
  );
  let exportedImage: Uint8Array | undefined;
  let phaseOneCompletedUrls: ReadonlySet<string> | undefined;
  let phaseOneLazyDownloads: readonly LazyDownloadEvent[] | undefined;
  let phaseOneSucceeded = false;
  try {
    await beforeDeadline(
      options.deadlineMs,
      "Homebrew lifecycle phase-one machine start",
      () => phaseOneMachine.start(),
    );
    const preflightStart = phaseOneMachine.lazyDownloads.length;
    await runScriptBeforeDeadline(
      phaseOneMachine,
      options.deadlineMs,
      {
        shellPath: options.runtime.shellPath,
        shellArgv0: options.runtime.shellArgv0,
        script: createImageOwnedShellPreflight(
          options.runtime.shellPath,
          "homebrew-lifecycle-offline-ok",
        ),
        marker: "homebrew-lifecycle-offline-ok",
        label: "Homebrew lifecycle image-owned shell preflight",
      },
    );
    assertNoLazyDownload(
      phaseOneMachine.lazyDownloads.slice(preflightStart),
      "image-owned shell preflight",
    );

    await runScriptBeforeDeadline(
      phaseOneMachine,
      options.deadlineMs,
      {
        shellPath: options.runtime.shellPath,
        shellArgv0: options.runtime.shellArgv0,
        script: createHomebrewGuestLifecyclePhaseOneScript(options.revisions),
        marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
        label: "stock Homebrew guest lifecycle phase one",
      },
    );
    assertSingleCompletedLazyDownload(
      phaseOneMachine.lazyDownloads,
      options.runtime.bootstrapTransportUrl,
      options.runtime.bootstrapBytes,
      "phase-one Homebrew bootstrap",
    );
    phaseOneLazyDownloads = [...phaseOneMachine.lazyDownloads];
    phaseOneCompletedUrls = completedLazyDownloadUrls(
      phaseOneLazyDownloads,
    );
    exportedImage = await exportRootfsAfterProcessTeardown(
      phaseOneMachine,
      options.deadlineMs,
    );
    phaseOneSucceeded = true;
  } finally {
    const destroy = destroyBeforeDeadline(
      phaseOneMachine,
      options.deadlineMs,
    );
    if (phaseOneSucceeded) await destroy;
    else await destroy.catch(() => {});
    assertNoUnexpectedHostDiagnostics(
      phaseOneMachine.diagnostics,
      "stock Homebrew guest lifecycle phase one host",
    );
  }
  if (
    exportedImage === undefined ||
    phaseOneCompletedUrls === undefined ||
    phaseOneLazyDownloads === undefined
  ) {
    throw new Error("phase one did not export a durable root filesystem");
  }

  const exportedImageBytes = exportedImage.byteLength;
  if (exportedImageBytes === 0) {
    throw new Error("phase one exported an empty root filesystem");
  }
  const exportedImageSha256 = options.hashExportedImage === undefined
    ? undefined
    : await beforeDeadline(
      options.deadlineMs,
      "Homebrew lifecycle exported-image digest",
      () => options.hashExportedImage!(exportedImage!),
    );
  if (
    options.runtime.takeImageOwnership === true &&
    exportedImageSha256 === undefined
  ) {
    throw new Error(
      "ownership-taking lifecycle requires a pre-handoff image digest",
    );
  }
  const phaseTwoRuntime: HomebrewGuestLifecycleRuntimeInputs = {
    ...options.runtime,
    imageBytes: exportedImage,
    // WHY: a rebooted image must own everything phase one materialized. Do not
    // leave those closed bytes available to hide an export durability defect.
    lazyAssets: omitCompletedClosedLazyAssets(
      options.runtime.lazyAssets,
      phaseOneCompletedUrls,
    ),
  };
  const phaseTwoMachine = options.createMachine(
    phaseTwoRuntime,
    "phase-two",
  );
  let phaseTwoLazyDownloads: readonly LazyDownloadEvent[] | undefined;
  let phaseTwoSucceeded = false;
  try {
    await beforeDeadline(
      options.deadlineMs,
      "Homebrew lifecycle phase-two machine start",
      () => phaseTwoMachine.start(),
    );
    const rebootPreflightStart = phaseTwoMachine.lazyDownloads.length;
    const exportedShellConfig = await beforeDeadline(
      options.deadlineMs,
      "Homebrew lifecycle rebooted shell-config read",
      () => phaseTwoMachine.readFile(KANDELO_SHELL_CONFIG_PATH),
    );
    if (exportedShellConfig === null) {
      throw new Error(
        `rebooted lifecycle is missing ${KANDELO_SHELL_CONFIG_PATH}`,
      );
    }
    const exportedShell = parseHomebrewGuestLifecycleShellConfig(
      exportedShellConfig,
    );
    await runScriptBeforeDeadline(
      phaseTwoMachine,
      options.deadlineMs,
      {
        shellPath: exportedShell.path,
        shellArgv0: exportedShell.argv0,
        script: createImageOwnedShellPreflight(
          exportedShell.path,
          "homebrew-lifecycle-reboot-shell-ok",
        ),
        marker: "homebrew-lifecycle-reboot-shell-ok",
        label: "Homebrew lifecycle rebooted image-owned shell preflight",
      },
    );
    assertNoLazyDownload(
      phaseTwoMachine.lazyDownloads.slice(rebootPreflightStart),
      "rebooted image-owned shell preflight",
    );
    await runScriptBeforeDeadline(
      phaseTwoMachine,
      options.deadlineMs,
      {
        shellPath: exportedShell.path,
        shellArgv0: exportedShell.argv0,
        script: createHomebrewGuestLifecyclePhaseTwoScript(options.revisions),
        marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
        label: "stock Homebrew guest lifecycle phase two after rootfs reboot",
      },
    );
    phaseTwoLazyDownloads = [...phaseTwoMachine.lazyDownloads];
    assertNoRepeatedLazyDownloads(
      phaseOneCompletedUrls,
      phaseTwoLazyDownloads,
      "rebooted lifecycle",
    );
    phaseTwoSucceeded = true;
  } finally {
    const destroy = destroyBeforeDeadline(
      phaseTwoMachine,
      options.deadlineMs,
    );
    if (phaseTwoSucceeded) await destroy;
    else await destroy.catch(() => {});
    assertNoUnexpectedHostDiagnostics(
      phaseTwoMachine.diagnostics,
      "stock Homebrew guest lifecycle phase two host",
    );
  }
  if (phaseTwoLazyDownloads === undefined) {
    throw new Error("phase two did not complete after the durable reboot");
  }

  return {
    exportedImageBytes,
    ...(exportedImageSha256 === undefined
      ? {}
      : { exportedImageSha256 }),
    phaseOneCompletedUrls,
    phaseOneLazyDownloads,
    phaseTwoLazyDownloads,
  };
}

async function exportRootfsAfterProcessTeardown(
  machine: HomebrewGuestLifecycleMachine,
  deadlineMs: number,
): Promise<Uint8Array> {
  for (;;) {
    try {
      return await beforeDeadline(
        deadlineMs,
        "Homebrew lifecycle rootfs export",
        () => machine.exportRootfsImage(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("no live or tearing-down processes") ||
        Date.now() >= deadlineMs
      ) {
        throw error;
      }
      // WHY: a process exit is observable before the worker has necessarily
      // finished its asynchronous teardown. Retry only that exact transient
      // state; the worker-owned snapshot gate remains authoritative.
      await delay(Math.min(20, remainingMilliseconds(deadlineMs)));
    }
  }
}

async function runScriptBeforeDeadline(
  machine: HomebrewGuestLifecycleMachine,
  deadlineMs: number,
  options: Omit<
    Parameters<HomebrewGuestLifecycleMachine["runShellScript"]>[0],
    "timeoutMs"
  >,
): Promise<void> {
  const timeoutMs = remainingMilliseconds(deadlineMs);
  await beforeDeadline(deadlineMs, options.label, () =>
    machine.runShellScript({ ...options, timeoutMs })
  );
}

async function destroyBeforeDeadline(
  machine: HomebrewGuestLifecycleMachine,
  deadlineMs: number,
): Promise<void> {
  const destroying = machine.destroy();
  try {
    await beforeDeadline(
      deadlineMs,
      "Homebrew lifecycle machine teardown",
      () => destroying,
    );
  } catch (error) {
    // The underlying cleanup cannot be cancelled. Keep observing its rejection
    // after the total deadline wins the race, then preserve that deadline as
    // the lifecycle result.
    void destroying.catch(() => {});
    throw error;
  }
}

async function beforeDeadline<T>(
  deadlineMs: number,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const timeoutMs = remainingMilliseconds(deadlineMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `${label} exceeded the Homebrew guest lifecycle total deadline`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function assertUsableDeadline(deadlineMs: number): void {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now()) {
    throw new Error(
      "Homebrew guest lifecycle deadline must be a future integer timestamp",
    );
  }
}

function remainingMilliseconds(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error(
      "Homebrew guest lifecycle exceeded its total deadline",
    );
  }
  return remaining;
}

function assertSingleCompletedLazyDownload(
  events: readonly LazyDownloadEvent[],
  url: string,
  expectedBytes: number,
  label: string,
): void {
  const matches = events.filter((event) => event.url === url);
  const started = matches.filter((event) => event.status === "started");
  const completed = matches.filter((event) => event.status === "complete");
  const failed = matches.filter((event) => event.status === "error");
  if (
    started.length !== 1 ||
    completed.length !== 1 ||
    failed.length !== 0 ||
    matches[0]?.status !== "started" ||
    matches.at(-1)?.status !== "complete" ||
    started[0]?.loadedBytes !== 0 ||
    completed[0]?.loadedBytes !== expectedBytes
  ) {
    throw new Error(
      `${label} must fetch its exact lazy tree once; events=` +
        `${JSON.stringify(matches)}`,
    );
  }
}

function assertNoLazyDownload(
  events: readonly LazyDownloadEvent[],
  label: string,
): void {
  if (events.length !== 0) {
    throw new Error(`${label} unexpectedly fetched ${events[0]!.url}`);
  }
}

function createImageOwnedShellPreflight(
  shellPath: string,
  marker: string,
): string {
  // WHY: spawnFromVfs deliberately moves bytes inside the owning worker, but
  // top-level host launch is not a guest execve syscall. Ask Bash's builtin
  // `test` to exercise Kandelo's credential-aware POSIX access path so a
  // readable Wasm file with the wrong execute/search permissions cannot make
  // this durability proof pass.
  return `set -eu; test -n "$BASH_VERSION"; ` +
    `test -x ${quoteShellWord(shellPath)}; ` +
    `printf '%s\\n' ${quoteShellWord(marker)}`;
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
