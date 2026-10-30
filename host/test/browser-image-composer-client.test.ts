import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposeImageJob, ComposeImageResult } from "../../apps/browser-demos/pages/kandelo/kernel-host/image-composer";
import type { ComposerToMainMessage, MainToComposerMessage } from "../../apps/browser-demos/pages/kandelo/kernel-host/image-composer-protocol";

const { workers, save, manifest } = vi.hoisted(() => ({
  workers: [] as Array<{
    onmessage: ((event: MessageEvent<ComposerToMainMessage>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    onmessageerror: (() => void) | null;
    sent: MainToComposerMessage[];
    reply(message: ComposerToMainMessage): void;
    terminate: ReturnType<typeof vi.fn>;
  }>, save: vi.fn(), manifest: vi.fn(),
}));
vi.mock("../../apps/browser-demos/pages/kandelo/kernel-host/image-composer-worker.ts?worker", () => ({ default: class {
  onmessage: ((event: MessageEvent<ComposerToMainMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: MainToComposerMessage[] = [];
  terminate = vi.fn();
  constructor() { workers.push(this); }
  postMessage(message: MainToComposerMessage) { this.sent.push(message); }
  reply(message: ComposerToMainMessage) { this.onmessage?.({ data: message } as MessageEvent<ComposerToMainMessage>); }
} }));
vi.mock("../../apps/browser-demos/pages/kandelo/kernel-host/fixed-persistence-image", () => ({
  saveFixedPersistenceImageStream: save, fixedPersistenceManifestMemoryUsage: manifest,
}));
vi.mock("../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec", () => ({
  UnprovenImageCodecCleanupError: class extends Error { readonly retainTarget = true; },
}));
import { composeImageInWorker } from "../../apps/browser-demos/pages/kandelo/kernel-host/image-composer-client";
import { UnprovenImageCodecCleanupError } from "../../apps/browser-demos/pages/kandelo/kernel-host/persistent-image-codec";

const composition = {} as Pick<ComposeImageResult, "imageConfig" | "profileId" | "terminalSession" | "requiredServices">;
function job(): ComposeImageJob {
  return { imageBytes: new Uint8Array(), persistentImage: { name: "computer", identity: "identity", integrityPolicy: "crc32c" },
    maxVfsByteLength: 65536, imageLabel: "probe", requestedProfileId: null, requestedProfileSource: null,
    hasCandidateEvidence: false, descriptor: {} as never, appPath: "/", proto: "http", preforkServiceProcesses: 1 };
}
afterEach(() => { workers.length = 0; save.mockReset(); manifest.mockReset(); });

describe("composer storage ownership", () => {
  it("forwards typed persistent image progress without parsing its log message", async () => {
    const progress = { phase: "verify", bytes: 16, total: 31, status: "loading" } as const;
    const onTick = vi.fn();
    save.mockImplementation(async (...args: unknown[]) => {
      const report = args[6] as (message: string, update: typeof progress) => void;
      report("a diagnostic with no numeric fields", progress);
      return { published: true };
    });
    const pending = composeImageInWorker(job(), { onTick, isCurrent: () => true, supersededError: () => new Error("superseded") });
    const worker = workers[0];
    worker.reply({ type: "persistent-start", composition, payloadLength: 31 });
    worker.reply({ type: "persistent-end" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(worker.sent).toContainEqual({ type: "persistent-ready" });
    expect(onTick).toHaveBeenCalledExactlyOnceWith("a diagnostic with no numeric fields", progress);
    worker.reply({ type: "done", ...composition, imageBytes: new Uint8Array() });
    await expect(pending).resolves.toMatchObject({ imageFile: { published: true } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([true, false])("requires positioned source-close proof before releasing a failed source (%s)", async closed => {
    const request = { ...job(), positionedSource: { file: { path: ["source.vfs"] },
      integrity: { length: 31, chunkBytes: 1024, imageSha256: "ab".repeat(32) } } };
    const pending = composeImageInWorker(request, { onTick: () => {}, isCurrent: () => true, supersededError: () => new Error("superseded") });
    workers[0].reply({ type: "error", message: "source verification failed", sourceClosed: closed });
    await expect(pending).rejects.toThrow(closed ? "source verification failed" : "source cleanup is unproven");
    if (!closed) await expect(pending).rejects.toHaveProperty("retainSource", true);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  for (const published of [false, true]) {
    it.each(["invalid", "snapshot-failed"] as const)(`rejects %s telemetry without hanging or deleting an already-published stage (${published})`, async failure => {
      const request = job();
      if (!published) delete request.persistentImage;
      const target = { published: true };
      save.mockResolvedValue(target);
      manifest.mockImplementation(() => { throw new Error("manifest snapshot failed"); });
      const pending = composeImageInWorker(request, { onTick: () => {}, isCurrent: () => true, supersededError: () => new Error("superseded") });
      const refused = expect(pending).rejects.toThrow(failure === "invalid" ? "invalid memory usage" : "manifest snapshot failed");
      const worker = workers[0];
      if (published) {
        worker.reply({ type: "persistent-start", composition, payloadLength: 31 });
        worker.reply({ type: "persistent-end" });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(worker.sent).toContainEqual({ type: "persistent-ready" });
      }
      worker.reply({ type: "done", ...composition, imageBytes: new Uint8Array(),
        memoryUsage: failure === "invalid" ? null : { wasmPages: 19, sourceBytes: 0, frozenSourceBytes: 0, returnedBytes: 0 },
      } as unknown as ComposerToMainMessage);
      await refused;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(target).toEqual({ published: true });
      expect(save).toHaveBeenCalledTimes(published ? 1 : 0);
    });
  }
  it.each(["error", "worker-error", "message-error", "tick-error"] as const)("drains storage after %s and retains unproven targets", async failure => {
    let rejectStorage!: (error: unknown) => void;
    save.mockReturnValue(new Promise((_resolve, reject) => { rejectStorage = reject; }));
    let completed = false;
    const pending = composeImageInWorker(job(), {
      onTick: () => { throw new Error("tick callback failed"); }, isCurrent: () => true, supersededError: () => new Error("superseded"),
    });
    void pending.then(() => { completed = true; }, () => { completed = true; });
    const refused = expect(pending).rejects.toMatchObject({ retainTarget: true });
    const worker = workers[0];
    worker.reply({ type: "persistent-start", composition, payloadLength: 31 });
    const signal = save.mock.calls[0][8] as AbortSignal;
    if (failure === "error") worker.reply({ type: "error", message: "composer failed" });
    if (failure === "worker-error") worker.onerror?.({ message: "worker failed" } as ErrorEvent);
    if (failure === "message-error") worker.onmessageerror?.();
    if (failure === "tick-error") worker.reply({ type: "tick", message: "writing" });
    expect(signal.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    rejectStorage(new UnprovenImageCodecCleanupError(new Error("physical close failed")));
    await refused;
    const messages = worker.sent.length;
    worker.reply({ type: "persistent-chunk", bytes: new Uint8Array(31) });
    expect(worker.sent).toHaveLength(messages);
  });

  it("bounds unacknowledged input while awaiting clean storage cancellation", async () => {
    let rejectStorage!: (error: unknown) => void;
    save.mockReturnValue(new Promise((_resolve, reject) => { rejectStorage = reject; }));
    const pending = composeImageInWorker(job(), { onTick: () => {}, isCurrent: () => true, supersededError: () => new Error("superseded") });
    const refused = expect(pending).rejects.toThrow("input credit");
    const worker = workers[0];
    worker.reply({ type: "persistent-start", composition, payloadLength: 62 });
    worker.reply({ type: "persistent-chunk", bytes: new Uint8Array(31) });
    worker.reply({ type: "persistent-chunk", bytes: new Uint8Array(31) });
    const signal = save.mock.calls[0][8] as AbortSignal;
    expect(signal.aborted).toBe(true);
    rejectStorage(signal.reason);
    await refused;
  });

  it.each(["isCurrent", "supersededError"] as const)("catches %s failures after storage fulfillment", async callback => {
    let resolveStorage!: (value: unknown) => void;
    save.mockReturnValue(new Promise(resolve => { resolveStorage = resolve; }));
    const failure = new Error("fulfilled-stage callback failed");
    let stored = false;
    const pending = composeImageInWorker(job(), {
      onTick: () => {},
      isCurrent: () => {
        if (!stored) return true;
        if (callback === "isCurrent") throw failure;
        return false;
      },
      supersededError: () => { throw failure; },
    });
    const refused = expect(pending).rejects.toBe(failure);
    const worker = workers[0];
    worker.reply({ type: "persistent-start", composition, payloadLength: 31 });
    worker.reply({ type: "persistent-end" });
    stored = true;
    resolveStorage({});
    await refused;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.sent.some(message => "type" in message && message.type === "persistent-ready")).toBe(false);
  });
});
