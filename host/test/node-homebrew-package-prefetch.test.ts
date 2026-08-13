import { describe, expect, it, vi } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import type {
  KernelToMainMessage,
  MainToKernelMessage,
} from "../src/node-kernel-protocol";
import type { HomebrewPackagePrefetchResult } from "../src/types";

const ROOT = "kandelo-dev/tap-core/kandelo-sdk";
const RESULT: HomebrewPackagePrefetchResult = {
  roots: [ROOT],
  packages: [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    ROOT,
  ],
  materializedPackages: [
    "kandelo-dev/tap-core/libcxx",
    "kandelo-dev/tap-core/clang",
    ROOT,
  ],
  alreadyMaterializedPackages: [],
};

interface TestableNodeKernelHost {
  initialized: boolean;
  workerStarted: boolean;
  worker: { terminate(): Promise<number> };
  sendToWorker(message: MainToKernelMessage): void;
  handleWorkerMessage(message: KernelToMainMessage): void;
  pendingHomebrewPrefetchRequests: Map<number, unknown>;
}

function testableHost(): {
  host: NodeKernelHost;
  internals: TestableNodeKernelHost;
  messages: MainToKernelMessage[];
} {
  const host = new NodeKernelHost();
  const internals = host as unknown as TestableNodeKernelHost;
  const messages: MainToKernelMessage[] = [];
  internals.initialized = true;
  internals.sendToWorker = vi.fn((message) => messages.push(message));
  return { host, internals, messages };
}

describe("Node Homebrew package prefetch", () => {
  it("sends one closed package-root request and correlates its result", async () => {
    const { host, internals, messages } = testableHost();

    const pending = host.prefetchHomebrewPackages([ROOT]);
    expect(messages).toEqual([{
      type: "prefetch_homebrew_packages",
      requestId: expect.any(Number),
      packages: [ROOT],
    }]);
    const requestId = (messages[0] as { requestId: number }).requestId;
    internals.handleWorkerMessage({
      type: "homebrew_packages_prefetched",
      requestId,
      result: RESULT,
    });

    await expect(pending).resolves.toEqual(RESULT);
    expect(internals.pendingHomebrewPrefetchRequests.size).toBe(0);
  });

  it("rejects malformed roots and bounded worker failures", async () => {
    const { host, internals, messages } = testableHost();
    await expect(host.prefetchHomebrewPackages(["clang"])).rejects.toThrow(
      /full name is invalid/,
    );
    expect(messages).toEqual([]);

    const pending = host.prefetchHomebrewPackages([ROOT]);
    const requestId = (messages[0] as { requestId: number }).requestId;
    internals.handleWorkerMessage({
      type: "homebrew_packages_prefetch_failed",
      requestId: requestId + 1,
      error: "late request",
    });
    expect(internals.pendingHomebrewPrefetchRequests.size).toBe(1);
    internals.handleWorkerMessage({
      type: "homebrew_packages_prefetch_failed",
      requestId,
      error: "injected prefetch failure",
    });
    await expect(pending).rejects.toThrow("injected prefetch failure");
  });

  it("rejects a pending prefetch when the host is destroyed", async () => {
    const { host, internals } = testableHost();
    internals.workerStarted = true;
    internals.worker = { terminate: vi.fn(async () => 0) };
    const pending = host.prefetchHomebrewPackages([ROOT]);
    internals.initialized = false;

    await host.destroy();

    await expect(pending).rejects.toThrow(/destroyed/);
    expect(internals.pendingHomebrewPrefetchRequests.size).toBe(0);
  });
});
