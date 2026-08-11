import { BrowserKernel } from "../../host/src/browser-kernel-host";
import { ABI_VERSION } from "../../host/src/generated/abi";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../../host/src/vfs/memory-fs";
import {
  createClosedFixtureSourceUrl,
  loadHomebrewGuestLifecycleBrowserFixture,
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
} from "./homebrew_guest_lifecycle_browser_fixture";
import {
  formatHomebrewGuestLifecycleFailureContext,
  HOMEBREW_GUEST_LIFECYCLE_ENV,
  HOMEBREW_GUEST_MAX_CAPTURED_DIAGNOSTICS,
  HOMEBREW_GUEST_MAX_CAPTURED_OUTPUT_BYTES,
  type HomebrewGuestForkCountSample,
  type HomebrewGuestLifecycleMachine,
  type HomebrewGuestObservedProcessEvent,
  type HomebrewGuestObservedScriptResult,
  runHomebrewGuestLifecycle,
  runHomebrewGuestLifecycleProcess,
} from "./homebrew_guest_lifecycle_runner";
import {
  deriveHomebrewGuestLifecycleRuntimeInputs,
  type HomebrewGuestLifecycleMachineRuntimeInputs,
  type HomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";
import {
  type HomebrewFlatVfsEmbeddedRuntimeInput,
  type HomebrewFlatVfsShippingProofResult,
  runHomebrewFlatVfsShippingProof,
} from "./homebrew_flat_vfs_shipping_proof";
import {
  assertNoUnexpectedHostDiagnostics,
  HOMEBREW_GUEST_LIFECYCLE_HOST_LIMITS,
} from "./homebrew_guest_lifecycle_runtime_contract";
import {
  runHomebrewSystemCommandSpawnProof,
} from "./homebrew_system_command_spawn_proof";

export interface HomebrewGuestLifecycleBrowserResult {
  exportedImageSha256: string;
  exportedImageBytes: number;
  coreRevision: string;
  canaryRevision: string;
  phaseOneCompletedUrls: string[];
  phaseOneLazyDownloads: readonly LazyDownloadEvent[];
  phaseTwoLazyDownloads: readonly LazyDownloadEvent[];
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Run the same stock-Homebrew lifecycle used by the Node acceptance runner in
 * Chromium. This adapter owns only browser transport and worker mechanics;
 * the guest scripts, reboot boundary, and assertions live in the shared
 * host-neutral runner.
 */
export async function runHomebrewGuestLifecycleInBrowser(options: {
  fixture: unknown;
  kernelWasm: ArrayBuffer;
  corsProxyUrl: string;
  /** Same-origin directory containing the exact closed-transport fixtures. */
  closedAssetRootUrl?: string;
  fetchImpl?: FetchLike;
  afterMachineDestroy?: () => Promise<void>;
}): Promise<HomebrewGuestLifecycleBrowserResult> {
  const fixture = projectHomebrewGuestLifecycleBrowserFixture(options.fixture);
  const deadlineMs = Date.now() + fixture.timeoutMs;
  const deadlineController = new AbortController();
  const deadlineReason = new Error(
    "Homebrew guest lifecycle exceeded its total deadline",
  );
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(deadlineReason),
    fixture.timeoutMs,
  );
  try {
    const loaded = await loadHomebrewGuestLifecycleBrowserFixture(
      fixture,
      {
        fetchImpl: options.fetchImpl,
        sourceUrl: (canonicalUrl) =>
          fixture.transportMode === "closed"
            ? createClosedFixtureSourceUrl(
                options.closedAssetRootUrl,
                canonicalUrl,
              )
            : createCorsProxySourceUrl(
                options.corsProxyUrl,
                canonicalUrl,
              ),
        signal: deadlineController.signal,
      },
    );
    MemoryFileSystem.assertImageKernelAbi(
      loaded.imageBytes,
      ABI_VERSION,
      "Homebrew guest lifecycle browser image",
    );
    const publicTransport = fixture.transportMode === "public";
    const runtime = await deriveHomebrewGuestLifecycleRuntimeInputs({
      imageBytes: loaded.imageBytes,
      takeImageOwnership: true,
      bootstrapSpecBytes: loaded.bootstrapSpecBytes,
      bootstrapArchiveBytes: loaded.bootstrapArchiveBytes,
      bootstrapArchiveSha256: fixture.bootstrap.archive.sha256,
      bootstrapEnvironmentBytes: loaded.bootstrapEnvironmentBytes,
      coreRevision: fixture.revisions.coreRevision,
      transportMode: fixture.transportMode,
      expectedEmbeddedBottlePlanBytes: loaded.bottleMirrorPlanBytes,
      lazyUrlBase: publicTransport
        ? new URL(".", fixture.bootstrap.archive.url).href
        : "https://closed.kandelo.invalid/homebrew-guest-lifecycle/",
      ...(publicTransport
        ? {
            expectedBootstrapTransportUrl: fixture.bootstrap.archive.url,
          }
        : {
            closedBottleAssets: loaded.closedBottleAssets!,
      }),
    });

    // WHY: the focused proof must not consume the image buffer that the
    // durable lifecycle transfers afterward. A separate machine gets an
    // exact byte-for-byte copy and exercises the same closed/public assets.
    const proofRuntime: HomebrewGuestLifecycleRuntimeInputs = {
      ...runtime,
      imageBytes: runtime.imageBytes.slice(),
      takeImageOwnership: true,
    };
    await runHomebrewSystemCommandSpawnProof({
      runtime: proofRuntime,
      deadlineMs,
      machine: createBrowserLifecycleMachine({
        runtime: proofRuntime,
        kernelWasm: options.kernelWasm,
        corsProxyUrl: options.corsProxyUrl,
        afterDestroy: options.afterMachineDestroy,
      }),
    });

    const result = await runHomebrewGuestLifecycle({
      runtime,
      revisions: fixture.revisions,
      deadlineMs,
      hashExportedImage: sha256,
      createMachine: (machineRuntime) =>
        createBrowserLifecycleMachine({
          runtime: machineRuntime,
          kernelWasm: options.kernelWasm,
          corsProxyUrl: options.corsProxyUrl,
          afterDestroy: options.afterMachineDestroy,
        }),
    });
    if (result.exportedImageSha256 === undefined) {
      throw new Error("browser lifecycle omitted its pre-handoff image digest");
    }
    return {
      exportedImageSha256: result.exportedImageSha256,
      exportedImageBytes: result.exportedImageBytes,
      coreRevision: fixture.revisions.coreRevision,
      canaryRevision: fixture.revisions.canaryRevision,
      phaseOneCompletedUrls: [...result.phaseOneCompletedUrls].sort(),
      phaseOneLazyDownloads: result.phaseOneLazyDownloads,
      phaseTwoLazyDownloads: result.phaseTwoLazyDownloads,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export function createCorsProxySourceUrl(
  corsProxyUrl: string,
  canonicalUrl: string,
): string {
  const proxy = new URL(corsProxyUrl, globalThis.location?.href);
  if (
    (
      proxy.protocol !== "http:" &&
      proxy.protocol !== "https:"
    ) ||
    proxy.username !== "" ||
    proxy.password !== "" ||
    proxy.hash !== ""
  ) {
    throw new Error("Homebrew browser lifecycle CORS proxy URL is invalid");
  }
  proxy.searchParams.set("url", canonicalUrl);
  return proxy.href;
}

export function createBrowserLifecycleMachine(options: {
  runtime: HomebrewGuestLifecycleMachineRuntimeInputs;
  kernelWasm: ArrayBuffer;
  corsProxyUrl: string;
  afterDestroy?: () => Promise<void>;
}): HomebrewGuestLifecycleMachine {
  const lazyDownloads: LazyDownloadEvent[] = [];
  const diagnostics: string[] = [];
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputLimitExceeded = false;
  let activeProcessObservation: {
    events: HomebrewGuestObservedProcessEvent[];
    forkCountSamples: HomebrewGuestForkCountSample[];
    forkCountSampleFailures: Array<{
      parentPid: number;
      childPid: number;
      message: string;
    }>;
    pendingSamples: Promise<void>[];
  } | undefined;
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const capture = (bytes: Uint8Array, stream: "stdout" | "stderr"): void => {
    outputBytes += bytes.byteLength;
    if (outputBytes > HOMEBREW_GUEST_MAX_CAPTURED_OUTPUT_BYTES) {
      outputLimitExceeded = true;
      return;
    }
    if (stream === "stdout") {
      stdout += stdoutDecoder.decode(bytes, { stream: true });
    } else {
      stderr += stderrDecoder.decode(bytes, { stream: true });
    }
  };
  const kernel = new BrowserKernel({
    ...HOMEBREW_GUEST_LIFECYCLE_HOST_LIMITS,
    kernelOwnedFs: true,
    corsProxyUrl: options.corsProxyUrl,
    onStdout: (bytes) => capture(bytes, "stdout"),
    onStderr: (bytes) => capture(bytes, "stderr"),
    onHostDiagnostic: (diagnostic) => {
      if (diagnostics.length < HOMEBREW_GUEST_MAX_CAPTURED_DIAGNOSTICS) {
        // Keep browser and Node failure evidence equivalent: function indices
        // become actionable only when they remain associated with a PID.
        diagnostics.push(
          `pid=${diagnostic.pid} source=${diagnostic.source}` +
            (diagnostic.status === undefined
              ? ""
              : ` status=${diagnostic.status}`) +
            `: ${diagnostic.message}`,
        );
      }
    },
    onLazyDownload: (event) => lazyDownloads.push(event),
    onProcessEvent: (event) => {
      if (activeProcessObservation === undefined) return;
      const observation = activeProcessObservation;
      observation.events.push({
        kind: event.kind,
        pid: event.pid,
        ...(event.ppid === undefined ? {} : { ppid: event.ppid }),
        ...(event.exitStatus === undefined
          ? {}
          : { exitStatus: event.exitStatus }),
      });
      if (event.kind !== "spawn" || event.ppid === undefined) return;
      const parentPid = event.ppid;
      observation.pendingSamples.push(
        kernel.getForkCount(parentPid).then(
          (count) => {
            observation.forkCountSamples.push({
              parentPid,
              childPid: event.pid,
              count,
            });
          },
          (error) => {
            observation.forkCountSampleFailures.push({
              parentPid,
              childPid: event.pid,
              message: error instanceof Error
                ? error.message
                : String(error),
            });
          },
        ),
      );
    },
  });

  const runScript = async (scriptOptions: {
    shellPath: string;
    shellArgv0: string;
    script: string;
    marker: string;
    label: string;
    timeoutMs: number;
  }): Promise<{ stdout: string; stderr: string }> => {
    const stdoutStart = stdout.length;
    const stderrStart = stderr.length;
    const diagnosticStart = diagnostics.length;
    const exitCode = await runHomebrewGuestLifecycleProcess({
      label: scriptOptions.label,
      timeoutMs: scriptOptions.timeoutMs,
      failureContext: () =>
        formatHomebrewGuestLifecycleFailureContext({
          stdout: stdout.slice(stdoutStart),
          stderr: stderr.slice(stderrStart),
          diagnostics: diagnostics.slice(diagnosticStart),
        }),
      spawn: () =>
        kernel.spawnFromVfs(
          scriptOptions.shellPath,
          [scriptOptions.shellArgv0, "-c", scriptOptions.script],
          {
            env: [...HOMEBREW_GUEST_LIFECYCLE_ENV],
            cwd: "/home/maker",
            uid: 1000,
            gid: 1000,
            stdin: new Uint8Array(),
          },
        ),
      terminate: (pid, exitStatus) =>
        kernel.terminateProcess(pid, exitStatus),
    });
    const scriptStdout = stdout.slice(stdoutStart);
    const scriptStderr = stderr.slice(stderrStart);
    if (exitCode !== 0) {
      throw new Error(
        `${scriptOptions.label} exited ${exitCode}; ` +
          formatHomebrewGuestLifecycleFailureContext({
            stdout: scriptStdout,
            stderr: scriptStderr,
            diagnostics: diagnostics.slice(diagnosticStart),
          }),
      );
    }
    if (!scriptStdout.split(/\r?\n/).includes(scriptOptions.marker)) {
      throw new Error(
        `${scriptOptions.label} marker is missing; ` +
          formatHomebrewGuestLifecycleFailureContext({
            stdout: scriptStdout,
            stderr: scriptStderr,
            diagnostics: diagnostics.slice(diagnosticStart),
          }),
      );
    }
    assertNoUnexpectedHostDiagnostics(
      diagnostics.slice(diagnosticStart),
      scriptOptions.label,
    );
    if (outputLimitExceeded) {
      throw new Error(
        `${scriptOptions.label} exceeded the ` +
          `${HOMEBREW_GUEST_MAX_CAPTURED_OUTPUT_BYTES}-byte output limit`,
      );
    }
    return { stdout: scriptStdout, stderr: scriptStderr };
  };

  return {
    lazyDownloads,
    diagnostics,
    failureContext: () =>
      formatHomebrewGuestLifecycleFailureContext({
        stdout,
        stderr,
        diagnostics,
      }),
    start: async () => {
      const init = {
        kernelWasm: options.kernelWasm,
        lazyUrlBase: options.runtime.lazyUrlBase,
        ...(options.runtime.lazyAssets === undefined
          ? {}
          : { closedLazyAssets: options.runtime.lazyAssets }),
      };
      if (options.runtime.takeImageOwnership === true) {
        const imageView = options.runtime.imageBytes;
        await kernel.initFromOwnedImage({
          ...init,
          vfsImage: wholeOwnedArrayBuffer(imageView),
        });
        if (imageView.byteLength !== 0) {
          throw new Error(
            "browser lifecycle worker did not take VFS image ownership",
          );
        }
        return;
      }
      await kernel.initFromImage({
        ...init,
        vfsImage: options.runtime.imageBytes,
      });
    },
    readFile: (path) => kernel.readFileFromVfs(path),
    runShellScript: (scriptOptions) =>
      runScript(scriptOptions).then(() => undefined),
    runObservedShellScript: async (scriptOptions) => {
      if (activeProcessObservation !== undefined) {
        throw new Error("nested Homebrew process observation is not allowed");
      }
      const observation = {
        events: [] as HomebrewGuestObservedProcessEvent[],
        forkCountSamples: [] as HomebrewGuestForkCountSample[],
        forkCountSampleFailures: [] as Array<{
          parentPid: number;
          childPid: number;
          message: string;
        }>,
        pendingSamples: [] as Promise<void>[],
      };
      activeProcessObservation = observation;
      try {
        const output = await runScript(scriptOptions);
        activeProcessObservation = undefined;
        await Promise.all(observation.pendingSamples);
        return {
          ...output,
          processEvents: observation.events,
          forkCountSamples: observation.forkCountSamples,
          forkCountSampleFailures: observation.forkCountSampleFailures,
          remainingObservedPids: await remainingObservedPids(
            kernel,
            observation.events,
          ),
        } satisfies HomebrewGuestObservedScriptResult;
      } finally {
        if (activeProcessObservation === observation) {
          activeProcessObservation = undefined;
        }
      }
    },
    exportRootfsImage: () => kernel.exportRootfsImage(),
    destroy: async () => {
      try {
        await kernel.destroy();
      } finally {
        await options.afterDestroy?.();
      }
    },
  };
}

/** Chromium supplies worker mechanics; the shared module owns every guest step. */
export function runHomebrewFlatVfsShippingProofInBrowser(options: {
  runtime: HomebrewFlatVfsEmbeddedRuntimeInput;
  tapRevision: string;
  deadlineMs: number;
  kernelWasm: ArrayBuffer;
  corsProxyUrl: string;
  afterMachineDestroy?: () => Promise<void>;
}): Promise<HomebrewFlatVfsShippingProofResult> {
  return runHomebrewFlatVfsShippingProof({
    runtime: options.runtime,
    tapRevision: options.tapRevision,
    deadlineMs: options.deadlineMs,
    createMachine: (runtime) =>
      createBrowserLifecycleMachine({
        runtime,
        kernelWasm: options.kernelWasm,
        corsProxyUrl: options.corsProxyUrl,
        ...(options.afterMachineDestroy === undefined
          ? {}
          : { afterDestroy: options.afterMachineDestroy }),
      }),
  });
}

async function remainingObservedPids(
  kernel: BrowserKernel,
  events: readonly HomebrewGuestObservedProcessEvent[],
): Promise<number[]> {
  const observedPids = new Set(events.map((event) => event.pid));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const remaining = (await kernel.enumProcs())
      .map((process) => process.pid)
      .filter((pid) => observedPids.has(pid))
      .sort((left, right) => left - right);
    if (remaining.length === 0) return [];
    if (attempt === 99) return remaining;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("unreachable browser process-retirement loop");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = wholeOwnedArrayBuffer(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", owned),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function wholeOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.byteOffset !== 0 ||
    bytes.byteLength !== bytes.buffer.byteLength
  ) {
    throw new Error(
      "browser lifecycle image ownership requires one whole ordinary ArrayBuffer",
    );
  }
  return bytes.buffer;
}

export type {
  HomebrewGuestLifecycleBrowserFixture,
};
