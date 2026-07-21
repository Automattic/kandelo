#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import { assertMainShellImageContract } from "./homebrew-main-shell-image-contract";
import {
  KANDELO_SHELL_CONFIG_PATH,
  parseKandeloShellConfig,
} from "../web-libs/kandelo-session/src/shell-config";
import {
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../web-libs/kandelo-session/src/vfs-capacity";

const { imagePath, migrationLockPath } = parseArgs(process.argv.slice(2));
const imageBytes = new Uint8Array(readFileSync(imagePath));
const metadata = MemoryFileSystem.readImageMetadata(imageBytes);
const capacity = MemoryFileSystem.readImageCapacity(imageBytes);
assertVfsImageFitsProfile(
  capacity,
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  declaredVfsMaxByteLength(metadata),
  imagePath,
);

const fs = MemoryFileSystem.fromImage(imageBytes, {
  maxByteLength: MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
});
const migrationLockBytes = new Uint8Array(readFileSync(migrationLockPath));
const guestManifest = parseJson(
  readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json"),
  "/etc/kandelo/homebrew-vfs.json",
);
const shellConfig = parseKandeloShellConfig(
  new TextDecoder("utf-8", { fatal: true }).decode(readVfsFile(fs, KANDELO_SHELL_CONFIG_PATH)),
);
if (shellConfig === null) {
  throw new Error(`${KANDELO_SHELL_CONFIG_PATH} has an unsupported schema`);
}
assertMainShellImageContract({
  migrationLock: parseJson(migrationLockBytes, migrationLockPath),
  migrationLockSha256: createHash("sha256").update(migrationLockBytes).digest("hex"),
  migrationLockBytes: migrationLockBytes.byteLength,
  guestManifest,
  imageMetadata: metadata,
  imageCapacity: capacity,
  shellConfig,
});
const shellBytes = readVfsBinary(fs, "/bin/sh");
let stdout = "";
let stderr = "";
const host = new NodeKernelHost({
  maxWorkers: 8,
  rootfsImage: imageBytes,
  onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
  onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
});

await host.init();
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  const command = [
    "/usr/bin/env /bin/dash -c 'test -x /bin/bash && test -x /usr/bin/sh && test -x /usr/bin/env && printf \"homebrew-posix-paths-ok\\n\"'",
    "/bin/bash -c 'test -x /bin/dash && printf \"homebrew-bash-path-ok\\n\"'",
  ].join(" && ");
  const exitPromise = host.spawn(toArrayBuffer(shellBytes), ["/bin/sh", "-c", command], {
    env: [
      "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
      "HOME=/home/user",
      "USER=user",
      "TMPDIR=/tmp",
    ],
    cwd: "/home/user",
    stdin: new Uint8Array(),
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Homebrew main-shell Node smoke timed out after 120 seconds")),
      120_000,
    );
  });
  const exitCode = await Promise.race([exitPromise, timeoutPromise]);
  if (exitCode !== 0) {
    throw new Error(
      `Homebrew /bin/sh smoke exited ${exitCode}; ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  for (const marker of ["homebrew-posix-paths-ok", "homebrew-bash-path-ok"]) {
    if (!stdout.includes(marker)) {
      throw new Error(
        `Homebrew /bin/sh smoke did not emit ${marker}; stdout=${JSON.stringify(stdout)}`,
      );
    }
  }
  console.log(
    "Homebrew main-shell Node smoke: exact 32-root/38-Formula archive contract and " +
      "/bin/sh paths passed.",
  );
} finally {
  if (timeout !== undefined) clearTimeout(timeout);
  await host.destroy().catch(() => {});
}

function parseArgs(args: string[]): { imagePath: string; migrationLockPath: string } {
  if (
    args.length !== 4 || args[0] !== "--image" || !args[1] ||
    args[2] !== "--migration-lock" || !args[3]
  ) {
    throw new Error(
      "usage: npx tsx scripts/homebrew-main-shell-node-smoke.ts " +
        "--image <main-shell.vfs.zst> --migration-lock <main-shell-migration-lock.json>",
    );
  }
  return { imagePath: resolve(args[1]), migrationLockPath: resolve(args[3]) };
}

function readVfsBinary(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & 0xf000) !== 0x8000 || (stat.mode & 0o111) === 0) {
    throw new Error(`${path} is not an executable regular file`);
  }
  return readVfsFile(fs, path, stat.size);
}

function readVfsFile(fs: MemoryFileSystem, path: string, knownSize?: number): Uint8Array {
  const stat = knownSize === undefined ? fs.stat(path) : undefined;
  const size = knownSize ?? stat!.size;
  if (stat !== undefined && (stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`${path} is not a regular file`);
  }
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(size);
    fs.read(fd, bytes, null, bytes.length);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
