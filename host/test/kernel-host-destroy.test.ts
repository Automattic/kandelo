import { describe, expect, it, vi } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";

type TestableNodeKernelHost = {
  workerStarted: boolean;
  initialized: boolean;
  worker: { terminate: ReturnType<typeof vi.fn> };
  pendingRequests: Map<number, unknown>;
  exitResolvers: Map<number, unknown>;
  unclaimedExitStatuses: Map<number, unknown>;
  lazyDownloadListeners: Set<unknown>;
  request: ReturnType<typeof vi.fn>;
};

function testableHost(
  onDiagnostic: (message: string) => void,
): {
  host: NodeKernelHost;
  testable: TestableNodeKernelHost;
  terminate: ReturnType<typeof vi.fn>;
} {
  const host = new NodeKernelHost({
    onHostDiagnostic: (diagnostic) => onDiagnostic(diagnostic.message),
  });
  const testable = host as unknown as TestableNodeKernelHost;
  const terminate = vi.fn(async () => 0);
  testable.workerStarted = true;
  testable.initialized = true;
  testable.worker = { terminate };
  testable.pendingRequests.set(1, {});
  testable.exitResolvers.set(2, {});
  testable.unclaimedExitStatuses.set(3, {});
  testable.lazyDownloadListeners.add(() => {});
  return { host, testable, terminate };
}

describe("kernel host destroy containment boundary", () => {
  it("terminates the Node worker realm after incomplete graceful detach", async () => {
    const diagnostics: string[] = [];
    const { host, testable, terminate } = testableHost((message) => {
      diagnostics.push(message);
    });
    testable.request = vi.fn(async () => ({
      gracefulDetachComplete: false,
    }));

    await host.destroy();

    expect(terminate).toHaveBeenCalledOnce();
    expect(testable.pendingRequests.size).toBe(0);
    expect(testable.exitResolvers.size).toBe(0);
    expect(testable.unclaimedExitStatuses.size).toBe(0);
    expect(testable.lazyDownloadListeners.size).toBe(0);
    expect(diagnostics).toEqual([
      expect.stringContaining("incomplete graceful generation detach"),
    ]);
  });

  it("bounds a missing Node destroy response before final realm release", async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: string[] = [];
      const { host, testable, terminate } = testableHost((message) => {
        diagnostics.push(message);
      });
      testable.request = vi.fn(() => new Promise<never>(() => {}));

      const destroyPromise = host.destroy();
      await vi.advanceTimersByTimeAsync(2_000);
      await destroyPromise;

      expect(terminate).toHaveBeenCalledOnce();
      expect(testable.pendingRequests.size).toBe(0);
      expect(diagnostics).toEqual([
        expect.stringContaining("timed out after 2000ms"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears Node aliases and reports a worker termination failure", async () => {
    const diagnostics: string[] = [];
    const { host, testable, terminate } = testableHost((message) => {
      diagnostics.push(message);
    });
    terminate.mockRejectedValue(new Error("injected terminate failure"));
    testable.request = vi.fn(async () => ({
      gracefulDetachComplete: true,
    }));

    await host.destroy();

    expect(testable.pendingRequests.size).toBe(0);
    expect(testable.exitResolvers.size).toBe(0);
    expect(testable.unclaimedExitStatuses.size).toBe(0);
    expect(diagnostics).toEqual([
      expect.stringContaining(
        "kernel-worker realm termination failed: injected terminate failure",
      ),
    ]);
  });
});
