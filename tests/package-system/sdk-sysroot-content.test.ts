import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The guest SDK ships a copy of the build machine's wasm32 sysroot. That
// directory is shared and mutable: scripts/build-programs.sh stages GTK,
// glib, SDL2, Wayland and other fixture libraries into it. When the SDK
// bundle copied the whole directory, its bytes depended on whether that
// script had run first, under a cache key that does not cover it. For
// reference, kandelo-sdk.zip has 2,418 members in the LLVM 21 bundle and
// 2,451 in the clean LLVM 23 bundle; the polluted LLVM 23 bundle had 3,552.
// These tests pin the SDK sysroot to its declared content, using a
// deliberately polluted sysroot.

const repoRoot = resolve(import.meta.dirname, "../..");
const stageScript = join(repoRoot, "images/vfs/scripts/stage-sdk-sysroot.sh");
const zipScript = join(repoRoot, "images/vfs/scripts/build-kandelo-sdk-zip.sh");
const outputState = join(repoRoot, "scripts/musl-output-state.mjs");
const vfsBuilder = join(repoRoot, "images/vfs/scripts/build-kandelo-sdk-vfs-image.sh");

// What scripts/build-musl.sh records in its output receipt.
const MUSL_RECEIPT_FILES = [
  "include/bits/alltypes.h",
  "include/bits/kandelo_thread_syscalls.h",
  "include/stdio.h",
  "include/EGL/egl.h",
  "lib/crt1.o",
  "lib/crti.o",
  "lib/crtn.o",
  "lib/libc.a",
  "lib/libkandelo-ucontext-unsupported.a",
];
// The rest of the declared SDK sysroot: musl files outside the receipt and
// the platform graphics libraries.
const SDK_FILES = [
  "include/drm/drm.h",
  "include/drm/drm_mode.h",
  "include/libdrm/xf86drm.h",
  "lib/Scrt1.o",
  "lib/__main_void.o",
  "lib/__main_void_adapter.o",
  "lib/libEGL.a",
  "lib/libGLESv2.a",
  "lib/libcrypt.a",
  "lib/libdl.a",
  "lib/libdrm.a",
  "lib/libgbm.a",
  "lib/libm.a",
  "lib/libpthread.a",
  "lib/libresolv.a",
  "lib/librt.a",
  "lib/libutil.a",
  "lib/libxnet.a",
  "lib/pkgconfig/egl.pc",
  "lib/pkgconfig/gbm.pc",
  "lib/pkgconfig/glesv2.pc",
  "lib/pkgconfig/libdrm.pc",
  "lib/rcrt1.o",
  "lib/sigsetjmp_helpers.o",
  "lib/wasm_setjmp_rt.o",
];
// What other tools leave in the shared sysroot (build-programs.sh fixture
// staging, build-machine freshness stamps).
const POLLUTION = [
  ".kandelo-dri-stubs.input-hash",
  ".kandelo-musl.input-hash",
  "include/ffi.h",
  "include/glib-2.0/glib.h",
  "include/gtk-3.0/gtk/gtk.h",
  "include/xkbcommon/xkbcommon.h",
  "lib/libSDL2.a",
  "lib/libgtk-3.a",
  "lib/libz.a",
  "lib/pkgconfig/gtk+-3.0.pc",
];

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-sdk-sysroot-"));
  temporaryRoots.push(root);
  return root;
}

function writeFile(root: string, path: string, contents = `${path}\n`): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path));
    }
  };
  walk(root);
  return out.sort();
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function pollutedSysroot(): string {
  const sysroot = join(tempDir(), "sysroot");
  for (const path of MUSL_RECEIPT_FILES) writeFile(sysroot, path);
  const receipt = run("node", [outputState, "write", sysroot]);
  expect(receipt.status, receipt.stderr).toBe(0);
  writeFileSync(join(sysroot, ".kandelo-musl.outputs.json"), receipt.stdout);
  for (const path of SDK_FILES) writeFile(sysroot, path);
  for (const path of POLLUTION) writeFile(sysroot, path);
  return sysroot;
}

const declared = [...MUSL_RECEIPT_FILES, ...SDK_FILES].sort();

