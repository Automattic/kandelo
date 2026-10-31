import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";

const repository = resolve(import.meta.dirname, "../../..");
export const PRESSURE_COLD_BYTES = 96 * 1024 * 1024;
export const PRESSURE_SEED_FILES = 2048;
export const PRESSURE_SAMPLE_OFFSETS = [0, 65536 - 31, 48 * 1024 * 1024 + 37, PRESSURE_COLD_BYTES - 257];
export const pressureSeedPath = (index: number) => `/seed/${index.toString().padStart(6, "0")}-${"s".repeat(200)}`;
export const pressureColdByte = (offset: number) => {
  const salt = Math.imul(Math.floor(offset / 65536) + 1, 0x9e3779b1) >>> 0;
  return ((offset % 65536) % 251) ^ ((salt >>> ((offset % 4) * 8)) & 0xff);
};
const moduleBytes = () => new Uint8Array(readFileSync(join(repository, "local-binaries/kandelo_image_module_positioned32.wasm")));

function closePressureFixture(cleanups: Array<() => void>, primaryFailure?: { error: unknown }): void {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throw Object.assign(new AggregateError(primaryFailure === undefined ? failures : [primaryFailure.error, ...failures],
      "Pressure fixture cleanup is unproven; retain its files"), { retainTarget: true });
  }
}

export function retainPressureFixture(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { retainTarget?: boolean }).retainTarget === true;
}

export async function checkedPressureImage(directory: string, policy: "crc32c" | "sha256") {
  const filesystem = KandeloImageFs.createPositioned(moduleBytes());
  let target: OverlayStorageFile | undefined;
  let primaryFailure: { error: unknown } | undefined;
  try {
    target = OverlayStorageFile.open(new HostFileSystem(directory), "/base.img");
    filesystem.setImageCapacity(512 * 1024 * 1024);
    filesystem.setExportTimestamp(0);
    filesystem.mkdir("/bin", 0o755);
    filesystem.mkdir("/seed", 0o750);
    filesystem.writeFile("/bin/pressure", readFileSync(join(repository,
      "local-binaries/test-fixtures/wasm32/persistence-aggregate-pressure.wasm")), 0o755);
    for (let index = 0; index < PRESSURE_SEED_FILES; index++) {
      filesystem.writeFile(pressureSeedPath(index), new Uint8Array(0), 0o640);
    }
    const chunk = new Uint8Array(65536);
    for (let offset = 0; offset < PRESSURE_COLD_BYTES; offset += chunk.length) {
      for (let index = 0; index < chunk.length; index++) chunk[index] = pressureColdByte(offset + index);
      if (filesystem.writeFileChunk("/cold", offset, chunk, 0o600, offset === 0) !== chunk.length) {
        throw new Error("Pressure fixture construction returned a short write");
      }
    }
    const result = await filesystem.exportPersistentImageTo(target, policy);
    return { ...result, path: join(directory, "base.img"),
      binding: { identitySha256: result.identitySha256, dataCachePages: 2, indexCachePages: 2 } };
  } catch (error) { primaryFailure = { error }; throw error; }
  finally { closePressureFixture([() => filesystem.reset(), () => target?.close()], primaryFailure); }
}

export async function checkPressureSnapshot(directory: string, policy: "crc32c" | "sha256") {
  const backend = new HostFileSystem(directory);
  const source = OverlayStorageFile.open(backend, "/snapshot.vfs", false);
  let filesystem: KandeloImageFs | undefined;
  let target: OverlayStorageFile | undefined;
  let primaryFailure: { error: unknown } | undefined;
  try {
    filesystem = KandeloImageFs.createFromPositionedImage(moduleBytes(), source.len(), (offset, destination) => {
      source.readExactAt(offset, destination);
      return destination.length;
    });
    target = OverlayStorageFile.open(backend, "/snapshot.img");
    const result = await filesystem.exportPersistentImageTo(target, policy);
    return { ...result, path: join(directory, "snapshot.img"),
      binding: { identitySha256: result.identitySha256, dataCachePages: 2, indexCachePages: 2 } };
  } catch (error) { primaryFailure = { error }; throw error; }
  finally { closePressureFixture([() => filesystem?.reset(), () => target?.close(), () => source.close()], primaryFailure); }
}

export async function servePressureImage(filename: string) {
  const server = createServer((request, response) => {
    if (request.url !== "/base.img") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/octet-stream",
      "Content-Length": statSync(filename).size, "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin" });
    const stream = createReadStream(filename, { highWaterMark: 65536 });
    stream.on("error", error => response.destroy(error));
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Pressure image server has no TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/base.img`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}
