/**
 * Browser test runner — runs individual wasm test programs via BrowserKernel.
 *
 * Exposes window.__runTest(wasmBytes) for Playwright to call.
 * Each call creates a fresh BrowserKernel, runs the program, cleans up,
 * and returns { exitCode, stdout, stderr, hostDiagnostics }.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import type { HostDiagnostic } from "@host/host-diagnostic";
import {
  createBuildFsWithEtc,
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
} from "../../lib/kernel-owned-boot";
import kernelWasmUrl from "@kernel-wasm?url";
import type { ExecBinarySupport } from "./exec-binaries";

interface DataFile {
  path: string;
  data?: number[]; // byte array (transferred as JSON-safe array)
  useWasmBytes?: boolean; // if true, use the wasmBytes as file content
}

interface PtyInput {
  data: Uint8Array;
  readyMarker: string;
}

declare global {
  interface Window {
    __testRunnerReady: boolean;
    __runTest: (
      wasmBytes: ArrayBuffer,
      argv?: string[],
      timeoutMs?: number,
      options?: {
        dataFiles?: DataFile[];
        cwd?: string;
        env?: string[];
        ptyInput?: PtyInput;
      },
    ) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      combined: string;
      hostDiagnostics: HostDiagnostic[];
    }>;
    __testCount: number;
  }
}

let kernelWasmBytes: ArrayBuffer | null = null;
let execBinarySupport: ExecBinarySupport | null = null;

const corsProxyUrl = new URL(
  `${import.meta.env.BASE_URL}__kandelo_cors_proxy?url=`,
  window.location.href,
).href;

async function init() {
  const minimal = new URLSearchParams(window.location.search).get("minimal") === "1";
  /*
   * WHY: tests that never exec shell tools must not activate unrelated
   * optional package generations. The default path still imports the checked
   * tool module; minimal mode simply never requests those bytes.
   */
  const execBinarySupportPromise = minimal
    ? Promise.resolve(null)
    : import("./exec-binaries").then((module) =>
      module.loadExecBinarySupport()
    );
  [kernelWasmBytes, execBinarySupport] = await Promise.all([
    fetch(kernelWasmUrl)
      .then((response) => response.arrayBuffer())
      .catch(() => null),
    execBinarySupportPromise,
  ]);

  if (!kernelWasmBytes) {
    throw new Error("Failed to fetch kernel wasm");
  }

  window.__testCount = 0;

  window.__runTest = async (
    wasmBytes: ArrayBuffer,
    argv?: string[],
    timeoutMs = 30_000,
    options?: {
      dataFiles?: DataFile[];
      cwd?: string;
      env?: string[];
      ptyInput?: PtyInput;
    },
  ) => {
    let stdout = "";
    let stderr = "";
    let combined = "";
    const hostDiagnostics: HostDiagnostic[] = [];

    // Assemble the test image (exec binaries + /etc + any data files) in a
    // transient build FS, then hand ownership to the kernel worker so the main
    // thread holds no VFS SharedArrayBuffer across the per-test loop.
    const buildFs = await createBuildFsWithEtc();
    execBinarySupport?.populate(buildFs);
    if (options?.dataFiles) {
      for (const file of options.dataFiles) {
        // Ensure parent directories exist
        const parts = file.path.split("/").filter(Boolean);
        let dirPath = "";
        for (let i = 0; i < parts.length - 1; i++) {
          dirPath += "/" + parts[i];
          try {
            buildFs.mkdir(dirPath, 0o755);
          } catch {
            // Directory may already exist
          }
        }
        // Write the file — use wasmBytes if flagged, otherwise use provided data
        const fileData = file.useWasmBytes
          ? new Uint8Array(wasmBytes)
          : new Uint8Array(file.data!);
        const fd = buildFs.open(file.path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
        buildFs.write(fd, fileData, null, fileData.length);
        buildFs.close(fd);
      }
    }
    const vfsImage = await finalizeKernelOwnedImage(buildFs);

    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      corsProxyUrl,
      onStdout: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        stdout += text;
        combined += text;
      },
      onStderr: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        stderr += text;
        combined += text;
      },
      onHostDiagnostic: (diagnostic: HostDiagnostic) => {
        hostDiagnostics.push(diagnostic);
      },
    });

    try {
      await kernel.initFromImage({ kernelWasm: kernelWasmBytes!, vfsImage });

      // Run the test with a timeout
      const cwd = options?.cwd;
      const ptyInput = options?.ptyInput;
      const spawnOpts: {
        cwd?: string;
        env?: string[];
        pty?: boolean;
        onStarted?: (pid: number) => Promise<void>;
      } = {};
      if (cwd) spawnOpts.cwd = cwd;
      if (options?.env) spawnOpts.env = options.env;
      if (ptyInput) {
        if (!(ptyInput.data instanceof Uint8Array)) {
          throw new TypeError("ptyInput.data must be a Uint8Array");
        }
        if (ptyInput.readyMarker.length === 0) {
          throw new TypeError("ptyInput.readyMarker must not be empty");
        }
        spawnOpts.pty = true;
        spawnOpts.onStarted = async (pid) => {
          let observed = "";
          let markReady: (() => void) | null = null;
          const ready = new Promise<void>((resolve) => {
            markReady = resolve;
          });
          kernel.onPtyOutput(pid, (data) => {
            const text = new TextDecoder().decode(data);
            stdout += text;
            combined += text;
            observed += text;
            if (observed.includes(ptyInput.readyMarker)) markReady?.();
          });
          /*
           * WHY: ptyWrite enters the kernel's current line discipline
           * synchronously. Wait until the guest confirms its terminal mode,
           * and register the callback first so output buffered before the
           * spawn acknowledgement cannot lose the readiness transition.
           */
          await ready;
          kernel.ptyWrite(pid, ptyInput.data);
        };
      }
      const exitCode = await Promise.race([
        kernel.spawn(wasmBytes, argv ?? ["test"], spawnOpts),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
        ),
      ]);

      return { exitCode, stdout, stderr, combined, hostDiagnostics };
    } finally {
      // Clean up to free memory for the next test
      await kernel.destroy();
      await settleWebKitReclaim();
      window.__testCount++;
    }
  };

  document.getElementById("status")!.textContent = "Ready";
  window.__testRunnerReady = true;
}

init().catch((err) => {
  document.getElementById("status")!.textContent = `Error: ${err.message}`;
  console.error("Test runner init failed:", err);
});
