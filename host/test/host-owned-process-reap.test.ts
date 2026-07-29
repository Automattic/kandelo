import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { reapHostOwnedExitedProcess } from "../src/host-owned-process-reap";
import { NodeKernelHost } from "../src/node-kernel-host";
import { signalExitStatus, SIGILL } from "../src/trap-signals";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helloWasm = join(__dirname, "../../examples/hello.wasm");
const spawnSmokeWasm = join(__dirname, "../../examples/spawn-smoke.wasm");
const wasmTrapWasm = join(__dirname, "../../examples/wasm_trap_test.wasm");

function kernelInstanceWithLifecycle(
  getParentPid: (pid: number) => number,
  reaper: (parentPid: number, childPid: number) => number,
) {
  return {
    exports: {
      kernel_get_parent_pid: getParentPid,
      kernel_reap_exited_child: reaper,
    },
  } as unknown as WebAssembly.Instance;
}

function loadProgramBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("host-owned exited-process reaping", () => {
  it("asks Rust to reap only a ppid=0 child", () => {
    const getParentPid = vi.fn(() => 0);
    const reapExitedChild = vi.fn(() => 0);

    expect(
      reapHostOwnedExitedProcess(
        kernelInstanceWithLifecycle(getParentPid, reapExitedChild),
        42,
      ),
    ).toBe("reaped");
    expect(getParentPid).toHaveBeenCalledWith(42);
    expect(reapExitedChild).toHaveBeenCalledOnce();
    expect(reapExitedChild).toHaveBeenCalledWith(0, 42);
  });

  it("leaves guest-owned children for wait/waitpid", () => {
    const reapExitedChild = vi.fn(() => 0);

    expect(
      reapHostOwnedExitedProcess(
        kernelInstanceWithLifecycle(() => 7, reapExitedChild),
        42,
      ),
    ).toBe("guest-owned");
    expect(reapExitedChild).not.toHaveBeenCalled();
  });

  it("accepts a guest-reaped child that is already absent", () => {
    const reapExitedChild = vi.fn(() => 0);

    expect(
      reapHostOwnedExitedProcess(
        kernelInstanceWithLifecycle(() => -3, reapExitedChild),
        42,
      ),
    ).toBe("already-reaped");
    expect(reapExitedChild).not.toHaveBeenCalled();
  });

  it("fails loudly when Rust rejects a known ppid=0 process", () => {
    expect(() =>
      reapHostOwnedExitedProcess(
        kernelInstanceWithLifecycle(() => 0, () => -10),
        42,
      ),
    ).toThrow("not an exited ppid=0 child");
    expect(() =>
      reapHostOwnedExitedProcess(
        kernelInstanceWithLifecycle(() => 0, () => -22),
        42,
      ),
    ).toThrow("kernel_reap_exited_child rejected process 42 with errno 22");
  });

  it("fails loudly when Rust cannot classify the process owner", () => {
    const reapExitedChild = vi.fn(() => 0);
    expect(() =>
      reapHostOwnedExitedProcess(
        kernelInstanceWithLifecycle(() => -22, reapExitedChild),
        42,
      ),
    ).toThrow("kernel_get_parent_pid rejected process 42 with errno 22");
    expect(reapExitedChild).not.toHaveBeenCalled();
  });

  it("fails loudly when required lifecycle exports are unavailable", () => {
    expect(() => reapHostOwnedExitedProcess(null, 42)).toThrow(
      "kernel instance is unavailable",
    );
    expect(() =>
      reapHostOwnedExitedProcess({ exports: {} } as WebAssembly.Instance, 42),
    ).toThrow("kernel_get_parent_pid export is unavailable");
    expect(() =>
      reapHostOwnedExitedProcess(
        {
          exports: { kernel_get_parent_pid: () => 0 },
        } as unknown as WebAssembly.Instance,
        42,
      ),
    ).toThrow("kernel_reap_exited_child export is unavailable");
  });

  it("keeps the normal Node and browser exit paths symmetric", () => {
    for (const entry of [
      "../src/node-kernel-worker-entry.ts",
      "../src/browser-kernel-worker-entry.ts",
    ]) {
      const source = readFileSync(join(__dirname, entry), "utf8");
      const finishExit = source.slice(source.indexOf("async function finishProcessExit"));
      const exactDetachAt = finishExit.indexOf(
        "detachExactProcessGeneration({",
      );
      const deactivateAt = finishExit.indexOf('operation: "deactivate"');
      const terminateAt = finishExit.indexOf("terminateTrackedWorker(expectedWorker");
      const reapAt = finishExit.indexOf("reapHostOwnedExitedProcess(");
      expect(exactDetachAt).toBeGreaterThanOrEqual(0);
      expect(deactivateAt).toBeGreaterThanOrEqual(0);
      expect(terminateAt).toBeGreaterThanOrEqual(0);
      expect(reapAt).toBeGreaterThan(terminateAt);
      expect(reapAt).toBeGreaterThan(exactDetachAt);
      expect(exactDetachAt).toBeGreaterThan(terminateAt);
    }
  });

  it(
    "preserves descendant wait/reap and reuses one Node kernel without retained processes",
    async () => {
      const diagnostics: string[] = [];
      const processEvents: Array<{
        kind: "spawn" | "exec" | "exit";
        pid: number;
        ppid?: number;
      }> = [];
      const host = new NodeKernelHost({
        execPrograms: { "/usr/bin/hello": helloWasm },
        rootfsImage: undefined,
        onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
        onProcessEvent: (event) => processEvents.push(event),
      });

      await host.init();
      try {
        const processTrees: number[][] = [];
        for (let launch = 0; launch < 2; launch += 1) {
          const eventStart = processEvents.length;
          const status = await host.spawn(
            loadProgramBytes(spawnSmokeWasm),
            ["spawn-smoke", "/usr/bin/hello"],
          );
          expect(status).toBe(0);

          const treePids = Array.from(new Set(
            processEvents
              .slice(eventStart)
              .filter((event) => event.kind === "spawn")
              .map((event) => event.pid),
          ));
          expect(treePids).toHaveLength(2);
          const root = processEvents
            .slice(eventStart)
            .find((event) => event.kind === "spawn" && event.ppid === undefined);
          const child = processEvents
            .slice(eventStart)
            .find((event) => event.kind === "spawn" && event.ppid !== undefined);
          expect(child?.ppid).toBe(root?.pid);

          // enumProcs() intentionally hides Exited entries. Proc maps remain
          // addressable until Rust has actually released each process record.
          await expect.poll(
            async () => Promise.all(treePids.map((pid) => host.readProcMaps(pid))),
            { timeout: 5_000, interval: 10 },
          ).toEqual(treePids.map(() => null));
          processTrees.push(treePids);
        }

        expect(Math.min(...processTrees[1])).toBeGreaterThan(
          Math.max(...processTrees[0]),
        );
        expect(diagnostics).toEqual([]);
      } finally {
        await host.destroy();
      }
    },
    20_000,
  );

  it(
    "removes a crashed top-level Node process after worker teardown",
    async () => {
      const diagnostics: string[] = [];
      const host = new NodeKernelHost({
        onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });
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
        // A deliberate Wasm trap may be reported as a host diagnostic. The
        // lifecycle assertion is that crash cleanup itself remains healthy.
        expect(
          diagnostics.filter((message) =>
            message.includes("failed to deactivate") ||
            message.includes("failed to reap"),
          ),
        ).toEqual([]);
      } finally {
        await host.destroy();
      }
    },
    10_000,
  );
});
