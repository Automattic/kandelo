import { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { OpfsOverlayStorageFile } from "../../../../../host/src/vfs/overlay-storage";
import { ERRNO } from "../../../../../host/src/generated/abi";
import { openOpfsFileReference } from "../../../../../host/src/vfs/opfs-file-reference";
import { StorageCloseLedger } from "../../../../../host/src/storage-close-ledger";
import { createStorageHasher } from "../../../../../host/src/vfs/overlay-seal-codec";
import type { ImageCodecProgress, ImageCodecRequest, ImageCodecResponse } from "./persistent-image-codec-protocol";

const controller = new AbortController();
let started = false;
let finished = false;
let receiveInput: ((bytes: Uint8Array | null) => void) | undefined;
let acknowledgeProgress: (() => void) | undefined;
let inputWindowPeak = 0;

function post(message: ImageCodecResponse): void {
  (self as unknown as Worker).postMessage(message);
}

function cancel(message: string): void {
  controller.abort(new DOMException(message, "AbortError"));
  const input = receiveInput;
  const progress = acknowledgeProgress;
  receiveInput = undefined;
  acknowledgeProgress = undefined;
  input?.(null);
  progress?.();
}

async function* inputChunks(): AsyncGenerator<Uint8Array> {
  for (;;) {
    controller.signal.throwIfAborted();
    const pending = new Promise<Uint8Array | null>(resolve => { receiveInput = resolve; });
    post({ type: "input-needed" });
    const bytes = await pending;
    controller.signal.throwIfAborted();
    if (bytes === null) return;
    const length = bytes instanceof Uint8Array ? bytes.byteLength : 0;
    if (length === 0 || length > 65536 || !(bytes.buffer instanceof ArrayBuffer)) {
      throw new Error("Persistent image worker received an invalid input window");
    }
    inputWindowPeak = Math.max(inputWindowPeak, length);
    yield new Uint8Array(bytes.buffer, bytes.byteOffset, length);
  }
}

function errnoFor(error: unknown, depth = 0): number | undefined {
  const native = (error as { errno?: unknown } | null)?.errno;
  if (typeof native === "number" && Number.isInteger(native) && native > 0 && native < 4096) return native;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && Object.hasOwn(ERRNO, code)) return (ERRNO as Record<string, number>)[code];
  if ((error as { name?: unknown } | null)?.name === "QuotaExceededError") return ERRNO.ENOSPC;
  if (depth < 8 && error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length === 1) {
    return errnoFor(error.errors[0], depth + 1);
  }
  return undefined;
}

