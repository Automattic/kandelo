import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { ABI_VERSION } from "../../host/src/generated/abi";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import { ensureDirRecursive } from "../../host/src/vfs/image-helpers";
import type { ZipEntry } from "../../host/src/vfs/zip";
import {
  buildSourceRootfsShellImage,
  SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES,
} from "../../images/vfs/scripts/build-source-rootfs-shell-image";
import {
  SHELL_LAZY_BINARY_SPECS,
} from "../../images/vfs/lib/init/shell-binaries";
import {
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveResolver,
} from "../../images/vfs/scripts/shell-lazy-archives";
import {
  KANDELO_DEMO_CONFIG_PATH,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
} from "../../web-libs/kandelo-session/src/demo-config";
import {
  KANDELO_SHELL_CONFIG_PATH,
  parseKandeloShellConfig,
} from "../../web-libs/kandelo-session/src/shell-config";
import {
  shouldReuseExistingPlaywrightServer,
} from "../../apps/browser-demos/playwright-server-policy";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];
const MiB = 1024 * 1024;
const ROOTFS_LAZY_IDS = new Set([
  "coreutils",
  "grep",
  "sed",
  "bc",
  "file",
  "m4",
  "make",
]);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-source-shell-"));
  roots.push(root);
  return root;
}

async function writeRootfs(path: string, kernelAbi = ABI_VERSION) {
  const maxByteLength = 16 * MiB;
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(4 * MiB, { maxByteLength }),
    maxByteLength,
  );
  fs.registerLazyFile(
    "/usr/bin/bash",
    "binaries/programs/wasm32/bash.wasm",
    3_348_482,
    0o755,
  );
  ensureDirRecursive(fs, "/bin");
  fs.symlink("/usr/bin/bash", "/bin/bash");
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (!ROOTFS_LAZY_IDS.has(spec.id)) continue;
    fs.registerLazyFile(
      spec.vfsPath,
      `binaries/${spec.resolverPath.replace("programs/", "programs/wasm32/")}`,
      spec.id === "grep" ? 412_000 : 200_000 + spec.id.length,
      0o755,
    );
  }
  const lazyTreeEntry: ZipEntry = {
    fileName: "opt/base/preserved.txt",
    fileNameBytes: new TextEncoder().encode(
      "opt/base/preserved.txt",
    ),
    compressedSize: 100,
    uncompressedSize: 4096,
    compressionMethod: 8,
    localHeaderOffset: 0,
    mode: 0o644,
    isDirectory: false,
    isSymlink: false,
    externalAttrs: 0,
    creatorOS: 3,
  };
  fs.registerLazyArchiveFromEntries(
    "https://example.invalid/base-runtime.zip",
    [lazyTreeEntry],
    "/",
  );
  const image = await fs.saveImage({
    metadata: {
      version: 1,
      kernelAbi,
      createdBy: "source-rootfs-shell-bridge.test",
    },
    normalizeTimestampsMs: 0,
  });
  writeFileSync(path, image);
  return { image, maxByteLength };
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) throw new Error(`short VFS read for ${path}`);
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function fixturePaths(root: string) {
  const rootfsPath = join(root, "rootfs.vfs");
  const bashPath = join(root, "bash.wasm");
  const fbdoomPath = join(root, "fbdoom.wasm");
  const modesetPath = join(root, "modeset.wasm");
  const shellConfigPath = join(
    repoRoot,
    "homebrew/source-rootfs-shell-default.json",
  );
  const demoConfigPath = join(repoRoot, "homebrew/main-shell-demo.json");
  writeFileSync(
    bashPath,
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
  writeFileSync(fbdoomPath, new Uint8Array([0xfa, 0xbd, 0x00, 0x01]));
  writeFileSync(modesetPath, new Uint8Array([0x6d, 0x6f, 0x64, 0x65]));
  const dependencyRoots = new Map<string, string>();
  for (const dependency of SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES) {
    const dir = join(root, "dependencies", dependency);
    mkdirSync(dir, { recursive: true });
    dependencyRoots.set(dependency, dir);
  }
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (ROOTFS_LAZY_IDS.has(spec.id)) continue;
    const dependency = spec.id === "git-remote-http" ? "git" : spec.id;
    writeFileSync(
      join(dependencyRoots.get(dependency)!, spec.resolverPath.split("/").at(-1)!),
      `${spec.id} fixture`,
    );
  }
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    writeFileSync(
      join(dependencyRoots.get(spec.dependency)!, spec.archiveUrl),
      zipSync({
        [spec.requiredExecutable]: new TextEncoder().encode(
          `${spec.id} executable`,
        ),
      }),
    );
  }
  const resolveArtifact: ShellLazyArchiveResolver = (
    resolverPath,
    requestedDependency,
  ) => {
    const dependency = requestedDependency === "git-remote-http"
      ? "git"
      : requestedDependency;
    const dir = dependencyRoots.get(dependency);
    if (!dir) throw new Error(`fixture omitted dependency ${dependency}`);
    const artifact = join(dir, resolverPath.split("/").at(-1)!);
    if (!existsSync(artifact)) {
      throw new Error(`fixture omitted ${dependency} output ${artifact}`);
    }
    return artifact;
  };
  return {
    rootfsPath,
    bashPath,
    fbdoomPath,
    modesetPath,
    shellConfigPath,
    demoConfigPath,
    dependencyRoots,
    resolveArtifact,
  };
}

