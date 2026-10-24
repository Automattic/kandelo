import { expect, type BrowserContext, type Page } from "@playwright/test";

interface ImageWorkerMemory {
  role: "composer" | "codec";
  operation?: string;
  createdMs: number;
  retirementRequestedMs?: number;
  moduleBytes?: number;
  transferredChunkPeak: number;
  result?: string;
  memoryUsage?: {
    wasmPages: number;
    inputWindowPeak?: number;
    sourceBytes?: number;
    frozenSourceBytes?: number;
    returnedBytes?: number;
    manifest?: { used: number; peak: number; limit: number };
  };
}

export async function observeImageWorkerMemory(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state = { records: [] as ImageWorkerMemory[], dropped: 0 };
    (window as Window & { kandeloImageMemory?: typeof state }).kandeloImageMemory = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private observation?: ImageWorkerMemory;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const role = String(url).includes("persistent-image-codec-worker") ? "codec"
          : String(url).includes("image-composer-worker") ? "composer" : undefined;
        if (role === undefined) return;
        if (state.records.length === 128) { state.dropped++; return; }
        this.observation = { role, createdMs: performance.now(), transferredChunkPeak: 0 };
        state.records.push(this.observation);
        this.addEventListener("message", event => {
          const record = this.observation!;
          const message = event.data;
          if (message?.type === "persistent-chunk" && message.bytes instanceof Uint8Array) {
            record.transferredChunkPeak = Math.max(record.transferredChunkPeak, message.bytes.byteLength);
          }
          if (["done", "inspected", "controlled", "staged", "error"].includes(message?.type)) {
            record.result = message.type;
            record.memoryUsage = message.memoryUsage;
          }
        });
      }
      override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
        const record = this.observation;
        if (record?.role === "codec" && message !== null && typeof message === "object") {
          const job = message as { type?: string; bytes?: Uint8Array; moduleBytes?: Uint8Array };
          if (job.type === "input" && job.bytes instanceof Uint8Array) {
            record.transferredChunkPeak = Math.max(record.transferredChunkPeak, job.bytes.byteLength);
          }
          if (job.type !== undefined && ["write", "inspect", "control", "stage"].includes(job.type)) {
            record.operation = job.type;
            record.moduleBytes = job.moduleBytes?.byteLength;
            message = { ...job, observeMemory: true };
          }
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
      override terminate(): void {
        super.terminate();
        if (this.observation !== undefined) this.observation.retirementRequestedMs = performance.now();
      }
    };
  });
}

export async function imageWorkerMemory(page: Page, expectComposer: boolean): Promise<ImageWorkerMemory[]> {
  const state = await page.evaluate(() => (window as Window & {
    kandeloImageMemory?: { records: ImageWorkerMemory[]; dropped: number };
  }).kandeloImageMemory);
  expect(state, "image worker observer must be installed").toBeDefined();
  expect(state!.dropped).toBe(0);
  const records = state!.records;
  if (expectComposer) expect(records.length).toBeGreaterThan(0);
  expect(records.some(record => record.role === "composer")).toBe(expectComposer);
  expect(records.some(record => record.role === "codec" && record.operation === "stage")).toBe(expectComposer);
  for (const record of records) {
    expect(record.retirementRequestedMs).toBeGreaterThanOrEqual(record.createdMs);
    expect(record.result).toBeDefined();
    expect(record.result).not.toBe("error");
    expect(record.memoryUsage, `${record.role}/${record.operation} memory must be attributed`).toBeDefined();
    expect(record.memoryUsage!.wasmPages).toBeGreaterThan(0);
    expect(record.memoryUsage!.wasmPages).toBeLessThanOrEqual(1024);
    expect(record.transferredChunkPeak).toBeLessThanOrEqual(65536);
    if (record.role === "composer") {
      expect(record.memoryUsage!.sourceBytes).toBe(0);
      expect(record.memoryUsage!.frozenSourceBytes).toBe(0);
      expect(record.memoryUsage!.returnedBytes).toBe(0);
      expect(record.memoryUsage!.manifest?.used).toBe(0);
      expect(record.memoryUsage!.manifest!.peak).toBeGreaterThan(0);
      expect(record.memoryUsage!.manifest!.peak).toBeLessThanOrEqual(record.memoryUsage!.manifest!.limit);
    } else {
      expect(record.memoryUsage!.inputWindowPeak).toBeLessThanOrEqual(65536);
    }
  }
  return records;
}
