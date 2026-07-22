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
