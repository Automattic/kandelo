import ImageCodecWorker from "./persistent-image-codec-worker.ts?worker";
import { ERRNO } from "../../../../../host/src/generated/abi";
import { referenceOpfsFile } from "../../../../../host/src/vfs/opfs-file-reference";
import type { PersistentImageIntegrityPolicy, PersistentImageWriteResult } from "../../../../../images/vfs/lib/kandelo-image-fs";
import type { ImageCodecMemoryUsage, ImageCodecProgress, ImageCodecRequest, ImageCodecResponse } from "./persistent-image-codec-protocol";

export const MAX_IMAGE_CODEC_MODULE_BYTES = 16 * 1024 * 1024;
const EMPTY_CODEC_BYTES = new Uint8Array();

export interface ImageCodecOptions {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onProgress?: (progress: ImageCodecProgress) => void | Promise<void>;
  onMemoryUsage?: (usage: ImageCodecMemoryUsage & { callerInputChunkPeak: number; callerInputBackingPeak: number }) => void;
}

export class UnprovenImageCodecCleanupError extends Error {
  readonly retainTarget = true;
  constructor(cause: unknown) {
    super("Persistent image worker cleanup is unproven; retain its staged target", { cause });
    this.name = "UnprovenImageCodecCleanupError";
  }
}

type Result = Extract<ImageCodecResponse, { type: "done" | "inspected" | "controlled" | "staged" }>;
type Job = Extract<ImageCodecRequest, { type: "write" | "inspect" | "control" | "stage" }>;

function snapshotCodecModule(bytes: Uint8Array): Uint8Array {
  const length = bytes instanceof Uint8Array ? bytes.byteLength : 0;
  if (length === 0) {
    throw new Error("Persistent image codec module bytes are invalid");
  }
  if (length > MAX_IMAGE_CODEC_MODULE_BYTES) {
    throw Object.assign(new Error("Persistent image codec module exceeds its memory bound"), { code: "ENOMEM", errno: ERRNO.ENOMEM });
  }
  return new Uint8Array(new Uint8Array(bytes.buffer, bytes.byteOffset, length));
}

