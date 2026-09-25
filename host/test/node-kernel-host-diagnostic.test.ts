import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { KernelToMainMessage } from "../src/node-kernel-protocol";
import type { LazyDownloadEvent } from "../src/vfs/memory-fs";

interface TestableNodeKernelHost {
  handleWorkerMessage(message: KernelToMainMessage): void;
}

describe("NodeKernelHost diagnostics", () => {
  it("delivers host diagnostics without invoking the guest stderr callback", () => {
    const onHostDiagnostic = vi.fn();
    const onStderr = vi.fn();
    const host = new NodeKernelHost({ onHostDiagnostic, onStderr });
    const testable = host as unknown as TestableNodeKernelHost;

    testable.handleWorkerMessage({
      type: "host_diagnostic",
      pid: 42,
      source: "clone allocation",
      message: "host allocation failed",
    });

    expect(onHostDiagnostic).toHaveBeenCalledOnce();
    expect(onHostDiagnostic).toHaveBeenCalledWith({
      pid: 42,
      source: "clone allocation",
      message: "host allocation failed",
    });
    expect(onStderr).not.toHaveBeenCalled();
  });

  it("keeps actual stderr messages on the guest callback", () => {
    const onHostDiagnostic = vi.fn();
    const onStderr = vi.fn();
    const host = new NodeKernelHost({ onHostDiagnostic, onStderr });
    const testable = host as unknown as TestableNodeKernelHost;
    const data = new TextEncoder().encode("guest stderr\n");

    testable.handleWorkerMessage({ type: "stderr", pid: 7, data });

    expect(onStderr).toHaveBeenCalledWith(7, data);
    expect(onHostDiagnostic).not.toHaveBeenCalled();
  });
});

describe("NodeKernelHost lazy VFS transport events", () => {
  const event: LazyDownloadEvent = {
    id: "archive:/:sha256:0",
    kind: "tree",
    status: "started",
    url: "https://example.invalid/dash.bottle.tar.gz",
    mountPrefix: "/",
    loadedBytes: 0,
    totalBytes: 123,
    t: 42,
  };

  it("delivers worker events to both the option callback and subscribers", () => {
    const onLazyDownload = vi.fn();
    const subscribed = vi.fn();
    const host = new NodeKernelHost({ onLazyDownload });
    const unsubscribe = host.subscribeLazyDownloads(subscribed);
    const testable = host as unknown as TestableNodeKernelHost;

    testable.handleWorkerMessage({ type: "lazy_download", event });

    expect(onLazyDownload).toHaveBeenCalledWith(event);
    expect(subscribed).toHaveBeenCalledWith(event);

    unsubscribe();
    testable.handleWorkerMessage({ type: "lazy_download", event });
    expect(onLazyDownload).toHaveBeenCalledTimes(2);
    expect(subscribed).toHaveBeenCalledOnce();
  });

  it("isolates throwing observers from the rest of delivery", () => {
    const host = new NodeKernelHost({
      onLazyDownload: () => {
        throw new Error("option observer failed");
      },
    });
    host.subscribeLazyDownloads(() => {
      throw new Error("first subscriber failed");
    });
    const survivingSubscriber = vi.fn();
    host.subscribeLazyDownloads(survivingSubscriber);

    const testable = host as unknown as TestableNodeKernelHost;
    expect(() => {
      testable.handleWorkerMessage({ type: "lazy_download", event });
    }).not.toThrow();
    expect(survivingSubscriber).toHaveBeenCalledWith(event);
  });
});

describe("NodeKernelHost VFS change events", () => {
  const inside = { kind: "modify" as const, path: "/home/maker/mcp/foo.json", t: 1 };
  const outside = { kind: "delete" as const, path: "/home/maker/foo.json", t: 2 };

  it("watches a prefix in the worker while subscribers exist and fans out matching events", () => {
    const postMessage = vi.fn();
    const host = new NodeKernelHost();
    (host as unknown as { worker: unknown }).worker = { postMessage };
    const testable = host as unknown as TestableNodeKernelHost;
    const first = vi.fn();
    const second = vi.fn();

    const offFirst = host.subscribeVfsChanges("/home/maker/mcp", first);
    const offSecond = host.subscribeVfsChanges("/home/maker/mcp", second);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "watch_vfs_changes", prefix: "/home/maker/mcp", enabled: true },
    ]);

    testable.handleWorkerMessage({ type: "vfs_change", event: inside });
    testable.handleWorkerMessage({ type: "vfs_change", event: outside });
    expect(first).toHaveBeenCalledExactlyOnceWith(inside);
    expect(second).toHaveBeenCalledExactlyOnceWith(inside);

    offFirst();
    expect(postMessage).toHaveBeenCalledTimes(1);
    offSecond();
    expect(postMessage.mock.calls.at(-1)?.[0]).toEqual({
      type: "watch_vfs_changes",
      prefix: "/home/maker/mcp",
      enabled: false,
    });
    testable.handleWorkerMessage({ type: "vfs_change", event: inside });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("isolates throwing subscribers from the rest of delivery", () => {
    const host = new NodeKernelHost();
    (host as unknown as { worker: unknown }).worker = { postMessage: vi.fn() };
    host.subscribeVfsChanges("/home/maker/mcp", () => {
      throw new Error("first subscriber failed");
    });
    const survivingSubscriber = vi.fn();
    host.subscribeVfsChanges("/home/maker/mcp", survivingSubscriber);

    const testable = host as unknown as TestableNodeKernelHost;
    expect(() => {
      testable.handleWorkerMessage({ type: "vfs_change", event: inside });
    }).not.toThrow();
    expect(survivingSubscriber).toHaveBeenCalledWith(inside);
  });
});
