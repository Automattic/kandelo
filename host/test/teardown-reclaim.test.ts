/*
 * Cross-engine teardown-reclamation test — runs under BOTH V8 (Node, via
 * `vitest`) and JSC (Bun, via `bun x vitest`). Exercises the shared
 * `killAllBlockedForTeardown` + the host `handleDestroy` wake/drain path on
 * both engines. See docs/jsc-terminate-atomics-wait-workaround.md.
 *
 * [JSC-TERMINATE-ATOMICS-WAIT-LEAK]
 *
 * The actual memory/thread reclamation (which only JSC gets wrong) is only
 * measurable out-of-process via RSS (Playwright). What we assert here is the
 * observable, engine-agnostic proxy: a daemon parked in a blocking syscall
 * (Atomics.wait on its channel) is WOKEN into a cooperative exit on destroy —
 * exit status 137 (128 + SIGKILL, from the glue's kernel_exit) — rather than
 * being force-terminated while parked. If the wake path regresses, the daemon
 * is force-terminated (a synthesized crash status) and/or the drain times out,
 * both of which fail the assertions below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABI_SYSCALLS } from "../src/generated/abi";
import { NodeKernelHost } from "../src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const blockForeverBinary = join(__dirname, "../../examples/block-forever.wasm");
const hasBinary = existsSync(blockForeverBinary);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// 128 + SIGKILL(9): a cooperatively-woken blocked worker exits via the glue's
// kernel_exit(128 + 9). A force-terminated straggler would report a synthesized
// crash status instead.
const COOPERATIVE_EXIT_STATUS = 137;

describe.skipIf(!hasBinary)(
  "teardown reclamation of Atomics.wait-blocked workers",
  () => {
    it("wakes a blocked daemon to a cooperative exit on destroy", async () => {
      const exits = new Map<number, number | undefined>();
      const host = new NodeKernelHost({
        maxWorkers: 4,
        onProcessEvent: (e) => {
          if (e.kind === "exit") exits.set(e.pid, e.exitStatus);
        },
      });
      await host.init();

      let pid = -1;
      let blockedPid = -1;
      let destroyed = false;
      let unsubscribe: (() => void) | undefined = host.subscribeSyscalls(
        (event) => {
          if (
            event.nr === ABI_SYSCALLS.Nanosleep ||
            event.nr === ABI_SYSCALLS.ClockNanosleep
          ) {
            blockedPid = event.pid;
          }
        },
      );

      try {
        // Do NOT await its exit — it parks in nanosleep (Atomics.wait on its
        // channel) and never exits on its own.
        void host
          .spawn(loadWasm(blockForeverBinary), ["block-forever"], {
            onStarted: (p) => {
              pid = p;
            },
          })
          .catch(() => {});

        for (let i = 0; i < 200 && pid < 0; i++) await delay(20);
        expect(pid).toBeGreaterThan(0);

        // onStarted fires when the process worker is launched, before the guest
        // necessarily reaches sleep(). Wait for the kernel worker to observe the
        // blocking syscall instead of assuming a fixed delay is long enough.
        for (let i = 0; i < 500 && blockedPid < 0; i++) await delay(20);
        expect(blockedPid).toBe(pid);
        unsubscribe();
        unsubscribe = undefined;

        const t0 = Date.now();
        await host.destroy();
        destroyed = true;
        const destroyMs = Date.now() - t0;

        // The daemon exited (it never does on its own), via the cooperative
        // kernel_exit path (137), not a force-terminate; and the drain resolved
        // promptly rather than after the ~1.5s force-terminate fallback.
        expect(exits.has(pid)).toBe(true);
        expect(exits.get(pid)).toBe(COOPERATIVE_EXIT_STATUS);
        expect(destroyMs).toBeLessThan(1500);
      } finally {
        unsubscribe?.();
        if (!destroyed) await host.destroy().catch(() => {});
      }
    }, 20_000);
  },
);