function runCodec(job: Job, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array> | undefined,
  options: ImageCodecOptions): Promise<Result> {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  const moduleBytes = snapshotCodecModule(job.moduleBytes);
  job = { ...job, moduleBytes, ...(job.type === "control" ? {
    input: new Uint8Array(new Uint8Array(job.input.buffer, job.input.byteOffset, 64)),
  } : {}) };
  const worker = new ImageCodecWorker();
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    let cancellationReason: unknown;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    let iterator: Iterator<Uint8Array> | AsyncIterator<Uint8Array> | undefined;
    let sourceComplete = false;
    let pulling = false;
    let reporting = false;
    let currentChunk: Uint8Array | undefined;
    let currentOffset = 0;
    let callerInputChunkPeak = 0;
    let callerInputBackingPeak = 0;
    let workerMemory: ImageCodecMemoryUsage | undefined;

    const post = (message: ImageCodecRequest, transfer: Transferable[] = []): void => {
      worker.postMessage(message, transfer);
    };
    const finish = (result: Result | undefined, failure?: { error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
      options.signal?.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      const retainTarget = failure?.error instanceof UnprovenImageCodecCleanupError;
      if (iterator !== undefined && !sourceComplete) {
        try {
          const cleanup = iterator.return?.();
          if (cleanup !== undefined) void Promise.resolve(cleanup).catch(error => {
            console.warn("Persistent image input cleanup failed", error);
          });
        } catch (error) {
          failure = { error: new AggregateError(failure === undefined ? [error] : [failure.error, error], "Persistent image input cleanup failed") };
        }
      }
      currentChunk = undefined;
      if (workerMemory !== undefined) {
        try { options.onMemoryUsage?.({ ...workerMemory, callerInputChunkPeak, callerInputBackingPeak }); }
        catch (error) {
          failure = { error: failure === undefined ? error
            : new AggregateError([failure.error, error], "Persistent image memory observer failed") };
        }
      }
      if (retainTarget && failure !== undefined && !(failure.error instanceof UnprovenImageCodecCleanupError)) {
        failure = { error: new UnprovenImageCodecCleanupError(failure.error) };
      }
      if (failure !== undefined) reject(failure.error);
      else if (result !== undefined) resolve(result);
      else reject(new Error("Persistent image worker produced no result"));
    };
    const cancel = (reason: unknown): void => {
      if (settled || cancelling) return;
      cancelling = true;
      cancellationReason = reason;
      cancellationTimer = setTimeout(() => {
        finish(undefined, { error: new UnprovenImageCodecCleanupError(cancellationReason) });
      }, 5000);
      try { post({ type: "cancel", message: String(reason) }); }
      catch (error) { finish(undefined, { error: new UnprovenImageCodecCleanupError(error) }); }
    };
    const abort = (): void => cancel(options.signal?.reason ?? new DOMException("Image operation aborted", "AbortError"));
    const current = (): void => {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
    };
    const pull = async (): Promise<void> => {
      if (pulling || chunks === undefined || sourceComplete) throw new Error("Unexpected persistent image input request");
      pulling = true;
      try {
        current();
        iterator ??= Symbol.asyncIterator in chunks ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
        if (currentChunk === undefined || currentOffset === currentChunk.length) {
          currentChunk = undefined;
          currentOffset = 0;
          const next = await iterator.next();
          if (settled || cancelling) return;
          current();
          if (next.done) {
            sourceComplete = true;
            currentChunk = undefined;
            post({ type: "input", bytes: null });
            return;
          }
          const length = next.value instanceof Uint8Array ? next.value.byteLength : 0;
          if (length === 0 || length > 1024 * 1024) {
            throw new Error("Persistent image input must use nonempty chunks of at most 1 MiB");
          }
          currentChunk = new Uint8Array(new Uint8Array(next.value.buffer, next.value.byteOffset, length));
          callerInputChunkPeak = Math.max(callerInputChunkPeak, currentChunk.length);
          callerInputBackingPeak = Math.max(callerInputBackingPeak, currentChunk.buffer.byteLength);
          currentOffset = 0;
        }
        const bytes = currentChunk.slice(currentOffset, currentOffset + 65536);
        currentOffset += bytes.length;
        current();
        if (settled || cancelling) return;
        post({ type: "input", bytes }, [bytes.buffer as ArrayBuffer]);
      } finally { pulling = false; }
    };
    const progress = async (message: Extract<ImageCodecResponse, { type: "progress" }>): Promise<void> => {
      if (reporting) throw new Error("Persistent image progress acknowledgement is already pending");
      reporting = true;
      try {
        current();
        await options.onProgress?.({ phase: message.phase, bytes: message.bytes, total: message.total });
        if (settled || cancelling) return;
        current();
        post({ type: "progress-ack" });
      } finally { reporting = false; }
    };
    worker.onmessage = ({ data }: MessageEvent<ImageCodecResponse>) => {
      if (settled) return;
      if (data.type === "done" || data.type === "inspected" || data.type === "controlled" || data.type === "staged" || data.type === "error") {
        let failure: { error: unknown } | undefined;
        try {
          current();
          if (data.memoryUsage !== undefined) {
            const usage = data.memoryUsage;
            if (!Number.isSafeInteger(usage.wasmPages) || usage.wasmPages <= 0 || usage.wasmPages > 65536 ||
              !Number.isSafeInteger(usage.inputWindowPeak) || usage.inputWindowPeak < 0 || usage.inputWindowPeak > 65536) {
              throw new Error("Persistent image worker returned invalid memory usage");
            }
            workerMemory = usage;
          } else if (options.onMemoryUsage !== undefined && data.type !== "error") {
            throw new Error("Persistent image worker returned no requested memory usage");
          }
        }
        catch (error) { failure = { error }; }
        if (cancelling) failure = { error: cancellationReason };
        if (data.type === "error" && failure === undefined) {
          const error = new Error(data.message) as Error & { errno?: number };
          if (Number.isInteger(data.errno) && data.errno! > 0 && data.errno! < 4096) error.errno = data.errno;
          failure = { error };
        }
        if (job.type === "stage" && data.type === "staged" && !sourceComplete && failure === undefined) {
          failure = { error: new Error("Source staging worker completed before consuming the input stream") };
        }
        if (!data.closed) {
          finish(undefined, { error: new UnprovenImageCodecCleanupError(failure?.error) });
        } else if (failure !== undefined) finish(undefined, failure);
        else if ((job.type === "write" && data.type !== "done") || (job.type === "inspect" && data.type !== "inspected")
          || (job.type === "control" && data.type !== "controlled") || (job.type === "stage" && data.type !== "staged")) {
          finish(undefined, { error: new Error("Persistent image worker replied to the wrong operation") });
        } else finish(data as Result);
        return;
      }
      if (cancelling) return;
      if (data.type === "input-needed") void pull().catch(cancel);
      else void progress(data).catch(cancel);
    };
    worker.onerror = event => {
      finish(undefined, { error: new UnprovenImageCodecCleanupError(new Error(event.message)) });
    };
    worker.onmessageerror = () => {
      finish(undefined, { error: new UnprovenImageCodecCleanupError(new Error("Persistent image worker sent an uncloneable message")) });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      current();
      post({ ...job, moduleBytes, ...(options.onMemoryUsage === undefined ? {} : { observeMemory: true }) }, [moduleBytes.buffer as ArrayBuffer,
        ...(job.type === "inspect" ? [job.prefix.buffer as ArrayBuffer] : [])]);
    } catch (error) {
      finish(undefined, { error });
    }
  });
}

