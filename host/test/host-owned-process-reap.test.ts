import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { reapHostOwnedExitedProcess } from "../src/host-owned-process-reap";
import { NodeKernelHost } from "../src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helloWasm = join(__dirname, "../../examples/hello.wasm");

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

  it.skipIf(!existsSync(helloWasm))(
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
});
