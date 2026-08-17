import { BrowserKernel } from "@host/browser-kernel-host";
import { ABI_VERSION } from "@host/generated/abi";
import {
  MemoryFileSystem,
  resolveMountSetIdCapability,
} from "@host/vfs/memory-fs";
import {
  restoreVerifiedVfsImage,
  restoreVerifiedVfsImagePreservingCapacity,
} from "@host/vfs/load-image";
import {
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
  trackTransientImageBuffer,
} from "../../lib/kernel-owned-boot";
import {
  composeBootDescriptorVfs,
  composeBootDescriptorVfsWithReviewedProduct,
} from "../../lib/init/homebrew-package-layers";
import { createReviewedPrivilegedProgramPolicy } from "@host/vfs/privileged-projection";
import {
  assertLocalTestHomebrewTapBundle,
  projectLocalTestHomebrewTapBundleBinding,
} from "@host/homebrew-vfs-builder";
import * as privilegedProjectionModule from "@host/vfs/privileged-projection";
import { homebrewClosedAcceptanceAssetRoot } from "../../lib/homebrew-closed-acceptance";
import type { BootDescriptor } from "../../../../web-libs/kandelo-session/src/kernel-host";
import {
  createBrowserLifecycleMachine,
  runHomebrewFlatVfsShippingProofInBrowser,
  runHomebrewGuestCoreShippingProofInBrowser,
  runHomebrewGuestLifecycleInBrowser,
  type HomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserResult,
} from "../../../../homebrew/test/homebrew_guest_lifecycle_browser";
import type { HomebrewFlatVfsShippingProofResult } from "../../../../homebrew/test/homebrew_flat_vfs_shipping_proof";
import {
  createClosedFixtureSourceUrl,
  loadHomebrewGuestLifecycleBrowserFixture,
  projectHomebrewGuestLifecycleBrowserFixture,
} from "../../../../homebrew/test/homebrew_guest_lifecycle_browser_fixture";
import { deriveHomebrewGuestLifecycleRuntimeInputs } from "../../../../homebrew/test/homebrew_guest_lifecycle_runtime_inputs";
import { LiveKernelHost } from "../../../../web-libs/kandelo-session/src/kernel-host";
import { DEMO_TERMINAL_SESSION_POLICY } from "../kandelo/kernel-host/demo-terminal-sessions";
import { initializeDemoLoginKernel } from "../kandelo/kernel-host/demo-login-loader";
import { publishPrivilegedProgramProduct } from "@host/vfs/privileged-projection";
import { runHomebrewSystemCommandSpawnProof } from "../../../../homebrew/test/homebrew_system_command_spawn_proof";
import kernelWasmUrl from "@kernel-wasm?url";
import {
  validateHomebrewVfsAcceptanceRequest,
  type HomebrewVfsAcceptanceRequest,
} from "./acceptance-request";
import {
  validateHomebrewFlatVfsShippingProofRequest,
  type HomebrewFlatVfsShippingProofRequest,
} from "./flat-vfs-shipping-request";
import {
  resolveBrowserCorsProxyConfig,
} from "../../lib/browser-cors-proxy";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const corsProxy = resolveBrowserCorsProxyConfig({
  configuredUrl: `${import.meta.env.BASE_URL}__kandelo_cors_proxy?url=`,
  development: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  pageUrl: window.location.href,
});
const closedLifecycleAssetRoot = homebrewClosedAcceptanceAssetRoot(
  import.meta.env.MODE,
  import.meta.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT as
    string | undefined,
);
let loginProductPhaseAcknowledgement: (() => void) | undefined;

async function announceLoginProductPhase(phase: string): Promise<void> {
  if (loginProductPhaseAcknowledgement !== undefined) {
    throw new Error("login product phase acknowledgement is already pending");
  }
  window.__homebrewLoginProductPhase = phase;
  await new Promise<void>((resolve) => {
    loginProductPhaseAcknowledgement = resolve;
  });
  loginProductPhaseAcknowledgement = undefined;
}

interface HomebrewVfsAcceptanceResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  imageSha256: string;
  kernelSha256: string;
}

