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
import kernelWasmUrl from "@kernel-wasm?url";

const MAX_OUTPUT_BYTES = 1024 * 1024;

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
}

interface RootfsExportAcceptanceResult {
  persistedText: string;
  firstExportSha256: string;
  secondExportSha256: string;
  firstExportBytes: number;
  secondExportBytes: number;
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

async function init(): Promise<void> {
  const kernelBytes = await fetchBytes(kernelWasmUrl, "kernel.wasm");
  const kernelSha256 = await sha256(kernelBytes);

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
    let firstKernel: BrowserKernel | null = new BrowserKernel({
      kernelOwnedFs: true,
    });
    let firstExport: Uint8Array;
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
      firstExport = await firstKernel.exportRootfsImage();
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

    let secondKernel: BrowserKernel | null = new BrowserKernel({
      kernelOwnedFs: true,
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
