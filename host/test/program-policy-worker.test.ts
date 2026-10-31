import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createNodePolicyWorker } from "../src/program-policy-node";
import { ProgramPolicyInspector } from "../src/program-policy";
import { MockWorkerHandle } from "../src/worker-adapter";
import type { PolicyWorkerFactory } from "../src/program-policy";
import type { PolicyWorkerRequest } from "../src/program-policy-worker";

const raw = readFileSync(resolve(import.meta.dirname, "../../abi/program-fixtures/v55/raw-fork.wasm"));
const module = new WebAssembly.Module(readFileSync(resolve(import.meta.dirname, "../../local-binaries/kandelo_program_policy32.wasm")));
const source = Uint8Array.from(raw).buffer;
const request: PolicyWorkerRequest = { module, source, metadataBytes: 1024 * 1024, workItems: 1_000_000, memoryPages: 64, heapBytes: 2 * 1024 * 1024 };
const limits = { maximumJobs: 1, maximumWorkspace: 64 * 1024 * 1024 };

describe("isolated Rust program metadata", () => {
  it("reads the supported program in a real bounded Node worker", async () => {
    const inspector = new ProgramPolicyInspector(createNodePolicyWorker, limits);
    const record = await inspector.inspect(request, { timeoutMs: 30_000 });
    expect(record.byteLength).toBe(160);
    expect(new TextDecoder().decode(record.subarray(0, 6))).toBe("KDPOL1");
    expect(Buffer.from(record.subarray(24, 56)).toString("hex")).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(new DataView(record.buffer).getInt32(60, true)).toBe(55);
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
    expect(new Uint8Array(source)).toEqual(Uint8Array.from(raw));
  });

  it("contains malformed-diagnostic allocator exhaustion and accepts the next job", async () => {
    const inspector = new ProgramPolicyInspector(createNodePolicyWorker, limits);
    const malformed = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 1, 255]).buffer;
    await expect(inspector.inspect({ ...request, source: malformed, heapBytes: malformed.byteLength }, { timeoutMs: 30_000 }))
      .rejects.toMatchObject({ reason: "allocation" });
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
    expect((await inspector.inspect(request, { timeoutMs: 30_000 })).byteLength).toBe(160);
  });

  it.each([
    [{ metadataBytes: 1 }, "metadata-limit"],
    [{ workItems: 1 }, "work-limit"],
    [{ source: Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 1, 255]).buffer }, "invalid"],
  ] as const)("retires refusals for %j", async (changes, reason) => {
    const inspector = new ProgramPolicyInspector(createNodePolicyWorker, limits);
    await expect(inspector.inspect({ ...request, ...changes }, { timeoutMs: 30_000 })).rejects.toMatchObject({ reason });
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("refuses an original reference shorter than a Wasm header: %i", async (length) => {
    const name = new TextEncoder().encode("kandelo.original-program");
    const reference = new Uint8Array(44);
    const view = new DataView(reference.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, BigInt(length), true);
    reference.fill(1, 12);
    const bytes = Uint8Array.from([...raw, 0, 1 + name.byteLength + reference.byteLength, name.byteLength, ...name, ...reference]);
    const inspector = new ProgramPolicyInspector(createNodePolicyWorker, limits);
    await expect(inspector.inspect({ ...request, source: bytes.buffer }, { timeoutMs: 30_000 })).rejects.toMatchObject({ reason: "invalid" });
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
    await inspector.close();
  });

  it("refuses excess workspace and shared input before creating any worker", async () => {
    let created = 0;
    const factory: PolicyWorkerFactory = Object.assign(() => { created += 1; return new MockWorkerHandle(); }, { workspaceOverheadBytes: 0 });
    const inspector = new ProgramPolicyInspector(factory, { ...limits, maximumWorkspace: 1024 });
    await expect(inspector.inspect(request, { timeoutMs: 100 })).rejects.toMatchObject({ reason: "workspace" });
    await expect(inspector.inspect({ ...request, source: new SharedArrayBuffer(16) as unknown as ArrayBuffer }, { timeoutMs: 100 }))
      .rejects.toMatchObject({ reason: "protocol" });
    expect(created).toBe(0);
  });

  it("keeps admission until refused termination is successfully retried", async () => {
    class RetiringWorker extends MockWorkerHandle {
      attempts = 0;
      async terminate() {
        if (++this.attempts === 1) throw new Error("termination refused");
        return 0;
      }
    }
    const worker = new RetiringWorker();
    const factory: PolicyWorkerFactory = Object.assign(() => worker, { workspaceOverheadBytes: 0 });
    const inspector = new ProgramPolicyInspector(factory, limits);
    const controller = new AbortController();
    const inspection = inspector.inspect(request, { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    await expect(inspection).rejects.toMatchObject({ reason: "retirement" });
    expect(inspector.active.jobs).toBe(1);
    await expect(inspector.inspect(request, { timeoutMs: 10_000 })).rejects.toMatchObject({ reason: "busy" });
    await inspector.drainRetirements();
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
    expect(worker.attempts).toBe(2);
  });

  it("contains queued worker errors until successful retirement, including refused termination", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const terminationStarted = new Promise<void>(resolve => { started = resolve; });
    let attempts = 0;
    const worker = Object.assign(new EventEmitter(), {
      postMessage() {},
      async terminate() {
        if (++attempts === 1) {
          started!();
          await new Promise<void>(resolve => { release = resolve; });
          throw new Error("termination refused");
        }
        worker.emit("error", new Error("error while retrying termination"));
        return 0;
      },
    });
    const factory: PolicyWorkerFactory = Object.assign(() => worker, { workspaceOverheadBytes: 0 });
    const inspector = new ProgramPolicyInspector(factory, limits);
    const pending = inspector.inspect(request, { timeoutMs: 10_000 });
    worker.emit("message", { kind: "inspection", record: new Uint8Array(160) });
    await terminationStarted;
    expect(worker.listenerCount("error")).toBe(1);
    worker.emit("error", new Error("queued error during termination"));
    release!();
    await expect(pending).rejects.toMatchObject({ reason: "retirement" });
    worker.emit("error", new Error("error while awaiting a retirement retry"));
    expect(inspector.active.jobs).toBe(1);
    await inspector.drainRetirements();
    expect(worker.listenerCount("error")).toBe(0);
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
  });

  it("retires timeout and rejects oversized result backing", async () => {
    const worker = new MockWorkerHandle();
    const factory: PolicyWorkerFactory = Object.assign(() => worker, { workspaceOverheadBytes: 0 });
    const inspector = new ProgramPolicyInspector(factory, limits);
    await expect(inspector.inspect(request, { timeoutMs: 1 })).rejects.toMatchObject({ reason: "timeout" });
    const second = inspector.inspect(request, { timeoutMs: 1000 });
    worker.simulateMessage({ kind: "inspection", record: new Uint8Array(new ArrayBuffer(4096), 0, 160) });
    await expect(second).rejects.toMatchObject({ reason: "protocol" });
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
  });

  it("closes pending work before disposing its bootstrap and refuses new jobs", async () => {
    const worker = new MockWorkerHandle();
    const dispose = vi.fn();
    const factory: PolicyWorkerFactory = Object.assign(() => worker, { workspaceOverheadBytes: 0, dispose });
    const inspector = new ProgramPolicyInspector(factory, limits);
    const pending = inspector.inspect(request, { timeoutMs: 10_000 });
    await inspector.close();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
    await expect(inspector.inspect(request, { timeoutMs: 1000 })).rejects.toMatchObject({ reason: "closed" });
  });

  it("joins concurrent retirement drains without releasing admission twice", async () => {
    let complete: (() => void) | undefined;
    class RetiringWorker extends MockWorkerHandle {
      attempts = 0;
      async terminate() {
        if (++this.attempts === 1) throw new Error("termination refused");
        await new Promise<void>(resolve => { complete = resolve; });
        return 0;
      }
    }
    const worker = new RetiringWorker();
    const factory: PolicyWorkerFactory = Object.assign(() => worker, { workspaceOverheadBytes: 0 });
    const inspector = new ProgramPolicyInspector(factory, limits);
    const controller = new AbortController();
    const pending = inspector.inspect(request, { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "retirement" });
    const first = inspector.drainRetirements();
    const second = inspector.drainRetirements();
    expect(worker.attempts).toBe(2);
    expect(inspector.active.jobs).toBe(1);
    complete!();
    await Promise.all([first, second]);
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
  });

  it("releases admission after independent source-copy allocation fails", async () => {
    const inspector = new ProgramPolicyInspector(createNodePolicyWorker, limits);
    const copy = vi.spyOn(ArrayBuffer.prototype, "slice").mockImplementationOnce(() => { throw new RangeError("copy refused"); });
    const pending = inspector.inspect(request, { timeoutMs: 1000 });
    copy.mockRestore();
    await expect(pending).rejects.toMatchObject({ reason: "allocation" });
    expect(inspector.active).toEqual({ jobs: 0, workspace: 0 });
  });
});
