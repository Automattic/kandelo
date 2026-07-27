#!/usr/bin/env -S npx tsx

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { ABI_VERSION } from "../host/src/generated/abi";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../host/src/vfs/memory-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
} from "../web-libs/kandelo-session/src/demo-config";
import {
  KANDELO_SHELL_CONFIG_PATH,
  parseKandeloShellConfig,
} from "../web-libs/kandelo-session/src/shell-config";
import {
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../web-libs/kandelo-session/src/vfs-capacity";
import {
  composeSourceRootfsDemoConfig,
} from "../images/vfs/scripts/build-source-rootfs-shell-image";

const {
  imagePath,
  kernelPath,
  shellConfigPath,
  demoConfigPath,
  demoProfileOverlayPath,
} = parseArgs(process.argv.slice(2));
for (const input of [
  imagePath,
  kernelPath,
  shellConfigPath,
  demoConfigPath,
  demoProfileOverlayPath,
]) {
  const stat = lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`source-rootfs shell smoke input is not a regular file: ${input}`);
  }
}

const imageBytes = new Uint8Array(readFileSync(imagePath));
const kernelBytes = new Uint8Array(readFileSync(kernelPath));
if (!WebAssembly.validate(kernelBytes)) {
  throw new Error(`source-rootfs shell kernel is not valid Wasm: ${kernelPath}`);
}
const metadata = MemoryFileSystem.readImageMetadata(imageBytes);
const capacity = MemoryFileSystem.readImageCapacity(imageBytes);
assertVfsImageFitsProfile(
  capacity,
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  declaredVfsMaxByteLength(metadata),
  imagePath,
);
if (metadata?.kernelAbi !== ABI_VERSION) {
  throw new Error(
    `${imagePath} requires kernel ABI ${String(metadata?.kernelAbi)}, expected ${ABI_VERSION}`,
  );
}

const fs = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
// WHY: the acceptance assertions below trust deferred-tree metadata.
await fs.verifyImportedLazyAtomicGroupSeals();
const shellConfigBytes = readVfsFile(fs, KANDELO_SHELL_CONFIG_PATH);
expectExactBytes(
  shellConfigBytes,
  new Uint8Array(readFileSync(shellConfigPath)),
  KANDELO_SHELL_CONFIG_PATH,
);
const shellConfig = parseKandeloShellConfig(
  new TextDecoder("utf-8", { fatal: true }).decode(shellConfigBytes),
);
if (
  shellConfig === null ||
  shellConfig.path !== "/bin/bash" ||
  shellConfig.argv.join("\0") !== ["bash", "-l", "-i"].join("\0")
) {
  throw new Error("source-rootfs shell config does not select image-owned Bash");
}
expectExactBytes(
  readVfsFile(fs, KANDELO_DEMO_CONFIG_PATH),
  composeSourceRootfsDemoConfig(demoConfigPath, demoProfileOverlayPath),
  KANDELO_DEMO_CONFIG_PATH,
);

const binBash = fs.stat("/bin/bash");
const usrBinBash = fs.stat("/usr/bin/bash");
if (
  fs.isPathDeferred("/bin/bash") ||
  fs.isPathDeferred("/usr/bin/bash") ||
  binBash.ino !== usrBinBash.ino ||
  (binBash.mode & 0o111) === 0
) {
  throw new Error(
    "source-rootfs shell did not eagerly preserve Bash alias identity",
  );
}
if (!fs.isPathDeferred("/bin/grep")) {
  throw new Error("source-rootfs shell unexpectedly materialized unrelated grep bytes");
}

const shellBytes = readVfsFile(fs, shellConfig.path);
let stdout = "";
let stderr = "";
const lazyDownloads: LazyDownloadEvent[] = [];
const host = new NodeKernelHost({
  maxWorkers: 4,
  rootfsImage: imageBytes,
  onStdout: (_pid, data) => {
    stdout += new TextDecoder().decode(data);
  },
  onStderr: (_pid, data) => {
    stderr += new TextDecoder().decode(data);
  },
  onLazyDownload: (event) => {
    lazyDownloads.push(event);
  },
});

await host.init(toArrayBuffer(kernelBytes));
try {
  const command = [
    "set -eu",
    'test -n "$BASH_VERSION"',
    "test /bin/bash -ef /usr/bin/bash",
    "test -x /bin/grep",
    "printf 'source-rootfs-shell-node-ok:%s\\n' \"$BASH_VERSION\"",
  ].join("\n");
  const exitCode = await withTimeout(
    host.spawn(toArrayBuffer(shellBytes), [shellConfig.argv[0], "-c", command], {
      env: [
        "PATH=/usr/bin:/bin",
        "HOME=/home/user",
        "USER=user",
        "TMPDIR=/tmp",
      ],
      cwd: "/home/user",
      uid: 1000,
      gid: 1000,
      stdin: new Uint8Array(),
    }),
    120_000,
    "source-rootfs shell Node smoke",
  );
  if (
    exitCode !== 0 ||
    !stdout.includes("source-rootfs-shell-node-ok:") ||
    stderr !== ""
  ) {
    throw new Error(
      `source-rootfs Bash exited ${exitCode}; ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  if (lazyDownloads.length !== 0) {
    throw new Error(
      `image-owned Bash required lazy transport: ${JSON.stringify(lazyDownloads)}`,
    );
  }
  console.log(
    "Source-rootfs shell Node smoke: exact ABI/capacity/config, eager Bash " +
      "alias identity, and offline Bash execution passed.",
  );
} finally {
  await host.destroy().catch(() => {});
}

function parseArgs(args: string[]): {
  imagePath: string;
  kernelPath: string;
  shellConfigPath: string;
  demoConfigPath: string;
  demoProfileOverlayPath: string;
} {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--image",
    "--kernel",
    "--shell-config",
    "--demo-config",
    "--demo-profile-overlay",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !allowed.has(option) ||
      values.has(option)
    ) {
      return usage();
    }
    values.set(option, value);
  }
  const image = values.get("--image");
  const kernel = values.get("--kernel");
  const shellConfig = values.get("--shell-config");
  const demoConfig = values.get("--demo-config");
  const demoProfileOverlay = values.get("--demo-profile-overlay");
  if (
    !image ||
    !kernel ||
    !shellConfig ||
    !demoConfig ||
    !demoProfileOverlay
  ) {
    return usage();
  }
  return {
    imagePath: resolve(image),
    kernelPath: resolve(kernel),
    shellConfigPath: resolve(shellConfig),
    demoConfigPath: resolve(demoConfig),
    demoProfileOverlayPath: resolve(demoProfileOverlay),
  };
}

function usage(): never {
  throw new Error(
    "usage: npx tsx scripts/source-rootfs-shell-node-smoke.ts " +
      "--image <shell.vfs.zst> --kernel <kernel.wasm> " +
      "--shell-config <shell.json> " +
      "--demo-config <demo.json> --demo-profile-overlay <profiles.json>",
  );
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`${path} is not a regular file`);
  }
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    const count = fs.read(fd, bytes, null, bytes.byteLength);
    if (count !== bytes.byteLength) {
      throw new Error(`${path} produced ${count} bytes, expected ${bytes.byteLength}`);
    }
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function expectExactBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  if (
    actual.byteLength !== expected.byteLength ||
    !actual.every((byte, index) => byte === expected[index])
  ) {
    throw new Error(`${label} differs from its tracked source bytes`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