describe("guest SDK sysroot content", () => {
  it("stages only the declared content of a polluted sysroot", () => {
    const sysroot = pollutedSysroot();
    const staged = join(tempDir(), "staged");
    const result = run("bash", [stageScript, sysroot, staged]);
    expect(result.status, result.stderr).toBe(0);
    expect(files(staged)).toEqual(declared);
  });

  it("fails when receipt-listed musl content was overwritten", () => {
    const sysroot = pollutedSysroot();
    writeFile(sysroot, "include/stdio.h", "staged over by another tool\n");
    const result = run("bash", [stageScript, sysroot, join(tempDir(), "staged")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SDK output changed: include/stdio.h");
    expect(result.stderr).toContain("does not match its musl output receipt");
  });

  // The script reads the receipt once. A shim cp rewrites the source after
  // that read, as another tool writing the shared sysroot would; the copied
  // bytes must be checked against the snapshot, including when the source
  // receipt is rewritten to match the new bytes.
  for (const rewriteReceipt of [false, true]) {
    it(`fails when the sysroot changes during staging${rewriteReceipt ? " with its receipt" : ""}`, () => {
      const sysroot = pollutedSysroot();
      const fakeBin = join(tempDir(), "bin");
      const realCp = run("bash", ["-c", "command -v cp"]).stdout.trim();
      writeFile(
        fakeBin,
        "cp",
        [
          "#!/bin/sh",
          `"${realCp}" "$@" || exit`,
          'case "$2" in',
          "  */kandelo-sdk-receipt.*/.kandelo-musl.outputs.json)",
          `    printf 'rewritten during staging\\n' >"${sysroot}/include/stdio.h"`,
          rewriteReceipt
            ? `    node "${outputState}" write "${sysroot}" >"${sysroot}/.kandelo-musl.outputs.json"`
            : "    :",
          "    ;;",
          "esac",
          "",
        ].join("\n"),
      );
      chmodSync(join(fakeBin, "cp"), 0o755);
      const result = run("bash", [stageScript, sysroot, join(tempDir(), "staged")], {
        PATH: `${fakeBin}:${process.env.PATH}`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("SDK output changed: include/stdio.h");
      expect(result.stderr).toContain("changed during staging");
    });
  }

  it("refuses a non-empty destination", () => {
    const sysroot = pollutedSysroot();
    const staged = join(tempDir(), "staged");
    writeFile(staged, "leftover");
    const result = run("bash", [stageScript, sysroot, staged]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `destination must be absent or an empty directory: ${staged}`,
    );
    expect(files(staged)).toEqual(["leftover"]);
  });

  it("refuses a symlinked destination", () => {
    const sysroot = pollutedSysroot();
    const root = tempDir();
    mkdirSync(join(root, "target"));
    symlinkSync(join(root, "target"), join(root, "staged"));
    const result = run("bash", [stageScript, sysroot, join(root, "staged")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("destination must be absent or an empty directory");
    expect(readdirSync(join(root, "target"))).toEqual([]);
  });

  it("refuses a symlinked sysroot", () => {
    const sysroot = pollutedSysroot();
    const link = join(tempDir(), "sysroot-link");
    symlinkSync(sysroot, link);
    const result = run("bash", [stageScript, link, join(tempDir(), "staged")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`source sysroot is not a directory: ${link}`);
  });

  it("refuses a symlink in place of a declared file", () => {
    const sysroot = pollutedSysroot();
    const outside = join(tempDir(), "libgbm.a");
    writeFileSync(outside, "outside the sysroot\n");
    rmSync(join(sysroot, "lib/libgbm.a"));
    symlinkSync(outside, join(sysroot, "lib/libgbm.a"));
    const result = run("bash", [stageScript, sysroot, join(tempDir(), "staged")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `required SDK sysroot file missing or not a regular file: ${sysroot}/lib/libgbm.a`,
    );
  });

  it("refuses a symlink inside a declared directory", () => {
    const sysroot = pollutedSysroot();
    symlinkSync(join(sysroot, "include/drm/drm.h"), join(sysroot, "include/drm/alias.h"));
    const result = run("bash", [stageScript, sysroot, join(tempDir(), "staged")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `SDK sysroot directory holds a non-regular file: ${sysroot}/include/drm`,
    );
  });

  it("refuses a receipt path outside the sysroot", () => {
    const sysroot = pollutedSysroot();
    writeFileSync(
      join(sysroot, ".kandelo-musl.outputs.json"),
      JSON.stringify({ "../escape": "0".repeat(64) }),
    );
    const staged = join(tempDir(), "staged");
    const result = run("bash", [stageScript, sysroot, staged]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid musl output receipt path: "../escape"');
    expect(existsSync(staged)).toBe(false);
  });

  it("fails when declared SDK content is missing", () => {
    const sysroot = pollutedSysroot();
    rmSync(join(sysroot, "lib/libgbm.a"));
    const result = run("bash", [stageScript, sysroot, join(tempDir(), "staged")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `required SDK sysroot file missing or not a regular file: ${sysroot}/lib/libgbm.a`,
    );
  });

  it("fails without a musl output receipt", () => {
    const sysroot = pollutedSysroot();
    rmSync(join(sysroot, ".kandelo-musl.outputs.json"));
    const result = run("bash", [stageScript, sysroot, join(tempDir(), "staged")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no musl output receipt");
  });

  it("keeps the browser SDK bundle's sysroot to the declared content", () => {
    const sysroot = pollutedSysroot();
    const root = tempDir();
    const clangDir = join(root, "clang");
    for (const tool of ["clang", "wasm-ld", "llvm-ar", "llvm-ranlib", "llvm-nm"]) {
      writeFile(clangDir, `${tool}.wasm`);
    }
    const libcxxDir = join(root, "libcxx");
    for (const path of [
      "lib/libc++.a",
      "lib/libc++abi.a",
      "include/c++/v1/vector",
      "include/c++/v1/__config",
    ]) writeFile(libcxxDir, path);
    const kandeloCcDir = join(root, "kandelo-cc");
    writeFile(kandeloCcDir, "kandelo-cc.wasm");
    const binaryenDir = join(root, "binaryen");
    writeFile(binaryenDir, "wasm-opt.wasm");
    const resourceDir = join(root, "clang-resource");
    writeFile(resourceDir, "include/stddef.h");
    // CLANG_RESOURCE_DIR skips the version comparison; the script still
    // asks for a version, so give it a clang that answers.
    const fakeBin = join(root, "bin");
    writeFile(fakeBin, "clang", "#!/bin/sh\necho 'clang version 0.0.0'\n");
    chmodSync(join(fakeBin, "clang"), 0o755);

    const output = join(root, "out", "kandelo-sdk.zip");
    const result = run(
      "bash",
      [zipScript, clangDir, libcxxDir, kandeloCcDir, binaryenDir, output],
      {
        CLANG_RESOURCE_DIR: resourceDir,
        PATH: `${fakeBin}:${process.env.PATH}`,
        WASM_POSIX_SYSROOT: sysroot,
        WASM_POSIX_DEP_WORK_DIR: "",
      },
    );
    expect(result.status, result.stderr).toBe(0);

    const listing = run("python3", [
      "-I",
      "-c",
      "import sys, zipfile\nfor name in zipfile.ZipFile(sys.argv[1]).namelist(): print(name)",
      output,
    ]);
    expect(listing.status, listing.stderr).toBe(0);
    const prefix = "lib/kandelo/wasm32posix/sysroot/";
    const sysrootMembers = listing.stdout
      .split("\n")
      .filter((name) => name.startsWith(prefix) && !name.endsWith("/"))
      .map((name) => name.slice(prefix.length))
      .sort();
    expect(sysrootMembers).toEqual(
      [
        ...declared,
        "include/c++/v1/__config",
        "include/c++/v1/vector",
        "lib/libc++.a",
        "lib/libc++abi.a",
      ].sort(),
    );
  });
});

// The developer-kandelo-sdk product names build-kandelo-sdk-vfs-image.sh as
// its builder. Run directly, it must not fall back to the shared sysroot
// (which no longer holds libc++) or accept one that was not staged.
describe("kandelo-sdk VFS builder inputs", () => {
  function builderEnv(sysroot: string | undefined, libcxx: string | undefined) {
    const root = tempDir();
    writeFile(root, "clang-resource/include/stddef.h");
    return {
      WASM_POSIX_SYSROOT: sysroot ?? "",
      KANDELO_SDK_LIBCXX_DIR: libcxx ?? "",
      KANDELO_SDK_DRIVER: join(root, "kandelo-cc.wasm"),
      KANDELO_SDK_WASM_OPT: join(root, "wasm-opt.wasm"),
      KANDELO_SDK_VFS_OUT: join(root, "out", "kandelo-sdk.vfs.zst"),
      CLANG_RESOURCE_DIR: join(root, "clang-resource"),
    };
  }

  function libcxxDir(): string {
    const dir = join(tempDir(), "libcxx");
    for (const path of ["lib/libc++.a", "lib/libc++abi.a", "include/c++/v1/vector"]) {
      writeFile(dir, path);
    }
    return dir;
  }

  function stagedSysroot(): string {
    const staged = join(tempDir(), "staged");
    const result = run("bash", [stageScript, pollutedSysroot(), staged]);
    expect(result.status, result.stderr).toBe(0);
    return staged;
  }

  it("requires an explicit sysroot", () => {
    const env = builderEnv(undefined, libcxxDir());
    const result = run("bash", [vfsBuilder], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("WASM_POSIX_SYSROOT is required");
    expect(existsSync(env.KANDELO_SDK_VFS_OUT)).toBe(false);
  });

  it("requires an explicit libcxx directory", () => {
    const env = builderEnv(stagedSysroot(), undefined);
    const result = run("bash", [vfsBuilder], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("KANDELO_SDK_LIBCXX_DIR is required");
  });

  it("refuses an unstaged sysroot", () => {
    const env = builderEnv(pollutedSysroot(), libcxxDir());
    const result = run("bash", [vfsBuilder], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still holds the musl output receipt");
    expect(existsSync(env.KANDELO_SDK_VFS_OUT)).toBe(false);
  });

  it("refuses a staged sysroot that already holds libc++", () => {
    const sysroot = stagedSysroot();
    writeFile(sysroot, "lib/libc++.a");
    const result = run("bash", [vfsBuilder], builderEnv(sysroot, libcxxDir()));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already contains undeclared libc++ content");
  });

  it("refuses an incomplete libcxx directory", () => {
    const libcxx = libcxxDir();
    rmSync(join(libcxx, "lib/libc++abi.a"));
    const result = run("bash", [vfsBuilder], builderEnv(stagedSysroot(), libcxx));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `required SDK libc++ runtime missing: ${libcxx}/lib/libc++abi.a`,
    );
  });
});
