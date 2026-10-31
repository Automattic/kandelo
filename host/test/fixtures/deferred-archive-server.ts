import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";
import type { ZipEntry } from "../../src/vfs/zip";
import type { DeferredByteServer } from "./deferred-byte-server";

export interface DeferredArchiveServer extends DeferredByteServer {
  entries: ZipEntry[];
  memberSize: number;
  memberSha256: string;
}

export async function startDeferredArchiveServer(memberSize: number, deflated: boolean): Promise<DeferredArchiveServer> {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-deferred-archive-"));
  try {
    const block = Buffer.alloc(64 * 1024, 86);
    const memberHash = createHash("sha256");
    let checksum = 0;
    const payload = join(directory, "payload");
    const body = Readable.from((async function* () {
      for (let offset = 0; offset < memberSize; offset += block.byteLength) {
        const chunk = block.subarray(0, Math.min(block.byteLength, memberSize - offset));
        memberHash.update(chunk);
        checksum = crc32(chunk, checksum);
        yield chunk;
      }
    })(), { objectMode: false });
    if (deflated) await pipeline(body, createDeflateRaw(), createWriteStream(payload));
    else await pipeline(body, createWriteStream(payload));
    const compressedSize = statSync(payload).size;
    const name = Buffer.from("large");
    const method = deflated ? 8 : 0;
    const attrs = (0o100600 << 16) >>> 0;
    const prefix = Buffer.alloc(30 + name.byteLength);
    prefix.writeUInt32LE(0x04034b50, 0);
    prefix.writeUInt16LE(20, 4);
    prefix.writeUInt16LE(method, 8);
    prefix.writeUInt32LE(checksum, 14);
    prefix.writeUInt32LE(compressedSize, 18);
    prefix.writeUInt32LE(memberSize, 22);
    prefix.writeUInt16LE(name.byteLength, 26);
    prefix.set(name, 30);
    const tail = Buffer.alloc(46 + name.byteLength + 22);
    tail.writeUInt32LE(0x02014b50, 0);
    tail.writeUInt16LE(0x0314, 4);
    tail.writeUInt16LE(20, 6);
    tail.writeUInt16LE(method, 10);
    tail.writeUInt32LE(checksum, 16);
    tail.writeUInt32LE(compressedSize, 20);
    tail.writeUInt32LE(memberSize, 24);
    tail.writeUInt16LE(name.byteLength, 28);
    tail.writeUInt32LE(attrs, 38);
    tail.set(name, 46);
    const end = 46 + name.byteLength;
    tail.writeUInt32LE(0x06054b50, end);
    tail.writeUInt16LE(1, end + 8);
    tail.writeUInt16LE(1, end + 10);
    tail.writeUInt32LE(end, end + 12);
    tail.writeUInt32LE(prefix.byteLength + compressedSize, end + 16);
    const archive = join(directory, "archive.zip");
    const archiveHash = createHash("sha256");
    await pipeline(Readable.from((async function* () {
      for (const chunk of [prefix]) { archiveHash.update(chunk); yield chunk; }
      for await (const chunk of createReadStream(payload)) { archiveHash.update(chunk); yield chunk; }
      archiveHash.update(tail);
      yield tail;
    })(), { objectMode: false }), createWriteStream(archive));
    let requests = 0;
    let notifyRequest!: () => void;
    const requested = new Promise<void>(resolve => { notifyRequest = resolve; });
    const server = createServer((request, response) => {
      if (request.url !== "/archive.zip" && !/^\/archive\.zip\?reader=[12]$/.test(request.url ?? "")) {
        response.writeHead(404).end();
        return;
      }
      requests++;
      notifyRequest();
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(statSync(archive).size),
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      });
      const stream = createReadStream(archive);
      response.once("close", () => stream.destroy());
      stream.once("error", error => response.destroy(error));
      stream.pipe(response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Deferred archive server has no port");
    let closing: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${address.port}/archive.zip`,
      size: statSync(archive).size,
      sha256: archiveHash.digest("hex"),
      memberSize,
      memberSha256: memberHash.digest("hex"),
      entries: [{
        fileName: "large", fileNameBytes: name, compressedSize, uncompressedSize: memberSize,
        compressionMethod: method, localHeaderOffset: 0, mode: 0o600,
        isDirectory: false, isSymlink: false, externalAttrs: attrs, creatorOS: 3,
      }],
      requested,
      requests: () => requests,
      firstChunkDelayMs: () => undefined,
      close: () => {
        if (closing === undefined) closing = new Promise<void>((resolve, reject) => {
          server.close(error => {
            rmSync(directory, { recursive: true, force: true });
            error ? reject(error) : resolve();
          });
          server.closeAllConnections();
        });
        return closing;
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
