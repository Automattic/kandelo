#!/usr/bin/env -S npx tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../web-libs/kandelo-session/src/vfs-capacity";

const imagePath = parseImageArg(process.argv.slice(2));
const imageBytes = new Uint8Array(readFileSync(imagePath));
const metadata = MemoryFileSystem.readImageMetadata(imageBytes);
assertVfsImageFitsProfile(
  MemoryFileSystem.readImageCapacity(imageBytes),
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  declaredVfsMaxByteLength(metadata),
  imagePath,
);

const fs = MemoryFileSystem.fromImage(imageBytes, {
  maxByteLength: MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
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
  console.log("Homebrew main-shell Node smoke: /bin/sh and representative POSIX paths passed.");
} finally {
  if (timeout !== undefined) clearTimeout(timeout);
  await host.destroy().catch(() => {});
}

function parseImageArg(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--image" || !args[1]) {
    throw new Error(
      "usage: npx tsx scripts/homebrew-main-shell-node-smoke.ts --image <main-shell.vfs.zst>",
    );
  }
  return resolve(args[1]);
}

function readVfsBinary(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & 0xf000) !== 0x8000 || (stat.mode & 0o111) === 0) {
    throw new Error(`${path} is not an executable regular file`);
  }
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    fs.read(fd, bytes, null, bytes.length);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
