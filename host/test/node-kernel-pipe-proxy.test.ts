import { describe, expect, it, vi } from "vitest";

import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodeKernelHost } from "../src/node-kernel-host";
import { uninitializedKernelPipeResult } from "../src/kernel-pipe-transport";
import type {
  KernelToMainMessage,
  MainToKernelMessage,
} from "../src/node-kernel-protocol";

interface TestableNodeKernelHost {
  worker: { postMessage(message: MainToKernelMessage): void };
  handleWorkerMessage(message: KernelToMainMessage): void;
}

interface TestableKernelPipeWorker {
  pumpHttpResponse(
    pid: number,
    sendPipeIdx: number,
    recvPipeIdx: number,
    pipeRead: (pid: number, pipeIdx: number, pointer: number, length: number) => number,
    pipeIsWriteOpen: (pid: number, pipeIdx: number) => number,
    pipeCloseRead: (pid: number, pipeIdx: number) => number,
    pipeCloseWrite: (pid: number, pipeIdx: number) => number,
    timeoutMs: number,
    maxResponseBytes: number,
    label: string,
  ): Promise<unknown>;
}

function fixture() {
  const sent: MainToKernelMessage[] = [];
  const host = new NodeKernelHost();
  const testable = host as unknown as TestableNodeKernelHost;
  testable.worker = { postMessage: (message) => sent.push(message) };
  return { host, sent, testable };
}

describe("NodeKernelHost kernel-pipe proxy parity", () => {
  it("keeps pre-initialization pipe messages on fail-closed sentinels", () => {
    expect(uninitializedKernelPipeResult("pick-listener")).toBeNull();
    expect(uninitializedKernelPipeResult("read")).toBeNull();
    expect(uninitializedKernelPipeResult("inject")).toBe(-1);
    expect(uninitializedKernelPipeResult("write")).toBe(-1);
    expect(uninitializedKernelPipeResult("is-write-open")).toBe(false);
  });
  it("round-trips listener selection and connection injection", async () => {
    const { host, sent, testable } = fixture();
    const targetPromise = host.pickListenerTarget(3306);
    const pick = sent.at(-1)!;
    expect(pick).toMatchObject({ type: "pick_listener_target", port: 3306 });
    testable.handleWorkerMessage({
      type: "response",
      requestId: "requestId" in pick ? pick.requestId : -1,
      result: { pid: 9, fd: 4 },
    });
    await expect(targetPromise).resolves.toEqual({ pid: 9, fd: 4 });

    const injectionPromise = host.injectConnection(9, 4, [127, 0, 0, 1], 12000);
    const injection = sent.at(-1)!;
    expect(injection).toMatchObject({
      type: "inject_connection",
      pid: 9,
      fd: 4,
      peerAddr: [127, 0, 0, 1],
      peerPort: 12000,
    });
    testable.handleWorkerMessage({
      type: "response",
      requestId: "requestId" in injection ? injection.requestId : -1,
      result: 20,
    });
    await expect(injectionPromise).resolves.toBe(20);
  });

  it("round-trips bounded pipe reads and writes", async () => {
    const { host, sent, testable } = fixture();
    const request = new Uint8Array([1, 2, 3]);
    const writePromise = host.pipeWrite(0, 20, request);
    const write = sent.at(-1)!;
    expect(write).toMatchObject({ type: "pipe_write", pid: 0, pipeIdx: 20, data: request });
    testable.handleWorkerMessage({
      type: "response",
      requestId: "requestId" in write ? write.requestId : -1,
      result: 3,
    });
    await expect(writePromise).resolves.toBe(3);

    const readPromise = host.pipeRead(0, 21);
    const read = sent.at(-1)!;
    expect(read).toMatchObject({ type: "pipe_read", pid: 0, pipeIdx: 21 });
    const response = new Uint8Array([4, 5]);
    testable.handleWorkerMessage({
      type: "response",
      requestId: "requestId" in read ? read.requestId : -1,
      result: response,
    });
    await expect(readPromise).resolves.toEqual(response);

    const openPromise = host.pipeIsWriteOpen(0, 21);
    const open = sent.at(-1)!;
    expect(open).toMatchObject({ type: "pipe_is_write_open", pid: 0, pipeIdx: 21 });
    testable.handleWorkerMessage({
      type: "response",
      requestId: "requestId" in open ? open.requestId : -1,
      result: true,
    });
    await expect(openPromise).resolves.toBe(true);
  });

  it("forwards close and wake notifications without a response channel", () => {
    const { host, sent } = fixture();
    host.pipeCloseWrite(0, 20);
    host.pipeCloseRead(0, 21);
    host.wakeBlockedReaders(20);
    host.wakeBlockedWriters(21);
    expect(sent.slice(-4)).toEqual([
      { type: "pipe_close_write", pid: 0, pipeIdx: 20 },
      { type: "pipe_close_read", pid: 0, pipeIdx: 21 },
      { type: "wake_blocked_readers", pipeIdx: 20 },
      { type: "wake_blocked_writers", pipeIdx: 21 },
    ]);
  });
});

