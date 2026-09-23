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
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../host/src/vfs/image-helpers";
import type { ZipEntry } from "../../host/src/vfs/zip";
import {
  buildSourceRootfsShellImage,
  composeSourceRootfsDemoConfig,
  SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES,
} from "../../images/vfs/scripts/build-source-rootfs-shell-image";
import { SHELL_LAZY_BINARY_SPECS } from "../../images/vfs/lib/init/shell-binaries";
import {
  NCURSES_TERMINFO_RUNTIME_FILE,
  registerShellProfileScripts,
  SHELL_LAZY_ARCHIVE_SPECS,
  SHELL_PROFILE_SCRIPT_PATHS,
  type ShellLazyArchiveResolver,
} from "../../images/vfs/scripts/shell-lazy-archives";
import {
  KANDELO_DEMO_CONFIG_PATH,
  parseKandeloDemoConfig,
  resolveDemoAssets,
  resolveDemoInit,
  resolveDemoPresentation,
  validateKandeloDemoConfig,
} from "../../web-libs/kandelo-session/src/demo-config";
import {
  DOOM_WAD_SHA256,
  DOOM_WAD_URL,
} from "../../web-libs/kandelo-session/src/demo-guides";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  parseExperimentalTerminalSession,
} from "../../web-libs/kandelo-session/src/experimental-terminal-session";
import { shouldReuseExistingPlaywrightServer } from "../../apps/browser-demos/playwright-server-policy";
import {
  readSourceRootfsShellDependencyContract,
  validateSourceRootfsShellPackageManifest,
} from "../../packages/registry/shell/source-rootfs-shell-dependency-contract.mjs";
import {
  assertSourceRootfsShellImage,
  assertSourceRootfsShellMetadata,
} from "../../scripts/assert-source-rootfs-shell-composition";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const canonicalPackageRoot = join(repoRoot, "packages/registry/shell");
const canonicalPackageManifest = join(canonicalPackageRoot, "package.toml");
const canonicalDependencyContract = join(
  repoRoot,
  "packages/registry/shell/source-rootfs-shell-dependencies.json",
);
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

interface SourceRootfsDemoOverlayFixture {
  profiles: {
    doom: {
      presentation: {
        runningPrimary: string[];
      };
      assets: Array<{
        sha256: string;
      }>;
    };
  };
}

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

