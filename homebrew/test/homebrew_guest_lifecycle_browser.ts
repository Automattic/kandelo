import { BrowserKernel } from "../../host/src/browser-kernel-host";
import { ABI_VERSION } from "../../host/src/generated/abi";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../../host/src/vfs/memory-fs";
import {
  loadHomebrewGuestLifecycleBrowserFixture,
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
} from "./homebrew_guest_lifecycle_browser_fixture";
import {
  HOMEBREW_GUEST_LIFECYCLE_ENV,
  type HomebrewGuestLifecycleMachine,
  runHomebrewGuestLifecycle,
  runHomebrewGuestLifecycleProcess,
} from "./homebrew_guest_lifecycle_runner";
import {
  deriveHomebrewGuestLifecycleRuntimeInputs,
  type HomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";
import {
  assertNoUnexpectedHostDiagnostics,
} from "./homebrew_guest_lifecycle_runtime_contract";

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

const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_DIAGNOSTICS = 1_000;

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
          createCorsProxySourceUrl(options.corsProxyUrl, canonicalUrl),
        signal: deadlineController.signal,
      },
    );
    MemoryFileSystem.assertImageKernelAbi(
      loaded.imageBytes,
      ABI_VERSION,
      "Homebrew guest lifecycle browser image",
    );
    const publicTransport = fixture.transportMode === "public";
    const runtime = deriveHomebrewGuestLifecycleRuntimeInputs({
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

function createBrowserLifecycleMachine(options: {
  runtime: HomebrewGuestLifecycleRuntimeInputs;
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
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const capture = (bytes: Uint8Array, stream: "stdout" | "stderr"): void => {
    outputBytes += bytes.byteLength;
    if (outputBytes > MAX_CAPTURED_OUTPUT_BYTES) {
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
    kernelOwnedFs: true,
    maxWorkers: 8,
    corsProxyUrl: options.corsProxyUrl,
    onStdout: (bytes) => capture(bytes, "stdout"),
    onStderr: (bytes) => capture(bytes, "stderr"),
    onHostDiagnostic: (diagnostic) => {
      if (diagnostics.length < MAX_CAPTURED_DIAGNOSTICS) {
        diagnostics.push(diagnostic.message);
      }
    },
    onLazyDownload: (event) => lazyDownloads.push(event),
  });

  return {
    lazyDownloads,
    diagnostics,
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
    runShellScript: async (scriptOptions) => {
      const stdoutStart = stdout.length;
      const stderrStart = stderr.length;
      const diagnosticStart = diagnostics.length;
      const exitCode = await runHomebrewGuestLifecycleProcess({
        label: scriptOptions.label,
        timeoutMs: scriptOptions.timeoutMs,
        spawn: () =>
          kernel.spawnFromVfs(
            scriptOptions.shellPath,
            [scriptOptions.shellArgv0, "-c", scriptOptions.script],
            {
              env: [...HOMEBREW_GUEST_LIFECYCLE_ENV],
              cwd: "/home/user",
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
          `${scriptOptions.label} exited ${exitCode}; stdout=` +
            `${JSON.stringify(scriptStdout)}; stderr=` +
            `${JSON.stringify(scriptStderr)}; diagnostics=` +
            `${JSON.stringify(diagnostics)}`,
        );
      }
      if (!scriptStdout.split(/\r?\n/).includes(scriptOptions.marker)) {
        throw new Error(
          `${scriptOptions.label} marker is missing; stdout=` +
            `${JSON.stringify(scriptStdout)}; stderr=` +
            `${JSON.stringify(scriptStderr)}`,
        );
      }
      assertNoUnexpectedHostDiagnostics(
        diagnostics.slice(diagnosticStart),
        scriptOptions.label,
      );
      if (outputLimitExceeded) {
        throw new Error(
          `${scriptOptions.label} exceeded the ` +
            `${MAX_CAPTURED_OUTPUT_BYTES}-byte output limit`,
        );
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
