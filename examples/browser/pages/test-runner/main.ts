/**
 * Browser test runner — runs individual wasm test programs via BrowserKernel.
 *
 * Exposes window.__runTest(wasmBytes) for Playwright to call.
 * Each call creates a fresh BrowserKernel, runs the program, cleans up,
 * and returns { exitCode, stdout, stderr }.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";

interface DataFile {
  path: string;
  data?: number[]; // byte array (transferred as JSON-safe array)
  useWasmBytes?: boolean; // if true, use the wasmBytes as file content
}

declare global {
  interface Window {
    __testRunnerReady: boolean;
    __runTest: (
      wasmBytes: ArrayBuffer,
      argv?: string[],
      timeoutMs?: number,
      options?: { dataFiles?: DataFile[]; cwd?: string },
    ) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
    __testCount: number;
  }
}

let kernelWasmBytes: ArrayBuffer | null = null;

async function init() {
  const resp = await fetch(kernelWasmUrl);
  kernelWasmBytes = await resp.arrayBuffer();

  window.__testCount = 0;

  window.__runTest = async (
    wasmBytes: ArrayBuffer,
    argv?: string[],
    timeoutMs = 30_000,
    options?: { dataFiles?: DataFile[]; cwd?: string },
  ) => {
    let stdout = "";
    let stderr = "";

    const kernel = new BrowserKernel({
      onStdout: (data: Uint8Array) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (data: Uint8Array) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await kernel.init(kernelWasmBytes!);

      // Populate VFS with data files if provided
      if (options?.dataFiles) {
        // Create directories and write data files into VFS
        for (const file of options.dataFiles) {
          // Ensure parent directories exist
          const parts = file.path.split("/").filter(Boolean);
          let dirPath = "";
          for (let i = 0; i < parts.length - 1; i++) {
            dirPath += "/" + parts[i];
            try {
              kernel.fs.mkdir(dirPath, 0o755);
            } catch {
              // Directory may already exist
            }
          }
          // Write the file — use wasmBytes if flagged, otherwise use provided data
          const fileData = file.useWasmBytes
            ? new Uint8Array(wasmBytes)
            : new Uint8Array(file.data!);
          const fd = kernel.fs.open(file.path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o644);
          kernel.fs.write(fd, fileData, fileData.length, -1);
          kernel.fs.close(fd);
        }
      }

      // Run the test with a timeout
      const cwd = options?.cwd;
      const exitCode = await Promise.race([
        kernel.spawn(wasmBytes, argv ?? ["test"], cwd ? { cwd } : undefined),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
        ),
      ]);

      return { exitCode, stdout, stderr };
    } finally {
      // Clean up to free memory for the next test
      await kernel.destroy();
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
