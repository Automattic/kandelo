import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageCodecRequest, ImageCodecResponse } from "../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-protocol";

const { workers } = vi.hoisted(() => ({ workers: [] as Array<{
  sent: ImageCodecRequest[];
  onmessage: ((event: MessageEvent<ImageCodecResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  waitFor(type: ImageCodecRequest["type"]): Promise<ImageCodecRequest>;
  reply(message: ImageCodecResponse): void;
  terminate: ReturnType<typeof vi.fn>;
}> }));
vi.mock("../src/vfs/opfs-file-reference", () => ({ referenceOpfsFile: async () => ({ path: ["probe.vfs"] }) }));

vi.mock("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-worker.ts?worker", () => ({ default: class {
  sent: ImageCodecRequest[] = [];
  onmessage: ((event: MessageEvent<ImageCodecResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  private waiters: Array<{ type: ImageCodecRequest["type"]; resolve: (message: ImageCodecRequest) => void }> = [];
  constructor() { workers.push(this); }
  postMessage(message: ImageCodecRequest) {
    this.sent.push(message);
    const index = this.waiters.findIndex(waiter => waiter.type === message.type);
    if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
  }
  waitFor(type: ImageCodecRequest["type"]): Promise<ImageCodecRequest> {
    const message = this.sent.find(message => message.type === type);
    return message === undefined ? new Promise(resolve => this.waiters.push({ type, resolve })) : Promise.resolve(message);
  }
  reply(message: ImageCodecResponse) { this.onmessage?.({ data: message } as MessageEvent<ImageCodecResponse>); }
} }));

import { inspectPersistentImageFile, runPersistentImageControl, stageSourceImageFile, UnprovenImageCodecCleanupError, writePersistentImageFile, MAX_IMAGE_CODEC_MODULE_BYTES } from "../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec";

const file = {} as FileSystemFileHandle;
const moduleBytes = new Uint8Array([0, 97, 115, 109]);

function growAfterLengthRead(length: number, maximum: number): Uint8Array {
  const buffer = new SharedArrayBuffer(length, { maxByteLength: maximum });
  const view = new Uint8Array(buffer).fill(19);
  const observed = () => { if (buffer.byteLength !== maximum) buffer.grow(maximum); return length; };
  Object.defineProperties(view, { length: { get: observed }, byteLength: { get: observed } });
  return view;
}
afterEach(() => { workers.length = 0; vi.useRealTimers(); });

describe("persistent image codec worker ownership", () => {
  it.each(["closed", "unproven", "early"] as const)("source staging requires EOF and physical close proof: %s", async scenario => {
    async function* chunks() { yield Uint8Array.of(11, 17, 23); }
    const pending = stageSourceImageFile(file, moduleBytes, 100, chunks());
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    expect(worker.sent[0]).toMatchObject({ file: { path: ["probe.vfs"] } });
    const firstInput = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    expect(await firstInput).toEqual({ type: "input", bytes: Uint8Array.of(11, 17, 23) });
    if (scenario !== "early") {
      worker.sent.length = 0;
      const end = worker.waitFor("input");
      worker.reply({ type: "input-needed" });
      expect(await end).toEqual({ type: "input", bytes: null });
    }
    if (scenario === "unproven") {
      worker.reply({ type: "error", closed: false, message: "close failed" });
      await expect(pending).rejects.toBeInstanceOf(UnprovenImageCodecCleanupError);
    } else {
      worker.reply({ type: "staged", closed: true, length: 3, imageSha256: "ab".repeat(32) });
      if (scenario === "early") await expect(pending).rejects.toThrow("before consuming the input stream");
      else await expect(pending).resolves.toEqual({ length: 3, imageSha256: "ab".repeat(32) });
    }
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("fixes the module span before a growable buffer changes length", async () => {
    const module = growAfterLengthRead(4, MAX_IMAGE_CODEC_MODULE_BYTES + 1);
    const pending = runPersistentImageControl(module, 20, new Uint8Array(64));
    const message = workers[0].sent[0];
    if (message.type !== "control") throw new Error("missing control");
    expect(message.moduleBytes?.byteLength).toBe(4);
    workers[0].reply({ type: "controlled", result: -12, closed: true });
    await expect(pending).resolves.toBe(-12);
  });

  it("copies only the control packet when its growable source changes length", async () => {
    const input = growAfterLengthRead(64, 1024 * 1024);
    const pending = runPersistentImageControl(moduleBytes, 20, input);
    const message = workers[0].sent[0];
    if (message.type !== "control") throw new Error("missing control");
    expect(message.input.buffer.byteLength).toBe(64);
    workers[0].reply({ type: "controlled", result: -12, closed: true });
    await expect(pending).resolves.toBe(-12);
  });

  it("copies a fixed input span when the yielded backing grows after validation", async () => {
    const view = growAfterLengthRead(65536, 2 * 1024 * 1024);
    const observed = vi.fn();
    const pending = writePersistentImageFile(file, moduleBytes, 65536, "crc32c", [view], { onMemoryUsage: observed });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    worker.sent.length = 0;
    const input = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    const packet = await input;
    expect(packet.type === "input" && packet.bytes?.byteLength).toBe(65536);
    worker.sent.length = 0;
    const end = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    expect(await end).toEqual({ type: "input", bytes: null });
    worker.reply({ type: "done", closed: true, memoryUsage: { wasmPages: 19, inputWindowPeak: 65536 }, result: {
      payloadLength: 65536, physicalLength: 65536 + 4224, identitySha256: "ab".repeat(32), integrityPolicy: "crc32c",
    } });
    await pending;
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ callerInputBackingPeak: 65536 }));
  });
  it.each([false, true])("copies exact module and control spans without transferring or cloning borrowed backings (%s)", async shared => {
    const backing = shared ? new SharedArrayBuffer(2 * 1024 * 1024) : new ArrayBuffer(2 * 1024 * 1024);
    const module = new Uint8Array(backing, 0, 4);
    module.set(moduleBytes);
    const input = new Uint8Array(backing, 65536, 64).fill(19);
    const pending = runPersistentImageControl(module, 20, input);
    const worker = workers[0];
    const message = worker.sent[0];
    if (message.type !== "control") throw new Error("missing control packet");
    expect(message.moduleBytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(message.moduleBytes.buffer.byteLength).toBe(4);
    expect(message.input.buffer).toBeInstanceOf(ArrayBuffer);
    expect(message.input.buffer.byteLength).toBe(64);
    input.fill(99);
    expect(message.input[0]).toBe(19);
    expect(module.byteLength).toBe(4);
    worker.reply({ type: "controlled", result: -12, closed: true });
    await expect(pending).resolves.toBe(-12);
  });

  it("refuses oversized codec modules before creating a worker or reading a source file", async () => {
    const module = new Uint8Array(MAX_IMAGE_CODEC_MODULE_BYTES + 1);
    const getFile = vi.fn();
    await expect(runPersistentImageControl(module, 20, new Uint8Array(64)))
      .rejects.toMatchObject({ code: "ENOMEM", errno: 12 });
    await expect(inspectPersistentImageFile({ getFile } as unknown as FileSystemFileHandle,
      module, 8192, "ab".repeat(32), "crc32c")).rejects.toMatchObject({ code: "ENOMEM", errno: 12 });
    expect(workers).toHaveLength(0);
    expect(getFile).not.toHaveBeenCalled();
  });
  it.each([false, true])("snapshots a small yielded view instead of retaining its large backing (%s)", async shared => {
    let original: Uint8Array | undefined;
    let supplied = false;
    const chunks = { [Symbol.asyncIterator]: () => ({ next: async () => {
      if (supplied) return { done: true as const, value: undefined };
      supplied = true;
      const buffer = shared ? new SharedArrayBuffer(2 * 1024 * 1024) : new ArrayBuffer(2 * 1024 * 1024);
      original = new Uint8Array(buffer, 0, 128 * 1024).fill(19);
      return { done: false as const, value: original };
    } }) };
    const observed = vi.fn();
    const pending = writePersistentImageFile(file, moduleBytes, 128 * 1024, "crc32c", chunks, { onMemoryUsage: observed });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    worker.sent.length = 0;
    const first = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    const initial = await first;
    expect(initial.type === "input" && initial.bytes?.[0]).toBe(19);
    original!.fill(99);
    original = undefined;
    worker.sent.length = 0;
    const second = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    const next = await second;
    expect(next.type === "input" && next.bytes?.[0]).toBe(19);
    worker.sent.length = 0;
    const end = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    expect(await end).toEqual({ type: "input", bytes: null });
    worker.reply({ type: "done", closed: true, memoryUsage: { wasmPages: 19, inputWindowPeak: 65536 }, result: {
      payloadLength: 128 * 1024, physicalLength: 128 * 1024 + 4224, identitySha256: "ab".repeat(32), integrityPolicy: "crc32c",
    } });
    await pending;
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ callerInputChunkPeak: 128 * 1024, callerInputBackingPeak: 128 * 1024 }));
  });
  it("attributes bounded caller and worker windows only after worker retirement", async () => {
    const bytes = new Uint8Array(1024 * 1024);
    const observed = vi.fn(usage => {
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(usage).toEqual({ wasmPages: 19, inputWindowPeak: 65536, callerInputChunkPeak: bytes.length, callerInputBackingPeak: bytes.length });
    });
    const pending = writePersistentImageFile(file, moduleBytes, bytes.length, "crc32c", [bytes], { onMemoryUsage: observed });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    expect(worker.sent[0]).toMatchObject({ observeMemory: true });
    worker.sent.length = 0;
    for (let index = 0; index < 16; index++) {
      const input = worker.waitFor("input");
      worker.reply({ type: "input-needed" });
      const message = await input;
      expect(message.type === "input" && message.bytes?.length).toBe(65536);
      worker.sent.length = 0;
    }
    const end = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    expect(await end).toEqual({ type: "input", bytes: null });
    worker.reply({ type: "done", closed: true, memoryUsage: { wasmPages: 19, inputWindowPeak: 65536 }, result: {
      payloadLength: bytes.length, physicalLength: bytes.length + 4224, identitySha256: "ab".repeat(32), integrityPolicy: "crc32c",
    } });
    await pending;
    expect(observed).toHaveBeenCalledOnce();
  });

  it("preserves uncertain storage ownership when a memory observer also fails", async () => {
    const observerFailure = new Error("observer failed");
    const pending = runPersistentImageControl(moduleBytes, 20, new Uint8Array(64), {
      onMemoryUsage: () => { throw observerFailure; },
    });
    workers[0].reply({ type: "error", message: "close refused", closed: false,
      memoryUsage: { wasmPages: 19, inputWindowPeak: 0 } });
    const failure = await pending.catch(error => error);
    expect(failure).toBeInstanceOf(UnprovenImageCodecCleanupError);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(failure.cause.errors).toContain(observerFailure);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("refuses missing or contradictory requested worker memory", async () => {
    for (const memoryUsage of [undefined, { wasmPages: 0, inputWindowPeak: 0 }, { wasmPages: 19, inputWindowPeak: 65537 }]) {
      const observed = vi.fn();
      const pending = runPersistentImageControl(moduleBytes, 20, new Uint8Array(64), { onMemoryUsage: observed });
      workers.at(-1)!.reply({ type: "controlled", result: 0, closed: true, memoryUsage });
      await expect(pending).rejects.toThrow(/memory usage/);
      expect(observed).not.toHaveBeenCalled();
    }
  });
  it("retires the bounded image policy worker and preserves native errors", async () => {
    const input = new Uint8Array(64);
    const pending = runPersistentImageControl(moduleBytes, 20, input);
    const worker = workers[0];
    expect(worker.sent[0]).toMatchObject({ type: "control", operation: 20, input });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ type: "controlled", result: -12, closed: true });
    await expect(pending).resolves.toBe(-12);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(moduleBytes.length).toBe(4);
  });

  it("does not accept a policy reply for a different operation or malformed geometry", async () => {
    const pending = runPersistentImageControl(moduleBytes, 20, new Uint8Array(64));
    workers[0].reply({ type: "inspected", payloadLength: 1, physicalLength: 4096, closed: true });
    await expect(pending).rejects.toThrow(/wrong operation/);
    const malformed = runPersistentImageControl(moduleBytes, 19, new Uint8Array(64));
    workers[1].reply({ type: "controlled", result: new Uint8Array(8), closed: true });
    await expect(malformed).rejects.toThrow(/geometry/);
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    await expect(runPersistentImageControl(moduleBytes, 20, new Uint8Array(65))).rejects.toThrow(/invalid/);
    expect(workers).toHaveLength(2);
  });
  it("copies cached module bytes and bounds input transfers while awaiting physical close acknowledgement", async () => {
    const bytes = new Uint8Array(65536).fill(19);
    const pending = writePersistentImageFile(file, moduleBytes, bytes.length, "sha256", [bytes]);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    const job = worker.sent[0];
    expect(job.type).toBe("write");
    if (job.type !== "write") throw new Error("missing job");
    expect(job.moduleBytes).not.toBe(moduleBytes);
    const input = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    const supplied = await input;
    expect(supplied.type).toBe("input");
    if (supplied.type !== "input") throw new Error("missing bytes");
    expect(supplied.bytes).toEqual(bytes);
    worker.sent.length = 0;
    const end = worker.waitFor("input");
    worker.reply({ type: "input-needed" });
    expect(await end).toEqual({ type: "input", bytes: null });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ type: "done", closed: true, result: {
      payloadLength: bytes.length, physicalLength: bytes.length + 4224, identitySha256: "ab".repeat(32), integrityPolicy: "sha256",
    } });
    await expect(pending).resolves.toMatchObject({ payloadLength: bytes.length });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(moduleBytes.length).toBe(4);
  });

  it("cancels a pending input promise without waiting for it or permitting late messages", async () => {
    const controller = new AbortController();
    let returned = 0;
    let announce!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({
      next: () => { announce(); return new Promise(() => {}); },
      return: async () => { returned++; return { done: true, value: undefined }; },
    }) };
    const pending = writePersistentImageFile(file, moduleBytes, 31, "crc32c", input, { signal: controller.signal });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    worker.reply({ type: "input-needed" });
    await entered;
    controller.abort();
    expect(worker.sent.at(-1)?.type).toBe("cancel");
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ type: "error", message: "cancelled", closed: true });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(returned).toBe(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels unresolved progress and ignores its completion after worker retirement", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const pending = writePersistentImageFile(file, moduleBytes, 31, "sha256", [new Uint8Array(31)], {
      signal: controller.signal, onProgress: () => blocked,
    });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    worker.reply({ type: "progress", phase: "write", bytes: 0, total: 31 });
    controller.abort();
    worker.reply({ type: "error", message: "cancelled", closed: true });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const messages = worker.sent.length;
    release();
    await blocked;
    expect(worker.sent).toHaveLength(messages);
  });

  it("never turns a cleanup timeout into proof that the target is safe to remove", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = writePersistentImageFile(file, moduleBytes, 31, "crc32c", [], { signal: controller.signal });
    const failure = expect(pending).rejects.toBeInstanceOf(UnprovenImageCodecCleanupError);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("retains an unproven target even if source iterator cleanup also throws", async () => {
    let announce!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({
      next: () => { announce(); return new Promise(() => {}); },
      return: () => { throw new Error("source close failed"); },
    }) };
    const pending = writePersistentImageFile(file, moduleBytes, 31, "sha256", input);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    worker.reply({ type: "input-needed" });
    await entered;
    worker.reply({ type: "error", message: "native close failed", closed: false });
    await expect(pending).rejects.toMatchObject({ retainTarget: true, name: "UnprovenImageCodecCleanupError" });
  });

  it("rejects an aborted request before creating a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(writePersistentImageFile(file, moduleBytes, 31, "sha256", [], { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(0);
  });

  it("rejects supersession before dispatch without waiting for a nonexistent handle close", async () => {
    let checks = 0;
    const failure = new Error("superseded before dispatch");
    await expect(writePersistentImageFile(file, moduleBytes, 31, "crc32c", [], {
      assertCurrent: () => { if (++checks === 2) throw failure; },
    })).rejects.toBe(failure);
    expect(workers[0].sent).toEqual([]);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("probes at most one ordinary page without opening a second OPFS storage handle", async () => {
    const slice = vi.fn(() => new Blob([new Uint8Array(4096)]));
    const source = { getFile: async () => ({ size: 32 * 1024 ** 3, slice }) } as unknown as FileSystemFileHandle;
    const pending = inspectPersistentImageFile(source, moduleBytes, 32 * 1024 ** 3, "ab".repeat(32), "sha256");
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    expect(slice).toHaveBeenCalledWith(0, 4096);
    const job = worker.sent[0];
    expect(job.type).toBe("inspect");
    if (job.type !== "inspect") throw new Error("missing inspection");
    expect(job.prefix.length).toBe(4096);
    expect("file" in job).toBe(false);
    worker.reply({ type: "inspected", closed: true, payloadLength: 32 * 1024 ** 3 - 4224, physicalLength: 32 * 1024 ** 3 });
    await expect(pending).resolves.toMatchObject({ physicalLength: 32 * 1024 ** 3 });
  });
});
