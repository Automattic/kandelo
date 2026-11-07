import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { OpfsOverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";
import { OpfsImageReader } from "../../../../host/src/vfs/opfs-image-reader";

interface Job {
  file: FileSystemFileHandle;
  cancelFile: FileSystemFileHandle;
  moduleBytes: ArrayBuffer;
  policy: "crc32c" | "sha256";
}

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Job>) => void;
  postMessage(message: unknown): void;
};
let started = false;
scope.onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  let output: OpfsOverlayStorageFile | undefined;
  let cancelledOutput: OpfsOverlayStorageFile | undefined;
  let reader: OpfsImageReader | undefined;
  let source: KandeloImageFs | undefined;
  let restored: KandeloImageFs | undefined;
  let reply: unknown;
  try {
    const moduleBytes = new Uint8Array(data.moduleBytes);
    source = KandeloImageFs.createPositioned(moduleBytes);
    cancelledOutput = await OpfsOverlayStorageFile.openHandle(data.cancelFile);
    const abortProgress = new AbortController();
    let progressCancelled = false;
    try {
      await source.writePersistentImageTo(cancelledOutput, 31, data.policy, [new Uint8Array(31)], {
        signal: abortProgress.signal,
        onProgress: () => {
          setTimeout(() => abortProgress.abort(), 0);
          return new Promise<void>(() => {});
        },
      });
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") throw error;
      progressCancelled = true;
    }
    if (!progressCancelled) throw new Error("A pending progress observer prevented image cancellation");
    cancelledOutput.truncate(0);
    const abortProducer = new AbortController();
    let producerCancelled = false;
    let producerReturned = false;
    const pendingInput: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          setTimeout(() => abortProducer.abort(), 0);
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        return: async () => { producerReturned = true; return { done: true, value: undefined }; },
      }),
    };
    try {
      await source.writePersistentImageTo(cancelledOutput, 31, data.policy, pendingInput, { signal: abortProducer.signal });
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") throw error;
      producerCancelled = true;
    }
    const abandonedHeader = new Uint8Array(128);
    cancelledOutput.readExactAt(0, abandonedHeader);
    if (!producerCancelled || !producerReturned || !abandonedHeader.every(byte => byte === 0)) {
      throw new Error("Pending input cancellation retained or completed its image target");
    }
    cancelledOutput.close();
    cancelledOutput = undefined;
    source.writeFile("/state", new TextEncoder().encode("original"), 0o640);
    source.symlink("/state", "/link");
    const content = new Uint8Array(512 * 1024 + 17);
    for (let index = 0; index < content.length; index++) content[index] = index % 251;
    source.writeFile("/large", content, 0o600);
    output = await OpfsOverlayStorageFile.openHandle(data.file);
    const phases: string[] = [];
    let written = 0;
    let verified = 0;
    const result = await source.exportPersistentImageTo(output, data.policy, {
      onProgress: progress => {
        if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
        if (progress.phase === "write") written = progress.bytes;
        else verified = progress.bytes;
      },
    });
    source.reset();
    output.close();
    output = undefined;
    reader = await OpfsImageReader.open(data.file, undefined, undefined, true);
    let startupRead = 0;
    const binding = { identitySha256: result.identitySha256, dataCachePages: 1, indexCachePages: 1 };
    restored = KandeloImageFs.createFromPositionedImage(moduleBytes, reader.length, (offset, destination) => {
      startupRead += destination.length;
      return reader!.readAt(offset, destination);
    }, binding);
    const mountedRead = startupRead;
    const value = new TextDecoder().decode(restored.readFile("/state"));
    const recovered = restored.readFile("/large");
    if (recovered.length !== content.length || !recovered.every((byte, index) => byte === content[index])) {
      throw new Error("Persistent image readback changed file contents");
    }
    reply = { result, binding, phases, written, verified, value, mountedRead, progressCancelled, producerCancelled };
  } catch (error) {
    reply = { error: String(error), stack: (error as Error)?.stack };
  } finally {
    restored?.reset();
    reader?.close();
    source?.reset();
    output?.close();
    cancelledOutput?.close();
  }
  scope.postMessage(reply);
};