async function writeRootfs(
  path: string,
  kernelAbi = ABI_VERSION,
  terminalProgramPath = "/usr/bin/login",
) {
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
  ensureDirRecursive(fs, "/etc/kandelo");
  fs.symlink("/usr/bin/bash", "/bin/bash");
  writeVfsBinary(
    fs,
    "/usr/bin/login",
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    0o4755,
  );
  writeVfsBinary(
    fs,
    EXPERIMENTAL_TERMINAL_SESSION_PATH,
    new TextEncoder().encode(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path: terminalProgramPath,
        argv: ["login", "-p", "-f", "maker"],
        uid: 0,
        gid: 0,
      },
      afterExit: {
        path: "/usr/bin/login",
        argv: ["login", "-p"],
        uid: 0,
        gid: 0,
      },
    })),
    0o644,
  );
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
    fileNameBytes: new TextEncoder().encode("opt/base/preserved.txt"),
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
  const sdl2Path = join(root, "sdl2.wasm");
  const evdevDemoPath = join(root, "evdev_demo.wasm");
  const espeakNgPath = join(root, "espeak-ng.wasm");
  const espeakNgDataPath = join(root, "espeak-ng-data.zip");
  const demoConfigPath = join(
    repoRoot,
    "packages/registry/shell/source-rootfs-shell-demo.json",
  );
  const demoProfileOverlayPath = join(
    repoRoot,
    "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
  );
  writeFileSync(
    bashPath,
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
  writeFileSync(fbdoomPath, new Uint8Array([0xfa, 0xbd, 0x00, 0x01]));
  writeFileSync(modesetPath, new Uint8Array([0x6d, 0x6f, 0x64, 0x65]));
  writeFileSync(sdl2Path, new Uint8Array([0x73, 0x64, 0x6c, 0x32]));
  writeFileSync(evdevDemoPath, new Uint8Array([0x65, 0x76, 0x64, 0x65]));
  writeFileSync(espeakNgPath, new Uint8Array([0x65, 0x73, 0x70, 0x6b]));
  writeFileSync(
    espeakNgDataPath,
    zipSync({
      "en/en_dict": new TextEncoder().encode("espeak voice data fixture"),
    }),
  );
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
      join(
        dependencyRoots.get(dependency)!,
        spec.resolverPath.split("/").at(-1)!,
      ),
      `${spec.id} fixture`,
    );
  }
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    writeFileSync(
      join(dependencyRoots.get(spec.dependency)!, spec.archiveUrl),
      zipSync({
        [spec.requiredMember]: new TextEncoder().encode(
          `${spec.id} executable`,
        ),
      }),
    );
  }
  // WHY: populateTerminfoDatabase unpacks this eagerly (unlike the lazy
  // archives above) and requires its one declared entry unconditionally.
  writeFileSync(
    join(
      dependencyRoots.get(NCURSES_TERMINFO_RUNTIME_FILE.dependency)!,
      NCURSES_TERMINFO_RUNTIME_FILE.resolverPath.split("/").at(-1)!,
    ),
    zipSync({
      [NCURSES_TERMINFO_RUNTIME_FILE.requiredEntry]: new TextEncoder().encode(
        "ncurses terminfo fixture",
      ),
    }),
  );
  const resolveArtifact: ShellLazyArchiveResolver = (
    resolverPath,
    requestedDependency,
  ) => {
    const dependency =
      requestedDependency === "git-remote-http" ? "git" : requestedDependency;
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
    sdl2Path,
    evdevDemoPath,
    espeakNgPath,
    espeakNgDataPath,
    demoConfigPath,
    demoProfileOverlayPath,
    dependencyRoots,
    resolveArtifact,
  };
}

