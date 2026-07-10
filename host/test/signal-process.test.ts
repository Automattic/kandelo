/**
 * Host-initiated signal delivery: `NodeKernelHost.signalProcess`.
 *
 * This is the Node half of a capability the browser host exposes identically
 * (`BrowserKernel.signalProcess`), used by the browser demos' file-ingest flow
 * to stop the process holding a single-owner device before relaunching it.
 *
 * Unlike `terminateProcess`, which tears the wasm worker down from the host,
 * this routes through the kernel's SYS_KILL path, so the target's signal
 * disposition applies and the kernel's own exit cleanup runs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { findRepoRoot } from "../src/binary-resolver";

const SIGTERM = 15;

function programBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(findRepoRoot(), "examples", name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("host-initiated signal delivery", () => {
  it("SIGTERM terminates a process blocked in pause()", { timeout: 30_000 }, async () => {
    const exited = new Map<number, number | undefined>();
    const host = new NodeKernelHost({
      onProcessEvent: (event) => {
        if (event.kind === "exit") exited.set(event.pid, event.exitStatus);
      },
    });
    await host.init();
    try {
      // spawn() resolves with the *exit status*, so don't await it here:
      // signal-wait never exits on its own. Take the pid from onStarted.
      let pid = -1;
      const started = new Promise<void>((resolve) => {
        void host.spawn(programBytes("signal-wait.wasm"), ["signal-wait"], {
          onStarted: (p) => { pid = p; resolve(); },
        });
      });
      await started;
      expect(pid).toBeGreaterThan(0);

      // Give the guest time to reach pause().
      await new Promise((r) => setTimeout(r, 300));
      expect(exited.has(pid)).toBe(false);

      expect(await host.signalProcess(pid, SIGTERM)).toBe(true);

      await expect.poll(() => exited.has(pid), { timeout: 10_000 }).toBe(true);
    } finally {
      await host.destroy();
    }
  });

  it("signalling an unknown pid reports ESRCH rather than pretending", async () => {
    const host = new NodeKernelHost();
    await host.init();
    try {
      expect(await host.signalProcess(999_999, SIGTERM)).toBe(false);
    } finally {
      await host.destroy();
    }
  });
});
