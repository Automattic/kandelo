import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KernelToMainMessage,
  MainToKernelMessage,
} from "../src/node-kernel-protocol";

type WorkerEvent = "message" | "error" | "exit";
type WorkerListener = (...args: any[]) => void;

const workerMock = vi.hoisted(() => {
  class MockNodeWorker {
    static instances: MockNodeWorker[] = [];

    readonly sent: MainToKernelMessage[] = [];
    readonly terminate = vi.fn(async () => 1);
    private readonly listeners = new Map<string, Set<WorkerListener>>();

    constructor(_filename: string | URL, _options?: object) {
      MockNodeWorker.instances.push(this);
    }

    postMessage(
      message: MainToKernelMessage,
      _transfer?: readonly ArrayBuffer[],
    ): void {
      this.sent.push(message);
    }

    on(event: WorkerEvent, listener: WorkerListener): this {
      let listeners = this.listeners.get(event);
      if (listeners === undefined) {
        listeners = new Set();
        this.listeners.set(event, listeners);
      }
      listeners.add(listener);
      return this;
    }

    once(event: WorkerEvent, listener: WorkerListener): this {
      const wrapper: WorkerListener = (...args) => {
        this.removeListener(event, wrapper);
        listener(...args);
      };
      return this.on(event, wrapper);
    }

    removeListener(event: WorkerEvent, listener: WorkerListener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: WorkerEvent, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    lastMessage<T extends MainToKernelMessage["type"]>(
      type: T,
    ): Extract<MainToKernelMessage, { type: T }> | undefined {
      for (let index = this.sent.length - 1; index >= 0; index--) {
        const message = this.sent[index]!;
        if (message.type === type) {
          return message as Extract<MainToKernelMessage, { type: T }>;
        }
      }
      return undefined;
    }
  }

  return { MockNodeWorker };
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...original,
    Worker: workerMock.MockNodeWorker,
  };
});

import { NodeKernelHost } from "../src/node-kernel-host";

type MockNodeWorker = InstanceType<typeof workerMock.MockNodeWorker>;

async function initializedHost(
  options?: ConstructorParameters<typeof NodeKernelHost>[0],
): Promise<{ host: NodeKernelHost; worker: MockNodeWorker }> {
  const host = new NodeKernelHost(options);
  const initPromise = host.init(new ArrayBuffer(8));
  const worker = workerMock.MockNodeWorker.instances.at(-1);
  expect(worker).toBeDefined();
  expect(worker!.lastMessage("init")).toBeDefined();
  worker!.emit("message", {
    type: "ready",
  } satisfies KernelToMainMessage);
  await initPromise;
  return { host, worker: worker! };
}

async function runningProcess(
  host: NodeKernelHost,
  worker: MockNodeWorker,
): Promise<{ exit: Promise<number> }> {
  const spawning = host.spawnFromVfs("/bin/sleep", ["/bin/sleep"]);
  const spawn = worker.lastMessage("spawn");
  expect(spawn).toBeDefined();
  worker.emit("message", {
    type: "response",
    requestId: spawn!.requestId,
    result: 101,
  } satisfies KernelToMainMessage);
  return { exit: (await spawning).exit };
}

describe("NodeKernelHost fatal worker lifecycle", () => {
  beforeEach(() => {
    workerMock.MockNodeWorker.instances = [];
    vi.restoreAllMocks();
  });

  it("preserves a typed kernel fatal that arrives before ready", async () => {
    const host = new NodeKernelHost();
    const initPromise = host.init(new ArrayBuffer(8));
    const worker = workerMock.MockNodeWorker.instances.at(-1)!;
    const fatalMessage = "transfer reservation trapped during initialization";
    const rejected = expect(initPromise).rejects.toThrow(
      `Kernel worker failed: ${fatalMessage}`,
    );

    worker.emit("message", {
      type: "kernel_fatal",
      error: fatalMessage,
    } satisfies KernelToMainMessage);

    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects pending, process-exit, and future work after kernel_fatal", async () => {
    const { host, worker } = await initializedHost();
    const { exit: processExit } = await runningProcess(host, worker);
    const pendingRequest = host.getKernelMemoryPages();
    const fatalMessage = "reserved transfer execution trapped";
    const pendingRejection = expect(pendingRequest).rejects.toThrow(
      `Kernel worker failed: ${fatalMessage}`,
    );
    const exitRejection = expect(processExit).rejects.toThrow(
      `Kernel worker failed: ${fatalMessage}`,
    );
    const messagesBeforeFatal = worker.sent.length;

    worker.emit("message", {
      type: "kernel_fatal",
      error: fatalMessage,
    } satisfies KernelToMainMessage);

    await Promise.all([pendingRejection, exitRejection]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(host.getKernelMemoryPages()).rejects.toThrow(
      `Kernel worker failed: ${fatalMessage}`,
    );
    expect(worker.sent).toHaveLength(messagesBeforeFatal);
  });

  it("rejects pending and future work when the worker exits unexpectedly", async () => {
    const onHostDiagnostic = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, worker } = await initializedHost({ onHostDiagnostic });
    const { exit: processExit } = await runningProcess(host, worker);
    const pendingRequest = host.getKernelMemoryPages();
    const exitMessage = "Kernel worker exited unexpectedly (code 17)";
    const pendingRejection = expect(pendingRequest).rejects.toThrow(exitMessage);
    const processRejection = expect(processExit).rejects.toThrow(exitMessage);
    const messagesBeforeExit = worker.sent.length;

    worker.emit("exit", 17);

    await Promise.all([pendingRejection, processRejection]);
    expect(onHostDiagnostic).toHaveBeenCalledWith({
      pid: 0,
      source: "kernel worker",
      message: `[NodeKernelHost] ${exitMessage}`,
    });
    expect(consoleError).toHaveBeenCalledWith(`[NodeKernelHost] ${exitMessage}`);
    await expect(host.getKernelMemoryPages()).rejects.toThrow(exitMessage);
    expect(worker.sent).toHaveLength(messagesBeforeExit);
  });
});