export async function stageSourceImageFile(
  file: FileSystemFileHandle,
  moduleBytes: Uint8Array,
  maximumLength: number,
  chunks: AsyncIterable<Uint8Array>,
  options: ImageCodecOptions = {},
): Promise<{ length: number; imageSha256: string }> {
  if (!Number.isSafeInteger(maximumLength) || maximumLength <= 0) throw new Error("Source staging bound is invalid");
  moduleBytes = snapshotCodecModule(moduleBytes);
  const pending = runCodec({ type: "stage", file: await referenceOpfsFile(file), moduleBytes, maximumLength }, chunks, options);
  moduleBytes = EMPTY_CODEC_BYTES;
  const result = await pending;
  if (result.type !== "staged" || !Number.isSafeInteger(result.length) || result.length <= 0
    || result.length > maximumLength || !/^[0-9a-f]{64}$/.test(result.imageSha256)) {
    throw new Error("Source staging worker returned an invalid identity");
  }
  return { length: result.length, imageSha256: result.imageSha256 };
}

export async function writePersistentImageFile(
  file: FileSystemFileHandle,
  moduleBytes: Uint8Array,
  payloadLength: number,
  policy: PersistentImageIntegrityPolicy,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  options: ImageCodecOptions = {},
): Promise<PersistentImageWriteResult> {
  if (!Number.isSafeInteger(payloadLength) || payloadLength <= 0 || (policy !== "crc32c" && policy !== "sha256")) {
    throw new Error("Persistent image creation length or policy is invalid");
  }
  moduleBytes = snapshotCodecModule(moduleBytes);
  const pending = runCodec({ type: "write", file: await referenceOpfsFile(file), moduleBytes, payloadLength, policy }, chunks, options);
  moduleBytes = EMPTY_CODEC_BYTES;
  const result = await pending;
  if (result.type !== "done") throw new Error("Persistent image writer returned no identity");
  const value = result.result;
  if (value === null || typeof value !== "object" || value.payloadLength !== payloadLength || value.integrityPolicy !== policy
    || !Number.isSafeInteger(value.physicalLength) || value.physicalLength <= payloadLength
    || typeof value.identitySha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.identitySha256)) {
    throw new Error("Persistent image writer returned invalid geometry or identity");
  }
  return Object.freeze({ payloadLength, physicalLength: value.physicalLength, integrityPolicy: policy, identitySha256: value.identitySha256 });
}

export async function runPersistentImageControl(
  moduleBytes: Uint8Array,
  operation: 19 | 20,
  input: Uint8Array,
  options: ImageCodecOptions = {},
): Promise<Uint8Array | number> {
  if (input.length !== 64 || (operation !== 19 && operation !== 20)) throw new Error("Persistent image control request is invalid");
  const pending = runCodec({ type: "control", moduleBytes, operation, input }, undefined, options);
  moduleBytes = EMPTY_CODEC_BYTES;
  input = EMPTY_CODEC_BYTES;
  const result = await pending;
  if (result.type !== "controlled") throw new Error("Persistent image control returned no result");
  if (typeof result.result === "number") {
    if (!Number.isInteger(result.result) || result.result >= 0 || result.result <= -4096) throw new Error("Persistent image control returned an invalid errno");
  } else if (!(result.result instanceof Uint8Array) || result.result.length !== (operation === 19 ? 0 : 8)) {
    throw new Error("Persistent image control returned invalid transport geometry");
  }
  return result.result;
}

export async function inspectPersistentImageFile(
  file: FileSystemFileHandle,
  moduleBytes: Uint8Array,
  physicalLength: number,
  identitySha256: string,
  policy: PersistentImageIntegrityPolicy,
  options: ImageCodecOptions = {},
): Promise<{ payloadLength: number; physicalLength: number }> {
  if (!Number.isSafeInteger(physicalLength) || physicalLength <= 0 || !/^[0-9a-f]{64}$/.test(identitySha256)
    || (policy !== "crc32c" && policy !== "sha256")) throw new Error("Persistent image binding is invalid");
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  moduleBytes = snapshotCodecModule(moduleBytes);
  const snapshot = await file.getFile();
  if (snapshot.size !== physicalLength) throw Object.assign(new Error("Persistent image physical length changed"), { errno: ERRNO.EIO });
  const prefix = new Uint8Array(await snapshot.slice(0, 4096).arrayBuffer());
  const pending = runCodec({ type: "inspect", prefix, moduleBytes, physicalLength, identitySha256, policy }, undefined, options);
  moduleBytes = EMPTY_CODEC_BYTES;
  const result = await pending;
  if (result.type !== "inspected") throw new Error("Persistent image inspector returned no geometry");
  if (result.physicalLength !== physicalLength || !Number.isSafeInteger(result.payloadLength)
    || result.payloadLength <= 0 || result.payloadLength >= physicalLength) throw new Error("Persistent image inspector returned invalid geometry");
  return { payloadLength: result.payloadLength, physicalLength: result.physicalLength };
}
