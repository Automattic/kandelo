/**
 * Worker entry for VFS image composition.
 *
 * The staging image writer's Wasm memory lives and dies inside this realm.
 * The main thread aborts a composition by terminating the worker, which is the
 * only mechanism that reclaims that memory deterministically on WebKit — see
 * `image-composer.ts` for why that matters.
 */

import {
  composeKandeloImage,
  type ComposeImageJob,
} from "./image-composer";
import type {
  ComposerToMainMessage,
  MainToComposerMessage,
} from "./image-composer-protocol";

function post(message: ComposerToMainMessage, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
}

let continuePersistent: (() => void) | undefined;

self.onmessage = (event: MessageEvent<MainToComposerMessage>) => {
  if ("type" in event.data) {
    const resume = continuePersistent;
    continuePersistent = undefined;
    resume?.();
    return;
  }
  const job = event.data.job as ComposeImageJob;
  const awaitMain = () => new Promise<void>((resolve) => { continuePersistent = resolve; });
  void composeKandeloImage(
    job,
    (message) => post({ type: "tick", message }),
    async (chunks, composition) => {
      post({ type: "persistent-start", composition });
      for (const bytes of chunks) {
        post({ type: "persistent-chunk", bytes }, [bytes.buffer as ArrayBuffer]);
        await awaitMain();
      }
      post({ type: "persistent-end" });
      await awaitMain();
    },
  )
    .then((result) => {
      post(
        { type: "done", ...result },
        // Hand the bytes over rather than copying them: the main thread is
        // only a courier between this realm and the kernel worker.
        [result.imageBytes.buffer as ArrayBuffer],
      );
    })
    .catch((err: unknown) => {
      // WHY serialize here: an Error does not survive structured cloning with
      // its stack intact across every engine, and a composition failure is
      // the boot's user-visible failure.
      post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
};