async function runHomebrewLoginProductLifecycle(
  fixtureValue: unknown,
  kernelBytes: ArrayBuffer,
): Promise<{ markers: string[] }> {
  const fixture = projectHomebrewGuestLifecycleBrowserFixture(fixtureValue);
  const loaded = await loadHomebrewGuestLifecycleBrowserFixture(fixture, {
    sourceUrl: (canonicalUrl) =>
      createClosedFixtureSourceUrl(closedLifecycleAssetRoot, canonicalUrl),
  });
  const runtime = await deriveHomebrewGuestLifecycleRuntimeInputs({
    imageBytes: loaded.imageBytes.slice(),
    bootstrapSpecBytes: loaded.bootstrapSpecBytes,
    bootstrapArchiveBytes: loaded.bootstrapArchiveBytes,
    bootstrapArchiveSha256: fixture.bootstrap.archive.sha256,
    bootstrapEnvironmentBytes: loaded.bootstrapEnvironmentBytes,
    coreRevision: fixture.revisions.coreRevision,
    transportMode: fixture.transportMode,
    expectedEmbeddedBottlePlanBytes: loaded.bottleMirrorPlanBytes,
    lazyUrlBase: "https://closed.kandelo.invalid/homebrew-login-product/",
    closedBottleAssets: loaded.closedBottleAssets!,
  });
  if (loaded.compositionReportBytes === undefined) {
    throw new Error("login product fixture omits its composition report");
  }
  let compositionReport: unknown;
  try {
    compositionReport = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        loaded.compositionReportBytes,
      ),
    );
  } catch (error) {
    throw new Error("login product composition report is not UTF-8 JSON", {
      cause: error,
    });
  }
  const fs = MemoryFileSystem.fromImage(loaded.imageBytes.slice());
  await fs.verifyImportedLazyAtomicGroupSeals();
  const localTest = (
    compositionReport as {
      local_test?: {
        source_tap_commit?: unknown;
        prepared_tap_commit?: unknown;
        staged_tap?: unknown;
      };
    }
  ).local_test;
  const stagedTap = projectLocalTestHomebrewTapBundleBinding(
    localTest?.staged_tap,
  );
  if (
    localTest?.source_tap_commit !== fixture.revisions.coreRevision ||
    localTest.prepared_tap_commit !== stagedTap.prepared_commit ||
    stagedTap.source_commit !== fixture.revisions.coreRevision
  ) {
    throw new Error(
      "login product staged tap differs from its source/prepared report binding",
    );
  }
  assertLocalTestHomebrewTapBundle(fs, stagedTap);
  const projectionsValue = (
    compositionReport as {
      privileged_programs?: { projections?: Array<Record<string, unknown>> };
    }
  ).privileged_programs?.projections;
  if (!Array.isArray(projectionsValue)) {
    throw new Error("login product composition report omits projections");
  }
  const projections = projectionsValue.map((entry) => ({
    schema: entry.schema,
    formula: entry.formula,
    bottleSha256: entry.bottle_sha256,
    sourcePath: entry.source_path,
    destinationPath: entry.destination_path,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    mountPoint: entry.mount_point,
    artifactValidationSha256: entry.artifact_validation_sha256,
  }));
  if (
    !projections.some((entry) => entry.destinationPath === "/usr/bin/login")
  ) {
    throw new Error("login product composition omits /usr/bin/login");
  }
  const privilegedProduct = await publishPrivilegedProgramProduct({
    policy: createReviewedPrivilegedProgramPolicy(projections),
    sources: projections.map((projection) => {
      const sourcePath = String(projection.sourcePath);
      const guestPath = `/opt/kandelo/homebrew/Cellar/${sourcePath}`;
      return {
        formula: String(projection.formula),
        bottleSha256: String(projection.bottleSha256),
        fs,
        inventory: {
          entries: [
            {
              sourcePath,
              type: "file" as const,
              size: fs.stat(guestPath).size,
            },
          ],
        },
        guestPathForSource: (path: string) =>
          `/opt/kandelo/homebrew/Cellar/${path}`,
      };
    }),
    writableBottleFileSystems: [fs],
  });
  if (loaded.privilegedProductBytes === undefined) {
    throw new Error("login product fixture omits its serialized product");
  }
  const serializedIdentity = (
    compositionReport as {
      privileged_product?: {
        image?: unknown;
        sha256?: unknown;
        bytes?: unknown;
      };
    }
  ).privileged_product;
  const generatedSha256 = await sha256(privilegedProduct.imageBytes);
  const loadedSha256 = await sha256(loaded.privilegedProductBytes);
  if (
    serializedIdentity?.image !== "main-shell.vfs.privileged.vfs" ||
    serializedIdentity.sha256 !== loadedSha256 ||
    serializedIdentity.bytes !== loaded.privilegedProductBytes.byteLength ||
    generatedSha256 !== loadedSha256 ||
    privilegedProduct.imageBytes.byteLength !==
      loaded.privilegedProductBytes.byteLength
  ) {
    throw new Error(
      "published privileged product differs from the exact serialized artifact",
    );
  }

  const diagnostics: string[] = [];
  const kernel = new BrowserKernel({
    maxWorkers: 8,
    env: ["TERM=xterm-kandelo", "PATH=/opt/kandelo/homebrew/bin:/usr/bin:/bin"],
    corsProxyUrl,
    onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
  });
  const markers: string[] = [];
  try {
    await announceLoginProductPhase("before-boot");
    const enabled = await initializeDemoLoginKernel({
      kernel,
      fs,
      kernelWasm: kernelBytes,
      vfsImage: runtime.imageBytes,
      closedLazyAssets: runtime.lazyAssets,
      lazyUrlBase: runtime.lazyUrlBase,
      privilegedProduct,
    });
    if (!enabled) throw new Error("reviewed login product was not admitted");
    const host = new LiveKernelHost({ kernel, status: "running" });
    host.setTerminalSessionPolicy(DEMO_TERMINAL_SESSION_POLICY);
    const pty = await host.attachPty("/dev/pts/0", { cols: 100, rows: 30 });
    let output = "";
    const off = pty.onData((bytes) => {
      output += new TextDecoder().decode(bytes);
    });
    const waitFrom = async (
      needle: string,
      start: number,
      label: string,
    ): Promise<void> => {
      const deadline = performance.now() + fixture.timeoutMs;
      while (!output.slice(start).includes(needle)) {
        if (performance.now() >= deadline) {
          throw new Error(
            `timed out waiting for ${label}; output=${JSON.stringify(output.slice(-4096))}`,
          );
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    };
    const command = async (text: string, marker: string): Promise<void> => {
      const start = output.length;
      pty.write(`(${text}) && printf '${marker}\\n'\n`);
      await waitFrom(marker, start, marker);
      markers.push(marker);
    };
    await waitFrom(
      "Every new terminal logs in automatically.",
      0,
      "automatic maker login",
    );
    markers.push("automatic-maker-login-ok");
    await command("id | grep 'uid=1000'", "maker-id-ok");

    let interactionStart = output.length;
    pty.write("/usr/bin/sudo -S -k id\n");
    await waitFrom(
      "Password:",
      interactionStart,
      "failed sudo password prompt",
    );
    interactionStart = output.length;
    pty.write("definitely-wrong\n");
    await waitFrom(
      "Sorry, try again",
      interactionStart,
      "failed sudo password rejection",
    );
    markers.push("failed-sudo-password-ok");
    interactionStart = output.length;
    pty.write("kandelo\n");
    await waitFrom("uid=0", interactionStart, "sudo root identity");
    markers.push("sudo-id-ok");
    await command(
      "printf 'kandelo\\n' | /usr/bin/sudo -S -l >/dev/null",
      "sudo-list-ok",
    );
    await command(
      "cp /usr/bin/sudo-lite /tmp/sudo-lite && chmod 4755 /tmp/sudo-lite && ! /tmp/sudo-lite id >/dev/null 2>&1",
      "nosuid-copy-rejected",
    );

    await announceLoginProductPhase("before-ruby");
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const live = `ruby-child-${repetition}-live`;
      const reaped = `ruby-child-${repetition}-reaped`;
      const repetitionStart = output.length;
      pty.write(
        `ruby --disable-gems -e 'require "rbconfig"; p=Process.spawn(RbConfig.ruby,"--disable-gems","-e","sleep 2"); puts "${live}"; STDOUT.flush; Process.wait(p); puts "${reaped}"'\n`,
      );
      await waitFrom(live, repetitionStart, live);
      if (repetition === 1) await announceLoginProductPhase("peak");
      await waitFrom(reaped, repetitionStart, reaped);
      if (repetition === 1) {
        await announceLoginProductPhase("after-child-reaping");
      }
      markers.push(reaped);
    }
    await announceLoginProductPhase("after-three-repetitions");
    await command(
      "irb --version >/dev/null && erb --version >/dev/null && gem --version >/dev/null && bundle --version >/dev/null && rake --version >/dev/null",
      "ruby-stock-tools-ok",
    );

    interactionStart = output.length;
    pty.write("exit\n");
    await waitFrom("login: ", interactionStart, "ordinary login prompt");
    interactionStart = output.length;
    pty.write("maker\n");
    await waitFrom("Password: ", interactionStart, "ordinary password prompt");
    interactionStart = output.length;
    pty.write("definitely-wrong\n");
    await waitFrom(
      "Login incorrect",
      interactionStart,
      "ordinary failed password",
    );
    await waitFrom("login: ", interactionStart, "ordinary retry login prompt");
    interactionStart = output.length;
    pty.write("maker\n");
    await waitFrom(
      "Password: ",
      interactionStart,
      "ordinary second password prompt",
    );
    interactionStart = output.length;
    pty.write("kandelo\n");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    pty.write("id; printf 'ordinary-login-ok\\n'\n");
    await waitFrom(
      "ordinary-login-ok",
      interactionStart,
      "ordinary maker identity",
    );
    markers.push("ordinary-login-ok");
    await command(
      `export HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1 HOMEBREW_REQUIRE_TAP_TRUST=1 GIT_TERMINAL_PROMPT=0; /usr/bin/brew tap kandelo-dev/tap-core file:///opt/kandelo/homebrew/var/kandelo/local-test/homebrew-tap-core.bundle && tap=$(/usr/bin/brew --repository kandelo-dev/tap-core) && test "$(/opt/kandelo/homebrew/bin/git -C "$tap" rev-parse HEAD)" = ${stagedTap.prepared_commit} && /opt/kandelo/homebrew/bin/git -C "$tap" cat-file -e ${stagedTap.source_commit}^\\{commit\\} && /opt/kandelo/homebrew/bin/git -C "$tap" merge-base --is-ancestor ${stagedTap.source_commit} ${stagedTap.prepared_commit} && /usr/bin/brew uninstall --ignore-dependencies kandelo-dev/tap-core/bzip2 && /usr/bin/brew trust --formula kandelo-dev/tap-core/bzip2 && /usr/bin/brew install --no-ask --force-bottle kandelo-dev/tap-core/bzip2 && prefix=$(/usr/bin/brew --prefix kandelo-dev/tap-core/bzip2) && printf 'login-product-bzip2\\n' > /tmp/login-product-bzip2 && "$prefix/bin/bzip2" -f /tmp/login-product-bzip2 && "$prefix/bin/bzip2" -d -f /tmp/login-product-bzip2.bz2 && grep -Fx login-product-bzip2 /tmp/login-product-bzip2 >/dev/null`,
      "brew-tap-install-execute-ok",
    );
    off();
    pty.close();
    host.detachKernel();
    if (diagnostics.length !== 0) {
      throw new Error(
        `login product diagnostics: ${JSON.stringify(diagnostics)}`,
      );
    }
  } finally {
    await kernel.destroy().catch(() => {});
  }

  return { markers };
}

