import { BrowserKernel } from "@host/browser-kernel-host";
import { ABI_VERSION } from "@host/generated/abi";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import {
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
  trackTransientImageBuffer,
} from "../../lib/kernel-owned-boot";
import {
  composeBootDescriptorVfs,
} from "../../lib/init/homebrew-package-layers";
import type {
  BootDescriptor,
} from "../../../../web-libs/kandelo-session/src/kernel-host";
import {
  runHomebrewGuestLifecycleInBrowser,
  type HomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserResult,
} from "../../../../homebrew/test/homebrew_guest_lifecycle_browser";
import kernelWasmUrl from "@kernel-wasm?url";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const corsProxyUrl = new URL(
  `${import.meta.env.BASE_URL}__kandelo_cors_proxy?url=`,
  window.location.href,
).href;

interface HomebrewVfsAcceptanceRequest {
  vfsUrl: string;
  executable: string;
  argv: string[];
  timeoutMs: number;
}

interface HomebrewVfsAcceptanceResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  imageSha256: string;
  kernelSha256: string;
}

interface LazyVfsAcceptanceRequest {
  vfsUrl: string;
  readPath: string;
  executable?: string;
  argv?: string[];
  env?: string[];
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
  inspect?: {
    statPaths: string[];
    readdirPaths: string[];
  };
}

interface PackageLayerBootResult {
  layerIds: string[];
  stats: Array<{ path: string; mode: number; size: number }>;
  directories: Array<{ path: string; names: string[] }>;
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
    __runRootfsExportAcceptance: (
      request: RootfsExportAcceptanceRequest,
    ) => Promise<RootfsExportAcceptanceResult>;
    __releaseRootfsExportLazyResponse: () => Promise<void>;
    __runHomebrewGuestLifecycleAcceptance: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<HomebrewGuestLifecycleBrowserResult>;
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

function extractExecutable(image: Uint8Array, path: string): Uint8Array {
  const fs = MemoryFileSystem.fromImagePreservingCapacity(image);
  try {
    return readVfsFile(fs, path);
  } finally {
    trackTransientImageBuffer(fs.sharedBuffer);
  }
}

function appendOutput(current: string, bytes: Uint8Array, label: string): string {
  const next = current + new TextDecoder().decode(bytes);
  if (new TextEncoder().encode(next).byteLength > MAX_OUTPUT_BYTES) {
    throw new Error(`${label} exceeded ${MAX_OUTPUT_BYTES} bytes`);
  }
  return next;
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source: BufferSource = bytes instanceof Uint8Array
    ? new Uint8Array(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength,
      )
    : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} fetch failed with HTTP ${response.status}`);
  return response.arrayBuffer();
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
      corsProxyUrl,
      afterMachineDestroy: settleWebKitReclaim,
    });

  window.__runHomebrewVfsAcceptance = async (request) => {
    if (!Array.isArray(request.argv) || request.argv.length === 0) {
      throw new Error("argv must contain at least one entry");
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000) {
      throw new Error("timeoutMs must be an integer of at least 1000");
    }

    const imageBytes = await fetchBytes(request.vfsUrl, "Homebrew VFS image");
    const imageSha256 = await sha256(imageBytes);
    MemoryFileSystem.assertImageKernelAbi(
      new Uint8Array(imageBytes),
      ABI_VERSION,
      "Homebrew Brewfile VFS image",
    );
    const executableBytes = extractExecutable(
      new Uint8Array(imageBytes),
      request.executable,
    );
    let stdout = "";
    let stderr = "";
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (bytes) => { stdout = appendOutput(stdout, bytes, "stdout"); },
      onStderr: (bytes) => { stderr = appendOutput(stderr, bytes, "stderr"); },
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
      const exitCode = await Promise.race([
        kernel.spawn(executable.buffer, request.argv, {
          cwd: "/",
          env: [
            "HOME=/tmp",
            "TMPDIR=/tmp",
            "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
          ],
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`browser acceptance timed out after ${request.timeoutMs}ms`)),
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
      onStdout: (bytes) => { stdout = appendOutput(stdout, bytes, "stdout"); },
      onStderr: (bytes) => { stderr = appendOutput(stderr, bytes, "stderr"); },
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
      if (read === null) throw new Error(`missing VFS file ${request.readPath}`);

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
              () => reject(new Error(
                `lazy VFS acceptance timed out after ${request.timeoutMs}ms`,
              )),
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
      const liveExit = firstKernel.spawn(
        liveProcessBytes,
        ["block-forever"],
        {
          onStarted: resolveLivePid,
        },
      ).catch((error) => {
        rejectLivePid(error);
        throw error;
      });
      const pid = await withTimeout(
        livePid,
        "live process start",
      );
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
        firstKernel.spawn(
          teardownProcessBytes,
          ["thread-exit-group"],
        ),
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
        if (
          event.url === request.lazyReadUrl &&
          event.status === "started"
        ) {
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

    const parsed = MemoryFileSystem.fromImage(firstExport);
    const lazyEntries = parsed.exportLazyEntries().map((entry) => ({
      path: entry.path,
      url: entry.url,
      size: entry.size,
    }));
    const exportedLazyRead = new TextDecoder().decode(
      readVfsFile(parsed, request.lazyReadPath),
    );
    if (exportedLazyRead !== request.lazyReadText) {
      throw new Error(
        `exported rootfs changed ${request.lazyReadPath}`,
      );
    }
    const lateWritePresentInExport = vfsPathExists(
      parsed,
      request.lateWritePath,
    );

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
      await secondKernel.initFromImage({
        kernelWasm: kernelBytes,
        vfsImage: firstExport,
      });
      const persisted = await secondKernel.readFileFromVfs(request.writePath);
      if (persisted === null) {
        throw new Error(`exported rootfs lost ${request.writePath}`);
      }
      const secondExport = await secondKernel.exportRootfsImage();
      return {
        persistedText: new TextDecoder().decode(persisted),
        firstExportSha256: await sha256(firstExport),
        secondExportSha256: await sha256(secondExport),
        firstExportBytes: firstExport.byteLength,
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
      const composed = await composeBootDescriptorVfs({
        descriptor: request.descriptor,
        baseImageBytes,
        kernelAbi: ABI_VERSION,
        onStagedFileSystemDiscarded: (buffer) => {
          packageLayerDiscardedBufferCount += 1;
          trackTransientImageBuffer(buffer);
        },
      });
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
      };
    } catch (error) {
      if (kernel) await kernel.destroy().catch(() => {});
      await settleWebKitReclaim();
      throw error;
    }
  };

  window.__readPackageLayerAcceptance = async (path) => {
    const machine = packageLayerMachine;
    if (!machine) throw new Error("package-layer acceptance machine is not booted");
    const bytes = await machine.kernel.readFileFromVfs(path);
    if (bytes === null) throw new Error(`missing package-layer VFS file ${path}`);
    return new TextDecoder().decode(bytes);
  };

  window.__execPackageLayerAcceptance = async (request) => {
    const machine = packageLayerMachine;
    if (!machine) throw new Error("package-layer acceptance machine is not booted");
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
            () => reject(new Error(
              `package-layer exec timed out after ${request.timeoutMs}ms`,
            )),
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
  document.getElementById("status")!.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  console.error("Homebrew VFS test runner failed:", error);
});
