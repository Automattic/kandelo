import { describe, expect, it, vi } from "vitest";
import { waitForProcessExit } from "../src/device-owner";
import type {
  KernelHost,
  ProcessEvent,
  ProcessInfo,
} from "../src/kernel-host";

function processHost(overrides: Partial<KernelHost> = {}): KernelHost {
  return {
    signalProcess: vi.fn(async () => true),
    ...overrides,
  } as unknown as KernelHost;
}

describe("process-exit observation", () => {
  it("subscribes before proving that an already-gone pid is absent", async () => {
    const unsubscribe = vi.fn();
    const host = processHost({
      subscribeProcessEvents: vi.fn(() => unsubscribe),
      enumProcs: vi.fn(async () => []),
    });
    await waitForProcessExit(host, 41);
    expect(host.subscribeProcessEvents).toHaveBeenCalledOnce();
    expect(host.enumProcs).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not miss an exit racing the initial process-table query", async () => {
    let listener: ((event: ProcessEvent) => void) | undefined;
    let resolveProcesses!: (processes: ProcessInfo[]) => void;
    const unsubscribe = vi.fn();
    const host = processHost({
      subscribeProcessEvents: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
      enumProcs: vi.fn(() => new Promise((resolve) => {
        resolveProcesses = resolve;
      })),
    });

    const exited = waitForProcessExit(host, 41);
    listener?.({ kind: "exit", pid: 41, exitStatus: 143 });
    resolveProcesses([]);
    await exited;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