interface HomebrewSystemCommandProofRequest {
  vfsUrl: string;
  lazyUrlBase: string;
  bootstrapArchiveUrl: string;
  bootstrapArchiveBytes: number;
  timeoutMs: number;
}

interface HomebrewSystemCommandProofResult {
  stdout: string;
  stderr: string;
  processEvents: Array<{
    kind: "spawn" | "exec" | "exit";
    pid: number;
    ppid?: number;
    exitStatus?: number;
  }>;
  forkCountSamples: Array<{
    parentPid: number;
    childPid: number;
    count: string;
  }>;
  remainingObservedPids: number[];
}

interface LazyVfsAcceptanceRequest {
  vfsUrl: string;
  readPath: string;
  executable?: string;
  argv?: string[];
  env?: string[];
  corsProxyExternalLazyUrls?: boolean;
  retryReadAfterFailure?: boolean;
  timeoutMs: number;
}

interface LazyVfsAcceptanceResult {
  readText: string;
  firstReadError?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

interface PackageLayerBootRequest {
  baseVfsUrl: string;
  descriptor: BootDescriptor;
  reviewedProductProfile?: "package-layer-acceptance-v1";
  inspect?: {
    statPaths: string[];
    readdirPaths: string[];
  };
}

const PACKAGE_LAYER_ACCEPTANCE_PRODUCT_POLICY =
  createReviewedPrivilegedProgramPolicy(
    ["login", "sudo-lite", "sudo"].map((name) => ({
      schema: 1,
      formula: "kandelo-dev/tap-core/lazyfixture",
      bottleSha256:
        "3daab2c56480490730e08bd73ee06e6beb681fa45ada1179318514af9362c433",
      sourcePath: "lazyfixture/1.0/bin/mount-probe",
      destinationPath: `/usr/bin/${name}`,
      uid: 0,
      gid: 0,
      mode: 0o4755,
      mountPoint: "trusted-root-product",
      artifactValidationSha256:
        "bc22eba05a72927443ab9294a685b0bde701977c4e380d18c25f357f2d8aa584",
    })),
  );

interface PackageLayerBootResult {
  layerIds: string[];
  stats: Array<{ path: string; mode: number; size: number }>;
  directories: Array<{ path: string; names: string[] }>;
  privilegedProduct?: {
    stats: Array<{
      path: string;
      mode: number;
      uid: number;
      gid: number;
      nlink: number;
    }>;
    uniqueIdentityCount: number;
    readonly: boolean;
    trusted: boolean;
    ordinaryBottleWritable: boolean;
    ordinaryMountNosuid: boolean;
  };
}

interface PackageLayerExecRequest {
  executable: string;
  argv: string[];
  env?: string[];
  timeoutMs: number;
}

interface PackageLayerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RootfsExportAcceptanceRequest {
  vfsUrl: string;
  writePath: string;
  writeText: string;
  liveProcessUrl: string;
  teardownProcessUrl: string;
  lazyReadPath: string;
  lazyReadUrl: string;
  lazyReadText: string;
  lateWritePath: string;
  lateWriteText: string;
}

interface RootfsExportAcceptanceResult {
  persistedText: string;
  firstExportSha256: string;
  secondExportSha256: string;
  firstExportBytes: number;
  firstExportSourceBytesAfterOwnedInit: number;
  secondExportBytes: number;
  liveProcessExitCode: number;
  liveProcessExportError: string;
  teardownProcessExitCode: number;
  teardownExportError: string;
  overlappingExportError: string;
  overlappingWriteError: string;
  lazyReadText: string;
  lateWritePresentInExport: boolean;
  writeAfterExportText: string;
  diagnostics: Array<{ source: string; message: string }>;
  lazyEntries: Array<{
    path: string;
    url: string;
    size: number;
  }>;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewVfsAcceptance: (
      request: HomebrewVfsAcceptanceRequest,
    ) => Promise<HomebrewVfsAcceptanceResult>;
    __runLazyVfsAcceptance: (
      request: LazyVfsAcceptanceRequest,
    ) => Promise<LazyVfsAcceptanceResult>;
    __bootPackageLayerAcceptance: (
      request: PackageLayerBootRequest,
    ) => Promise<PackageLayerBootResult>;
    __readPackageLayerAcceptance: (path: string) => Promise<string>;
    __execPackageLayerAcceptance: (
      request: PackageLayerExecRequest,
    ) => Promise<PackageLayerExecResult>;
    __destroyPackageLayerAcceptance: () => Promise<void>;
    __packageLayerDiscardedBufferCount: () => number;
    __inspectSharedWrapperAuthorityBoundary: () => {
      distinctWrapper: boolean;
      mutationShared: boolean;
      candidateAdmission: boolean;
      testCandidateAdmission: boolean;
    };
    __runRootfsExportAcceptance: (
      request: RootfsExportAcceptanceRequest,
    ) => Promise<RootfsExportAcceptanceResult>;
    __releaseRootfsExportLazyResponse: () => Promise<void>;
    __runHomebrewGuestLifecycleAcceptance: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<HomebrewGuestLifecycleBrowserResult>;
    __runHomebrewGuestCoreShippingProof: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<{ coreRevision: string; completedUrls: string[] }>;
    __homebrewLoginProductPhase: string;
    __ackHomebrewLoginProductPhase: () => void;
    __runHomebrewLoginProductLifecycle: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<{ markers: string[] }>;
    __runHomebrewSystemCommandProof: (
      request: HomebrewSystemCommandProofRequest,
    ) => Promise<HomebrewSystemCommandProofResult>;
    __runHomebrewFlatVfsShippingProof: (
      request: HomebrewFlatVfsShippingProofRequest,
    ) => Promise<HomebrewFlatVfsShippingProofResult>;
  }
}

