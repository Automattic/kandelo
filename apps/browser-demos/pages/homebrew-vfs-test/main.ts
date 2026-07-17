import { BrowserKernel } from "@host/browser-kernel-host";
import { ABI_VERSION } from "@host/generated/abi";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import {
  settleWebKitReclaim,
  trackTransientImageBuffer,
} from "../../lib/kernel-owned-boot";
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

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewVfsAcceptance: (
      request: HomebrewVfsAcceptanceRequest,
    ) => Promise<HomebrewVfsAcceptanceResult>;
  }
}

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

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
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

  window.__homebrewVfsTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((error) => {
  document.getElementById("status")!.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  console.error("Homebrew VFS test runner failed:", error);
});
