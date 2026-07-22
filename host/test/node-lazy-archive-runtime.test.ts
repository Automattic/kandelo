import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../src/vfs/zip";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const environmentProgram = join(
  repoRoot,
  "examples/environment_lifecycle_test.wasm",
);
const mountProbe = join(repoRoot, "examples/mount_probe_test.wasm");
const kernel = join(repoRoot, "host/wasm/kandelo-kernel.wasm");
const available = [environmentProgram, mountProbe, kernel].every(existsSync);
const TAR_BLOCK = 512;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function integrity(bytes: Uint8Array): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

describe.skipIf(!available)("Node lazy archive runtime paths", () => {
  it("executes and ordinarily opens archive-backed files through the mounted VFS", async () => {
    const temp = mkdtempSync(join(tmpdir(), "kandelo-node-lazy-"));
    const execBytes = new Uint8Array(readFileSync(environmentProgram));
    const probeBytes = new Uint8Array(readFileSync(mountProbe));
    const execTar = tarBytes([
      { path: "bin/environment-lifecycle-real", data: execBytes, mode: 0o755 },
      {
        path: "bin/environment-lifecycle",
        target: "bin/environment-lifecycle-real",
        mode: 0o755,
      },
    ]);
    const execArchive = gzipSync(execTar);
    const dataArchive = zipSync({
      "etc/lazy-runtime-data": new TextEncoder().encode("lazy-node-data"),
    });
    const execArchivePath = join(temp, "exec.tar.gz");
    const dataArchivePath = join(temp, "data.zip");
    writeFileSync(execArchivePath, execArchive);
    writeFileSync(dataArchivePath, dataArchive);

    const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
    fs.registerLazyTree({
      decoder: "homebrew-bottle-tar-gzip-v1",
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      ...integrity(execArchive),
      expandedBytes: execTar.byteLength,
      sourceEntryCount: 2,
      transports: [pathToFileURL(execArchivePath).href],
    }, [
      {
        vfsPath: "/bin/environment-lifecycle-real",
        sourcePath: "bin/environment-lifecycle-real",
        type: "file",
        mode: 0o755,
        size: execBytes.byteLength,
        inodeGroup: "environment-lifecycle",
      },
      {
        vfsPath: "/bin/environment-lifecycle",
        sourcePath: "bin/environment-lifecycle",
        type: "hardlink",
        mode: 0o755,
        size: execBytes.byteLength,
        target: "/bin/environment-lifecycle-real",
        inodeGroup: "environment-lifecycle",
      },
    ]);
    fs.registerLazyArchiveFromEntries(
      pathToFileURL(dataArchivePath).href,
      parseZipCentralDirectory(dataArchive),
      "/",
      undefined,
      integrity(dataArchive),
    );
    const image = await fs.saveImage();
    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      rootfsImage: image,
      onStdout: (_pid, bytes) => {
        stdout += new TextDecoder().decode(bytes);
      },
      onStderr: (_pid, bytes) => {
        stderr += new TextDecoder().decode(bytes);
      },
    });

    try {
      await host.init();
      expect(await host.spawn(arrayBuffer(execBytes), [
        "/bin/environment-lifecycle",
      ], {
        env: ["INITIAL=parent", "REMOVE=before-fork"],
      })).toBe(0);
      expect(stdout).toContain("EXEC_ENV_PASS");
      expect(stdout).toContain("EMPTY_ENV_PASS");
      expect(stderr).toBe("");

      stdout = "";
      expect(await host.spawn(arrayBuffer(probeBytes), [
        "mount_probe_test",
        "rootfs",
        "/etc/lazy-runtime-data",
      ])).toBe(0);
      expect(stdout).toContain("ROOTFS size=14");
      expect(stderr).toBe("");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

interface TarSpec {
  path: string;
  mode: number;
  data?: Uint8Array;
  target?: string;
}

function tarBytes(entries: readonly TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = TAR_BLOCK * 2;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const payload = new Uint8Array(Math.ceil(data.byteLength / TAR_BLOCK) * TAR_BLOCK);
    payload.set(data);
    const header = new Uint8Array(TAR_BLOCK);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.target ? "1" : "0").charCodeAt(0);
    if (entry.target) writeTarString(header, 157, 100, entry.target);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeTarString(
      header,
      148,
      8,
      `${checksum.toString(8).padStart(6, "0")}\0 `,
    );
    chunks.push(header, payload);
    total += header.byteLength + payload.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeTarString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error("test TAR field is too long");
  target.set(bytes, offset);
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeTarString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 2, "0")}\0`,
  );
}