async function run(job: Extract<ImageCodecRequest, { type: "write" | "inspect" | "control" | "stage" }>): Promise<void> {
  let target: OpfsOverlayStorageFile | undefined;
  const storage = new StorageCloseLedger();
  let closed = false;
  let reply: ImageCodecResponse;
  let filesystem: KandeloImageFs | undefined;
  let memoryPages: number | undefined;
  try {
    controller.signal.throwIfAborted();
    if (job.type === "control") {
      if (!(job.input instanceof Uint8Array) || job.input.length !== 64 || (job.operation !== 19 && job.operation !== 20)) {
        throw new Error("Persistent image control request is invalid");
      }
      filesystem = KandeloImageFs.createPositioned(job.moduleBytes);
      const result = filesystem.overlayActivationCodecCall(job.operation, job.input);
      controller.signal.throwIfAborted();
      reply = { type: "controlled", result, closed: true };
    } else if (job.type === "inspect") {
      if (!(job.prefix instanceof Uint8Array) || job.prefix.length > 4096) throw new Error("Persistent image header probe is invalid");
      const inspected = KandeloImageFs.inspectPersistentImageState(job.moduleBytes, job.physicalLength,
        (offset, destination) => {
          const bytes = job.prefix.subarray(offset, offset + destination.length);
          destination.set(bytes);
          return bytes.length;
        }, job.identitySha256, job.policy);
      const payloadLength = inspected.payloadLength;
      memoryPages = inspected.memoryPages;
      controller.signal.throwIfAborted();
      reply = { type: "inspected", payloadLength, physicalLength: job.physicalLength, closed: true };
    } else if (job.type === "stage") {
      if (!Number.isSafeInteger(job.maximumLength) || job.maximumLength <= 0) throw new Error("Source staging bound is invalid");
      filesystem = KandeloImageFs.createPositioned(job.moduleBytes);
      const hasher = createStorageHasher((operation, bytes) => filesystem!.overlayActivationCodecCall(operation, bytes));
      target = await storage.run(async () => OpfsOverlayStorageFile.openHandle(await openOpfsFileReference(job.file), storage));
      controller.signal.throwIfAborted();
      target.truncate(0);
      let length = 0;
      for await (const bytes of inputChunks()) {
        if (bytes.length > job.maximumLength - length) throw new Error("Source image exceeds its staged byte bound");
        hasher.update(bytes);
        target.writeAllAt(length, bytes);
        length += bytes.length;
      }
      if (length === 0) throw new Error("Source image is empty");
      target.truncate(length);
      target.flush();
      controller.signal.throwIfAborted();
      const imageSha256 = Array.from(hasher.finish(), byte => byte.toString(16).padStart(2, "0")).join("");
      reply = { type: "staged", length, imageSha256, closed: true };
    } else {
      filesystem = KandeloImageFs.createPositioned(job.moduleBytes);
      target = await storage.run(async () => OpfsOverlayStorageFile.openHandle(await openOpfsFileReference(job.file), storage));
      controller.signal.throwIfAborted();
      let lastPhase: ImageCodecProgress["phase"] | undefined;
      let lastBytes = 0;
      const result = await filesystem.writePersistentImageTo(target, job.payloadLength, job.policy, inputChunks(), {
        signal: controller.signal,
        onProgress: progress => {
          if (progress.phase === lastPhase && progress.bytes !== progress.total && progress.bytes - lastBytes < 1024 * 1024) return;
          lastPhase = progress.phase;
          lastBytes = progress.bytes;
          const pending = new Promise<void>(resolve => { acknowledgeProgress = resolve; });
          post({ type: "progress", ...progress });
          return pending;
        },
      });
      controller.signal.throwIfAborted();
      reply = { type: "done", result, closed: true };
    }
  } catch (error) {
    reply = { type: "error", message: String(error), errno: errnoFor(error), closed: false };
  }
  try {
    await storage.beginRetirement();
    storage.closeAll();
    closed = true;
  } catch (error) {
    reply = { type: "error", message: `${reply.type === "error" ? `${reply.message}; ` : ""}Persistent image handle close failed: ${error}`,
      errno: (reply.type === "error" ? reply.errno : undefined) ?? errnoFor(error), closed: false };
    closed = false;
  }
  try {
    if (job.observeMemory) {
      memoryPages ??= filesystem?.getMemoryPages();
      if (memoryPages !== undefined) reply = { ...reply, memoryUsage: { wasmPages: memoryPages, inputWindowPeak } };
    }
  } catch (error) {
    reply = { type: "error", closed, errno: reply.type === "error" ? reply.errno : errnoFor(error),
      message: `${reply.type === "error" ? `${reply.message}; ` : ""}Image memory observation failed: ${error}` };
  }
  finished = true;
  if (reply.type === "error") post({ ...reply, closed });
  else if (!closed) post({ type: "error", message: "Persistent image handle closure is unproven", closed: false });
  else post(reply);
}

self.onmessage = ({ data }: MessageEvent<ImageCodecRequest>) => {
  if (finished) return;
  if (data.type === "cancel") { cancel(data.message); return; }
  if (data.type === "input") {
    const receiver = receiveInput;
    receiveInput = undefined;
    if (receiver === undefined) cancel("Unexpected persistent image input");
    else receiver(data.bytes);
    return;
  }
  if (data.type === "progress-ack") {
    const receiver = acknowledgeProgress;
    acknowledgeProgress = undefined;
    if (receiver === undefined) cancel("Unexpected persistent image progress acknowledgement");
    else receiver();
    return;
  }
  if (started) { cancel("Persistent image worker received a second job"); return; }
  started = true;
  void run(data).catch(error => {
    finished = true;
    post({ type: "error", message: `Persistent image worker failed: ${error}`, closed: false });
  });
};
