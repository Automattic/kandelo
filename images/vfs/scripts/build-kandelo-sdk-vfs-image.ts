/** Build the Kandelo SDK VFS from either explicit staged inputs or legacy paths. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  exactVfsImageMetadata,
  saveImage,
  symlink,
  type ExactVfsImageAbi,
  writeVfsBinary,
  writeVfsFile,
} from "./vfs-image-helpers";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

export interface KandeloSdkLicenseInput {
  hostPath: string;
  guestPath: string;
}

export interface KandeloSdkVfsInputs {
  sysrootDirectory: string;
  glueDirectory: string;
  glueObjectsDirectory: string;
  sdkBinDirectory: string;
  configSitePath: string;
  clangResourceDirectory: string;
  licenseFiles: readonly KandeloSdkLicenseInput[];
  outputPath: string;
  libcxxDirectory?: string;
  targetAbi?: ExactVfsImageAbi;
  maximumBytes?: number;
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
    for (const name of readdirSync(hostDir).sort()) {
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
          writeVfsBinary(
            fs,
            vfsPath,
            new Uint8Array(readFileSync(hostPath)),
            targetStat.mode & 0o111 ? 0o755 : fileMode,
          );
          count++;
        }
      } else if (st.isDirectory()) {
        ensureDirRecursive(fs, vfsPath);
        walk(hostPath);
      } else if (st.isFile()) {
        writeVfsBinary(
          fs,
          vfsPath,
          new Uint8Array(readFileSync(hostPath)),
          st.mode & 0o111 ? 0o755 : fileMode,
        );
        count++;
      }
    }
  }
  walk(hostRoot);
  return count;
}

function requireInput(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`required SDK ${label} missing: ${path}`);
}

export async function buildKandeloSdkVfsImage(
  inputs: KandeloSdkVfsInputs,
): Promise<void> {
  const glueNames = ["channel_syscall", "compiler_rt", "cxxrt", "dlopen"];
  requireInput(join(inputs.sysrootDirectory, "lib", "libc.a"), "sysroot libc");
  requireInput(join(inputs.sdkBinDirectory, "wasm32posix-cc"), "compiler wrapper");
  requireInput(inputs.configSitePath, "config.site");
  requireInput(inputs.clangResourceDirectory, "Clang resource headers");
  for (const name of glueNames) {
    requireInput(join(inputs.glueDirectory, `${name}.c`), `${name} glue source`);
    requireInput(join(inputs.glueObjectsDirectory, `${name}.o`), `${name} glue object`);
  }
  for (const license of inputs.licenseFiles) {
    requireInput(license.hostPath, `license ${license.guestPath}`);
  }
  if (inputs.libcxxDirectory !== undefined) {
    for (const path of [
      join(inputs.libcxxDirectory, "lib", "libc++.a"),
      join(inputs.libcxxDirectory, "lib", "libc++abi.a"),
      join(inputs.libcxxDirectory, "include", "c++", "v1"),
    ]) requireInput(path, "libc++ runtime");
    for (const path of [
      join(inputs.sysrootDirectory, "lib", "libc++.a"),
      join(inputs.sysrootDirectory, "lib", "libc++abi.a"),
      join(inputs.sysrootDirectory, "include", "c++", "v1"),
    ]) {
      if (existsSync(path)) {
        throw new Error(
          `staged SDK sysroot already contains undeclared libc++ content: ${path}`,
        );
      }
    }
  }

  const maximumBytes = inputs.maximumBytes ?? 256 * 1024 * 1024;
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(maximumBytes));
  for (const dir of [
    "/usr", "/usr/bin", "/usr/lib", "/usr/lib/llvm", "/usr/lib/llvm/bin",
    "/usr/lib/llvm/lib", "/usr/lib/llvm/lib/clang", "/usr/wasm32posix", "/home",
  ]) ensureDirRecursive(fs, dir);
  fs.chmod("/home", 0o777);

  copyTree(fs, inputs.sysrootDirectory, "/usr/wasm32posix/sysroot");
  if (inputs.libcxxDirectory !== undefined) {
    copyTree(
      fs,
      join(inputs.libcxxDirectory, "lib"),
      "/usr/wasm32posix/sysroot/lib",
    );
    copyTree(
      fs,
      join(inputs.libcxxDirectory, "include", "c++", "v1"),
      "/usr/wasm32posix/sysroot/include/c++/v1",
    );
  }
  copyTree(fs, inputs.glueDirectory, "/usr/wasm32posix/glue");
  copyTree(fs, inputs.glueObjectsDirectory, "/usr/wasm32posix/glue-objects");
  copyTree(fs, inputs.sdkBinDirectory, "/usr/bin", 0o755);
  symlink(fs, "/usr/bin/wasm32posix-cc", "/usr/bin/cc");
  symlink(fs, "/usr/bin/wasm32posix-cc", "/usr/bin/c89");
  symlink(fs, "/usr/bin/wasm32posix-cc", "/usr/bin/c99");
  symlink(fs, "/usr/bin/wasm32posix-c++", "/usr/bin/c++");
  writeVfsBinary(
    fs,
    "/usr/wasm32posix/config.site",
    new Uint8Array(readFileSync(inputs.configSitePath)),
    0o644,
  );
  copyTree(
    fs,
    inputs.clangResourceDirectory,
    "/usr/lib/llvm/lib/clang/21",
    0o644,
    { preserveSymlinks: false },
  );
  for (const license of inputs.licenseFiles) {
    ensureDirRecursive(fs, dirname(license.guestPath));
    writeVfsBinary(
      fs,
      license.guestPath,
      new Uint8Array(readFileSync(license.hostPath)),
      0o644,
    );
  }
  writeVfsFile(
    fs,
    "/home/hello.c",
    "#include <stdio.h>\n\nint main(void) {\n    puts(\"hello from Kandelo clang\");\n    return 0;\n}\n",
  );
  await saveImage(fs, inputs.outputPath, inputs.targetAbi === undefined
    ? {}
    : {
        kernelAbi: inputs.targetAbi.version,
        metadata: exactVfsImageMetadata(
          inputs.targetAbi,
          "images/vfs/scripts/build-kandelo-sdk-vfs-image.ts",
        ),
      });
}

function hostClangResourceDir(): string {
  if (process.env.CLANG_RESOURCE_DIR) return process.env.CLANG_RESOURCE_DIR;
  const out = execFileSync("clang", ["--print-resource-dir"], { encoding: "utf8" }).trim();
  if (!out) throw new Error("clang --print-resource-dir returned an empty path");
  return out;
}

async function main(): Promise<void> {
  const sdkLicenseRoot = join(REPO_ROOT, "sdk", "kandelo", "licenses");
  await buildKandeloSdkVfsImage({
    sysrootDirectory: process.env.WASM_POSIX_SYSROOT ?? join(REPO_ROOT, "sysroot"),
    glueDirectory: process.env.WASM_POSIX_GLUE_DIR ?? join(REPO_ROOT, "libc", "glue"),
    glueObjectsDirectory: process.env.KANDELO_SDK_GLUE_OBJ_DIR ??
      join(REPO_ROOT, "packages", "registry", "kandelo-sdk", "kandelo-sdk-glue-objs"),
    sdkBinDirectory: join(REPO_ROOT, "sdk", "kandelo", "bin"),
    configSitePath: join(REPO_ROOT, "sdk", "config.site"),
    clangResourceDirectory: hostClangResourceDir(),
    licenseFiles: [
      { hostPath: join(REPO_ROOT, "LICENSE"), guestPath: "/usr/share/licenses/kandelo/LICENSE" },
      { hostPath: join(REPO_ROOT, "COPYING.runtime"), guestPath: "/usr/share/licenses/kandelo/COPYING.runtime" },
      {
        hostPath: existsSync(join(REPO_ROOT, "libc", "musl", "COPYRIGHT"))
          ? join(REPO_ROOT, "libc", "musl", "COPYRIGHT")
          : join(sdkLicenseRoot, "MUSL-COPYRIGHT"),
        guestPath: "/usr/share/licenses/musl/COPYRIGHT",
      },
      { hostPath: join(sdkLicenseRoot, "LLVM-LICENSE.TXT"), guestPath: "/usr/share/licenses/llvm/LICENSE.TXT" },
    ],
    outputPath: process.env.KANDELO_SDK_VFS_OUT ??
      join(REPO_ROOT, "apps", "browser-demos", "public", "kandelo-sdk.vfs.zst"),
    maximumBytes: Number.parseInt(process.env.KANDELO_SDK_VFS_MB ?? "256", 10) * 1024 * 1024,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
