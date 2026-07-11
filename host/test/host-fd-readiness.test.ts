import { describe, expect, it, vi } from "vitest";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { WasmPosixKernel } from "../src/kernel";
import { SharedPipeBuffer } from "../src/shared-pipe-buffer";

const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;

function createStdinHarness(): any {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    stdinBuffers: new Map<number, { data: Uint8Array; offset: number }>(),
    stdinFinite: new Set<number>(),
  });
}

function createKernelHarness(options: {
  onStdinPoll?: (events: number) => number;
  networkPoll?: (handle: number, events: number) => number;
} = {}): any {
  const networkPoll = options.networkPoll ?? vi.fn(() => 0);
  return Object.assign(Object.create(WasmPosixKernel.prototype), {
    callbacks: { onStdinPoll: options.onStdinPoll },
    io: { network: { poll: networkPoll } },
    memory: new WebAssembly.Memory({ initial: 1 }),
    sharedPipes: new Map(),
  });
}

describe("host-delegated pipe readiness", () => {
  it("derives open-empty, buffered, and EOF stdin readiness per process", () => {
    const worker = createStdinHarness();
    const pid = 7;

    expect(worker.stdinPollEvents(pid, POLLIN)).toBe(0);

    worker.stdinBuffers.set(pid, {
      data: new Uint8Array([1, 2, 3]),
      offset: 1,
    });
    expect(worker.stdinPollEvents(pid, POLLIN)).toBe(POLLIN);

    worker.stdinFinite.add(pid);
    expect(worker.stdinPollEvents(pid, POLLIN)).toBe(POLLIN | POLLHUP);

    worker.stdinBuffers.delete(pid);
    expect(worker.stdinPollEvents(pid, POLLIN)).toBe(POLLHUP);
  });

  it("keeps ordinary network handle 0 separate from tagged stdin fd 0", () => {
    const onStdinPoll = vi.fn(() => POLLHUP);
    const networkPoll = vi.fn(() => POLLIN);
    const kernel = createKernelHarness({ onStdinPoll, networkPoll });

    expect(kernel.hostNetPoll(0, POLLIN)).toBe(POLLIN);
    expect(networkPoll).toHaveBeenCalledWith(0, POLLIN);
    expect(onStdinPoll).not.toHaveBeenCalled();

    // WasmHostIO encodes delegated fd N as ~N on the existing poll import.
    expect(kernel.hostNetPoll(~0, POLLIN)).toBe(POLLHUP);
    expect(onStdinPoll).toHaveBeenCalledWith(POLLIN);
    expect(networkPoll).toHaveBeenCalledTimes(1);
  });

  it("reports SharedPipeBuffer data, EOF, capacity, and peer closure", () => {
    const kernel = createKernelHarness();
    const pipe = SharedPipeBuffer.create(4);
    kernel.sharedPipes.set(20, { pipe, end: "read" });

    expect(kernel.hostFdPoll(20, POLLIN)).toBe(0);
    pipe.write(new Uint8Array([1, 2, 3, 4]));
    expect(kernel.hostFdPoll(20, POLLIN)).toBe(POLLIN);
    pipe.closeWrite();
    expect(kernel.hostFdPoll(20, POLLIN)).toBe(POLLIN | POLLHUP);

    kernel.sharedPipes.set(21, { pipe, end: "write" });
    expect(kernel.hostFdPoll(21, POLLOUT)).toBe(0);
    const drained = new Uint8Array(1);
    pipe.read(drained);
    expect(kernel.hostFdPoll(21, POLLOUT)).toBe(POLLOUT);
    pipe.closeRead();
    expect(kernel.hostFdPoll(21, POLLOUT)).toBe(POLLERR);
  });

  it("returns EAGAIN rather than EOF for an open empty shared pipe", () => {
    const kernel = createKernelHarness();
    const pipe = SharedPipeBuffer.create(4);
    kernel.sharedPipes.set(20, { pipe, end: "read" });

    expect(kernel.hostRead(20n, 0, 4)).toBe(-11);
    pipe.write(new Uint8Array([9]));
    expect(kernel.hostRead(20n, 0, 4)).toBe(1);
    pipe.closeWrite();
    expect(kernel.hostRead(20n, 0, 4)).toBe(0);
  });

  it("returns EAGAIN for a full shared pipe and EPIPE after reader closure", () => {
    const kernel = createKernelHarness();
    const pipe = SharedPipeBuffer.create(2);
    kernel.sharedPipes.set(21, { pipe, end: "write" });

    pipe.write(new Uint8Array([1, 2]));
    expect(kernel.hostWrite(21n, 0, 1)).toBe(-11);
    const drained = new Uint8Array(1);
    pipe.read(drained);
    expect(kernel.hostWrite(21n, 0, 1)).toBe(1);
    pipe.closeRead();
    expect(kernel.hostWrite(21n, 0, 1)).toBe(-32);
  });

  it("does not partially write data at or below PIPE_BUF", () => {
    const kernel = createKernelHarness();
    const pipe = SharedPipeBuffer.create(4);
    kernel.sharedPipes.set(21, { pipe, end: "write" });
    pipe.write(new Uint8Array([1, 2, 3]));

    expect(kernel.hostWrite(21n, 0, 2)).toBe(-11);
    expect(pipe.available()).toBe(3);
  });
});
