/**
 * Browser test runner — runs individual wasm test programs via BrowserKernel.
 *
 * Exposes window.__runTest(wasmBytes) for Playwright to call.
 * Each call creates a fresh BrowserKernel, runs the program, cleans up,
 * and returns { exitCode, stdout, stderr }.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";

declare global {
  interface Window {
    __testRunnerReady: boolean;
    __runTest: (wasmBytes: ArrayBuffer, argv?: string[], timeoutMs?: number) => Promise<{
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

      // Run the test with a timeout
      const exitCode = await Promise.race([
        kernel.spawn(wasmBytes, argv ?? ["test"]),
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
