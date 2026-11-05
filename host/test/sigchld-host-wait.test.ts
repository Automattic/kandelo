import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * A caught SIGCHLD interrupts a parent blocked in a host-owned wait.
 *
 * poll, select, epoll_wait and accept are still waits the host holds. The
 * kernel announces a child's exit (generating SIGCHLD) when it records it,
 * and may reap the child in the same step: an SA_NOCLDWAIT auto-reap, or
 * another thread of the parent parked in waitpid. The parent's host-owned
 * wait must still end with EINTR and run the handler, on the main thread and
 * on a second thread while the main thread blocks SIGCHLD. Before the kernel
 * owned child waits, the host routed SIGCHLD only after its own exit
 * bookkeeping and skipped the interruption once the zombie was gone, so the
 * first case below waited out its watchdog instead.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/sigchld-host-wait.wasm");

const SIGCHLD_HOST_WAIT_CASES = [
  "poll", "select", "epoll", "accept",
].flatMap((kind) =>
  ["autoreap", "waiter"].flatMap((mode) => [
    `${kind}-${mode}`,
    `thread-${kind}-${mode}`,
  ]),
);

describe.skipIf(!existsSync(binary))("SIGCHLD versus host-owned waits", () => {
  it("interrupts poll, select, epoll_wait and accept with EINTR", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: binary,
      argv: ["sigchld-host-wait"],
      timeout: 60_000,
    });
    for (const name of SIGCHLD_HOST_WAIT_CASES) {
      expect(stdout, stderr).toContain(`ok ${name}\n`);
    }
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 70_000);
});