describe("CentralizedKernelWorker host pipe boundary", () => {
  it("bounds one read and wakes the guest writer after draining bytes", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const bytes = new Uint8Array(memory.buffer);
    let calls = 0;
    const worker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        kernelInstance: {
          exports: {
            kernel_pipe_read: (
              _pid: number,
              _pipeIdx: number,
              pointer: number,
              length: number,
            ) => {
              calls += 1;
              if (calls > 1) return 0;
              expect(length).toBe(65_536);
              bytes.set([4, 5, 6], pointer);
              return 3;
            },
          },
        },
        kernelMemory: memory,
        kernel: { toKernelPtr: (value: number | bigint) => value },
        tcpScratchOffset: 4_096,
        cachedKernelMem: null,
        cachedKernelBuffer: null,
        notifyPipeWritable: vi.fn(),
      },
    ) as CentralizedKernelWorker;

    expect(worker.readHostPipe(0, 21)).toEqual(new Uint8Array([4, 5, 6]));
    expect(calls).toBe(1);
    expect(worker.notifyPipeWritable).toHaveBeenCalledWith(21);
  });

  it.each([65_537, 1.5])(
    "rejects invalid host-pipe read count %s before copying kernel memory",
    (returned) => {
      const memory = new WebAssembly.Memory({ initial: 2 });
      const worker = Object.assign(
        Object.create(CentralizedKernelWorker.prototype),
        {
          kernelInstance: {
            exports: { kernel_pipe_read: vi.fn(() => returned) },
          },
          kernelMemory: memory,
          kernel: { toKernelPtr: (value: number | bigint) => value },
          tcpScratchOffset: 4_096,
          cachedKernelMem: null,
          cachedKernelBuffer: null,
          notifyPipeWritable: vi.fn(),
        },
      ) as CentralizedKernelWorker;

      expect(() => worker.readHostPipe(0, 21)).toThrow(
        "kernel_pipe_read returned an invalid byte count",
      );
      expect(worker.notifyPipeWritable).not.toHaveBeenCalled();
    },
  );

  it.each([4, 1.5])(
    "rejects invalid host-pipe write count %s before advancing the input",
    (returned) => {
      const memory = new WebAssembly.Memory({ initial: 2 });
      const worker = Object.assign(
        Object.create(CentralizedKernelWorker.prototype),
        {
          kernelInstance: {
            exports: { kernel_pipe_write: vi.fn(() => returned) },
          },
          kernelMemory: memory,
          kernel: { toKernelPtr: (value: number | bigint) => value },
          tcpScratchOffset: 4_096,
          cachedKernelMem: null,
          cachedKernelBuffer: null,
          notifyPipeReadable: vi.fn(),
        },
      ) as CentralizedKernelWorker;

      expect(() => worker.writeHostPipe(0, 20, new Uint8Array([1, 2, 3])))
        .toThrow("kernel_pipe_write returned an invalid byte count");
      expect(worker.notifyPipeReadable).not.toHaveBeenCalled();
    },
  );

  it("rejects an overreported HTTP pipe read before retaining response bytes", async () => {
    const getKernelMem = vi.fn(() => new Uint8Array(2 * 65_536));
    const closeRead = vi.fn(() => 0);
    const closeWrite = vi.fn(() => 0);
    const worker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        kernel: { toKernelPtr: (value: number | bigint) => value },
        tcpScratchOffset: 4_096,
        getKernelMem,
        notifyPipeReadable: vi.fn(),
        notifyPipeWritable: vi.fn(),
        scheduleWakeBlockedRetries: vi.fn(),
      },
    ) as unknown as TestableKernelPipeWorker;

    await expect(worker.pumpHttpResponse(
      0,
      21,
      20,
      () => 65_537,
      () => 1,
      closeRead,
      closeWrite,
      1_000,
      1_000_000,
      "bounded test",
    )).rejects.toThrow("kernel_pipe_read returned an invalid byte count");
    expect(getKernelMem).not.toHaveBeenCalled();
    expect(closeRead).toHaveBeenCalledWith(0, 21);
    expect(closeWrite).toHaveBeenCalledWith(0, 20);
  });

  it("injects and writes through exact typed kernel exports", () => {
    const memory = new WebAssembly.Memory({ initial: 2 });
    const bytes = new Uint8Array(memory.buffer);
    const inject = vi.fn(() => 20);
    const write = vi.fn(
      (_pid: number, _pipeIdx: number, pointer: number, length: number) => {
        expect([...bytes.slice(pointer, pointer + length)]).toEqual([1, 2, 3]);
        return length;
      },
    );
    const worker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        kernelInstance: {
          exports: {
            kernel_inject_connection: inject,
            kernel_pipe_write: write,
          },
        },
        kernelMemory: memory,
        kernel: { toKernelPtr: (value: number | bigint) => value },
        tcpScratchOffset: 4_096,
        cachedKernelMem: null,
        cachedKernelBuffer: null,
        notifyPipeReadable: vi.fn(),
        scheduleWakeBlockedRetries: vi.fn(),
      },
    ) as CentralizedKernelWorker;

    expect(worker.injectHostConnection(9, 4, [127, 0, 0, 1], 12_000)).toBe(20);
    expect(inject).toHaveBeenCalledWith(9, 4, 127, 0, 0, 1, 12_000);
    expect(worker.writeHostPipe(0, 20, new Uint8Array([1, 2, 3]))).toBe(3);
    expect(worker.notifyPipeReadable).toHaveBeenCalledWith(20);
  });

  it("closes, checks, and wakes through the shared host boundary", () => {
    const closeRead = vi.fn(() => 0);
    const closeWrite = vi.fn(() => 0);
    const isWriteOpen = vi.fn(() => 1);
    const worker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        kernelInstance: {
          exports: {
            kernel_pipe_close_read: closeRead,
            kernel_pipe_close_write: closeWrite,
            kernel_pipe_is_write_open: isWriteOpen,
          },
        },
        notifyPipeReadable: vi.fn(),
        notifyPipeWritable: vi.fn(),
      },
    ) as CentralizedKernelWorker;

    worker.closeHostPipeRead(0, 21);
    worker.closeHostPipeWrite(0, 20);
    expect(worker.isHostPipeWriteOpen(0, 20)).toBe(true);
    worker.wakeHostPipeReaders(20);
    worker.wakeHostPipeWriters(21);

    expect(closeRead).toHaveBeenCalledWith(0, 21);
    expect(closeWrite).toHaveBeenCalledWith(0, 20);
    expect(isWriteOpen).toHaveBeenCalledWith(0, 20);
    expect(worker.notifyPipeReadable).toHaveBeenCalledWith(20);
    expect(worker.notifyPipeWritable).toHaveBeenCalledWith(21);
  });
});