describe("source-rootfs shell bridge", () => {
  it("owns its browser server for every exact-artifact proof", () => {
    expect(shouldReuseExistingPlaywrightServer({})).toBe(true);
    expect(shouldReuseExistingPlaywrightServer({ CI: "1" })).toBe(false);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_HOMEBREW_MAIN_SHELL_STRICT: "1",
    })).toBe(false);
    expect(shouldReuseExistingPlaywrightServer({
      KANDELO_SOURCE_ROOTFS_SHELL_STRICT: "1",
    })).toBe(false);
  });

  it("declares a closed source-package build graph with no bottle or network input", () => {
    const manifest = readFileSync(
      join(repoRoot, "packages/registry/shell/package.toml"),
      "utf8",
    );
    const buildToml = readFileSync(
      join(repoRoot, "packages/registry/shell/build.toml"),
      "utf8",
    );
    const wrapper = readFileSync(
      join(repoRoot, "packages/registry/shell/build-shell.sh"),
      "utf8",
    );
    const composer = readFileSync(
      join(repoRoot, "images/vfs/scripts/build-source-rootfs-shell-image.ts"),
      "utf8",
    );

    expect(manifest.match(/^\s*"[^"]+@[0-9][^"]*",?$/gm)).toEqual([
      '  "rootfs@0.1.0",',
      '  "bash@5.2.37",',
      '  "fbdoom@0.1.0",',
      '  "modeset@0.1.0",',
      '  "less@668",',
      '  "tar@1.35",',
      '  "curl@8.11.1",',
      '  "netcat@0.7.1",',
      '  "wget@1.25.0",',
      '  "git@2.47.1",',
      '  "gzip@1.13",',
      '  "bzip2@1.0.8",',
      '  "xz@5.6.2",',
      '  "zstd@1.5.6",',
      '  "zip@3.0",',
      '  "unzip@6.0",',
      '  "lsof@0.1.0",',
      '  "nano@8.0",',
      '  "vim-browser-bundle@9.1.0900",',
      '  "nethack-browser-bundle@3.6.7",',
    ]);
    expect(manifest.match(/^name = "[^"]+"$/gm)).toEqual([
      'name = "shell"',
      'name = "shell"',
      'name = "node"',
    ]);
    expect(buildToml).toMatch(/^commit\s*=\s*"UNPUBLISHED"$/m);
    expect(buildToml).toMatch(/^revision\s*=\s*21$/m);
    expect(buildToml).not.toContain("[[git_inputs]]");
    for (const input of [
      "homebrew/source-rootfs-shell-default.json",
      "homebrew/main-shell-demo.json",
      "images/vfs/scripts/build-source-rootfs-shell-image.ts",
      "images/vfs/scripts/shell-vfs-build.ts",
      "images/vfs/scripts/shell-lazy-archives.ts",
      "images/vfs/lib/init/shell-binaries.ts",
      "web-libs/kandelo-session/src/shell-config.ts",
      "web-libs/kandelo-session/src/demo-config.ts",
    ]) {
      expect(buildToml).toContain(`"${input}"`);
    }

    for (const name of ["ROOTFS", "BASH", "FBDOOM", "MODESET"]) {
      expect(wrapper).toContain(`WASM_POSIX_DEP_${name}_DIR`);
    }
    expect(wrapper).toContain('EXTENDED_DEPENDENCIES=(');
    expect(composer).toContain("populateShellEnvironment(fs, {");
    expect(composer).toContain("resolveArtifact: inputs.resolveArtifact");
    for (const forbidden of [
      "WASM_POSIX_BUILD_GIT_",
      "prepare-build-tools.sh",
      "build-homebrew-main-shell-closure.sh",
      "npm ci",
      "curl http",
      "wget http",
    ]) {
      expect(wrapper).not.toContain(forbidden);
    }
    expect(composer).not.toContain("binary-resolver");
    expect(composer).not.toMatch(/\bfetch\s*\(/);
    expect(composer).not.toMatch(/https?:\/\//);
  });

  it("preserves ABI, capacity, and lazy identities while adding exact image-owned files", async () => {
    const root = tempRoot();
    const paths = fixturePaths(root);
    const source = await writeRootfs(paths.rootfsPath);
    const sourceFs = MemoryFileSystem.fromImagePreservingCapacity(source.image);
    const sourceLazy = sourceFs
      .exportLazyEntries()
      .filter((entry) => !entry.paths?.includes("/usr/bin/bash"));
    const sourceLazyTrees = sourceFs.exportLazyArchiveEntries();
    const firstOut = join(root, "first.vfs.zst");
    const secondOut = join(root, "second.vfs.zst");

    const first = await buildSourceRootfsShellImage({
      ...paths,
      outFile: firstOut,
      sourceDateEpoch: "0",
    });
    const second = await buildSourceRootfsShellImage({
      ...paths,
      outFile: secondOut,
      sourceDateEpoch: "0",
    });

    expect(first).toEqual(second);
    expect(new Uint8Array(readFileSync(firstOut))).toEqual(first);
    expect(MemoryFileSystem.readImageMetadata(first)).toMatchObject({
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "build-source-rootfs-shell-image",
    });
    expect(MemoryFileSystem.readImageCapacity(first).maxByteLength).toBe(
      source.maxByteLength,
    );

    const fs = MemoryFileSystem.fromImagePreservingCapacity(first);
    for (const entry of sourceLazy) {
      expect(fs.exportLazyEntries()).toContainEqual(entry);
    }
    for (const entry of sourceLazyTrees) {
      expect(fs.exportLazyArchiveEntries()).toContainEqual(entry);
    }
    for (const spec of SHELL_LAZY_BINARY_SPECS) {
      expect(fs.getLazyEntry(spec.vfsPath), spec.id).not.toBeNull();
    }
    for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
      expect(
        fs.exportLazyArchiveEntries().some((entry) => entry.url === spec.archiveUrl),
        spec.id,
      ).toBe(true);
    }
    expect(fs.getLazyEntry("/bin/bash")).toBeNull();
    expect(fs.getLazyEntry("/usr/bin/bash")).toBeNull();
    expect(fs.isPathDeferred("/bin/bash")).toBe(false);
    expect(fs.isPathDeferred("/usr/bin/bash")).toBe(false);
    expect(fs.stat("/bin/bash").ino).toBe(fs.stat("/usr/bin/bash").ino);
    expect(fs.readlink("/bin/bash")).toBe("/usr/bin/bash");
    expect(readVfsFile(fs, "/bin/bash")).toEqual(
      new Uint8Array(readFileSync(paths.bashPath)),
    );
    expect(readVfsFile(fs, "/usr/bin/bash")).toEqual(
      new Uint8Array(readFileSync(paths.bashPath)),
    );
    expect(fs.getLazyEntry("/usr/bin/grep")).toMatchObject({
      url: "binaries/programs/wasm32/grep.wasm",
      size: 412_000,
    });
    expect(readVfsFile(fs, "/usr/local/bin/fbdoom")).toEqual(
      new Uint8Array(readFileSync(paths.fbdoomPath)),
    );
    expect(readVfsFile(fs, "/usr/local/bin/modeset")).toEqual(
      new Uint8Array(readFileSync(paths.modesetPath)),
    );
    expect(fs.stat("/usr/local/bin/fbdoom").mode & 0o777).toBe(0o755);
    expect(fs.stat("/usr/local/bin/modeset").mode & 0o777).toBe(0o755);
    expect(text(readVfsFile(fs, "/etc/gitconfig"))).toContain("defaultBranch = main");
    expect(text(readVfsFile(fs, "/etc/profile"))).toContain("NETHACKOPTIONS");
    expect(fs.stat("/home/.nethack")).toMatchObject({
      uid: 1000,
      gid: 1000,
    });
    expect(fs.stat("/home/.nethack").mode & 0o777).toBe(0o777);

    const shellBytes = readVfsFile(fs, KANDELO_SHELL_CONFIG_PATH);
    expect(shellBytes).toEqual(
      new Uint8Array(readFileSync(paths.shellConfigPath)),
    );
    expect(parseKandeloShellConfig(text(shellBytes))).toEqual({
      version: 1,
      path: "/bin/bash",
      argv: ["bash", "-l", "-i"],
    });
    const demoBytes = readVfsFile(fs, KANDELO_DEMO_CONFIG_PATH);
    expect(demoBytes).toEqual(
      new Uint8Array(readFileSync(paths.demoConfigPath)),
    );
    const demo = parseKandeloDemoConfig(text(demoBytes));
    expect(demo).not.toBeNull();
    validateKandeloDemoConfig(demo!);
  });

  it("rejects an implicit or wrong rootfs ABI before writing an output", async () => {
    const root = tempRoot();
    const paths = fixturePaths(root);
    await writeRootfs(paths.rootfsPath, ABI_VERSION - 1);
    const outFile = join(root, "wrong-abi.vfs.zst");

    await expect(
      buildSourceRootfsShellImage({
        ...paths,
        outFile,
        sourceDateEpoch: "0",
      }),
    ).rejects.toThrow(
      `rootfs dependency must explicitly declare kernel ABI ${ABI_VERSION}`,
    );
    expect(existsSync(outFile)).toBe(false);
  });

  it("rejects shell metadata that does not identify a rootfs executable", async () => {
    const root = tempRoot();
    const paths = fixturePaths(root);
    await writeRootfs(paths.rootfsPath);
    const shellConfigPath = join(root, "missing-shell.json");
    writeFileSync(
      shellConfigPath,
      JSON.stringify({
        version: 1,
        path: "/bin/missing",
        argv: ["missing", "-i"],
      }),
    );

    await expect(
      buildSourceRootfsShellImage({
        ...paths,
        shellConfigPath,
        outFile: join(root, "missing-shell.vfs.zst"),
        sourceDateEpoch: "0",
      }),
    ).rejects.toThrow("/bin/missing");
  });

  it("passes only resolver-owned dependency artifacts to an isolated wrapper invocation", async () => {
    const root = tempRoot();
    const outDir = join(root, "out");
    const workDir = join(root, "work");
    const rootfsDir = join(root, "rootfs");
    const bashDir = join(root, "bash");
    const fbdoomDir = join(root, "fbdoom");
    const modesetDir = join(root, "modeset");
    const toolDir = join(root, "tools");
    const extendedDependencyDirs = new Map<string, string>();
    for (const dir of [
      outDir,
      workDir,
      rootfsDir,
      bashDir,
      fbdoomDir,
      modesetDir,
      toolDir,
    ]) {
      ensureDirRecursiveOnHost(dir);
    }
    for (const dependency of SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES) {
      const dir = join(root, "extended", dependency);
      ensureDirRecursiveOnHost(dir);
      extendedDependencyDirs.set(dependency, dir);
    }
    writeFileSync(join(rootfsDir, "rootfs.vfs"), "rootfs");
    writeFileSync(join(bashDir, "bash.wasm"), "bash");
    writeFileSync(join(fbdoomDir, "fbdoom.wasm"), "fbdoom");
    writeFileSync(join(modesetDir, "modeset.wasm"), "modeset");
    const logPath = join(root, "composer.log");
    const fakeNode = join(toolDir, "node");
    writeFileSync(
      fakeNode,
      `#!/bin/bash
set -euo pipefail
for name in GH_TOKEN GITHUB_TOKEN NODE_OPTIONS NODE_PATH HTTP_PROXY HTTPS_PROXY; do
  [ "\${!name+x}" != x ] || { echo "ambient variable leaked: $name" >&2; exit 81; }
done
if [[ "\${1:-}" == */scripts/source-rootfs-shell-dependency-contract.mjs ]]; then
  [ "\${2:-}" = --print-resolver-owned ]
  printf '%s\\n' ${
    SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES
      .map((dependency) => `'${dependency}'`)
      .join(" ")
  }
  exit 0
fi
[ "\${SOURCE_DATE_EPOCH:-}" = 0 ]
shift 2
out=""
printf '%s\\n' "$*" >"\${FAKE_SHELL_LOG:?}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift 2 ;;
  esac
done
[ -n "$out" ]
printf '%s\\n' "source-rootfs-shell" >"$out"
`,
    );
    chmodSync(fakeNode, 0o755);

    const dependencyEnv = Object.fromEntries(
      Array.from(extendedDependencyDirs, ([dependency, dir]) => [
        `WASM_POSIX_DEP_${dependency.replaceAll("-", "_").toUpperCase()}_DIR`,
        dir,
      ]),
    );
    execFileSync(
      "/bin/bash",
      [join(repoRoot, "packages/registry/shell/build-shell.sh")],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FAKE_SHELL_LOG: logPath,
          GH_TOKEN: "forbidden",
          GITHUB_TOKEN: "forbidden",
          NODE_OPTIONS: "--trace-warnings",
          NODE_PATH: "/forbidden",
          HTTP_PROXY: "https://proxy.invalid",
          HTTPS_PROXY: "https://proxy.invalid",
          KANDELO_DEV_SHELL_TOOL_PATH: toolDir,
          WASM_POSIX_DEP_TARGET_ARCH: "wasm32",
          WASM_POSIX_DEP_OUT_DIR: outDir,
          WASM_POSIX_DEP_WORK_DIR: workDir,
          WASM_POSIX_DEP_ROOTFS_DIR: rootfsDir,
          WASM_POSIX_DEP_BASH_DIR: bashDir,
          WASM_POSIX_DEP_FBDOOM_DIR: fbdoomDir,
          WASM_POSIX_DEP_MODESET_DIR: modesetDir,
          ...dependencyEnv,
        },
        stdio: "pipe",
      },
    );

    expect(readFileSync(join(outDir, "shell.vfs.zst"), "utf8")).toBe(
      "source-rootfs-shell\n",
    );
    expect(readdirSync(workDir)).toEqual([]);
    const invocation = readFileSync(logPath, "utf8");
    expect(invocation).toContain(`--rootfs ${rootfsDir}/rootfs.vfs`);
    expect(invocation).toContain(`--bash ${bashDir}/bash.wasm`);
    expect(invocation).toContain(`--fbdoom ${fbdoomDir}/fbdoom.wasm`);
    expect(invocation).toContain(`--modeset ${modesetDir}/modeset.wasm`);
    expect(invocation).not.toContain("homebrew-tap");
  });
});

function ensureDirRecursiveOnHost(path: string): void {
  mkdirSync(path, { recursive: true });
}
