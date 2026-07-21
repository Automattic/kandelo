import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import type { ZipEntry } from "../../../../host/src/vfs/zip";

interface StandaloneRequest {
  kind: "file";
  assetUrl: string;
  expectedBytes: number;
}

interface ArchiveRequest {
  kind: "archive";
  assetUrl: string;
  compressedBytes: number;
  sha256: string;
  entries: Array<Omit<ZipEntry, "fileNameBytes"> & { fileNameBytes: number[] }>;
}

function read(fs: MemoryFileSystem, path: string, size: number): number[] {
  const fd = fs.open(path, 0, 0);
  const bytes = new Uint8Array(size);
  const count = fs.read(fd, bytes, null, bytes.byteLength);
  fs.close(fd);
  return Array.from(bytes.subarray(0, count));
}

async function testStandalone(data: StandaloneRequest) {
  const source = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  source.registerLazyFile(
    "/usr/bin/tool",
    data.assetUrl,
    data.expectedBytes,
    0o755,
  );
  const fs = MemoryFileSystem.fromImage(await source.saveImage());
  const statuses: string[] = [];
  fs.subscribeLazyDownloads((event) => statuses.push(event.status));

  let firstError = "";
  try {
    await fs.ensureMaterialized("/usr/bin/tool");
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }
  const retained = fs.getLazyEntry("/usr/bin/tool");
  const stubRead = read(fs, "/usr/bin/tool", data.expectedBytes).length;
  const retried = await fs.ensureMaterialized("/usr/bin/tool");

  return {
    firstError,
    retained,
    stubRead,
    retried,
    bytes: read(fs, "/usr/bin/tool", data.expectedBytes),
    remainingEntry: fs.getLazyEntry("/usr/bin/tool"),
    statuses,
  };
}

async function testArchive(data: ArchiveRequest) {
  const source = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  source.registerLazyArchiveFromEntries(
    data.assetUrl,
    data.entries.map((entry) => ({
      ...entry,
      fileNameBytes: new Uint8Array(entry.fileNameBytes),
    })),
    "/opt",
    undefined,
    { compressedBytes: data.compressedBytes, sha256: data.sha256 },
  );
  const fs = MemoryFileSystem.fromImage(await source.saveImage());
  const statuses: string[] = [];
  fs.subscribeLazyDownloads((event) => statuses.push(event.status));

  let firstError = "";
  try {
    await fs.ensureMaterialized("/opt/bin/tool");
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }
  const retainedGroups = fs.exportLazyArchiveEntries().length;
  const firstStubRead = read(fs, "/opt/bin/tool", 64).length;
  const secondStubRead = read(fs, "/opt/lib/runtime.dat", 64).length;
  const retried = await fs.ensureMaterialized("/opt/bin/tool");

  return {
    firstError,
    retainedGroups,
    firstStubRead,
    secondStubRead,
    retried,
    tool: new TextDecoder().decode(
      new Uint8Array(read(fs, "/opt/bin/tool", 64)),
    ),
    runtime: new TextDecoder().decode(
      new Uint8Array(read(fs, "/opt/lib/runtime.dat", 64)),
    ),
    remainingGroups: fs.exportLazyArchiveEntries().length,
    statuses,
  };
}

self.onmessage = async ({ data }: MessageEvent<StandaloneRequest | ArchiveRequest>) => {
  try {
    self.postMessage(
      data.kind === "file"
        ? await testStandalone(data)
        : await testArchive(data),
    );
  } catch (error) {
    self.postMessage({
      fatalError: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
