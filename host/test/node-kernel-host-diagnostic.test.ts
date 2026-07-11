import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { KernelToMainMessage } from "../src/node-kernel-protocol";

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
