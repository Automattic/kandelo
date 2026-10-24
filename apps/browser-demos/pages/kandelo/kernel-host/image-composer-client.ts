/**
 * Main-thread side of VFS image composition.
 *
 * Spawns a composer worker, forwards its progress, and always terminates it —
 * on success, on failure, and on supersession. Termination is not tidiness:
 * on WebKit it is the only way the staging `SharedArrayBuffer` is reclaimed
 * deterministically, so a composer that outlives its boot is the exact leak
 * this worker exists to prevent.
 */

import ComposerWorker from "./image-composer-worker.ts?worker";
import {
  saveFixedPersistenceImageStream,
  fixedPersistenceManifestMemoryUsage,
  type FixedPersistenceImageHandle,
} from "./fixed-persistence-image";
import type { ComposeImageJob, ComposeImageResult } from "./image-composer";
import { UnprovenImageCodecCleanupError } from "./persistent-image-codec";
import type {
  ComposerToMainMessage,
  MainToComposerMessage,
} from "./image-composer-protocol";

export interface ComposeInWorkerOptions {
  onTick: (message: string) => void;
  /**
   * Returns false once a newer boot owns the session. Checked when the worker
   * reports progress and again on completion; a superseded composition is
   * abandoned by terminating the worker.
   */
  isCurrent: () => boolean;
  /** Thrown when `isCurrent()` goes false, so callers keep their own type. */
  supersededError: () => Error;
}

/**
 * Compose `job` in a disposable worker and return its serialized image.
 *
 * The returned bytes were transferred, not copied — this realm is only a
 * courier between the composer and the kernel worker.
 */
