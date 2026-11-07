import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { OpfsImageReader } from "../../../../host/src/vfs/opfs-image-reader";
import { readComposerFile } from "../../pages/kandelo/kernel-host/composer-file";
import { OPEN_FLAGS } from "../../../../host/src/generated/abi";

function failureOf(operation: () => unknown): { errno?: number; message: string } | null {
  try { operation(); return null; }
  catch (error) {
    return { errno: (error as { errno?: number }).errno, message: String(error) };
  }
}

self.onmessage = async (event: MessageEvent<{ imageUrl: string; moduleUrl: string; digest: string }>) => {
  let root: FileSystemDirectoryHandle | undefined;
  const name = `composer-file-${crypto.randomUUID()}`;
  let reader: OpfsImageReader | undefined;
  try {
    root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name, { create: true });
    const file = await directory.getFileHandle("source", { create: true });
    const image = await (await fetch(event.data.imageUrl)).arrayBuffer();
    const writer = await file.createWritable();
    await writer.write(image);
    await writer.close();
    reader = await OpfsImageReader.open(file, { length: image.byteLength,
      chunkBytes: 64 * 1024, imageSha256: event.data.digest });
    let largestSourceRead = 0;
    const filesystem = KandeloImageFs.createFromPositionedImage(
      new Uint8Array(await (await fetch(event.data.moduleUrl)).arrayBuffer()), reader.length,
      (offset, destination) => {
        largestSourceRead = Math.max(largestSourceRead, destination.length);
        return reader!.readAt(offset, destination);
      });
    const length = filesystem.stat("/etc/php.ini").size;
    const memoryBefore = filesystem.transientBuffer.byteLength;
    let opened = 0;
    let largestFileRead = 0;
    const open = filesystem.open.bind(filesystem);
    const read = filesystem.read.bind(filesystem);
    filesystem.open = (...args) => { opened++; return open(...args); };
    filesystem.read = (...args) => { largestFileRead = Math.max(largestFileRead, args[3] ?? 0); return read(...args); };
    let failure: { code?: string; errno?: number; message: string } | undefined;
    let outputLength: number | undefined;
    let zeroFilled: boolean | undefined;
    try {
      const output = new Uint8Array(readComposerFile(filesystem, "/etc/php.ini"));
      outputLength = output.length;
      zeroFilled = output.every(byte => byte === 0);
    } catch (error) {
      const detail = error as { code?: string; errno?: number };
      failure = { code: detail.code, errno: detail.errno, message: String(error) };
    }
    let wholeReadFailure: { code?: string; errno?: number; message: string } | undefined;
    if (length > 0xffff_ffff) {
      try {
        filesystem.readFile("/etc/php.ini");
      } catch (error) {
        const detail = error as { code?: string; errno?: number };
        wholeReadFailure = { code: detail.code, errno: detail.errno, message: String(error) };
      }
    }
    const memoryAfter = filesystem.transientBuffer.byteLength;
    let writes: Record<string, unknown> | undefined;
    if (length > 0xffff_ffff) {
      const borrowed = open("/etc/php.ini", OPEN_FLAGS.O_RDWR);
      try {
        const highFailure = failureOf(() => filesystem.write(borrowed, new Uint8Array([23]), 2 ** 32 + 1));
        const materializationFailure = failureOf(() => filesystem.write(borrowed, new Uint8Array([29]), 1));
        const bytes = new Uint8Array(2).fill(31);
        const count = read(borrowed, bytes, 0, bytes.length);
        writes = { highFailure, materializationFailure, sizeAfter: filesystem.stat("/etc/php.ini").size,
          count, bytes: [...bytes] };
      } finally { filesystem.close(borrowed); }
      const resident = open("/resident-probe", OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_RDWR, 0o4755);
      try {
        const count = filesystem.write(resident, new Uint8Array(2 * 64 * 1024).fill(41), null);
        const tail = filesystem.write(resident, new Uint8Array([43]), null);
        const bytes = new Uint8Array(1).fill(47);
        const atHighWord = read(resident, bytes, 2 ** 32, bytes.length);
        const highWriteFailure = failureOf(() => filesystem.write(resident, new Uint8Array([53]), 2 ** 32));
        Object.assign(writes!, { resident: { count, tail, atHighWord, highWriteFailure,
          bytes: [...bytes], size: filesystem.stat("/resident-probe").size,
          mode: filesystem.stat("/resident-probe").mode & 0o7777 } });
      } finally { filesystem.close(resident); }
    }
    const result = { length, memoryBefore, memoryAfter,
      opened, largestFileRead, largestSourceRead, failure, outputLength, zeroFilled, wholeReadFailure,
      writes, probeMemoryAfter: filesystem.transientBuffer.byteLength };
    reader.close();
    reader = undefined;
    await root.removeEntry(name, { recursive: true });
    self.postMessage(result);
  } catch (error) {
    reader?.close();
    await root?.removeEntry(name, { recursive: true }).catch(() => {});
    self.postMessage({ unexpected: String(error) });
  }
};
