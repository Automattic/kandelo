/**
 * Build a VFS layer containing the Kandelo SDK wrappers, sysroot, syscall glue,
 * and clang resource headers. Compiler executables are staged separately so
 * the SDK image can stay focused on data and scripts.
 *
 * Produces: apps/browser-demos/public/kandelo-sdk.vfs.zst
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  saveImage,
  symlink,
  writeVfsBinary,
  writeVfsFile,
} from "./vfs-image-helpers";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const OUT_FILE = process.env.KANDELO_SDK_VFS_OUT ??
  join(REPO_ROOT, "apps", "browser-demos", "public", "kandelo-sdk.vfs.zst");
const SYSROOT = process.env.WASM_POSIX_SYSROOT ?? join(REPO_ROOT, "sysroot");
const GLUE_DIR = process.env.WASM_POSIX_GLUE_DIR ?? join(REPO_ROOT, "libc", "glue");
const GLUE_OBJ_DIR = process.env.KANDELO_SDK_GLUE_OBJ_DIR ??
  join(REPO_ROOT, "packages", "registry", "kandelo-sdk", "kandelo-sdk-glue-objs");
const SDK_BIN_DIR = join(REPO_ROOT, "sdk", "kandelo", "bin");
const CONFIG_SITE = join(REPO_ROOT, "sdk", "config.site");
const KANDELO_LICENSE = join(REPO_ROOT, "LICENSE");
const KANDELO_RUNTIME_LICENSE = join(REPO_ROOT, "COPYING.runtime");
const MUSL_LICENSE = existsSync(join(REPO_ROOT, "libc", "musl", "COPYRIGHT"))
  ? join(REPO_ROOT, "libc", "musl", "COPYRIGHT")
  : join(REPO_ROOT, "sdk", "kandelo", "licenses", "MUSL-COPYRIGHT");
const LLVM_LICENSE = join(REPO_ROOT, "sdk", "kandelo", "licenses", "LLVM-LICENSE.TXT");
const VFS_MB = Number.parseInt(process.env.KANDELO_SDK_VFS_MB ?? "256", 10);

function hostClangResourceDir(): string {
  if (process.env.CLANG_RESOURCE_DIR) return process.env.CLANG_RESOURCE_DIR;
  const out = execFileSync("clang", ["--print-resource-dir"], { encoding: "utf8" }).trim();
  if (!out) throw new Error("clang --print-resource-dir returned an empty path");
  return out;
}

function copyTree(
  fs: MemoryFileSystem,
  hostRoot: string,
  vfsRoot: string,
  fileMode = 0o644,
  opts: { preserveSymlinks?: boolean } = {},
): number {
  let count = 0;
  ensureDirRecursive(fs, vfsRoot);

  function walk(hostDir: string): void {
    for (const name of readdirSync(hostDir)) {
      const hostPath = join(hostDir, name);
      const rel = relative(hostRoot, hostPath);
      const vfsPath = `${vfsRoot}/${rel}`.replace(/\/+/g, "/");
      const st = lstatSync(hostPath);

      if (st.isSymbolicLink()) {
        if (opts.preserveSymlinks ?? true) {
          symlink(fs, readlinkSync(hostPath), vfsPath);
          count++;
          continue;
        }
        const targetStat = statSync(hostPath);
        if (targetStat.isDirectory()) {
          ensureDirRecursive(fs, vfsPath);
          walk(hostPath);
        } else if (targetStat.isFile()) {
          const mode = targetStat.mode & 0o111 ? 0o755 : fileMode;
          writeVfsBinary(fs, vfsPath, new Uint8Array(readFileSync(hostPath)), mode);
          count++;
        }
      } else if (st.isDirectory()) {
        ensureDirRecursive(fs, vfsPath);
        walk(hostPath);
      } else if (st.isFile()) {
        const mode = st.mode & 0o111 ? 0o755 : fileMode;
        writeVfsBinary(fs, vfsPath, new Uint8Array(readFileSync(hostPath)), mode);
        count++;
      }
    }
  }

  walk(hostRoot);
  return count;
}

async function main(): Promise<void> {
  for (const required of [
    join(SYSROOT, "lib", "libc.a"),
    join(GLUE_DIR, "channel_syscall.c"),
    join(GLUE_OBJ_DIR, "channel_syscall.o"),
    join(SDK_BIN_DIR, "wasm32posix-cc"),
  ]) {
    if (!existsSync(required)) throw new Error(`required SDK input missing: ${required}`);
  }

  const resourceDir = hostClangResourceDir();
  if (!existsSync(resourceDir)) throw new Error(`clang resource dir not found: ${resourceDir}`);

  const sab = new SharedArrayBuffer(VFS_MB * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  for (const dir of [
    "/usr",
    "/usr/bin",
    "/usr/lib",
    "/usr/lib/llvm",
    "/usr/lib/llvm/bin",
    "/usr/lib/llvm/lib",
    "/usr/lib/llvm/lib/clang",
    "/usr/wasm32posix",
    "/home",
  ]) {
    ensureDirRecursive(fs, dir);
  }
  fs.chmod("/home", 0o777);

  console.log("Copying sysroot...");
  const sysrootFiles = copyTree(fs, SYSROOT, "/usr/wasm32posix/sysroot");

  console.log("Copying syscall glue...");
  const glueFiles = copyTree(fs, GLUE_DIR, "/usr/wasm32posix/glue");

  console.log("Copying precompiled syscall glue objects...");
  const glueObjectFiles = copyTree(fs, GLUE_OBJ_DIR, "/usr/wasm32posix/glue-objects");

  console.log("Copying SDK wrappers...");
  const wrapperFiles = copyTree(fs, SDK_BIN_DIR, "/usr/bin", 0o755);
  symlink(fs, "/usr/bin/wasm32posix-cc", "/usr/bin/cc");
  symlink(fs, "/usr/bin/wasm32posix-cc", "/usr/bin/c89");
  symlink(fs, "/usr/bin/wasm32posix-cc", "/usr/bin/c99");
  symlink(fs, "/usr/bin/wasm32posix-c++", "/usr/bin/c++");

  if (existsSync(CONFIG_SITE)) {
    writeVfsBinary(
      fs,
      "/usr/wasm32posix/config.site",
      new Uint8Array(readFileSync(CONFIG_SITE)),
      0o644,
    );
  }

  console.log("Copying clang resource headers...");
  const resourceFiles = copyTree(
    fs,
    resourceDir,
    "/usr/lib/llvm/lib/clang/21",
    0o644,
    { preserveSymlinks: false },
  );

  console.log("Copying license notices...");
  const licenseFiles = [
    [KANDELO_LICENSE, "/usr/share/licenses/kandelo/LICENSE"],
    [KANDELO_RUNTIME_LICENSE, "/usr/share/licenses/kandelo/COPYING.runtime"],
    [MUSL_LICENSE, "/usr/share/licenses/musl/COPYRIGHT"],
    [LLVM_LICENSE, "/usr/share/licenses/llvm/LICENSE.TXT"],
  ] as const;
  let noticeFiles = 0;
  for (const [hostPath, vfsPath] of licenseFiles) {
    if (!existsSync(hostPath)) continue;
    ensureDirRecursive(fs, vfsPath.slice(0, vfsPath.lastIndexOf("/")));
    writeVfsBinary(fs, vfsPath, new Uint8Array(readFileSync(hostPath)), 0o644);
    noticeFiles++;
  }

  writeVfsFile(
    fs,
    "/home/hello.c",
    [
      "#include <stdio.h>",
      "",
      "int main(void) {",
      "    puts(\"hello from Kandelo clang\");",
      "    return 0;",
      "}",
      "",
    ].join("\n"),
  );

  await saveImage(fs, OUT_FILE);
  console.log(`SDK VFS contents: ${sysrootFiles} sysroot files, ${glueFiles} glue files, ${glueObjectFiles} glue objects, ${wrapperFiles} wrappers, ${resourceFiles} clang resource files, ${noticeFiles} notice files`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