interface PackageLayerMachine {
  kernel: BrowserKernel;
  output: { stdout: string; stderr: string };
}

let packageLayerMachine: PackageLayerMachine | null = null;
let packageLayerDiscardedBufferCount = 0;

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    fs.read(fd, bytes, null, bytes.byteLength);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

async function extractExecutable(
  image: Uint8Array,
  path: string,
): Promise<Uint8Array> {
  const fs = await restoreVerifiedVfsImagePreservingCapacity(image);
  try {
    return readVfsFile(fs, path);
  } finally {
    trackTransientImageBuffer(fs.sharedBuffer);
  }
}

function appendOutput(
  current: string,
  bytes: Uint8Array,
  label: string,
): string {
  const next = current + new TextDecoder().decode(bytes);
  if (new TextEncoder().encode(next).byteLength > MAX_OUTPUT_BYTES) {
    throw new Error(`${label} exceeded ${MAX_OUTPUT_BYTES} bytes`);
  }
  return next;
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source: BufferSource =
    bytes instanceof Uint8Array
    ? new Uint8Array(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength,
      )
    : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function fetchBytes(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`${label} fetch failed with HTTP ${response.status}`);
  return response.arrayBuffer();
}

function sameOriginTestUrl(value: string, label: string): URL {
  const url = new URL(value, window.location.href);
  if (
    url.origin !== window.location.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`Homebrew SystemCommand ${label} URL is invalid`);
  }
  return url;
}

