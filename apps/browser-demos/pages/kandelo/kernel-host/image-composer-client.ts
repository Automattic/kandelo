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
  type FixedPersistenceImageHandle,
} from "./fixed-persistence-image";
import type { ComposeImageJob, ComposeImageResult } from "./image-composer";
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
        queuedChunks.push(chunk);
      }
    };
    async function* imageChunks(): AsyncIterableIterator<Uint8Array> {
      for (;;) {
        const chunk = queuedChunks.length > 0
          ? queuedChunks.shift()!
          : await new Promise<Uint8Array | null>((receive) => { receiveChunk = receive; });
        if (settled) throw options.supersededError();
        if (chunk === null) return;
        yield chunk;
        if (settled) throw options.supersededError();
        worker.postMessage({ type: "persistent-ack" } satisfies MainToComposerMessage);
      }
    }
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      enqueue(null);
      // Terminate before resolving so the staging buffer is already released
      // when the caller starts allocating the machine's own address spaces.
      worker.terminate();
      run();
    };
    worker.onmessage = (event: MessageEvent<ComposerToMainMessage>) => {
      const data = event.data;
      if (data.type === "tick") {
        if (!options.isCurrent()) {
          finish(() => reject(options.supersededError()));
          return;
        }
        options.onTick(data.message);
        return;
      }
      if (data.type === "error") {
        const err = new Error(data.message);
        if (data.stack) err.stack = data.stack;
        finish(() => reject(err));
        return;
      }
      if (!options.isCurrent()) {
        finish(() => reject(options.supersededError()));
        return;
      }
      if (data.type === "persistent-start") {
        if (job.persistentImage === undefined || stagePromise !== undefined) {
          finish(() => reject(new Error("unexpected persistent image stream")));
          return;
        }
        stagePromise = saveFixedPersistenceImageStream(
          job.persistentImage.name,
          job.persistentImage.identity,
          imageChunks(),
          job.persistentImage.lazyAssets,
          data.composition,
          () => {
            if (settled || !options.isCurrent()) throw options.supersededError();
          },
          (message) => {
            if (!options.isCurrent()) throw options.supersededError();
            options.onTick(message);
          },
        );
        void stagePromise.catch((error: unknown) => finish(() => reject(error)));
        return;
      }
      if (data.type === "persistent-chunk") {
        if (stagePromise === undefined) {
          finish(() => reject(new Error("persistent image chunk without stream")));
        } else {
          enqueue(data.bytes);
        }
        return;
      }
      if (data.type === "persistent-end") {
        if (stagePromise === undefined) {
          finish(() => reject(new Error("persistent image ended without stream")));
          return;
        }
        enqueue(null);
        void stagePromise.then((imageFile) => {
          if (settled) return;
          if (!options.isCurrent()) {
            finish(() => reject(options.supersededError()));
            return;
          }
          staged = imageFile;
          worker.postMessage({ type: "persistent-ready" } satisfies MainToComposerMessage);
        }, (error: unknown) => finish(() => reject(error)));
        return;
      }
      const { type: _type, ...result } = data;
      if (job.persistentImage !== undefined) {
        if (staged === undefined) {
          finish(() => reject(new Error("persistent image was not staged")));
          return;
        }
        result.imageFile = staged;
        finish(() => resolve(result));
      } else {
        finish(() => resolve(result));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      finish(() =>
        reject(new Error(`image composer worker error: ${event.message}`))
      );
    };
    worker.onmessageerror = () => {
      finish(() =>
        reject(new Error("image composer worker sent an uncloneable message"))
      );
    };
    const message: MainToComposerMessage = { job };
    // Transfer the fetched image rather than copying it. The caller has
    // already read everything it needs from these bytes.
    worker.postMessage(message, [
      job.imageBytes.buffer as ArrayBuffer,
      ...(job.frozenImageBytes === undefined
        ? []
        : [job.frozenImageBytes.buffer as ArrayBuffer]),
    ]);
  });
}
