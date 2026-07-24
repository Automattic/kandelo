import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../../host/src/vfs/memory-fs";
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
  resolveHomebrewGuestLifecycleShell,
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
  runShellScript(options: {
    shellBytes: Uint8Array;
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
  exportedImage: Uint8Array;
  phaseOneCompletedUrls: ReadonlySet<string>;
  phaseOneLazyDownloads: readonly LazyDownloadEvent[];
  phaseTwoLazyDownloads: readonly LazyDownloadEvent[];
}

export async function runHomebrewGuestLifecycle(options: {
  runtime: HomebrewGuestLifecycleRuntimeInputs;
  revisions: HomebrewGuestLifecycleRevisions;
  timeoutMs: number;
  createMachine: (
    runtime: HomebrewGuestLifecycleRuntimeInputs,
    phase: HomebrewGuestLifecyclePhase,
  ) => HomebrewGuestLifecycleMachine;
}): Promise<HomebrewGuestLifecycleRunResult> {
  const phaseOneMachine = options.createMachine(
    options.runtime,
    "phase-one",
  );
  let exportedImage: Uint8Array | undefined;
  let phaseOneCompletedUrls: ReadonlySet<string> | undefined;
  let phaseOneLazyDownloads: readonly LazyDownloadEvent[] | undefined;
  try {
    await phaseOneMachine.start();
    const preflightStart = phaseOneMachine.lazyDownloads.length;
    await phaseOneMachine.runShellScript({
      shellBytes: options.runtime.shellBytes,
      shellArgv0: options.runtime.shellArgv0,
      script:
        "set -eu; test -n \"$BASH_VERSION\"; " +
        "printf 'homebrew-lifecycle-offline-ok\\n'",
      marker: "homebrew-lifecycle-offline-ok",
      label: "Homebrew lifecycle image-owned shell preflight",
      timeoutMs: options.timeoutMs,
    });
    assertNoLazyDownload(
      phaseOneMachine.lazyDownloads.slice(preflightStart),
      "image-owned shell preflight",
    );

    await phaseOneMachine.runShellScript({
      shellBytes: options.runtime.shellBytes,
      shellArgv0: options.runtime.shellArgv0,
      script: createHomebrewGuestLifecyclePhaseOneScript(options.revisions),
      marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
      label: "stock Homebrew guest lifecycle phase one",
      timeoutMs: options.timeoutMs,
    });
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
      5_000,
    );
  } finally {
    await phaseOneMachine.destroy().catch(() => {});
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

  const exportedFs = MemoryFileSystem.fromImage(exportedImage);
  const exportedShell = resolveHomebrewGuestLifecycleShell(exportedFs);
  const phaseTwoRuntime: HomebrewGuestLifecycleRuntimeInputs = {
    ...options.runtime,
    imageBytes: exportedImage,
    shellBytes: exportedShell.bytes,
    shellArgv0: exportedShell.argv0,
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
  try {
    await phaseTwoMachine.start();
    await phaseTwoMachine.runShellScript({
      shellBytes: phaseTwoRuntime.shellBytes,
      shellArgv0: phaseTwoRuntime.shellArgv0,
      script: createHomebrewGuestLifecyclePhaseTwoScript(options.revisions),
      marker: HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
      label: "stock Homebrew guest lifecycle phase two after rootfs reboot",
      timeoutMs: options.timeoutMs,
    });
    phaseTwoLazyDownloads = [...phaseTwoMachine.lazyDownloads];
    assertNoRepeatedLazyDownloads(
      phaseOneCompletedUrls,
      phaseTwoLazyDownloads,
      "rebooted lifecycle",
    );
  } finally {
    await phaseTwoMachine.destroy().catch(() => {});
    assertNoUnexpectedHostDiagnostics(
      phaseTwoMachine.diagnostics,
      "stock Homebrew guest lifecycle phase two host",
    );
  }
  if (phaseTwoLazyDownloads === undefined) {
    throw new Error("phase two did not complete after the durable reboot");
  }

  return {
    exportedImage,
    phaseOneCompletedUrls,
    phaseOneLazyDownloads,
    phaseTwoLazyDownloads,
  };
}

async function exportRootfsAfterProcessTeardown(
  machine: HomebrewGuestLifecycleMachine,
  timeoutMs: number,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await machine.exportRootfsImage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("no live or tearing-down processes") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      // WHY: a process exit is observable before the worker has necessarily
      // finished its asynchronous teardown. Retry only that exact transient
      // state; the worker-owned snapshot gate remains authoritative.
      await delay(20);
    }
  }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