describe("canonical source-rootfs shell", () => {
  it("classifies only the exact package-rootfs composition marker", () => {
    const sourceMetadata = {
      version: 1 as const,
      kernelAbi: ABI_VERSION,
      shellComposition: { schema: 1, kind: "package-rootfs-shell" },
    };

    expect(() => assertSourceRootfsShellMetadata(sourceMetadata)).not.toThrow();
    for (const invalid of [
      null,
      {
        ...sourceMetadata,
        shellComposition: { schema: 2, kind: "package-rootfs-shell" },
      },
      {
        ...sourceMetadata,
        shellComposition: { schema: 1, kind: "package-rootfs-shell", extra: true },
      },
    ]) {
      expect(() => assertSourceRootfsShellMetadata(invalid)).toThrow();
    }
  });

  it("owns its browser server for every exact-artifact proof", () => {
    expect(shouldReuseExistingPlaywrightServer({})).toBe(true);
    expect(shouldReuseExistingPlaywrightServer({ CI: "1" })).toBe(false);
    expect(
      shouldReuseExistingPlaywrightServer({
        KANDELO_SOURCE_ROOTFS_SHELL_STRICT: "1",
      }),
    ).toBe(false);
  });

  it("declares a closed source-package build graph with no bottle or network input", () => {
    const manifest = readFileSync(canonicalPackageManifest, "utf8");
    const buildToml = readFileSync(
      join(canonicalPackageRoot, "build.toml"),
      "utf8",
    );
    const wrapper = readFileSync(
      join(canonicalPackageRoot, "build-shell.sh"),
      "utf8",
    );
    const composer = readFileSync(
      join(repoRoot, "images/vfs/scripts/build-source-rootfs-shell-image.ts"),
      "utf8",
    );

    const contract = readSourceRootfsShellDependencyContract(
      canonicalDependencyContract,
    );
    expect(
      validateSourceRootfsShellPackageManifest(
        contract,
        canonicalPackageManifest,
      ),
    ).toEqual(
      contract.dependencies.map(({ name, version }) => ({ name, version })),
    );
    expect(manifest.match(/^name = "[^"]+"$/gm)).toEqual([
      'name = "shell"',
      'name = "shell"',
      'name = "node"',
    ]);
    expect(buildToml).toMatch(/^commit\s*=\s*"UNPUBLISHED"$/m);
    expect(buildToml).toMatch(/^revision\s*=\s*30$/m);
    expect(buildToml).not.toContain("[[git_inputs]]");
    for (const input of [
      "packages/registry/shell/source-rootfs-shell-demo.json",
      "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
      "images/vfs/scripts/build-source-rootfs-shell-image.ts",
      "images/vfs/scripts/source-rootfs-shell-overlay.ts",
      "images/vfs/scripts/shell-lazy-archives.ts",
      "images/vfs/lib/init/shell-binaries.ts",
      "web-libs/kandelo-session/src/experimental-terminal-session.ts",
      "web-libs/kandelo-session/src/demo-config.ts",
    ]) {
      expect(buildToml).toContain(`"${input}"`);
    }

    for (const name of ["ROOTFS", "BASH", "FBDOOM", "MODESET"]) {
      expect(wrapper).toContain(`WASM_POSIX_DEP_${name}_DIR`);
    }
    expect(wrapper).toContain("EXTENDED_DEPENDENCIES=(");
    expect(composer).toContain(
      "populateSourceRootfsShellOverlay(fs, inputs.resolveArtifact)",
    );
    for (const forbidden of [
      "WASM_POSIX_BUILD_GIT_",
      "prepare-build-tools.sh",
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

  it("fails closed when the bridge manifest drifts from its JSON dependency authority", () => {
    const root = tempRoot();
    const source = readFileSync(canonicalPackageManifest, "utf8");
    const contract = readSourceRootfsShellDependencyContract(
      canonicalDependencyContract,
    );
    const cases = [
      {
        label: "missing",
        source: source.replace('  "nano@8.0",\n', ""),
        error: "missing: nano",
      },
      {
        label: "duplicate",
        source: source.replace(
          '  "nano@8.0",\n',
          '  "nano@8.0",\n  "nano@8.0",\n',
        ),
        error: "dependency names must be unique",
      },
      {
        label: "version-drift",
        source: source.replace('"nano@8.0"', '"nano@8.1"'),
        error: "version drift: nano: expected 8.0, got 8.1",
      },
      {
        label: "extra",
        source: source.replace(
          '  "nano@8.0",\n',
          '  "nano@8.0",\n  "unexpected@1.0.0",\n',
        ),
        error: "extra: unexpected",
      },
    ];

    for (const fixture of cases) {
      const manifest = join(root, `${fixture.label}.toml`);
      writeFileSync(manifest, fixture.source);
      expect(
        () => validateSourceRootfsShellPackageManifest(contract, manifest),
        fixture.label,
      ).toThrow(fixture.error);
    }
  });

  // WHY THIS ASSERTS AGAINST A BUILT IMAGE: the maker account's interactive
  // identity (`/etc/profile.d/00-kandelo-shell.sh`) once shipped absent from
  // this product for weeks while a unit test calling its registrar directly
  // stayed green — the registrar was simply never reached by THIS builder, so
  // every shell-family machine showed `-bash-5.2$` instead of `kandelo$`. A
  // test that exercises a builder helper cannot catch that class of bug; only
  // reading the bytes the product actually ships can.
  //
  // The expectation is derived from `registerShellProfileScripts`, not from a
  // hand-written list, so a script added there is required here automatically.
  it("ships every /etc/profile.d script in the built image", async () => {
    const root = tempRoot();
    const paths = fixturePaths(root);
    await writeRootfs(paths.rootfsPath);
    const image = await buildSourceRootfsShellImage({
      ...paths,
      outFile: join(root, "profile-d.vfs.zst"),
      sourceDateEpoch: "0",
    });
    const fs = MemoryFileSystem.fromImagePreservingCapacity(image);

    const expectedFs = MemoryFileSystem.create(new SharedArrayBuffer(MiB));
    registerShellProfileScripts(expectedFs);
    expect(SHELL_PROFILE_SCRIPT_PATHS).toContain(
      "/etc/profile.d/00-kandelo-shell.sh",
    );
    for (const path of SHELL_PROFILE_SCRIPT_PATHS) {
      expect(text(readVfsFile(fs, path)), path).toBe(
        text(readVfsFile(expectedFs, path)),
      );
    }

    // Name the one value a user sees, so a rewrite that kept the file but
    // dropped the prompt still fails here.
    expect(
      text(readVfsFile(fs, "/etc/profile.d/00-kandelo-shell.sh")),
    ).toContain("export PS1='kandelo$ '");
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
      shellComposition: {
        schema: 1,
        kind: "package-rootfs-shell",
      },
    });
    expect(() => assertSourceRootfsShellImage(firstOut)).not.toThrow();
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
        fs
          .exportLazyArchiveEntries()
          .some((entry) => entry.url === spec.archiveUrl),
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

    // WHY: sdl2, evdev_demo, and espeak-ng were previously fetched from the
    // page origin and written into the image at browser boot. An image the
    // host has to complete after the fact is not self-describing, so this
    // asserts they ship inside the built image itself.
    expect(readVfsFile(fs, "/usr/local/bin/sdl2")).toEqual(
      new Uint8Array(readFileSync(paths.sdl2Path)),
    );
    expect(fs.stat("/usr/local/bin/sdl2").mode & 0o777).toBe(0o755);
    expect(readVfsFile(fs, "/usr/local/bin/evdev_demo")).toEqual(
      new Uint8Array(readFileSync(paths.evdevDemoPath)),
    );
    expect(fs.stat("/usr/local/bin/evdev_demo").mode & 0o777).toBe(0o755);
    expect(readVfsFile(fs, "/usr/bin/espeak-ng")).toEqual(
      new Uint8Array(readFileSync(paths.espeakNgPath)),
    );
    expect(fs.stat("/usr/bin/espeak-ng").mode & 0o777).toBe(0o755);
    // PATH_ESPEAK_DATA is compiled into the binary as /usr/share, so the
    // voice-data zip must land unpacked rather than staying a lazy archive.
    expect(text(readVfsFile(fs, "/usr/share/espeak-ng-data/en/en_dict"))).toBe(
      "espeak voice data fixture",
    );
    // Assert byte-for-byte equality against the tracked source for one
    // image shader and one sound shader: a loose "non-empty" check would
    // pass for a truncated or stubbed preset, which is exactly the kind of
    // silent corruption this composer must not introduce when it moves
    // these files off the browser's Vite ?raw import path.
    for (const shaderPath of [
      "image/plasma.frag",
      "sound/chord.frag",
    ]) {
      const expected = readFileSync(
        join(repoRoot, "programs/sdl2/presets", shaderPath),
        "utf8",
      );
      expect(
        text(readVfsFile(fs, `/usr/share/shaders/${shaderPath}`)),
        shaderPath,
      ).toBe(expected);
    }
    for (const shaderPath of [
      "/usr/share/shaders/image/plasma.frag",
      "/usr/share/shaders/image/audio_bars.frag",
      "/usr/share/shaders/image/tunnelwisp.frag",
      "/usr/share/shaders/sound/tunnelwisp.frag",
      "/usr/share/shaders/sound/sine.frag",
      "/usr/share/shaders/sound/fm_bell.frag",
      "/usr/share/shaders/sound/noise_sweep.frag",
      "/usr/share/shaders/sound/chord.frag",
    ]) {
      expect(readVfsFile(fs, shaderPath).length, shaderPath).toBeGreaterThan(0);
    }
    expect(text(readVfsFile(fs, "/etc/gitconfig"))).toContain(
      "defaultBranch = main",
    );
    expect(text(readVfsFile(fs, "/etc/profile"))).toContain("NETHACKOPTIONS");
    expect(fs.stat("/home/.nethack")).toMatchObject({
      uid: 1000,
      gid: 1000,
    });
    expect(fs.stat("/home/.nethack").mode & 0o777).toBe(0o777);

    const terminalSessionBytes = readVfsFile(
      fs,
      EXPERIMENTAL_TERMINAL_SESSION_PATH,
    );
    expect(parseExperimentalTerminalSession(text(terminalSessionBytes))).toMatchObject({
      initial: { path: "/usr/bin/login", uid: 0, gid: 0 },
      afterExit: { path: "/usr/bin/login", uid: 0, gid: 0 },
    });
    const demoBytes = readVfsFile(fs, KANDELO_DEMO_CONFIG_PATH);
    const demo = parseKandeloDemoConfig(text(demoBytes));
    expect(demo).not.toBeNull();
    validateKandeloDemoConfig(demo!);
    expect(resolveDemoInit(demo!, "shell")).toBeNull();
    expect(resolveDemoInit(demo!, "doom")).toEqual({
      shellCommand: "/usr/local/bin/fbdoom -iwad /doom1.wad",
    });
    expect(resolveDemoPresentation(demo!, "doom")?.touchControls).toBe(true);
    expect(resolveDemoPresentation(demo!, "doom")?.runningPrimary).toEqual([
      "framebuffer",
      "terminal",
      "syslog",
    ]);
    expect(resolveDemoAssets(demo!, "doom")).toEqual([
      {
        path: "/doom1.wad",
        url: DOOM_WAD_URL,
        sha256: DOOM_WAD_SHA256,
        mode: 0o644,
      },
    ]);
    expect(resolveDemoInit(demo!, "modeset")).toEqual({
      shellCommand: "/usr/local/bin/modeset",
    });
    expect(resolveDemoPresentation(demo!, "modeset")?.runningPrimary).toEqual([
      "kms",
      "terminal",
      "syslog",
    ]);
  });

  it("treats structurally identical package-owned profiles as one shared contract", () => {
    const root = tempRoot();
    const packageDemoPath = join(
      repoRoot,
      "packages/registry/shell/source-rootfs-shell-demo.json",
    );
    const overlay = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
        ),
        "utf8",
      ),
    );
    const base = JSON.parse(readFileSync(packageDemoPath, "utf8"));
    base.profiles.doom = overlay.profiles.doom;
    base.profiles.modeset = overlay.profiles.modeset;
    const basePath = join(root, "base-with-owned-profiles.json");
    writeFileSync(basePath, JSON.stringify(base));
    const reverseObjectKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseObjectKeys);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
      );
    };
    const reorderedOverlayPath = join(root, "reordered-overlay.json");
    writeFileSync(
      reorderedOverlayPath,
      JSON.stringify(reverseObjectKeys(overlay)),
    );

    const composed = text(
      composeSourceRootfsDemoConfig(basePath, reorderedOverlayPath),
    );

    // The base entries remain authoritative even when equivalent package
    // overlay JSON uses different formatting and object-key order.
    expect(composed).toBe(`${JSON.stringify(base, null, 2)}\n`);
  });

  it("adds an image-owned overlay profile that is absent from the base", () => {
    const root = tempRoot();
    const base = JSON.parse(readFileSync(
      join(repoRoot, "packages/registry/shell/source-rootfs-shell-demo.json"),
      "utf8",
    ));
    const overlay = JSON.parse(readFileSync(
      join(
        repoRoot,
        "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
      ),
      "utf8",
    ));
    const expectedDoom = overlay.profiles.doom;
    const basePath = join(root, "base-without-doom.json");
    writeFileSync(basePath, JSON.stringify(base));
    const overlayPath = join(
      repoRoot,
      "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
    );

    const composed = parseKandeloDemoConfig(
      text(composeSourceRootfsDemoConfig(basePath, overlayPath)),
    );

    expect(composed).not.toBeNull();
    expect(composed!.profiles?.doom).toEqual(expectedDoom);
    expect(composed!.profiles?.modeset).toEqual(overlay.profiles.modeset);
    expect(composed!.profiles?.shell).toEqual(base.profiles.shell);
  });

  const profileDriftCases: Array<{
    label: string;
    mutate: (overlay: SourceRootfsDemoOverlayFixture) => void;
  }> = [
    {
      label: "nested presentation",
      mutate: (overlay) => {
        overlay.profiles.doom.presentation.runningPrimary = [
          "terminal",
          "framebuffer",
          "syslog",
        ];
      },
    },
    {
      label: "nested asset",
      mutate: (overlay) => {
        overlay.profiles.doom.assets[0].sha256 = "0".repeat(64);
      },
    },
  ];

  it.each(profileDriftCases)(
    "rejects $label drift in an overlapping profile",
    ({
      mutate,
    }: {
      label: string;
      mutate: (overlay: SourceRootfsDemoOverlayFixture) => void;
    }) => {
      const root = tempRoot();
      const overlay = JSON.parse(
        readFileSync(
          join(
            repoRoot,
            "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
          ),
          "utf8",
        ),
      ) as SourceRootfsDemoOverlayFixture;
      const base = JSON.parse(readFileSync(
        join(repoRoot, "packages/registry/shell/source-rootfs-shell-demo.json"),
        "utf8",
      ));
      base.profiles.doom = structuredClone(overlay.profiles.doom);
      base.profiles.modeset = structuredClone(overlay.profiles.modeset);
      const basePath = join(root, "base-with-owned-profiles.json");
      writeFileSync(basePath, JSON.stringify(base));
      mutate(overlay);
      const overlayPath = join(root, "drifted-overlay.json");
      writeFileSync(overlayPath, JSON.stringify(overlay));

      expect(() =>
        composeSourceRootfsDemoConfig(
          basePath,
          overlayPath,
        ),
      ).toThrow(
        "source-rootfs demo profile overlay drifts from base profile doom",
      );
    },
  );

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

  it("rejects terminal metadata that does not identify a rootfs executable", async () => {
    const root = tempRoot();
    const paths = fixturePaths(root);
    await writeRootfs(paths.rootfsPath, ABI_VERSION, "/bin/missing");

    await expect(
      buildSourceRootfsShellImage({
        ...paths,
        outFile: join(root, "missing-shell.vfs.zst"),
        sourceDateEpoch: "0",
      }),
    ).rejects.toThrow("/bin/missing");
  });

  it("rejects a demo profile that no longer launches its owned executable", async () => {
    const root = tempRoot();
    const paths = fixturePaths(root);
    await writeRootfs(paths.rootfsPath);
    const demo = JSON.parse(readFileSync(paths.demoConfigPath, "utf8"));
    delete demo.profiles.doom;
    delete demo.profiles.modeset;
    const demoConfigPath = join(root, "base-without-owned-profiles.json");
    writeFileSync(demoConfigPath, JSON.stringify(demo));
    const demoProfileOverlayPath = join(root, "wrong-demo-command.json");
    writeFileSync(
      demoProfileOverlayPath,
      readFileSync(paths.demoProfileOverlayPath, "utf8").replace(
        '"shellCommand": "/usr/local/bin/modeset"',
        '"shellCommand": "/usr/local/bin/not-modeset"',
      ),
    );

    await expect(
      buildSourceRootfsShellImage({
        ...paths,
        demoConfigPath,
        demoProfileOverlayPath,
        outFile: join(root, "wrong-demo-command.vfs.zst"),
        sourceDateEpoch: "0",
      }),
    ).rejects.toThrow(
      "source-rootfs demo profile modeset must launch /usr/local/bin/modeset",
    );
  });

  it("rejects demo metadata for a program the source image does not own", async () => {
    const root = tempRoot();
    const paths = fixturePaths(root);
    await writeRootfs(paths.rootfsPath);
    const demoProfileOverlayPath = join(root, "unowned-demo-profile.json");
    const overlay = JSON.parse(
      readFileSync(paths.demoProfileOverlayPath, "utf8"),
    );
    overlay.profiles.unowned = {};
    writeFileSync(demoProfileOverlayPath, JSON.stringify(overlay));

    await expect(
      buildSourceRootfsShellImage({
        ...paths,
        demoProfileOverlayPath,
        outFile: join(root, "unowned-demo-profile.vfs.zst"),
        sourceDateEpoch: "0",
      }),
    ).rejects.toThrow(
      "source-rootfs demo profile overlay must contain exactly the image-owned profiles: doom, modeset",
    );
  });

  it("passes only resolver-owned dependency artifacts to an isolated wrapper invocation", async () => {
    const root = tempRoot();
    const outDir = join(root, "out");
    const workDir = join(root, "work");
    const rootfsDir = join(root, "rootfs");
    const bashDir = join(root, "bash");
    const fbdoomDir = join(root, "fbdoom");
    const modesetDir = join(root, "modeset");
    const sdl2Dir = join(root, "sdl2-demo");
    const evdevDemoDir = join(root, "evdev-demo");
    const espeakNgDir = join(root, "espeak-ng");
    const toolDir = join(root, "tools");
    const extendedDependencyDirs = new Map<string, string>();
    for (const dir of [
      outDir,
      workDir,
      rootfsDir,
      bashDir,
      fbdoomDir,
      modesetDir,
      sdl2Dir,
      evdevDemoDir,
      espeakNgDir,
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
    writeFileSync(join(sdl2Dir, "sdl2.wasm"), "sdl2");
    writeFileSync(join(evdevDemoDir, "evdev_demo.wasm"), "evdev_demo");
    writeFileSync(join(espeakNgDir, "espeak-ng.wasm"), "espeak-ng");
    writeFileSync(join(espeakNgDir, "espeak-ng-data.zip"), "espeak-ng-data");
    const logPath = join(root, "composer.log");
    const fakeNode = join(toolDir, "node");
    writeFileSync(
      fakeNode,
      `#!/bin/bash
set -euo pipefail
for name in GH_TOKEN GITHUB_TOKEN NODE_OPTIONS NODE_PATH HTTP_PROXY HTTPS_PROXY; do
  [ "\${!name+x}" != x ] || { echo "ambient variable leaked: $name" >&2; exit 81; }
done
if [[ "\${1:-}" == */packages/registry/shell/source-rootfs-shell-dependency-contract.mjs ]]; then
  [ "\${2:-}" = --print-resolver-owned ]
  [ "\${3:-}" = ${JSON.stringify(canonicalDependencyContract)} ]
  [ "\${4:-}" = ${JSON.stringify(canonicalPackageManifest)} ]
  printf '%s\\n' ${SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES.map(
    (dependency) => `'${dependency}'`,
  ).join(" ")}
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
    execFileSync("/bin/bash", [join(canonicalPackageRoot, "build-shell.sh")], {
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
        WASM_POSIX_DEP_SDL2_DEMO_DIR: sdl2Dir,
        WASM_POSIX_DEP_EVDEV_DEMO_DIR: evdevDemoDir,
        WASM_POSIX_DEP_ESPEAK_NG_DIR: espeakNgDir,
        ...dependencyEnv,
      },
      stdio: "pipe",
    });

    expect(readFileSync(join(outDir, "shell.vfs.zst"), "utf8")).toBe(
      "source-rootfs-shell\n",
    );
    expect(readdirSync(workDir)).toEqual([]);
    const invocation = readFileSync(logPath, "utf8");
    expect(invocation).toContain(`--rootfs ${rootfsDir}/rootfs.vfs`);
    expect(invocation).toContain(`--bash ${bashDir}/bash.wasm`);
    expect(invocation).toContain(`--fbdoom ${fbdoomDir}/fbdoom.wasm`);
    expect(invocation).toContain(`--modeset ${modesetDir}/modeset.wasm`);
    expect(invocation).toContain(`--sdl2 ${sdl2Dir}/sdl2.wasm`);
    expect(invocation).toContain(`--evdev-demo ${evdevDemoDir}/evdev_demo.wasm`);
    expect(invocation).toContain(`--espeak-ng ${espeakNgDir}/espeak-ng.wasm`);
    expect(invocation).toContain(
      `--espeak-ng-data ${espeakNgDir}/espeak-ng-data.zip`,
    );
    expect(invocation).toContain(
      `--demo-profile-overlay ${join(repoRoot, "packages/registry/shell/source-rootfs-shell-demo-profiles.json")}`,
    );
  });
});

function ensureDirRecursiveOnHost(path: string): void {
  mkdirSync(path, { recursive: true });
}
