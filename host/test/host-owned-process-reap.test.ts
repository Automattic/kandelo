import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { reapHostOwnedExitedProcess } from "../src/host-owned-process-reap";
import { NodeKernelHost } from "../src/node-kernel-host";
import { signalExitStatus, SIGILL } from "../src/trap-signals";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helloWasm = join(__dirname, "../../examples/hello.wasm");
const wasmTrapWasm = join(__dirname, "../../examples/wasm_trap_test.wasm");

function kernelInstanceWithReaper(
  reaper: (parentPid: number, childPid: number) => number,
) {
  return { exports: { kernel_reap_exited_child: reaper } } as unknown as WebAssembly.Instance;
}

function loadProgramBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("host-owned exited-process reaping", () => {
  it("asks Rust to reap only a ppid=0 child", () => {
    const reapExitedChild = vi.fn(() => 0);

    expect(
      reapHostOwnedExitedProcess(kernelInstanceWithReaper(reapExitedChild), 42),
    ).toBe(true);
    expect(reapExitedChild).toHaveBeenCalledOnce();
    expect(reapExitedChild).toHaveBeenCalledWith(0, 42);
  });

  it("leaves guest-owned children for wait/waitpid when Rust returns ECHILD", () => {
    const reapExitedChild = vi.fn(() => -10);

    expect(
      reapHostOwnedExitedProcess(kernelInstanceWithReaper(reapExitedChild), 42),
    ).toBe(false);
    expect(reapExitedChild).toHaveBeenCalledWith(0, 42);
  });

  it("fails loudly when the required kernel reaper is unavailable", () => {
    expect(() => reapHostOwnedExitedProcess(null, 42)).toThrow(
      "kernel instance is unavailable",
    );
    expect(() => reapHostOwnedExitedProcess({ exports: {} } as WebAssembly.Instance, 42))
      .toThrow("kernel_reap_exited_child export is unavailable");
  });

  it("keeps the normal Node and browser exit paths symmetric", () => {
    for (const entry of [
      "../src/node-kernel-worker-entry.ts",
      "../src/browser-kernel-worker-entry.ts",
    ]) {
      const source = readFileSync(join(__dirname, entry), "utf8");
      const finishExit = source.slice(source.indexOf("async function finishProcessExit"));
      const deactivateAt = finishExit.indexOf("kernelWorker.deactivateProcess(pid)");
      const reapAt = finishExit.indexOf("reapHostOwnedExitedProcess(");
      expect(deactivateAt).toBeGreaterThanOrEqual(0);
      expect(reapAt).toBeGreaterThan(deactivateAt);
    }
  });

  it(
    "removes a completed top-level Node process from the authoritative process table",
    async () => {
      const host = new NodeKernelHost();
      let pid: number | undefined;

      await host.init();
      try {
        const status = await host.spawn(loadProgramBytes(helloWasm), ["hello"], {
          onStarted(startedPid) {
            pid = startedPid;
          },
        });

        expect(status).toBe(0);
        expect(pid).toBeDefined();
        // enumProcs() intentionally filters Exited entries, so it cannot
        // distinguish a retained zombie from a reaped process. Proc maps stay
        // addressable while the Rust Process entry exists and become null only
        // after the ppid=0 child has actually been reaped.
        await expect.poll(
          async () => host.readProcMaps(pid!),
          { timeout: 5_000, interval: 10 },
        ).toBeNull();
      } finally {
        await host.destroy();
      }
    },
    10_000,
  );

  it(
    "removes a crashed top-level Node process after worker teardown",
    async () => {
      const host = new NodeKernelHost();
      let pid: number | undefined;

      await host.init();
      try {
        const status = await host.spawn(
          loadProgramBytes(wasmTrapWasm),
          ["wasm_trap_test"],
          {
            onStarted(startedPid) {
              pid = startedPid;
            },
          },
        );

        expect(status).toBe(signalExitStatus(SIGILL));
        expect(pid).toBeDefined();
        await expect.poll(
          async () => host.readProcMaps(pid!),
          { timeout: 5_000, interval: 10 },
        ).toBeNull();
      } finally {
        await host.destroy();
      }
    },
    10_000,
  );
});
