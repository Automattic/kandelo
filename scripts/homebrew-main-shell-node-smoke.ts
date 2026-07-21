#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import { assertMainShellImageContract } from "./homebrew-main-shell-image-contract";
import { KANDELO_DEMO_CONFIG_PATH } from "../web-libs/kandelo-session/src/demo-config";
import {
  KANDELO_SHELL_CONFIG_PATH,
  parseKandeloShellConfig,
} from "../web-libs/kandelo-session/src/shell-config";
import {
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../web-libs/kandelo-session/src/vfs-capacity";

const { imagePath, migrationLockPath, demoConfigPath } = parseArgs(process.argv.slice(2));
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
const migrationLock = parseJson(migrationLockBytes, migrationLockPath);
const demoConfigSource = readVfsFile(fs, KANDELO_DEMO_CONFIG_PATH);
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
  migrationLock,
  migrationLockSha256: createHash("sha256").update(migrationLockBytes).digest("hex"),
  migrationLockBytes: migrationLockBytes.byteLength,
  guestManifest,
  imageMetadata: metadata,
  imageCapacity: capacity,
  shellConfig,
  demoConfigSource,
  expectedDemoConfigSource: new Uint8Array(readFileSync(demoConfigPath)),
  runtimeState: readRuntimeState(fs, migrationLock),
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
  const command = `
set -eu
/usr/bin/env /bin/dash -c 'test -x /bin/bash && test -x /usr/bin/sh && test -x /usr/bin/env && printf "homebrew-posix-paths-ok\\n"'
/bin/bash -c 'test -x /bin/dash && printf "homebrew-bash-path-ok\\n"'
/bin/bash -lc 'set -eu
test "$USER" = player
printf "homebrew-profile-user-ok\\n"
test "$NETHACKOPTIONS" = "windowtype:curses,color,lit_corridor,hilite_pet"
printf "homebrew-profile-nethack-options-ok\\n"
alias ls >/dev/null
alias grep >/dev/null
printf "homebrew-profile-aliases-ok\\n"
test "$(git config --get user.name)" = User
printf "homebrew-profile-git-config-ok\\n"
printf "homebrew-profile-state-ok\\n"'
printf 'device-null-check' >/dev/null
printf 'homebrew-dev-null-ok\\n'
printf '' >>/home/.nethack/record
score_output="$(nethack -s all 2>&1)"
case "$score_output" in
  *"Cannot open record file"*) printf '%s\\n' "$score_output" >&2; exit 1 ;;
esac
printf 'homebrew-nethack-state-ok\\n'
`.trim();
  const exitPromise = host.spawn(toArrayBuffer(shellBytes), ["/bin/sh", "-c", command], {
    env: [
      "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
      "HOME=/home/user",
      "USER=user",
      "TMPDIR=/tmp",
    ],
    cwd: "/home/user",
    uid: 1000,
    gid: 1000,
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
  for (const marker of [
    "homebrew-posix-paths-ok",
    "homebrew-bash-path-ok",
    "homebrew-profile-state-ok",
    "homebrew-dev-null-ok",
    "homebrew-nethack-state-ok",
  ]) {
    if (!stdout.includes(marker)) {
      throw new Error(
        `Homebrew /bin/sh smoke did not emit ${marker}; stdout=${JSON.stringify(stdout)}`,
      );
    }
  }
  console.log(
    "Homebrew main-shell Node smoke: exact 32-root/38-Formula archive, image-owned " +
      "metadata/runtime state, /dev/null, and NetHack score paths passed.",
  );
} finally {
  if (timeout !== undefined) clearTimeout(timeout);
  await host.destroy().catch(() => {});
}

function parseArgs(args: string[]): {
  imagePath: string;
  migrationLockPath: string;
  demoConfigPath: string;
} {
  if (
    args.length !== 6 || args[0] !== "--image" || !args[1] ||
    args[2] !== "--migration-lock" || !args[3] ||
    args[4] !== "--demo-config" || !args[5]
  ) {
    throw new Error(
      "usage: npx tsx scripts/homebrew-main-shell-node-smoke.ts " +
        "--image <main-shell.vfs.zst> --migration-lock <main-shell-migration-lock.json> " +
        "--demo-config <main-shell-demo.json>",
    );
  }
  return {
    imagePath: resolve(args[1]),
    migrationLockPath: resolve(args[3]),
    demoConfigPath: resolve(args[5]),
  };
}

function readRuntimeState(
  fs: MemoryFileSystem,
  migrationLock: unknown,
): Array<{
  path: string;
  kind: "directory" | "empty_file" | "text_file";
  mode: number;
  uid: number;
  gid: number;
  contents?: Uint8Array;
}> {
  const lock = migrationLock as {
    compatibility?: { runtime_state?: Array<{ path?: unknown; kind?: unknown }> };
  };
  const declarations = lock.compatibility?.runtime_state;
  if (!Array.isArray(declarations)) {
    throw new Error("migration lock does not declare runtime_state");
  }
  return declarations.map((declaration, index) => {
    if (
      typeof declaration.path !== "string" ||
      (declaration.kind !== "directory" &&
        declaration.kind !== "empty_file" &&
        declaration.kind !== "text_file")
    ) {
      throw new Error(`migration lock runtime_state[${index}] is invalid`);
    }
    const stat = fs.lstat(declaration.path);
    const actualKind = (stat.mode & 0xf000) === 0x4000
      ? "directory"
      : (stat.mode & 0xf000) === 0x8000
      ? declaration.kind === "text_file" ? "text_file" : "empty_file"
      : "unsupported";
    if (actualKind === "unsupported") {
      throw new Error(`${declaration.path} is not a regular file or directory`);
    }
    return {
      path: declaration.path,
      kind: actualKind,
      mode: stat.mode & 0o7777,
      uid: stat.uid,
      gid: stat.gid,
      ...(actualKind === "directory" ? {} : {
        contents: readVfsFile(fs, declaration.path, stat.size),
      }),
    };
  });
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