async function rejectionMessage(
  operation: Promise<unknown>,
  label: string,
): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function exportRootfsWhenQuiescent(
  kernel: BrowserKernel,
  timeoutMs = 5_000,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await kernel.exportRootfsImage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("no live or tearing-down processes") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      // WHY: the public process-exit promise resolves when the worker reports
      // exit, before the worker-owned teardown promise necessarily settles.
      // Retry only that documented transient rejection; the export API remains
      // the authority for when the browser kernel is actually quiescent.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function init(): Promise<void> {
  const kernelBytes = await fetchBytes(kernelWasmUrl, "kernel.wasm");
  const kernelSha256 = await sha256(kernelBytes);

  window.__runHomebrewGuestLifecycleAcceptance = (fixture) =>
    runHomebrewGuestLifecycleInBrowser({
      fixture,
      kernelWasm: kernelBytes,
      corsProxy,
      ...(closedLifecycleAssetRoot === undefined
        ? {}
        : { closedAssetRootUrl: closedLifecycleAssetRoot }),
      afterMachineDestroy: settleWebKitReclaim,
    });
  window.__runHomebrewGuestCoreShippingProof = (fixture) =>
    runHomebrewGuestCoreShippingProofInBrowser({
      fixture,
      kernelWasm: kernelBytes,
      corsProxyUrl,
      ...(closedLifecycleAssetRoot === undefined
        ? {}
        : { closedAssetRootUrl: closedLifecycleAssetRoot }),
      afterMachineDestroy: settleWebKitReclaim,
    });
  window.__homebrewLoginProductPhase = "idle";
  window.__ackHomebrewLoginProductPhase = () => {
    if (loginProductPhaseAcknowledgement === undefined) {
      throw new Error("no login product phase acknowledgement is pending");
    }
    loginProductPhaseAcknowledgement();
  };
  window.__runHomebrewLoginProductLifecycle = (fixture) =>
    runHomebrewLoginProductLifecycle(fixture, kernelBytes);

  window.__runHomebrewFlatVfsShippingProof = async (request) => {
    const validated = validateHomebrewFlatVfsShippingProofRequest(request, {
      locationHref: window.location.href,
      actualKernelSha256: kernelSha256,
    });
    const imageBytes = new Uint8Array(
      await fetchBytes(validated.vfsUrl.href, "flat Homebrew VFS image"),
    );
    const actualImageSha256 = await sha256(imageBytes);
    if (actualImageSha256 !== validated.expectedImageSha256) {
      throw new Error(
        "flat Homebrew VFS fetched image SHA-256 does not match the request",
      );
    }
    return runHomebrewFlatVfsShippingProofInBrowser({
      runtime: {
        imageBytes,
        shellPath: validated.shellPath,
        shellArgv0: validated.shellArgv0,
        takeImageOwnership: true,
      },
      tapRevision: validated.tapRevision,
      deadlineMs: Date.now() + validated.timeoutMs,
      kernelWasm: kernelBytes,
      corsProxy,
      afterMachineDestroy: settleWebKitReclaim,
    });
  };

  window.__runHomebrewSystemCommandProof = async (request) => {
    if (
      !Number.isSafeInteger(request.bootstrapArchiveBytes) ||
      request.bootstrapArchiveBytes < 1 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1_000 ||
      request.timeoutMs > 5 * 60_000
    ) {
      throw new Error("Homebrew SystemCommand proof limits are invalid");
    }
    const vfsUrl = sameOriginTestUrl(request.vfsUrl, "VFS image");
    const lazyUrlBase = sameOriginTestUrl(request.lazyUrlBase, "lazy URL base");
    const bootstrapArchiveUrl = sameOriginTestUrl(
      request.bootstrapArchiveUrl,
      "bootstrap archive",
    );
    if (!lazyUrlBase.pathname.endsWith("/")) {
      throw new Error(
        "Homebrew SystemCommand lazy URL base is not a directory",
      );
    }
    const imageBytes = new Uint8Array(
      await fetchBytes(vfsUrl.href, "Homebrew SystemCommand VFS image"),
    );
    MemoryFileSystem.assertImageKernelAbi(
      imageBytes,
      ABI_VERSION,
      "Homebrew SystemCommand browser image",
    );
    const runtime = {
      imageBytes,
      shellPath: "/bin/bash",
      shellArgv0: "bash",
      lazyUrlBase: lazyUrlBase.href,
      bootstrapTransportUrl: bootstrapArchiveUrl.href,
      bootstrapBytes: request.bootstrapArchiveBytes,
    };
    const result = await runHomebrewSystemCommandSpawnProof({
      runtime,
      deadlineMs: Date.now() + request.timeoutMs,
      machine: createBrowserLifecycleMachine({
        runtime,
        kernelWasm: kernelBytes,
        corsProxy,
        afterDestroy: settleWebKitReclaim,
      }),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      processEvents: [...result.processEvents],
      forkCountSamples: result.forkCountSamples.map((sample) => ({
        ...sample,
        count: sample.count.toString(),
      })),
      remainingObservedPids: [...result.remainingObservedPids],
    };
  };

  window.__runHomebrewVfsAcceptance = async (request) => {
    const input = validateHomebrewVfsAcceptanceRequest(request);

    const imageBytes = await fetchBytes(request.vfsUrl, "Homebrew VFS image");
    const imageSha256 = await sha256(imageBytes);
    MemoryFileSystem.assertImageKernelAbi(
      new Uint8Array(imageBytes),
      ABI_VERSION,
      "Homebrew Brewfile VFS image",
    );
    const executableBytes = await extractExecutable(
      new Uint8Array(imageBytes),
      request.executable,
    );
    let stdout = "";
    let stderr = "";
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (bytes) => {
        stdout = appendOutput(stdout, bytes, "stdout");
      },
      onStderr: (bytes) => {
        stderr = appendOutput(stderr, bytes, "stderr");
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Pass the exact fetched bytes. Unlike the interactive demo path, this
      // acceptance runner does not stage shell utilities or reserialize first.
      await kernel.initFromImage({
        kernelWasm: kernelBytes,
        vfsImage: new Uint8Array(imageBytes),
      });
      const executable = new Uint8Array(executableBytes.byteLength);
      executable.set(executableBytes);
      const spawnOptions = {
        cwd: "/",
        env: [
          "HOME=/tmp",
          "TMPDIR=/tmp",
          "PATH=/opt/kandelo/homebrew/bin:/usr/bin:/bin",
        ],
        ...(input.kind !== "stdio" || input.stdin === undefined
          ? {}
          : { stdin: input.stdin }),
        ...(input.kind !== "pty"
          ? {}
          : {
              pty: true,
              onStarted: (pid: number) => {
                // WHY: a PTY routes both input and combined terminal output
                // through its master side. The browser worker intentionally
                // ignores SpawnMessage.stdin for PTY processes, so register
                // output first and then send the bounded script via ptyWrite.
                kernel.onPtyOutput(pid, (bytes) => {
                  stdout = appendOutput(stdout, bytes, "PTY output");
                });
                kernel.ptyWrite(pid, input.input);
              },
            }),
      };
      const exitCode = await Promise.race([
        kernel.spawn(executable.buffer, request.argv, spawnOptions),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `browser acceptance timed out after ${request.timeoutMs}ms`,
                ),
              ),
            request.timeoutMs,
          );
        }),
      ]);
      return { exitCode, stdout, stderr, imageSha256, kernelSha256 };
    } finally {
      if (timer) clearTimeout(timer);
      await kernel.destroy().catch(() => {});
      await settleWebKitReclaim();
    }
  };

  window.__runLazyVfsAcceptance = async (request) => {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000) {
      throw new Error("timeoutMs must be an integer of at least 1000");
    }
    const imageBytes = await fetchBytes(request.vfsUrl, "lazy VFS image");
    MemoryFileSystem.assertImageKernelAbi(
      new Uint8Array(imageBytes),
      ABI_VERSION,
      "lazy VFS image",
    );
    let stdout = "";
    let stderr = "";
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      ...(request.corsProxyExternalLazyUrls ? { corsProxyUrl } : {}),
      onStdout: (bytes) => {
        stdout = appendOutput(stdout, bytes, "stdout");
      },
      onStderr: (bytes) => {
        stderr = appendOutput(stderr, bytes, "stderr");
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await kernel.initFromImage({
        kernelWasm: kernelBytes,
        vfsImage: new Uint8Array(imageBytes),
      });
      let firstReadError: string | undefined;
      let read: Uint8Array | null = null;
      try {
        read = await kernel.readFileFromVfs(request.readPath);
      } catch (error) {
        firstReadError = error instanceof Error ? error.message : String(error);
        if (!request.retryReadAfterFailure) throw error;
      }
      if (read === null && request.retryReadAfterFailure) {
        read = await kernel.readFileFromVfs(request.readPath);
      }
      if (read === null)
        throw new Error(`missing VFS file ${request.readPath}`);

      let exitCode: number | undefined;
      if (request.executable) {
        const spawned = await kernel.spawnFromVfs(
          request.executable,
          request.argv ?? [request.executable],
          {
            cwd: "/",
            env: request.env ?? [],
          },
        );
        exitCode = await Promise.race([
          spawned.exit,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                `lazy VFS acceptance timed out after ${request.timeoutMs}ms`,
                  ),
                ),
              request.timeoutMs,
            );
          }),
        ]);
      }
      return {
        readText: new TextDecoder().decode(read),
        ...(firstReadError === undefined ? {} : { firstReadError }),
        ...(exitCode === undefined ? {} : { exitCode }),
        stdout,
        stderr,
      };
    } finally {
      if (timer) clearTimeout(timer);
      await kernel.destroy().catch(() => {});
      await settleWebKitReclaim();
    }
  };

  window.__runRootfsExportAcceptance = async (request) => {
    const initialImage = new Uint8Array(
      await fetchBytes(request.vfsUrl, "rootfs export VFS image"),
    );
    const liveProcessBytes = await fetchBytes(
      request.liveProcessUrl,
      "live-process fixture",
    );
    const teardownProcessBytes = await fetchBytes(
      request.teardownProcessUrl,
      "teardown-process fixture",
    );
    const diagnostics: Array<{ source: string; message: string }> = [];
    let firstKernel: BrowserKernel | null = new BrowserKernel({
      kernelOwnedFs: true,
      onHostDiagnostic: (diagnostic) => {
        diagnostics.push({
          source: diagnostic.source,
          message: diagnostic.message,
        });
      },
    });
    let firstExport: Uint8Array;
    let liveProcessExitCode: number;
    let liveProcessExportError: string;
    let teardownProcessExitCode: number;
    let teardownExportError: string;
    let overlappingExportError: string;
    let overlappingWriteError: string;
    let lazyReadText: string;
    let writeAfterExportText: string;
    try {
      await firstKernel.initFromImage({
        kernelWasm: kernelBytes,
        vfsImage: initialImage,
      });
      await firstKernel.writeFileToVfs(
        request.writePath,
        new TextEncoder().encode(request.writeText),
        0o640,
      );

      let resolveLivePid!: (pid: number) => void;
      let rejectLivePid!: (error: unknown) => void;
      const livePid = new Promise<number>((resolve, reject) => {
        resolveLivePid = resolve;
        rejectLivePid = reject;
      });
      const liveExit = firstKernel
        .spawn(liveProcessBytes, ["block-forever"], {
          onStarted: resolveLivePid,
        })
        .catch((error) => {
        rejectLivePid(error);
        throw error;
      });
      const pid = await withTimeout(livePid, "live process start");
      liveProcessExportError = await withTimeout(
        rejectionMessage(
          firstKernel.exportRootfsImage(),
          "rootfs export with a live process",
        ),
        "live-process rootfs rejection",
      );
      await firstKernel.terminateProcess(pid, 143);
      liveProcessExitCode = await withTimeout(
        liveExit,
        "live process termination",
      );

      teardownProcessExitCode = await withTimeout(
        firstKernel.spawn(teardownProcessBytes, ["thread-exit-group"]),
        "threaded process exit",
      );
      // WHY: thread-exit-group exits from its child thread. The public exit
      // promise resolves before the browser worker's tracked 250 ms thread and
      // process-worker teardown settles, giving this request a deterministic
      // real teardown window without exposing an internal test hook.
      teardownExportError = await withTimeout(
        rejectionMessage(
          firstKernel.exportRootfsImage(),
          "rootfs export during process-worker teardown",
        ),
        "teardown rootfs rejection",
      );
      await exportRootfsWhenQuiescent(firstKernel);

      let resolveLazyStart!: () => void;
      const lazyStarted = new Promise<void>((resolve) => {
        resolveLazyStart = resolve;
      });
      const unsubscribeLazy = firstKernel.subscribeLazyDownloads((event) => {
        if (event.url === request.lazyReadUrl && event.status === "started") {
          resolveLazyStart();
        }
      });
      const lazyRead = firstKernel.readFileFromVfs(request.lazyReadPath);
      let gatedExport: Promise<Uint8Array> | undefined;
      try {
        await withTimeout(lazyStarted, "lazy rootfs read start");
        // WHY: the lazy read has entered the worker's mutation gate but its
        // routed response is deliberately held by Playwright. FIFO worker
        // messages make the first export close the gate while it waits for
        // that read; the following export and write must therefore reject.
        gatedExport = firstKernel.exportRootfsImage();
        [overlappingExportError, overlappingWriteError] = await withTimeout(
          Promise.all([
            rejectionMessage(
              firstKernel.exportRootfsImage(),
              "overlapping rootfs export",
            ),
            rejectionMessage(
              firstKernel.writeFileToVfs(
                request.lateWritePath,
                new TextEncoder().encode(request.lateWriteText),
                0o640,
              ),
              "rootfs write during export",
            ),
          ]),
          "rootfs export exclusion",
        );
      } finally {
        unsubscribeLazy();
        // The callback is Playwright transport coordination only. It releases
        // the real fetch used by MemoryFileSystem; it does not mutate worker
        // state or bypass the production snapshot gate.
        await window.__releaseRootfsExportLazyResponse();
      }
      const lazyBytes = await withTimeout(
        lazyRead,
        "lazy rootfs read completion",
      );
      if (lazyBytes === null) {
        throw new Error(`lazy rootfs read lost ${request.lazyReadPath}`);
      }
      lazyReadText = new TextDecoder().decode(lazyBytes);
      if (gatedExport === undefined) {
        throw new Error("rootfs export exclusion did not start an export");
      }
      firstExport = await withTimeout(
        gatedExport,
        "rootfs export after lazy mutation",
      );

      await firstKernel.writeFileToVfs(
        request.lateWritePath,
        new TextEncoder().encode(request.lateWriteText),
        0o640,
      );
      const writeAfterExport = await firstKernel.readFileFromVfs(
        request.lateWritePath,
      );
      if (writeAfterExport === null) {
        throw new Error(`post-export write lost ${request.lateWritePath}`);
      }
      writeAfterExportText = new TextDecoder().decode(writeAfterExport);
    } finally {
      await firstKernel?.destroy().catch(() => {});
      firstKernel = null;
      await settleWebKitReclaim();
    }

    const firstExportSha256 = await sha256(firstExport);
    const firstExportBytes = firstExport.byteLength;
    if (
      !(firstExport.buffer instanceof ArrayBuffer) ||
      firstExport.byteOffset !== 0 ||
      firstExport.byteLength !== firstExport.buffer.byteLength
    ) {
      throw new Error(
        "rootfs export did not return one whole transferable ArrayBuffer",
      );
    }
    const firstExportBuffer = firstExport.buffer;
    let parsed: MemoryFileSystem | null =
      await restoreVerifiedVfsImage(firstExport);
    const lazyEntries = parsed.exportLazyEntries().map((entry) => ({
      path: entry.path,
      url: entry.url,
      size: entry.size,
    }));
    const exportedLazyRead = new TextDecoder().decode(
      readVfsFile(parsed, request.lazyReadPath),
    );
    if (exportedLazyRead !== request.lazyReadText) {
      throw new Error(`exported rootfs changed ${request.lazyReadPath}`);
    }
    const lateWritePresentInExport = vfsPathExists(
      parsed,
      request.lateWritePath,
    );
    trackTransientImageBuffer(parsed.sharedBuffer);
    parsed = null;

    let secondKernel: BrowserKernel | null = new BrowserKernel({
      kernelOwnedFs: true,
      onHostDiagnostic: (diagnostic) => {
        diagnostics.push({
          source: diagnostic.source,
          message: diagnostic.message,
        });
      },
    });
    try {
      // WHY: a durable reboot has already hashed and inspected this export.
      // Transfer its exact buffer so a large image is not structured-cloned on
      // the persistent browser main thread before worker-owned restore.
      await secondKernel.initFromOwnedImage({
        kernelWasm: kernelBytes,
        vfsImage: firstExportBuffer,
      });
      const firstExportSourceBytesAfterOwnedInit = firstExport.byteLength;
      const persisted = await secondKernel.readFileFromVfs(request.writePath);
      if (persisted === null) {
        throw new Error(`exported rootfs lost ${request.writePath}`);
      }
      const secondExport = await secondKernel.exportRootfsImage();
      return {
        persistedText: new TextDecoder().decode(persisted),
        firstExportSha256,
        secondExportSha256: await sha256(secondExport),
        firstExportBytes,
        firstExportSourceBytesAfterOwnedInit,
        secondExportBytes: secondExport.byteLength,
        liveProcessExitCode,
        liveProcessExportError,
        teardownProcessExitCode,
        teardownExportError,
        overlappingExportError,
        overlappingWriteError,
        lazyReadText,
        lateWritePresentInExport,
        writeAfterExportText,
        diagnostics,
        lazyEntries,
      };
    } finally {
      await secondKernel?.destroy().catch(() => {});
      secondKernel = null;
      await settleWebKitReclaim();
    }
  };

  window.__destroyPackageLayerAcceptance = async () => {
    const machine = packageLayerMachine;
    packageLayerMachine = null;
    if (machine) await machine.kernel.destroy().catch(() => {});
    await settleWebKitReclaim();
  };
  window.__packageLayerDiscardedBufferCount = () =>
    packageLayerDiscardedBufferCount;
  window.__inspectSharedWrapperAuthorityBoundary = () => {
    const candidate = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * 1024 * 1024),
    );
    const distinctWrapper = structuredClone(candidate.sharedBuffer);
    const writableAlias = MemoryFileSystem.fromExisting(distinctWrapper);
    candidate.mkdir("/shared-wrapper-proof", 0o755);
    return {
      distinctWrapper: distinctWrapper !== candidate.sharedBuffer,
      mutationShared:
        (writableAlias.lstat("/shared-wrapper-proof").mode & 0o170000) ===
          0o040000,
      candidateAdmission: Reflect.has(
        privilegedProjectionModule,
        "admitPrivilegedProgramProductCandidate",
      ),
      testCandidateAdmission: Reflect.has(
        privilegedProjectionModule,
        "admitPrivilegedProgramProductCandidateForTest",
      ),
    };
  };

  window.__bootPackageLayerAcceptance = async (request) => {
    await window.__destroyPackageLayerAcceptance();
    let kernel: BrowserKernel | null = null;
    try {
      const baseImageBytes = new Uint8Array(
        await fetchBytes(request.baseVfsUrl, "package-layer base VFS image"),
      );
      MemoryFileSystem.assertImageKernelAbi(
        baseImageBytes,
        ABI_VERSION,
        "package-layer base VFS image",
      );
      const compositionOptions = {
        descriptor: request.descriptor,
        baseImageBytes,
        kernelAbi: ABI_VERSION,
        onStagedFileSystemDiscarded: (buffer: SharedArrayBuffer) => {
          packageLayerDiscardedBufferCount += 1;
          trackTransientImageBuffer(buffer);
        },
      };
      if (
        request.reviewedProductProfile !== undefined &&
        request.reviewedProductProfile !== "package-layer-acceptance-v1"
      ) {
        throw new Error("unknown reviewed package-layer product profile");
      }
      const composed =
        request.reviewedProductProfile === undefined
        ? await composeBootDescriptorVfs(compositionOptions)
        : await composeBootDescriptorVfsWithReviewedProduct(
          compositionOptions,
          PACKAGE_LAYER_ACCEPTANCE_PRODUCT_POLICY,
        );
      trackTransientImageBuffer(composed.fs.sharedBuffer);
      const stats = (request.inspect?.statPaths ?? []).map((path) => {
        const stat = composed.fs.stat(path);
        return { path, mode: stat.mode, size: stat.size };
      });
      const directories = (request.inspect?.readdirPaths ?? []).map((path) => {
        const handle = composed.fs.opendir(path);
        const names: string[] = [];
        try {
          for (;;) {
            const entry = composed.fs.readdir(handle);
            if (entry === null) break;
            names.push(entry.name);
          }
        } finally {
          composed.fs.closedir(handle);
        }
        return { path, names: names.sort() };
      });
      let privilegedProduct: PackageLayerBootResult["privilegedProduct"];
      if (composed.privilegedProduct !== undefined) {
        const destinations = composed.privilegedProduct.projections.map(
          (projection) => projection.destinationPath,
        );
        let readonly = false;
        try {
          composed.privilegedProduct.mount.backend.unlink(destinations[0]!);
        } catch (error) {
          readonly = error instanceof Error && error.message.includes("EROFS");
        }
        const firstProjection = composed.privilegedProduct.projections[0]!;
        const ordinaryBottlePath = `/opt/kandelo/homebrew/Cellar/${firstProjection.sourcePath}`;
        const ordinaryBottleMode =
          composed.fs.lstat(ordinaryBottlePath).mode & 0o7777;
        let ordinaryBottleWritable = false;
        try {
          composed.fs.chmod(ordinaryBottlePath, ordinaryBottleMode ^ 0o200);
          ordinaryBottleWritable =
            (composed.fs.lstat(ordinaryBottlePath).mode & 0o7777) ===
              (ordinaryBottleMode ^ 0o200);
        } finally {
          composed.fs.chmod(ordinaryBottlePath, ordinaryBottleMode);
        }
        privilegedProduct = {
          stats: destinations.map((path) => {
            const stat = composed.privilegedProduct!.mount.backend.lstat(path);
            return {
              path,
              mode: stat.mode,
              uid: stat.uid,
              gid: stat.gid,
              nlink: stat.nlink,
            };
          }),
          uniqueIdentityCount: new Set(
            composed.privilegedProduct.evidence.map(
              (entry) =>
              `${entry.destinationIdentity.dev}:` +
              `${entry.destinationIdentity.ino}:` +
                `${entry.destinationIdentity.generation}`,
            ),
          ).size,
          readonly,
          trusted:
            resolveMountSetIdCapability(composed.privilegedProduct.mount)
              .kind === "trusted-root-product",
          ordinaryBottleWritable,
          ordinaryMountNosuid:
            resolveMountSetIdCapability({ backend: composed.fs }).kind ===
              "nosuid",
        };
      }
      const output = { stdout: "", stderr: "" };
      kernel = new BrowserKernel({
        kernelOwnedFs: true,
        onStdout: (bytes) => {
          output.stdout = appendOutput(output.stdout, bytes, "stdout");
        },
        onStderr: (bytes) => {
          output.stderr = appendOutput(output.stderr, bytes, "stderr");
        },
      });
      await kernel.initFromImage({
        kernelWasm: kernelBytes,
        vfsImage: await finalizeKernelOwnedImage(composed.fs),
      });
      packageLayerMachine = { kernel, output };
      return {
        layerIds: composed.layers.map((layer) => layer.id),
        stats,
        directories,
        ...(privilegedProduct === undefined ? {} : { privilegedProduct }),
      };
    } catch (error) {
      if (kernel) await kernel.destroy().catch(() => {});
      await settleWebKitReclaim();
      throw error;
    }
  };

  window.__readPackageLayerAcceptance = async (path) => {
    const machine = packageLayerMachine;
    if (!machine)
      throw new Error("package-layer acceptance machine is not booted");
    const bytes = await machine.kernel.readFileFromVfs(path);
    if (bytes === null)
      throw new Error(`missing package-layer VFS file ${path}`);
    return new TextDecoder().decode(bytes);
  };

  window.__execPackageLayerAcceptance = async (request) => {
    const machine = packageLayerMachine;
    if (!machine)
      throw new Error("package-layer acceptance machine is not booted");
    if (!Array.isArray(request.argv) || request.argv.length === 0) {
      throw new Error("argv must contain at least one entry");
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000) {
      throw new Error("timeoutMs must be an integer of at least 1000");
    }
    machine.output.stdout = "";
    machine.output.stderr = "";
    const spawned = await machine.kernel.spawnFromVfs(
      request.executable,
      request.argv,
      { cwd: "/", env: request.env ?? [] },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        spawned.exit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
              `package-layer exec timed out after ${request.timeoutMs}ms`,
                ),
              ),
            request.timeoutMs,
          );
        }),
      ]);
      return {
        exitCode,
        stdout: machine.output.stdout,
        stderr: machine.output.stderr,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  window.__homebrewVfsTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((error) => {
  document.getElementById("status")!.textContent =
    `Error: ${error instanceof Error ? error.message : String(error)}`;
  console.error("Homebrew VFS test runner failed:", error);
});
