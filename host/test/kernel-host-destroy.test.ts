import { describe, expect, it, vi } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { resolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

type TestableNodeKernelHost = {
  workerStarted: boolean;
  initialized: boolean;
  worker: { terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
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
  testable.worker = { terminate, postMessage: vi.fn() };
  testable.pendingRequests.set(1, { resolve: vi.fn(), reject: vi.fn() });
  testable.exitResolvers.set(2, {});
  testable.unclaimedExitStatuses.set(3, {});
  testable.lazyDownloadListeners.add(() => {});
  return { host, testable, terminate };
}

describe("kernel host destroy containment boundary", () => {
  it("settles lost native filesystem and HTTP replies and recovers shutdown-flushed writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-rpc-shutdown-"));
    const filesystem = KandeloImageFs.create();
    filesystem.writeFile("/pending", new Uint8Array([1, 2, 3]), 0o600);
    const image = await filesystem.saveImage();
    const wasm = new Uint8Array(readFileSync(resolveBinary("kernel.wasm")));
    const options = { rootfsImage: image, kernelMaxPages: 1024,
      experimentalResizablePersistencePath: join(directory, "journal") };
    const host = new NodeKernelHost(options);
    let recovered: NodeKernelHost | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await host.init(wasm.slice().buffer);
      await host.writeFileToVfs("/state", new TextEncoder().encode("before shutdown"), 0o600);
      const worker = (host as unknown as { worker: Worker }).worker;
      const emit = worker.emit;
      const post = worker.postMessage;
      const blocked = new Set<number>();
      const held = new Set<number>();
      let heldRead: unknown;
      let allHeld!: () => void;
      const repliesHeld = new Promise<void>(resolve => { allHeld = resolve; });
      worker.postMessage = ((message: { type?: string; path?: string; requestId?: number; request?: { url?: string } }, ...parameters: unknown[]) => {
        if ((message.type === "read_vfs_file" && message.path === "/pending") ||
          (message.type === "http_request" && message.request?.url === "/pending")) {
          if (typeof message.requestId !== "number" || blocked.size === 2) throw new Error("Invalid shutdown transport fixture request");
          blocked.add(message.requestId);
        }
        return Reflect.apply(post, worker, [message, ...parameters]);
      }) as typeof worker.postMessage;
      worker.emit = ((event: string | symbol, ...parameters: unknown[]) => {
        const message = parameters[0] as { type?: string; requestId?: number; result?: unknown } | undefined;
        if (event === "message" && message?.type === "response" && blocked.has(message.requestId!)) {
          held.add(message.requestId!);
          if (message.result instanceof Uint8Array) heldRead = message.result;
          if (held.size === 2) allHeld();
          return true;
        }
        return Reflect.apply(emit, worker, [event, ...parameters]);
      }) as typeof worker.emit;
      try {
        const outcomes = Promise.allSettled([
          host.readFileFromVfs("/pending"),
          host.fetchInKernel(80, { method: "GET", url: "/pending", headers: {}, body: null }),
        ]);
        await Promise.race([repliesHeld, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Native replies did not reach the transport fixture")), 10_000);
        })]);
        clearTimeout(timer);
        expect(heldRead).toEqual(new Uint8Array([1, 2, 3]));
        await host.destroy();
        for (const outcome of await outcomes) {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") expect(outcome.reason.message).toBe("kernel host destroyed");
        }
        expect(host.getPersistenceShutdownFailure()).toBeNull();
      } finally {
        worker.emit = emit;
        worker.postMessage = post;
      }
      recovered = new NodeKernelHost({ ...options, requireExistingRootfsPersistence: true });
      await recovered.init(wasm.slice().buffer);
      expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("before shutdown");
    } finally {
      clearTimeout(timer);
      await host.destroy();
      await recovered?.destroy();
      filesystem.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects outstanding Node filesystem and HTTP requests after realm shutdown", async () => {
    const { host, testable } = testableHost(() => {});
    const settled = vi.fn();
    const requests = [
      host.readFileFromVfs("/pending"),
      host.fetchInKernel(80, { method: "GET", url: "/pending", headers: {}, body: new Uint8Array() }),
    ];
    for (const request of requests) {
      void request.then(() => settled("unexpected success"), error => settled(error));
    }
    const request = testable.request;
    let acknowledge!: (value: { gracefulDetachComplete: boolean }) => void;
    const acknowledgement = new Promise<{ gracefulDetachComplete: boolean }>(resolve => { acknowledge = resolve; });
    testable.request = vi.fn((requestId, message) => message.type === "destroy"
      ? acknowledgement : request.call(host, requestId, message));

    const destroyed = host.destroy();
    const duringShutdown = Promise.allSettled([
      host.readFileFromVfs("/during-destroy"),
      host.fetchInKernel(80, { method: "GET", url: "/during-destroy", headers: {}, body: null }),
    ]);
    acknowledge({ gracefulDetachComplete: true });
    await destroyed;
    for (const result of await duringShutdown) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("kernel host is not accepting requests");
    }

    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2), { timeout: 500 });
    for (const [error] of settled.mock.calls) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("kernel host destroyed");
    }
    expect(testable.pendingRequests.size).toBe(0);
    testable.request = request;
    await expect(host.readFileFromVfs("/after-destroy")).rejects.toThrow("VFS read requires an initialized kernel");
    await expect(host.fetchInKernel(80, { method: "GET", url: "/after-destroy", headers: {}, body: null }))
      .rejects.toThrow("kernel host is not accepting requests");
    expect(testable.pendingRequests.size).toBe(0);
  });

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
      await vi.advanceTimersByTimeAsync(5_000);
      await destroyPromise;

      expect(terminate).toHaveBeenCalledOnce();
      expect(testable.pendingRequests.size).toBe(0);
      expect(diagnostics).toEqual([
        expect.stringContaining("timed out after 5000ms"),
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
