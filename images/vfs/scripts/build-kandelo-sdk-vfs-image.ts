/**
 * Build the Kandelo SDK VFS from explicit inputs.
 *
 * The sysroot must be one staged by images/vfs/scripts/stage-sdk-sysroot.sh,
 * which copies only the SDK's declared sysroot content out of the build
 * machine's shared sysroot/, and libc++ comes from the declared libcxx
 * dependency. packages/registry/kandelo-sdk/build-kandelo-sdk.sh provides
 * both; this builder does not fall back to the shared sysroot.
 */
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
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
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
  /** A sysroot staged by images/vfs/scripts/stage-sdk-sysroot.sh. */
  sysrootDirectory: string;
  glueDirectory: string;
  /** The SDK driver built for Kandelo (kandelo-cc.wasm). */
  driverPath: string;
  /** Binaryen's wasm-opt built for Kandelo (wasm-opt.wasm). */
  wasmOptPath: string;
  configSitePath: string;
  clangResourceDirectory: string;
  licenseFiles: readonly KandeloSdkLicenseInput[];
  outputPath: string;
  /** The libcxx package output: lib/libc++.a, lib/libc++abi.a, include/c++/v1. */
  libcxxDirectory: string;
  targetAbi?: ExactVfsImageAbi;
  maximumBytes?: number;
}

function copyTree(
  fs: VfsImageFilesystem,
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

/** The guest clang's version, from the `clang` package recipe. */
function guestClangVersion(): string {
  const recipe = join(REPO_ROOT, "packages", "registry", "clang", "package.toml");
  const version = /^version = "([^"]+)"$/m.exec(readFileSync(recipe, "utf8"))?.[1];
  if (!version) throw new Error(`no version in ${recipe}`);
  return version;
}

function requireInput(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`required SDK ${label} missing: ${path}`);
}

// libc++ files the image takes from the libcxx dependency. Its other
// archives (the -pic variants) are not part of the SDK.
const LIBCXX_ARCHIVES = ["libc++.a", "libc++abi.a"];
const LIBCXX_HEADERS = join("include", "c++", "v1");

/**
 * Refuse a sysroot that was not staged for the SDK. The build machine's
 * shared sysroot/ carries the musl output receipt (and other .kandelo-*
 * freshness stamps) next to whatever other tools staged into it, such as the
 * fixture libraries scripts/build-programs.sh copies there; a staged sysroot
 * has none of them. libc++ must come from the libcxx dependency.
 */
function requireStagedSysroot(sysroot: string): void {
  if (existsSync(join(sysroot, ".kandelo-musl.outputs.json"))) {
    throw new Error(
      `SDK sysroot ${sysroot} still holds the musl output receipt, so it is an ` +
        "unstaged build-machine sysroot; stage it with " +
        "images/vfs/scripts/stage-sdk-sysroot.sh",
    );
  }
  const stamps = readdirSync(sysroot).filter((name) => name.startsWith(".kandelo-"));
  if (stamps.length > 0) {
    throw new Error(
      `SDK sysroot ${sysroot} holds build-machine stamps (${stamps.join(", ")}); ` +
        "stage it with images/vfs/scripts/stage-sdk-sysroot.sh",
    );
  }
  for (const path of [
    ...LIBCXX_ARCHIVES.map((name) => join(sysroot, "lib", name)),
    join(sysroot, LIBCXX_HEADERS),
  ]) {
    if (existsSync(path)) {
      throw new Error(
        `staged SDK sysroot already contains undeclared libc++ content: ${path}`,
      );
    }
  }
}