export function composeImageInWorker(
  job: ComposeImageJob,
  options: ComposeInWorkerOptions,
): Promise<ComposeImageResult> {
  const worker = new ComposerWorker();
  return new Promise<ComposeImageResult>((resolve, reject) => {
    let settled = false;
    let finishing = false;
    let sourceClosed = job.positionedSource === undefined;
    const controller = new AbortController();
    let staged: FixedPersistenceImageHandle | undefined;
    let stagePromise: Promise<FixedPersistenceImageHandle> | undefined;
    const queuedChunks: Array<Uint8Array | null> = [];
    let receiveChunk: ((chunk: Uint8Array | null) => void) | undefined;
    const enqueue = (chunk: Uint8Array | null) => {
      if (receiveChunk !== undefined) {
        const receive = receiveChunk;
        receiveChunk = undefined;
        receive(chunk);
      } else {
        if (queuedChunks.length !== 0) throw new Error("persistent image stream exceeded its input credit");
        queuedChunks.push(chunk);
      }
    };
    async function* imageChunks(): AsyncIterableIterator<Uint8Array> {
      for (;;) {
        const chunk = queuedChunks.length > 0
          ? queuedChunks.shift()!
          : await new Promise<Uint8Array | null>((receive) => { receiveChunk = receive; });
        controller.signal.throwIfAborted();
        if (chunk === null) return;
        yield chunk;
        controller.signal.throwIfAborted();
        worker.postMessage({ type: "persistent-ack" } satisfies MainToComposerMessage);
      }
    }
    const finish = (result: ComposeImageResult) => {
      if (settled || finishing) return;
      if (!sourceClosed) throw new Error("Image composer returned no source-close proof");
      if (result.memoryUsage !== undefined) {
        const memory = result.memoryUsage;
        if (memory === null || typeof memory !== "object" ||
          ![memory.wasmPages, memory.sourceBytes, memory.frozenSourceBytes, memory.returnedBytes]
            .every(value => Number.isSafeInteger(value) && value >= 0) ||
          memory.wasmPages === 0 || memory.wasmPages > 65536 || memory.returnedBytes !== result.imageBytes.byteLength) {
          throw new Error("Image composer returned invalid memory usage");
        }
        memory.manifest = fixedPersistenceManifestMemoryUsage();
      }
      settled = true;
      worker.terminate();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled || finishing) return;
      finishing = true;
      controller.abort(error);
      queuedChunks.length = 0;
      const receive = receiveChunk;
      receiveChunk = undefined;
      receive?.(null);
      worker.terminate();
      void (async () => {
        let failure = error;
        try { await stagePromise; }
        catch (cleanup) {
          if (cleanup !== error) {
            const combined = new AggregateError([error, cleanup], `${String(error)}; image composition and storage cleanup failed`);
            failure = cleanup instanceof UnprovenImageCodecCleanupError
              ? new UnprovenImageCodecCleanupError(combined) : combined;
          }
        }
        settled = true;
        if (!sourceClosed) {
          failure = Object.assign(new Error("Image composer source cleanup is unproven; retain its staged source", { cause: failure }), { retainSource: true });
        }
        reject(failure);
      })();
    };
    worker.onmessage = (event: MessageEvent<ComposerToMainMessage>) => {
      if (settled || finishing) return;
      try {
        const data = event.data;
        if ((data.type === "done" || data.type === "error") && data.sourceClosed === true) sourceClosed = true;
        if (data.type === "tick") {
          if (!options.isCurrent()) {
            fail(options.supersededError());
            return;
          }
          options.onTick(data.message);
          return;
        }
        if (data.type === "error") {
          const err = new Error(data.message);
          if (Number.isInteger(data.errno) && data.errno! > 0 && data.errno! < 4096) Object.assign(err, { errno: data.errno });
          if (data.stack) err.stack = data.stack;
          fail(err);
          return;
        }
        if (!options.isCurrent()) {
          fail(options.supersededError());
          return;
        }
        if (data.type === "persistent-start") {
          if (job.persistentImage === undefined || stagePromise !== undefined) {
            fail(new Error("unexpected persistent image stream"));
            return;
          }
          stagePromise = saveFixedPersistenceImageStream(
            job.persistentImage.name,
            job.persistentImage.identity,
            { chunks: imageChunks(), payloadLength: data.payloadLength, integrityPolicy: job.persistentImage.integrityPolicy },
            job.persistentImage.lazyAssets,
            data.composition,
            () => {
              controller.signal.throwIfAborted();
              if (!options.isCurrent()) throw options.supersededError();
            },
            (message) => {
              if (!options.isCurrent()) throw options.supersededError();
              options.onTick(message);
            },
            job.persistentImage.journalName,
            controller.signal,
          );
          void stagePromise.catch(fail);
          return;
        }
        if (data.type === "persistent-chunk") {
          if (stagePromise === undefined) {
            fail(new Error("persistent image chunk without stream"));
          } else {
            if (!(data.bytes instanceof Uint8Array) || data.bytes.length === 0 || data.bytes.length > 65536) {
              throw new Error("persistent image stream has an invalid input window");
            }
            enqueue(data.bytes);
          }
          return;
        }
        if (data.type === "persistent-end") {
          if (stagePromise === undefined) {
            fail(new Error("persistent image ended without stream"));
            return;
          }
          enqueue(null);
          void stagePromise.then((imageFile) => {
            try {
              if (settled || finishing) return;
              if (!options.isCurrent()) {
                fail(options.supersededError());
                return;
              }
              staged = imageFile;
              worker.postMessage({ type: "persistent-ready" } satisfies MainToComposerMessage);
            }
            catch (error) { fail(error); }
          }, fail);
          return;
        }
        const { type: _type, ...result } = data;
        if (job.persistentImage !== undefined) {
          if (staged === undefined) {
            fail(new Error("persistent image was not staged"));
            return;
          }
          result.imageFile = staged;
          finish(result);
        } else {
          finish(result);
        }
      } catch (error) { fail(error); }
    };
    worker.onerror = (event: ErrorEvent) => {
      fail(new Error(`image composer worker error: ${event.message}`));
    };
    worker.onmessageerror = () => {
      fail(new Error("image composer worker sent an uncloneable message"));
    };
    const message: MainToComposerMessage = { job };
    // Transfer the fetched image rather than copying it. The caller has
    // already read everything it needs from these bytes.
    try { worker.postMessage(message, [
      job.imageBytes.buffer as ArrayBuffer,
      ...(job.frozenImageBytes === undefined
        ? []
        : [job.frozenImageBytes.buffer as ArrayBuffer]),
    ]); } catch (error) { fail(error); }
  });
}
