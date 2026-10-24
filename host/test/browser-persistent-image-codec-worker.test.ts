import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageCodecRequest, ImageCodecResponse } from "../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-protocol";

const { write, control, memory } = vi.hoisted(() => ({ write: vi.fn(), control: vi.fn(), memory: vi.fn(() => 19) }));
vi.mock("../../images/vfs/lib/kandelo-image-fs", () => ({
  KandeloImageFs: { createPositioned: () => ({ writePersistentImageTo: write, overlayActivationCodecCall: control, getMemoryPages: memory }) },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); write.mockReset(); control.mockReset(); memory.mockReset().mockReturnValue(19); });

describe("codec worker physical close proof", () => {
  it.each(["success", "quota", "close-refused", "oversized", "shared"] as const)("stages unknown-length source windows with native hashing and close proof: %s", async scenario => {
    const source = scenario === "shared" ? new Uint8Array(new SharedArrayBuffer(7)).fill(19) : Uint8Array.of(11, 17, 23, 29, 31, 37, 41);
    let stored = new Uint8Array();
    const close = vi.fn(() => { if (scenario === "close-refused") throw new Error("close refused"); });
    const flush = vi.fn(() => { if (scenario === "quota") throw Object.assign(new Error("quota"), { code: "ENOSPC" }); });
    const file = { createSyncAccessHandle: async () => ({ close, flush,
      truncate: (length: number) => { stored = stored.slice(0, length); },
      write: (bytes: Uint8Array, { at }: { at: number }) => {
        const count = Math.min(3, bytes.length);
        const next = new Uint8Array(Math.max(stored.length, at + count));
        next.set(stored);
        next.set(bytes.subarray(0, count), at);
        stored = next;
        return count;
      },
    }) } as unknown as FileSystemFileHandle;
    control.mockImplementation((operation: number) => new Uint8Array(operation === 8 ? 32 : 112).fill(operation === 8 ? 171 : 0));
    let respond!: (reply: ImageCodecResponse) => void;
    const response = new Promise<ImageCodecResponse>(resolve => { respond = resolve; });
    let sent = false;
    const worker = { onmessage: null as ((event: MessageEvent<ImageCodecRequest>) => void) | null,
      postMessage: (message: ImageCodecResponse) => {
        if (message.type === "input-needed") {
          worker.onmessage?.({ data: { type: "input", bytes: sent ? null : source } } as MessageEvent<ImageCodecRequest>);
          sent = true;
        } else respond(message);
      } };
    vi.stubGlobal("self", worker);
    await import("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-worker");
    worker.onmessage?.({ data: { type: "stage", file, moduleBytes: new Uint8Array(), maximumLength: scenario === "oversized" ? 6 : 100,
      observeMemory: true } } as MessageEvent<ImageCodecRequest>);
    const result = await response;
    expect(close).toHaveBeenCalledOnce();
    if (scenario === "success") {
      expect(result).toMatchObject({ type: "staged", closed: true, length: source.length, imageSha256: "ab".repeat(32),
        memoryUsage: { wasmPages: 19, inputWindowPeak: source.length } });
      expect(stored).toEqual(source);
      expect(flush).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ type: "error", closed: scenario !== "close-refused" });
      if (scenario === "quota") expect(result).toHaveProperty("errno", 28);
      if (scenario === "oversized" || scenario === "shared") expect(stored.length).toBe(0);
    }
  });

  it.each([false, true])("acknowledges a memory-getter failure without losing close proof or primary errno (%s)", async closeRefused => {
    const close = vi.fn(() => { if (closeRefused) throw Object.assign(new Error("close refused"), { code: "ENOSPC" }); });
    const file = { createSyncAccessHandle: async () => ({ close }) } as unknown as FileSystemFileHandle;
    let respond!: (reply: ImageCodecResponse) => void;
    const response = new Promise<ImageCodecResponse>(resolve => { respond = resolve; });
    const worker = { onmessage: null as ((event: MessageEvent<ImageCodecRequest>) => void) | null, postMessage: respond };
    vi.stubGlobal("self", worker);
    write.mockResolvedValue({ payloadLength: 31, physicalLength: 4255, identitySha256: "ab".repeat(32), integrityPolicy: "crc32c" });
    memory.mockImplementation(() => { throw Object.assign(new Error("memory refused"), { errno: 12 }); });
    await import("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-worker");
    worker.onmessage?.({ data: { type: "write", file, moduleBytes: new Uint8Array(), payloadLength: 31,
      policy: "crc32c", observeMemory: true } } as MessageEvent<ImageCodecRequest>);
    expect(await response).toMatchObject({ type: "error", closed: !closeRefused, errno: closeRefused ? 28 : 12 });
    expect(close).toHaveBeenCalledOnce();
  });
  it("reports its requested native memory after closing owned storage", async () => {
    const close = vi.fn();
    const file = { createSyncAccessHandle: async () => ({ close }) } as unknown as FileSystemFileHandle;
    let respond!: (reply: ImageCodecResponse) => void;
    const response = new Promise<ImageCodecResponse>(resolve => { respond = resolve; });
    const worker = { onmessage: null as ((event: MessageEvent<ImageCodecRequest>) => void) | null, postMessage: respond };
    vi.stubGlobal("self", worker);
    write.mockResolvedValue({ payloadLength: 31, physicalLength: 4255, identitySha256: "ab".repeat(32), integrityPolicy: "crc32c" });
    await import("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-worker");
    worker.onmessage?.({ data: { type: "write", file, moduleBytes: new Uint8Array(), payloadLength: 31,
      policy: "crc32c", observeMemory: true } } as MessageEvent<ImageCodecRequest>);
    expect(await response).toMatchObject({ type: "done", closed: true, memoryUsage: { wasmPages: 19, inputWindowPeak: 0 } });
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([19, 20] as const)("runs bounded native image policy %s without opening an OPFS handle", async operation => {
    let respond!: (reply: ImageCodecResponse) => void;
    const response = new Promise<ImageCodecResponse>(resolve => { respond = resolve; });
    const worker = { onmessage: null as ((event: MessageEvent<ImageCodecRequest>) => void) | null, postMessage: respond };
    vi.stubGlobal("self", worker);
    control.mockReturnValue(-12);
    await import("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-worker");
    const input = new Uint8Array(64);
    worker.onmessage?.({ data: { type: "control", operation, input, moduleBytes: new Uint8Array() } } as MessageEvent<ImageCodecRequest>);
    expect(await response).toEqual({ type: "controlled", result: -12, closed: true });
    expect(control).toHaveBeenCalledExactlyOnceWith(operation, input);
    expect(write).not.toHaveBeenCalled();
  });
  it.each(["open-refused", "closed", "close-refused"] as const)("tracks physical ownership when %s", async scenario => {
    const close = vi.fn(() => { if (scenario === "close-refused") throw new Error("close refused"); });
    const file = { createSyncAccessHandle: async () => {
      if (scenario === "open-refused") throw new Error("access handle refused");
      return { close };
    } } as unknown as FileSystemFileHandle;
    let resolveResponse!: (reply: ImageCodecResponse) => void;
    const response = new Promise<ImageCodecResponse>(resolve => { resolveResponse = resolve; });
    const worker = { onmessage: null as ((event: MessageEvent<ImageCodecRequest>) => void) | null, postMessage: resolveResponse };
    vi.stubGlobal("self", worker);
    write.mockResolvedValue({ payloadLength: 31, physicalLength: 4255, identitySha256: "ab".repeat(32), integrityPolicy: "crc32c" });
    await import("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec-worker");
    worker.onmessage?.({ data: { type: "write", file, moduleBytes: new Uint8Array(), payloadLength: 31, policy: "crc32c" } } as MessageEvent<ImageCodecRequest>);
    const reply = await response;
    expect(reply.type).toBe(scenario === "closed" ? "done" : "error");
    if (!("closed" in reply)) throw new Error("missing close acknowledgement");
    expect(reply.closed).toBe(scenario !== "close-refused");
    expect(close).toHaveBeenCalledTimes(scenario === "open-refused" ? 0 : 1);
    expect(write).toHaveBeenCalledTimes(scenario === "open-refused" ? 0 : 1);
  });
});
