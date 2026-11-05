import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orphanReparentWasm = join(
  __dirname,
  "../../examples/orphan_reparent_test.wasm",
);

function loadProgramBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("orphan adoption by synthetic init on the Node host", () => {
  it(
    "reparents orphans to PID 1, reaps them, and hangs up orphaned stopped groups",
    async () => {
      let stdout = "";
      let stderr = "";
      const diagnostics: string[] = [];
      const decoder = new TextDecoder();
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => {
          stdout += decoder.decode(data, { stream: true });
        },
        onStderr: (_pid, data) => {
          stderr += new TextDecoder().decode(data);
        },
        onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });

      await host.init();
      try {
        let rootPid: number | undefined;
        const exit = host.spawn(
          loadProgramBytes(orphanReparentWasm),
          ["orphan_reparent_test", "--hold"],
          {
            onStarted(pid) {
              rootPid = pid;
            },
          },
        );

        let earlyExit: number | undefined;
        void exit.then((status) => {
          earlyExit = status;
        });
        // The guest has checked getppid(), wait status, /proc and the
        // orphaned-group signals. It now holds still for the host to inspect
        // the authoritative process table. A failed check exits instead.
        await expect
          .poll(() => /HOLD \d+ \d+ \d+/.test(stdout) || earlyExit !== undefined, {
            timeout: 20_000,
            interval: 20,
          })
          .toBe(true);
        expect(stdout, `exit ${earlyExit}: ${stderr}`).toMatch(/HOLD \d+ \d+ \d+/);
        expect(stdout, stderr).toContain("PASS: ORPHAN_REPARENT");
        expect(stdout).toMatch(/DAEMON_GRANDCHILD \d+ PPID 1\n/);
        expect(stdout).toContain("ORPHANED_GROUP_SIGHUP");

        const adopted = stdout
          .match(/HOLD (\d+) (\d+) (\d+)/)!
          .slice(1)
          .map(Number);
        // Proc maps stay addressable until Rust releases a process record,
        // including an Exited zombie that enumProcs() hides. These are the
        // daemon grandchild, the adopted zombie, and the group member the
        // default SIGHUP action terminated.
        for (const pid of adopted) {
          expect(await host.readProcMaps(pid), `pid ${pid}`).toBeNull();
        }

        // Every remaining process has a parent that still exists: the
        // host-parent sentinel, synthetic init, or a listed process.
        const processes = await host.enumProcs();
        const pids = new Set(processes.map((process) => process.pid));
        expect(pids.has(rootPid!)).toBe(true);
        for (const process of processes) {
          expect(
            process.ppid === 0 || process.ppid === 1 || pids.has(process.ppid),
            `pid ${process.pid} names absent parent ${process.ppid}`,
          ).toBe(true);
        }

        host.setStdinData(rootPid!, new Uint8Array());
        expect(await exit, stderr).toBe(0);
        expect(stderr).toBe("");
        expect(diagnostics).toEqual([]);
      } finally {
        await host.destroy();
      }
    },
    40_000,
  );
});
