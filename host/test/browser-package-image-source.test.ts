import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackageImageSourceRequest, PackageImageSourceResponse } from "../../apps/browser-demos/pages/kandelo/kernel-host/package-image-source-protocol";

const { workers } = vi.hoisted(() => ({ workers: [] as Array<{
  sent: PackageImageSourceRequest[];
  reply(message: PackageImageSourceResponse): void;
  waitFor(type: PackageImageSourceRequest["type"]): Promise<PackageImageSourceRequest>;
  terminate: ReturnType<typeof vi.fn>;
}> }));
vi.mock("../src/vfs/opfs-file-reference", () => ({ referenceOpfsFile: async () => ({ path: ["target.vfs"] }) }));
vi.mock("../../apps/browser-demos/pages/kandelo/kernel-host/package-image-source-worker.ts?worker", () => ({ default: class {
  sent: PackageImageSourceRequest[] = [];
  onmessage: ((event: MessageEvent<PackageImageSourceResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  private waiters: Array<{ type: PackageImageSourceRequest["type"]; resolve(request: PackageImageSourceRequest): void }> = [];
  constructor() { workers.push(this); }
  postMessage(request: PackageImageSourceRequest): void {
    this.sent.push(request);
    const index = this.waiters.findIndex(waiter => waiter.type === request.type);
    if (index >= 0) this.waiters.splice(index, 1)[0].resolve(request);
  }
  waitFor(type: PackageImageSourceRequest["type"]): Promise<PackageImageSourceRequest> {
    const request = this.sent.find(message => message.type === type);
    return request === undefined ? new Promise(resolve => this.waiters.push({ type, resolve })) : Promise.resolve(request);
  }
  reply(message: PackageImageSourceResponse): void { this.onmessage?.({ data: message } as MessageEvent<PackageImageSourceResponse>); }
} }));

import { BrowserPackageImageSource, UnprovenPackageSourceCleanupError } from "../../apps/browser-demos/pages/kandelo/kernel-host/package-image-source";

const moduleBytes = Uint8Array.of(0, 97, 115, 109);
const file = {} as FileSystemFileHandle;
const identity = { length: 1000, sha256: "a".repeat(64), directory: `https://example.test/${"b".repeat(64)}/` };

async function open(signal?: AbortSignal) {
  const pending = BrowserPackageImageSource.open(moduleBytes, file, identity, signal);
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  const worker = workers[0];
  const request = await worker.waitFor("open");
  worker.reply({ type: "ready", id: request.id, inventoryBytes: 100 });
  return { source: await pending, worker };
}

afterEach(() => { workers.length = 0; vi.useRealTimers(); });

describe("package source worker ownership", () => {
  it("bounds cancellation while initial source verification has not acknowledged completion", async () => {
    const controller = new AbortController();
    const pending = BrowserPackageImageSource.open(moduleBytes, file, identity, controller.signal);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    await workers[0].waitFor("open");
    vi.useFakeTimers();
    const refused = expect(pending).rejects.toBeInstanceOf(UnprovenPackageSourceCleanupError);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    await refused;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("keeps abort attached through chunk reads and joins their storage-close acknowledgement", async () => {
    const controller = new AbortController();
    const { source, worker } = await open(controller.signal);
    const pending = source.readInventory(0, 1);
    const read = await worker.waitFor("read");
    controller.abort();
    expect(worker.sent.some(request => request.type === "close")).toBe(false);
    worker.reply({ type: "bytes", id: read.id, bytes: Uint8Array.of(4) });
    expect(await pending).toEqual(Uint8Array.of(4));
    const close = await worker.waitFor("close");
    worker.reply({ type: "closed", id: close.id });
    await source.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("refuses shared/oversized module ingress and missing source identity before creating a worker", async () => {
    for (const bytes of [new Uint8Array(new SharedArrayBuffer(4)), new Uint8Array(16 * 1024 * 1024 + 1), new Uint8Array()]) {
      await expect(BrowserPackageImageSource.open(bytes, file, identity)).rejects.toThrow("independent byte bound");
    }
    await expect(BrowserPackageImageSource.open(moduleBytes, file, { ...identity, sha256: "latest" })).rejects.toThrow("trusted image identity");
    expect(workers).toHaveLength(0);
  });

  it("transfers only copied module bytes and bounded reads, then awaits handle closure", async () => {
    const { source, worker } = await open();
    const request = worker.sent[0];
    expect(request.type).toBe("open");
    if (request.type !== "open") throw new Error("missing open");
    expect(request.moduleBytes).toEqual(moduleBytes);
    expect(request.moduleBytes.buffer).not.toBe(moduleBytes.buffer);
    expect(request.file).toEqual({ path: ["target.vfs"] });
    expect(source.inventoryBytes).toBe(100);
    const pending = source.readInventory(0, 4);
    const read = await worker.waitFor("read");
    worker.reply({ type: "bytes", id: read.id, bytes: Uint8Array.of(1, 2, 3, 4) });
    expect(await pending).toEqual(Uint8Array.of(1, 2, 3, 4));
    const closed = source.close();
    const close = await worker.waitFor("close");
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ type: "closed", id: close.id });
    await closed;
    expect(source.close()).toBe(closed);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(source.readInventory(0, 1)).rejects.toThrow("closing");
  });

  it("snapshots source identity and module bytes before awaiting OPFS resolution", async () => {
    const bytes = moduleBytes.slice();
    const binding = { ...identity };
    const pending = BrowserPackageImageSource.open(bytes, file, binding);
    bytes.fill(255);
    binding.directory = "x".repeat(5000);
    binding.length = -1;
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    const request = await worker.waitFor("open");
    expect(request).toMatchObject({ ...identity, moduleBytes });
    worker.reply({ type: "ready", id: request.id, inventoryBytes: 100 });
    const source = await pending;
    const closed = source.close();
    const close = await worker.waitFor("close");
    worker.reply({ type: "closed", id: close.id });
    await closed;
  });

  it("rejects concurrent reads and oversized paths before transport and drains the active read before closing", async () => {
    const { source, worker } = await open();
    await expect(source.readFile("/" + "x".repeat(4096), 0, 1)).rejects.toThrow("path is invalid");
    await expect(source.readFile("/" + "é".repeat(2500), 0, 1)).rejects.toThrow("path is invalid");
    await expect(source.readInventory(0, 65537)).rejects.toThrow("valid range");
    expect(worker.sent).toHaveLength(1);
    const pending = source.readFile("/bin/tool", 0, 1);
    const read = await worker.waitFor("read");
    await expect(source.readInventory(0, 1)).rejects.toThrow("already in flight");
    const closed = source.close();
    expect(worker.sent.filter(message => message.type === "close")).toHaveLength(0);
    worker.reply({ type: "bytes", id: read.id, bytes: Uint8Array.of(3) });
    expect(await pending).toEqual(Uint8Array.of(3));
    const close = await worker.waitFor("close");
    worker.reply({ type: "closed", id: close.id });
    await closed;
  });

  it.each([false, true])("requires source retention after an unproven close or stalled read (%s)", async stalled => {
    const { source, worker } = await open();
    vi.useFakeTimers();
    const pending = stalled ? source.readInventory(0, 1) : undefined;
    const readRefusal = pending === undefined ? undefined : expect(pending).rejects.toBeInstanceOf(UnprovenPackageSourceCleanupError);
    const closed = source.close();
    const refusal = expect(closed).rejects.toBeInstanceOf(UnprovenPackageSourceCleanupError);
    if (stalled) await vi.advanceTimersByTimeAsync(5000);
    else {
      const close = await worker.waitFor("close");
      worker.reply({ type: "error", id: close.id, message: "handle close refused", closed: false });
    }
    await refusal;
    await readRefusal;
    await expect(source.close()).rejects.toMatchObject({ retainTarget: true });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("refuses oversized reply backing stores and marks cleanup unproven", async () => {
    const { source, worker } = await open();
    const pending = source.readInventory(0, 1);
    const read = await worker.waitFor("read");
    worker.reply({ type: "bytes", id: read.id, bytes: new Uint8Array(new ArrayBuffer(65537), 0, 1) });
    await expect(pending).rejects.toBeInstanceOf(UnprovenPackageSourceCleanupError);
    await expect(source.close()).rejects.toMatchObject({ retainTarget: true });
  });
});
