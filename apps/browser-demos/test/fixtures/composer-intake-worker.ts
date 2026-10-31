import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { stageConfiguredAssets } from "../../pages/kandelo/kernel-host/configured-assets";

self.onmessage = async (event: MessageEvent<{ moduleUrl: string; assetUrl: string; digest: string; scenario: string }>) => {
  try {
    const { moduleUrl, assetUrl, digest, scenario } = event.data;
    const filesystem = KandeloImageFs.create(new Uint8Array(await (await fetch(moduleUrl)).arrayBuffer()));
    filesystem.setImageCapacity(128 * 1024 * 1024);
    const fetchResponse = globalThis.fetch;
    let response: Response | undefined;
    let eagerReads = 0;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      response = await fetchResponse(...args);
      response.arrayBuffer = async () => { eagerReads++; throw new Error("Whole asset response reads are forbidden"); };
      return response;
    };
    let largestWrite = 0;
    let writes = 0;
    const writeChunk = filesystem.writeFileChunk.bind(filesystem);
    filesystem.writeFileChunk = (path, offset, contents, mode, truncate) => {
      largestWrite = Math.max(largestWrite, contents.length);
      writes++;
      return writeChunk(path, offset, contents, mode, truncate);
    };
    let checks = 0;
    let failure: { message: string; errno?: number } | undefined;
    try {
      await stageConfiguredAssets(filesystem, [{ path: "/assets/payload", url: assetUrl,
        sha256: scenario === "checksum" ? "0".repeat(64) : digest, mode: 0o640 }], () => {}, () => {
        if (scenario === "cancel" && ++checks >= 3) throw new Error("Composition was cancelled");
      });
    } catch (error) {
      failure = { message: String(error), errno: (error as { errno?: number }).errno };
    }
    let length: number | undefined;
    let validBytes = true;
    let exportedBytes = 0;
    if (failure === undefined) {
      length = filesystem.stat("/assets/payload").size;
      const descriptor = filesystem.open("/assets/payload");
      try {
        const scratch = new Uint8Array(64 * 1024);
        for (;;) {
          const count = filesystem.read(descriptor, scratch, null, scratch.length);
          if (count === 0) break;
          validBytes &&= scratch.subarray(0, count).every(byte => byte === 90);
        }
      } finally { filesystem.close(descriptor); }
      for (const chunk of filesystem.exportImageChunks(64 * 1024)) exportedBytes += chunk.length;
    }
    self.postMessage({ length, validBytes, exportedBytes, writes, largestWrite, eagerReads, failure,
      declaredLength: response?.headers.get("content-length"), bodyLocked: response?.body?.locked ?? false });
  } catch (error) { self.postMessage({ unexpected: String(error) }); }
};