export async function buildKandeloSdkVfsImage(
  inputs: KandeloSdkVfsInputs,
): Promise<void> {
  const glueSources = [
    "channel_syscall.c",
    "compiler_rt.c",
    "cxxrt.c",
    "cxxrt_entry.cpp",
    "dlopen.c",
    "dynsym.c",
    "loader-internal.h",
    "kandelo-loader-wire.h",
  ];
  requireInput(join(inputs.sysrootDirectory, "lib", "libc.a"), "sysroot libc");
  requireStagedSysroot(inputs.sysrootDirectory);
  for (const path of [
    ...LIBCXX_ARCHIVES.map((name) => join(inputs.libcxxDirectory, "lib", name)),
    join(inputs.libcxxDirectory, LIBCXX_HEADERS),
  ]) requireInput(path, "libc++ runtime");
  requireInput(inputs.driverPath, "SDK driver");
  requireInput(inputs.wasmOptPath, "wasm-opt");
  requireInput(inputs.configSitePath, "config.site");
  requireInput(inputs.clangResourceDirectory, "Clang resource headers");
  // The SDK driver links executables against this generated allowance
  // (shared::abi::HOST_ENV_IMPORTS); without it every link fails.
  requireInput(join(inputs.glueDirectory, "kandelo-link-imports.txt"), "link allowance");
  for (const name of glueSources) {
    requireInput(join(inputs.glueDirectory, name), `${name} glue source`);
  }
  for (const license of inputs.licenseFiles) {
    requireInput(license.hostPath, `license ${license.guestPath}`);
  }
  const maximumBytes = inputs.maximumBytes ?? 256 * 1024 * 1024;
  const fs = KandeloImageFs.create();
  // The declared capacity the product's publication gate checks the artifact
  // against. The SharedArrayBuffer it used to come from was never anything but
  // the old constructor's first argument.
  fs.setImageCapacity(maximumBytes);
  for (const dir of [
    "/usr", "/usr/bin", "/usr/lib", "/usr/lib/llvm", "/usr/lib/llvm/bin",
    "/usr/lib/llvm/lib", "/usr/lib/llvm/lib/clang", "/usr/lib/kandelo/wasm32posix", "/home", "/home/maker",
  ]) ensureDirRecursive(fs, dir);
  fs.chown("/home/maker", 1000, 1000);

  copyTree(fs, inputs.sysrootDirectory, "/usr/lib/kandelo/wasm32posix/sysroot");
  for (const name of LIBCXX_ARCHIVES) {
    writeVfsBinary(
      fs,
      `/usr/lib/kandelo/wasm32posix/sysroot/lib/${name}`,
      new Uint8Array(readFileSync(join(inputs.libcxxDirectory, "lib", name))),
      0o644,
    );
  }
  copyTree(
    fs,
    join(inputs.libcxxDirectory, LIBCXX_HEADERS),
    "/usr/lib/kandelo/wasm32posix/sysroot/include/c++/v1",
    0o644,
    { preserveSymlinks: false },
  );
  // The driver compiles this glue into every executable it links, as it
  // does on the build machine.
  copyTree(fs, inputs.glueDirectory, "/usr/lib/kandelo/wasm32posix/glue");
  // One driver program under every SDK tool name; the name selects the tool.
  writeVfsBinary(fs, "/usr/bin/kandelo-cc", new Uint8Array(readFileSync(inputs.driverPath)), 0o755);
  writeVfsBinary(fs, "/usr/bin/wasm-opt", new Uint8Array(readFileSync(inputs.wasmOptPath)), 0o755);
  for (const tool of ["cc", "c++", "ar", "ranlib", "nm", "strip", "configure", "pkg-config"]) {
    symlink(fs, "kandelo-cc", `/usr/bin/wasm32posix-${tool}`);
  }
  for (const name of ["cc", "c89", "c99", "c++"]) symlink(fs, "kandelo-cc", `/usr/bin/${name}`);
  writeVfsBinary(
    fs,
    "/usr/lib/kandelo/wasm32posix/config.site",
    new Uint8Array(readFileSync(inputs.configSitePath)),
    0o644,
  );
  copyTree(
    fs,
    inputs.clangResourceDirectory,
    // The guest clang's resource directory: ../lib/clang/<major> from
    // /usr/lib/llvm/bin/clang, for the packages/registry/clang version.
    `/usr/lib/llvm/lib/clang/${guestClangVersion().split(".")[0]}`,
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
    "/home/maker/hello.c",
    "#include <stdio.h>\n\nint main(void) {\n    puts(\"hello from Kandelo clang\");\n    return 0;\n}\n",
  );
  fs.chown("/home/maker/hello.c", 1000, 1000);
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

function requiredEnv(name: string, meaning = ""): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required${meaning ? ` (${meaning})` : ""}; ` +
        "packages/registry/kandelo-sdk/build-kandelo-sdk.sh sets it",
    );
  }
  return value;
}

function hostClangResourceDir(): string {
  if (process.env.CLANG_RESOURCE_DIR) return process.env.CLANG_RESOURCE_DIR;
  const out = execFileSync("clang", ["--print-resource-dir"], { encoding: "utf8" }).trim();
  if (!out) throw new Error("clang --print-resource-dir returned an empty path");
  // The headers are part of the compiler, so they must come from the guest
  // clang's own release (as in build-kandelo-sdk-zip.sh).
  const host = /clang version (\d[\d.]*)/.exec(
    execFileSync("clang", ["--version"], { encoding: "utf8" }),
  )?.[1];
  const guest = guestClangVersion();
  if (host !== guest) {
    throw new Error(
      `the build machine's clang is ${host ?? "unknown"}, the guest clang ${guest}; their resource headers differ (set CLANG_RESOURCE_DIR to override)`,
    );
  }
  return out;
}

async function main(): Promise<void> {
  const sdkLicenseRoot = join(REPO_ROOT, "sdk", "kandelo", "licenses");
  await buildKandeloSdkVfsImage({
    // No default: the checkout's sysroot/ is the shared build-machine
    // sysroot, not SDK content.
    sysrootDirectory: requiredEnv(
      "WASM_POSIX_SYSROOT",
      "a sysroot staged by images/vfs/scripts/stage-sdk-sysroot.sh",
    ),
    libcxxDirectory: requiredEnv("KANDELO_SDK_LIBCXX_DIR", "the libcxx package output"),
    glueDirectory: process.env.WASM_POSIX_GLUE_DIR ?? join(REPO_ROOT, "libc", "glue"),
    driverPath: requiredEnv("KANDELO_SDK_DRIVER"),
    wasmOptPath: requiredEnv("KANDELO_SDK_WASM_OPT"),
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
