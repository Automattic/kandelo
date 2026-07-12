import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";

self.onmessage = async ({ data }: MessageEvent<{
  assetUrl: string;
  expectedBytes: number;
}>) => {
  try {
    const source = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    source.registerLazyFile("/usr/bin/tool", data.assetUrl, data.expectedBytes, 0o755);
    const fs = MemoryFileSystem.fromImage(await source.saveImage());
    const events: Array<{ status: string }> = [];
    fs.subscribeLazyDownloads((event) => events.push(event));

    let firstError = "";
    try {
      await fs.ensureMaterialized("/usr/bin/tool");
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }

    const retained = fs.getLazyEntry("/usr/bin/tool");
    const stubFd = fs.open("/usr/bin/tool", 0, 0);
    const stubBytes = new Uint8Array(data.expectedBytes);
    const stubRead = fs.read(stubFd, stubBytes, null, stubBytes.byteLength);
    fs.close(stubFd);

    const retried = await fs.ensureMaterialized("/usr/bin/tool");
    const fd = fs.open("/usr/bin/tool", 0, 0);
    const bytes = new Uint8Array(data.expectedBytes);
    const bytesRead = fs.read(fd, bytes, null, bytes.byteLength);
    fs.close(fd);

    self.postMessage({
      firstError,
      retained,
      stubRead,
      retried,
      bytesRead,
      bytes: Array.from(bytes),
      remainingEntry: fs.getLazyEntry("/usr/bin/tool"),
      statuses: events.map((event) => event.status),
    });
  } catch (error) {
    self.postMessage({
      fatalError: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
