import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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

  it("routes the Node worker protocol through the reentrant-safe pipe API", () => {
    const entry = readFileSync(
      new URL("../src/node-kernel-worker-entry.ts", import.meta.url),
      "utf8",
    );

    expect(entry).toContain("kernelWorker.readPipeAvailable(msg.pid, msg.pipeIdx)");
    expect(entry).toContain("kernelWorker.writePipeData(msg.pid, msg.pipeIdx, msg.data)");
    expect(entry).toContain("kernelWorker.notifyPipeReadable(msg.pipeIdx)");
    expect(entry).toContain("kernelWorker.injectConnection(");
    expect(entry).toContain("kernelWorker.closePipeRead(msg.pid, msg.pipeIdx)");
    expect(entry).toContain("kernelWorker.closePipeWrite(msg.pid, msg.pipeIdx)");
    expect(entry).toContain("kernelWorker.isPipeWriteOpen(msg.pid, msg.pipeIdx)");
    expect(entry).not.toContain("kernelWorker.readHostPipe(");
    expect(entry).not.toContain("kernelWorker.writeHostPipe(");
    expect(entry).not.toContain("kernelWorker.injectHostConnection(");
  });
});
