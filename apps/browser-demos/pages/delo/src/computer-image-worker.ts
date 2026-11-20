// Worker entry for writing a delo computer's disk. The image writer's Wasm
// memory lives and dies in this realm: the page terminates the worker after
// one build, which is the only way WebKit reclaims that memory
// deterministically (see pages/kandelo/kernel-host/image-composer.ts).

import { ensureImageWriterInstalled } from "../../../lib/kernel-owned-boot";
import { fetchArchiveIndex } from "./archive-index";
import { buildComputerImage } from "./computer-image";
import { fetchSourceSize } from "./source-size";
import type { ComputerImageMessage, ComputerImageRequest } from "./computer-image-protocol";

const post = (message: ComputerImageMessage, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<ComputerImageRequest>) => {
  const { plan, sources, base } = event.data;
  const source = (from: string) => {
    const url = sources[from];
    if (url === undefined) throw new Error(`${from} has no URL`);
    return url;
  };
  const read = async (from: string) => {
    const response = await fetch(source(from));
    if (!response.ok) throw new Error(`${from}: ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  void ensureImageWriterInstalled()
    .then(() => buildComputerImage(plan, { read, index: (from) => fetchArchiveIndex(source(from)), size: (from) => fetchSourceSize(source(from)) }, base))
    .then(({ image, written }) => {
      const buffer = image.buffer as ArrayBuffer;
      post({ type: "done", disk: { image: new Uint8Array(buffer), written } }, [buffer]);
    })
    .catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
