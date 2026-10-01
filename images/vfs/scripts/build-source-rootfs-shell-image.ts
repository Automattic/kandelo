/** Compose the canonical browser shell from resolver-owned package outputs. */
import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  resolveDemoInit,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  parseExperimentalTerminalSession,
  type ExperimentalTerminalProgram,
  type ExperimentalTerminalSession,
} from "../../../web-libs/kandelo-session/src/experimental-terminal-session";
import {
  ensureDirRecursive,
  saveImage,
  sourceDateEpochMilliseconds,
  writeVfsBinary,
  writeVfsFile,
} from "./vfs-image-helpers";
import { SHELL_LAZY_BINARY_SPECS } from "../lib/init/shell-binaries";
import {
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveResolver,
} from "./shell-lazy-archives";
import {
  populateSourceRootfsShellOverlay,
  PACKAGE_ROOTFS_SHELL_COMPOSITION,
} from "./source-rootfs-shell-overlay";

const REGULAR_FILE_MODE = 0o100000;
const DIRECTORY_MODE = 0o040000;
const SYMBOLIC_LINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;
const EXECUTE_BITS = 0o111;

// WHY: the SDL2 GLSL playground's shader presets are repository-owned source
// text, not a resolver-published package artifact — same status as the demo
// config JSON above. Read directly from the tracked programs/ tree rather
// than through a resolver dependency.
const SDL2_PRESET_ROOT = fileURLToPath(
  new URL("../../../programs/sdl2/presets", import.meta.url),
);
const SDL2_SHADER_PRESETS: ReadonlyArray<{
  guestPath: string;
  sourcePath: string;
}> = [
  { guestPath: "image/plasma.frag", sourcePath: "image/plasma.frag" },
  { guestPath: "image/audio_bars.frag", sourcePath: "image/audio_bars.frag" },
  { guestPath: "image/tunnelwisp.frag", sourcePath: "image/tunnelwisp.frag" },
  { guestPath: "sound/tunnelwisp.frag", sourcePath: "sound/tunnelwisp.frag" },
  { guestPath: "sound/sine.frag", sourcePath: "sound/sine.frag" },
  { guestPath: "sound/fm_bell.frag", sourcePath: "sound/fm_bell.frag" },
  { guestPath: "sound/noise_sweep.frag", sourcePath: "sound/noise_sweep.frag" },
  { guestPath: "sound/chord.frag", sourcePath: "sound/chord.frag" },
];

export interface SourceRootfsShellInputs {
  rootfsPath: string;
  bashPath: string;
  wldesktopPath: string;
  omarchydesktopPath: string;
  desktopDataPath: string;
  libinputQuirksPath: string;
  espeakNgDataPath: string;
  demoConfigPath: string;
  demoProfileOverlayPath: string;
  outFile: string;
  resolveArtifact: ShellLazyArchiveResolver;
  sourceDateEpoch?: string;
}

// Every image binds bash as /bin/sh (docs/package-management.md); check
// the sh aliases, not only the bash names, so a regression cannot pass.
const REQUIRED_BASH_ALIASES = [
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/sh",
  "/usr/bin/sh",
] as const;

/**
 * The only Wasm programs this composer may write eagerly, together with every
 * hard link to them (Bash is also /bin/sh). Bash is the account shell: login
 * execs it on every boot, before any machine could benefit from deferring it.
 * Every other program is a lazy file (SHELL_LAZY_BINARY_SPECS).
 * WHY enforce it: each eager byte is downloaded by every visitor before the
 * machine boots, and eager programs accumulate one convenient addition at a
 * time — 2.4 MB of compressed image had grown to 4.1 MB this way.
 */
const EAGER_SHELL_PROGRAMS: ReadonlySet<string> = new Set(["/usr/bin/bash"]);
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
export const SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES = [
  ...readSourceRootfsShellResolverDependencies(),
] as const;
const SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCY_SET = new Set<string>(
  SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES,
);

interface SourceRootfsShellDependencyContract {
  schema: 1;
  dependencies: Array<{
    name: string;
    version: string;
    role: "base-image" | "eager-program" | "eager-file" | "lazy-file" | "lazy-archive";
  }>;
}

function readSourceRootfsShellResolverDependencies(
  path = fileURLToPath(
    new URL(
      "../../../packages/registry/shell/source-rootfs-shell-dependencies.json",
      import.meta.url,
    ),
  ),
): string[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("dependencies" in value) ||
    !Array.isArray(value.dependencies)
  ) {
    throw new Error(`invalid source-rootfs shell dependency contract: ${path}`);
  }
  const contract = value as SourceRootfsShellDependencyContract;
  const dependencies = contract.dependencies
    .filter(
      ({ role }) =>
        role === "lazy-file" || role === "lazy-archive" || role === "eager-file",
    )
    .map(({ name }) => name);
  if (
    dependencies.length === 0 ||
    dependencies.some((name) => !/^[a-z0-9][a-z0-9._-]*$/.test(name)) ||
    new Set(dependencies).size !== dependencies.length
  ) {
    throw new Error(
      `source-rootfs shell resolver dependencies are invalid: ${path}`,
    );
  }
  return dependencies;
}

function readRegularInput(path: string, label: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

/**
 * Unpack a package's data zip under `root`, as ordinary files (0644).
 *
 * For data a program opens from a compiled-in directory by plain open/read —
 * espeak-ng's voices, libinput's device quirks — rather than through the
 * range-mapped reads a lazy archive mount serves.
 */
function unpackDataZip(fs: MemoryFileSystem, root: string, zipBytes: Uint8Array): void {
  ensureDirRecursive(fs, root);
  for (const entry of parseZipCentralDirectory(zipBytes)) {
    if (entry.isDirectory) continue;
    const target = `${root}/${entry.fileName}`;
    ensureDirRecursive(fs, target.slice(0, target.lastIndexOf("/")));
    writeVfsBinary(fs, target, extractZipEntry(zipBytes, entry), 0o644);
  }
}

/**
 * Bake the SDL2 GLSL playground's shader presets into the image.
 *
 * The playground's source-resolution chain is
 *   1. /home/shaders/<mode>/current.frag       (user-editable)
 *   2. /usr/share/shaders/<mode>/<preset>.frag (preset, baked here)
 *   3. built-in fallback compiled into main.c
 * tunnelwisp is the boot default for both modes; the others are loadable
 * through the editor's Ctrl+L preset browser.
 */
function writeSdl2ShaderPresets(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/usr/share/shaders/image");
  ensureDirRecursive(fs, "/usr/share/shaders/sound");
  for (const preset of SDL2_SHADER_PRESETS) {
    const source = decodeUtf8(
      readRegularInput(
        join(SDL2_PRESET_ROOT, preset.sourcePath),
        `sdl2 shader preset ${preset.sourcePath}`,
      ),
      `sdl2 shader preset ${preset.sourcePath}`,
    );
    writeVfsFile(fs, `/usr/share/shaders/${preset.guestPath}`, source);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
}

function loadDemoConfig(path: string, label: string): KandeloDemoConfig {
  const bytes = readRegularInput(path, "demo config");
  if (bytes.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(`${label} exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`);
  }
  const config = parseKandeloDemoConfig(decodeUtf8(bytes, label));
  if (config === null) {
    throw new Error(`${label} has an unsupported version`);
  }
  validateKandeloDemoConfig(config);
  return config;
}

const SOURCE_ROOTFS_DEMO_COMMANDS = {
  doom: {
    executable: "/usr/local/bin/fbdoom",
    command: "/usr/local/bin/fbdoom -iwad /doom1.wad",
  },
  modeset: {
    executable: "/usr/local/bin/modeset",
    command: "/usr/local/bin/modeset",
  },
  quake: {
    executable: "/usr/local/bin/quake",
    command: "/usr/local/bin/quake",
  },
  scummvm: {
    executable: "/usr/local/bin/scummvm",
    command: "/usr/local/bin/scummvm",
  },
} as const;

/**
 * The Quake software demo's launch wrapper, written eagerly to
 * /usr/local/bin/quake. It extracts id1/pak0.pak from id's original shareware
 * archive on first launch using the image's own lazy tools (unzip -> lha), then
 * execs the lazy engine at /usr/bin/quake with the shareware basedir. Using an
 * absolute engine path avoids recursing back into this wrapper via PATH. The
 * step is idempotent and surfaces failure honestly; the engine then reports its
 * own missing-data error rather than faking success.
 */
const QUAKE_LAUNCH_SCRIPT = `#!/bin/sh
set -e
BASE=/usr/share/quake
PAK="$BASE/id1/pak0.pak"
ZIP="$BASE/quake106.zip"
if [ ! -f "$PAK" ] && [ -f "$ZIP" ]; then
    echo "quake: extracting shareware data from quake106.zip..." >&2
    mkdir -p "$BASE/id1"
    cd "$BASE"
    unzip -o "$ZIP" >/dev/null
    lha xf resource.1 >/dev/null 2>&1 || true
    src="$(find "$BASE" -iname 'pak0.pak' 2>/dev/null | head -n1)"
    if [ -n "$src" ] && [ "$src" != "$PAK" ]; then cp "$src" "$PAK"; fi
    if [ -f "$PAK" ]; then
        echo "quake: extracted id1/pak0.pak" >&2
    else
        echo "quake: extraction failed; no pak0.pak produced" >&2
    fi
fi
exec /usr/bin/quake -basedir "$BASE" "$@"
`;

/**
 * The ScummVM demo's launch wrapper, written eagerly to /usr/local/bin/scummvm.
 * It execs the lazy engine at /usr/bin/scummvm (an absolute path, so PATH
 * cannot recurse into this wrapper) after two pieces of setup:
 *
 * - SDL's display follows where it is launched. Inside a Wayland session (a
 *   compositor's socket at $XDG_RUNTIME_DIR/wayland-0, e.g. from Omarchy's
 *   launcher or a terminal on that desktop) SDL picks its Wayland backend and
 *   ScummVM opens as a window. On a bare display (the ScummVM machine) the
 *   video driver is pinned to KMSDRM, and because Kandelo has no libudev,
 *   SDL's evdev layer only finds the kernel's input devices when
 *   SDL_EVDEV_DEVICES lists them (class 2 = keyboard, 1 = mouse). Audio is
 *   OSS either way.
 * - The config lives in the user's home, because ScummVM rewrites it whenever
 *   the user adds a game or changes an option. The first launch seeds it so
 *   the launcher's "Add Game" browser opens in the upload directory.
 *   gui_scale is ScummVM's own user multiplier and stays at its default of
 *   100%; the display's factor comes from SDL's display DPI, which SDL
 *   computes from the physical size the kernel reports on the connector
 *   (KMSDRM) or the compositor reports on wl_output (Wayland).
 *
 * It then stays alive beside the engine to unpack uploads. "Load game data"
 * writes one archive to $GAMES/upload.zip while ScummVM keeps running (the
 * user keeps their place in the launcher), and nothing else can run the
 * extraction: the machine's terminal is ScummVM's. The wrapper polls for the
 * archive — inotify is unimplemented (ENOSYS), and polling is what a watcher
 * falls back to — unzips it in place, and removes it so the peak filesystem
 * cost is one archive plus its contents. The host writes the file in one
 * kernel-worker task, so the wrapper never sees a partial archive.
 */
const SCUMMVM_LAUNCH_SCRIPT = `#!/bin/sh
set -e
GAMES=/usr/share/scummvm-games
INI="\${HOME:-/home/maker}/scummvm.ini"
if [ ! -f "$INI" ]; then
    printf '[scummvm]\\ngui_scale=100\\nbrowser_lastpath=%s\\n' "$GAMES" > "$INI"
fi
export SDL_AUDIODRIVER=dsp
if [ -z "\${XDG_RUNTIME_DIR:-}" ] || [ ! -S "$XDG_RUNTIME_DIR/\${WAYLAND_DISPLAY:-wayland-0}" ]; then
    export SDL_VIDEODRIVER=kmsdrm
    export SDL_EVDEV_DEVICES=2:/dev/input/event0,1:/dev/input/event1
fi
/usr/bin/scummvm --config="$INI" "$@" &
engine=$!
set +e
while kill -0 "$engine" 2>/dev/null; do
    if [ -f "$GAMES/upload.zip" ]; then
        echo "scummvm: extracting uploaded game data..." >&2
        if unzip -o -q "$GAMES/upload.zip" -d "$GAMES"; then
            echo "scummvm: extracted into $GAMES; add it from the launcher" >&2
        else
            echo "scummvm: could not extract the upload (not a zip archive?)" >&2
        fi
        rm -f "$GAMES/upload.zip"
    fi
    sleep 1
done
wait "$engine"
`;

export function composeSourceRootfsDemoConfig(
  basePath: string,
  profileOverlayPath: string,
): Uint8Array {
  const base = loadDemoConfig(basePath, "base demo config");
  const overlay = loadDemoConfig(
    profileOverlayPath,
    "source-rootfs demo profile overlay",
  );
  // Composition merges `profiles` and takes every other top-level field
  // verbatim from the base, so anything else the overlay declares is silently
  // discarded. Reject by ALLOW-LIST rather than by naming the block keys: an
  // enumeration of known blocks rots the moment KandeloDemoConfig grows a key
  // (it already missed `identity`, `runtime`, `init`, `web`, `display`, and
  // `defaultProfile`), and a rotted guard is worse than none because it reads
  // as protection.
  const strayOverlayKeys = Object.keys(overlay)
    .filter((key) => key !== "version" && key !== "profiles")
    .sort();
  if (strayOverlayKeys.length > 0) {
    throw new Error(
      "source-rootfs demo profile overlay must contain only named profiles, "
        + `but declares: ${strayOverlayKeys.join(", ")}`,
    );
  }
  const baseProfiles = base.profiles ?? {};
  const overlayProfiles = overlay.profiles ?? {};
  if (Object.keys(overlayProfiles).length === 0) {
    throw new Error("source-rootfs demo profile overlay has no profiles");
  }
  const expectedProfileIds = Object.keys(SOURCE_ROOTFS_DEMO_COMMANDS).sort();
  const actualProfileIds = Object.keys(overlayProfiles).sort();
  if (
    actualProfileIds.length !== expectedProfileIds.length ||
    actualProfileIds.some(
      (profileId, index) => profileId !== expectedProfileIds[index],
    )
  ) {
    throw new Error(
      "source-rootfs demo profile overlay must contain exactly the " +
        `image-owned profiles: ${expectedProfileIds.join(", ")}`,
    );
  }
  const composedProfiles = { ...baseProfiles };
  for (const profileId of Object.keys(overlayProfiles)) {
    if (Object.hasOwn(baseProfiles, profileId)) {
      // WHY: a package-owned base may already carry these profiles. Accept
      // only an exact structural match so the overlay can neither override nor
      // silently drift from the shared product contract.
      if (
        !isDeepStrictEqual(baseProfiles[profileId], overlayProfiles[profileId])
      ) {
        throw new Error(
          `source-rootfs demo profile overlay drifts from base profile ${profileId}`,
        );
      }
      continue;
    }
    const overlayProfile = overlayProfiles[profileId];
    if (overlayProfile === undefined) {
      throw new Error(
        `source-rootfs demo profile overlay omits profile ${profileId}`,
      );
    }
    composedProfiles[profileId] = overlayProfile;
  }
  const composed: KandeloDemoConfig = {
    ...base,
    profiles: composedProfiles,
  };
  validateKandeloDemoConfig(composed);
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(composed, null, 2)}\n`,
  );
  if (bytes.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(
      `composed demo config exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`,
    );
  }
  return bytes;
}

function requireOwnedDemoCommands(
  fs: MemoryFileSystem,
  demoBytes: Uint8Array,
): void {
  const config = parseKandeloDemoConfig(
    decodeUtf8(demoBytes, "composed demo config"),
  );
  if (config === null) {
    throw new Error("composed demo config has an unsupported version");
  }
  for (const [profileId, expected] of Object.entries(
    SOURCE_ROOTFS_DEMO_COMMANDS,
  )) {
    const init = resolveDemoInit(config, profileId);
    if (init === null || !("shellCommand" in init)
      || init.shellCommand !== expected.command) {
      throw new Error(
        `source-rootfs demo profile ${profileId} must launch ${expected.command}`,
      );
    }
    const stat = fs.stat(expected.executable);
    if (
      (stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE ||
      (stat.mode & EXECUTE_BITS) === 0
    ) {
      throw new Error(
        `source-rootfs demo profile ${profileId} does not own executable ${expected.executable}`,
      );
    }
  }
}

function requireImageExecutable(
  fs: MemoryFileSystem,
  config: ExperimentalTerminalProgram,
): void {
  const stat = (() => {
    try {
      return fs.stat(config.path);
    } catch (error) {
      throw new Error(
        `configured terminal program does not exist in the image: ${config.path}`,
        { cause: error },
      );
    }
  })();
  if ((stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE) {
    throw new Error(`configured terminal program is not a regular file: ${config.path}`);
  }
  if ((stat.mode & EXECUTE_BITS) === 0) {
    throw new Error(`configured terminal program is not executable: ${config.path}`);
  }
}

function readExperimentalTerminalSession(
  fs: MemoryFileSystem,
): ExperimentalTerminalSession {
  let stat;
  try {
    stat = fs.lstat(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  } catch (error) {
    throw new Error(
      `source rootfs is missing ${EXPERIMENTAL_TERMINAL_SESSION_PATH}`,
      { cause: error },
    );
  }
  if ((stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE) {
    throw new Error(`${EXPERIMENTAL_TERMINAL_SESSION_PATH} must be a regular file`);
  }
  if (stat.size > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} exceeds ` +
        `${MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES} bytes`,
    );
  }
  return parseExperimentalTerminalSession(
    decodeUtf8(
      readVfsBytes(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH),
      EXPERIMENTAL_TERMINAL_SESSION_PATH,
    ),
  );
}

interface LazyIdentity {
  ino: number;
  generation?: number;
}

interface BashAliasContract {
  path: string;
  kind: "hardlink" | "symlink";
  target?: string;
}

interface SourceBashIdentity {
  identity: LazyIdentity;
  hardlinkPaths: string[];
  aliases: BashAliasContract[];
}

function sameLazyIdentity(
  entry: { ino: number; generation?: number },
  identity: LazyIdentity,
): boolean {
  return entry.ino === identity.ino && entry.generation === identity.generation;
}

function lazyRecords(
  fs: MemoryFileSystem,
  omittedIdentities: readonly LazyIdentity[] = [],
): {
  files: ReturnType<MemoryFileSystem["exportLazyEntries"]>;
  trees: ReturnType<MemoryFileSystem["exportLazyArchiveEntries"]>;
} {
  return {
    files: fs
      .exportLazyEntries()
      .filter(
        (entry) =>
          !omittedIdentities.some((identity) =>
            sameLazyIdentity(entry, identity)
          ),
      ),
    trees: fs.exportLazyArchiveEntries(),
  };
}

function lazyState(
  fs: MemoryFileSystem,
  omittedIdentities: readonly LazyIdentity[] = [],
): string {
  return JSON.stringify(lazyRecords(fs, omittedIdentities));
}

/** The lazy identity at `path`, or null if `path` is not a lazy file. */
function optionalLazyIdentity(
  fs: MemoryFileSystem,
  path: string,
): LazyIdentity | null {
  const lazy = fs.getLazyEntry(path);
  return lazy === null ? null : { ino: lazy.ino, generation: lazy.generation };
}

/**
 * posix-utils-lite's raw `man` applet (cats the unformatted troff source) may
 * already occupy /usr/bin/man on the imported rootfs. The mandoc lazy-archive
 * (registered by populateSourceRootfsShellOverlay) mounts a formatting `man`
 * front-end at the exact same path and is meant to win, superseding the
 * applet's lazy identity there — an intentional identity change, exactly
 * like Bash's lazy-to-eager materialization above. Verify the supersession
 * actually happened rather than silently accepting either an unrelated
 * change or no change at all.
 */
function requireManSupersededByMandoc(
  fs: MemoryFileSystem,
  priorIdentity: LazyIdentity | null,
): void {
  if (priorIdentity === null) return;
  const stat = fs.lstat("/usr/bin/man");
  if ((stat.mode & FILE_TYPE_MASK) !== SYMBOLIC_LINK_MODE) {
    throw new Error(
      "/usr/bin/man must be superseded by the mandoc archive's symlink",
    );
  }
  if (sameLazyIdentity(stat, priorIdentity)) {
    throw new Error(
      "/usr/bin/man still resolves to the posix-utils-lite applet",
    );
  }
}

function requireExpectedLazyState(
  before: string,
  fs: MemoryFileSystem,
  label: string,
): void {
  const after = lazyState(fs);
  if (after !== before) {
    throw new Error(
      `${label} changed rootfs lazy file or tree identities\n` +
        `before=${before}\nafter=${after}`,
    );
  }
}

function requirePreservedLazyState(
  expected: ReturnType<typeof lazyRecords>,
  fs: MemoryFileSystem,
  label: string,
): void {
  const actual = lazyRecords(fs);
  const actualFiles = new Set(
    actual.files.map((entry) => JSON.stringify(entry)),
  );
  const actualTrees = new Set(
    actual.trees.map((entry) => JSON.stringify(entry)),
  );
  for (const entry of expected.files) {
    if (!actualFiles.has(JSON.stringify(entry))) {
      throw new Error(`${label} changed a rootfs lazy file identity`);
    }
  }
  for (const entry of expected.trees) {
    if (!actualTrees.has(JSON.stringify(entry))) {
      throw new Error(`${label} changed a rootfs lazy tree identity`);
    }
  }
}

function requireCompleteProductShellContract(fs: MemoryFileSystem): void {
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (fs.getLazyEntry(spec.vfsPath) === null) {
      throw new Error(
        `source-rootfs shell omitted production lazy utility ${spec.vfsPath}`,
      );
    }
  }
  const archiveUrls = new Set(
    fs.exportLazyArchiveEntries().map((entry) => entry.url),
  );
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    if (!archiveUrls.has(spec.archiveUrl)) {
      throw new Error(
        `source-rootfs shell omitted production lazy archive ${spec.archiveUrl}`,
      );
    }
  }
  for (const path of [
    "/etc/gitconfig",
    "/etc/profile",
    "/home/.nethack/perm",
    "/home/.nethack/record",
  ]) {
    fs.stat(path);
  }
  const playground = fs.stat("/home/.nethack");
  if (
    playground.uid !== 1000 ||
    playground.gid !== 1000 ||
    (playground.mode & 0o777) !== 0o777
  ) {
    throw new Error("source-rootfs shell lost the NetHack playground contract");
  }
}

function dependencyEnvKey(name: string): string {
  return name.replaceAll("-", "_").toUpperCase();
}

function strictResolverFromDependencyEnvironment(
  env: NodeJS.ProcessEnv,
  declaredDependencies = SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCY_SET,
): ShellLazyArchiveResolver {
  return (resolverPath, requestedDependency) => {
    const dependency =
      requestedDependency === "git-remote-http" ? "git" : requestedDependency;
    if (!declaredDependencies.has(dependency)) {
      throw new Error(
        `source-rootfs shell requested undeclared dependency ${dependency}`,
      );
    }
    const key = `WASM_POSIX_DEP_${dependencyEnvKey(dependency)}_DIR`;
    const root = env[key];
    if (!root) {
      throw new Error(`source-rootfs shell requires resolver directory ${key}`);
    }
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(
        `${key} must be a real resolver-owned directory: ${root}`,
      );
    }
    // A package's program is its output root's basename; a runtime file
    // keeps its path under the package (programs/<pkg>/share/...), which
    // mirrors the package's output tree.
    const packagePrefix = `programs/${dependency}/`;
    const artifact = resolverPath.startsWith(packagePrefix)
      ? join(root, resolverPath.slice(packagePrefix.length))
      : join(root, basename(resolverPath));
    readRegularInput(artifact, `${dependency} dependency output`);
    return artifact;
  };
}

function readVfsBytes(fs: MemoryFileSystem, path: string): Uint8Array {
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

/**
 * Paths of the regular files whose bytes are stored in the image and begin
 * with the Wasm magic. Lazy files and lazy-archive trees are skipped without
 * being read, so the walk never materializes deferred content.
 */
function eagerWasmPrograms(fs: MemoryFileSystem): Set<string> {
  const programs = new Set<string>();
  const magic = new Uint8Array(WASM_MAGIC.length);
  const walk = (dir: string): void => {
    const handle = fs.opendir(dir);
    try {
      for (let entry = fs.readdir(handle); entry; entry = fs.readdir(handle)) {
        if (entry.name === "." || entry.name === "..") continue;
        const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
        if (fs.isPathDeferred(path)) continue;
        const stat = fs.lstat(path);
        const type = stat.mode & FILE_TYPE_MASK;
        if (type === DIRECTORY_MODE) {
          walk(path);
          continue;
        }
        if (
          type !== REGULAR_FILE_MODE ||
          fs.getLazyEntry(path) !== null ||
          stat.size < magic.byteLength
        ) {
          continue;
        }
        const fd = fs.open(path, 0, 0);
        try {
          if (fs.read(fd, magic, null, magic.byteLength) !== magic.byteLength) {
            throw new Error(`short VFS read for ${path}`);
          }
        } finally {
          fs.close(fd);
        }
        if (WASM_MAGIC.every((byte, index) => magic[index] === byte)) {
          programs.add(path);
        }
      }
    } finally {
      fs.closedir(handle);
    }
  };
  walk("/");
  return programs;
}

function requireLazyShellPrograms(
  sourcePrograms: ReadonlySet<string>,
  fs: MemoryFileSystem,
): void {
  const allowedInodes = new Set(
    [...EAGER_SHELL_PROGRAMS].map((path) => fs.stat(path).ino),
  );
  const added = [...eagerWasmPrograms(fs)]
    .filter(
      (path) =>
        !sourcePrograms.has(path) && !allowedInodes.has(fs.lstat(path).ino),
    )
    .sort();
  if (added.length > 0) {
    throw new Error(
      "source-rootfs shell must add programs as lazy files " +
        "(SHELL_LAZY_BINARY_SPECS), but wrote eager Wasm at: " +
        added.join(", "),
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function requireLazyBashIdentity(
  fs: MemoryFileSystem,
): SourceBashIdentity {
  const bashPath = REQUIRED_BASH_ALIASES[0];
  const lazy = fs.getLazyEntry(bashPath);
  if (lazy === null) {
    throw new Error(`${bashPath} must be a lazy source-rootfs entry`);
  }
  const identity = { ino: lazy.ino, generation: lazy.generation };
  const hardlinkPaths = Array.from(
    new Set([lazy.path, ...(lazy.paths ?? [])]),
  ).sort();
  const aliases: BashAliasContract[] = [];
  for (const alias of REQUIRED_BASH_ALIASES) {
    const linkStat = fs.lstat(alias);
    const stat = fs.stat(alias);
    const aliasLazy = fs.getLazyEntry(alias);
    if (
      stat.ino !== lazy.ino ||
      aliasLazy === null ||
      !sameLazyIdentity(aliasLazy, identity)
    ) {
      throw new Error(
        `${alias} must resolve to the complete lazy Bash identity`,
      );
    }
    const fileType = linkStat.mode & FILE_TYPE_MASK;
    if (fileType === REGULAR_FILE_MODE) {
      if (!hardlinkPaths.includes(alias)) {
        throw new Error(
          `${alias} is absent from the lazy Bash hardlink ledger`,
        );
      }
      aliases.push({ path: alias, kind: "hardlink" });
    } else if (fileType === SYMBOLIC_LINK_MODE) {
      aliases.push({
        path: alias,
        kind: "symlink",
        target: fs.readlink(alias),
      });
    } else {
      throw new Error(`${alias} is neither a Bash hardlink nor symlink alias`);
    }
  }
  return { identity, hardlinkPaths, aliases };
}

function requireMaterializedBashIdentity(
  fs: MemoryFileSystem,
  contract: SourceBashIdentity,
  expectedBytes: Uint8Array,
): void {
  const canonicalPath = contract.hardlinkPaths[0];
  if (canonicalPath === undefined) {
    throw new Error("source Bash identity contains no canonical hardlink");
  }
  const canonical = fs.stat(canonicalPath);
  for (const path of contract.hardlinkPaths) {
    const stat = fs.stat(path);
    if (
      stat.ino !== canonical.ino ||
      (stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE ||
      (stat.mode & EXECUTE_BITS) === 0
    ) {
      throw new Error(`${path} lost the materialized Bash hardlink identity`);
    }
    if (fs.getLazyEntry(path) !== null || fs.isPathDeferred(path)) {
      throw new Error(`${path} remained lazy after Bash materialization`);
    }
    if (!bytesEqual(readVfsBytes(fs, path), expectedBytes)) {
      throw new Error(`${path} differs from the resolved Bash dependency`);
    }
  }
  for (const alias of contract.aliases) {
    const linkStat = fs.lstat(alias.path);
    const expectedType =
      alias.kind === "symlink" ? SYMBOLIC_LINK_MODE : REGULAR_FILE_MODE;
    if ((linkStat.mode & FILE_TYPE_MASK) !== expectedType) {
      throw new Error(`${alias.path} changed Bash alias type`);
    }
    if (alias.kind === "symlink" && fs.readlink(alias.path) !== alias.target) {
      throw new Error(`${alias.path} changed Bash symlink target`);
    }
    const stat = fs.stat(alias.path);
    if (stat.ino !== canonical.ino || fs.getLazyEntry(alias.path) !== null) {
      throw new Error(`${alias.path} does not resolve to materialized Bash`);
    }
    if (!bytesEqual(readVfsBytes(fs, alias.path), expectedBytes)) {
      throw new Error(
        `${alias.path} differs from the resolved Bash dependency`,
      );
    }
  }
}

/**
 * Compose and save one deterministic shell artifact.
 *
 * Every package byte comes from an explicit path supplied by the resolver.
 * Repository-owned JSON and TypeScript are the only other inputs; there is no
 * binary resolver, tap checkout, registry lookup, or network fallback here.
 */
export async function buildSourceRootfsShellImage(
  inputs: SourceRootfsShellInputs,
): Promise<Uint8Array> {
  const rootfs = readRegularInput(inputs.rootfsPath, "rootfs dependency");
  const sourceMetadata = MemoryFileSystem.readImageMetadata(rootfs);
  if (sourceMetadata?.kernelAbi !== ABI_VERSION) {
    throw new Error(
      `rootfs dependency must explicitly declare kernel ABI ${ABI_VERSION}; ` +
        `got ${String(sourceMetadata?.kernelAbi)}`,
    );
  }
  const sourceCapacity = MemoryFileSystem.readImageCapacity(rootfs);
  const fs = MemoryFileSystem.fromImagePreservingCapacity(rootfs);
  // WHY: this builder exports and preserves lazy state from an imported image;
  // authenticate atomic seals before the source image gains that authority.
  await fs.verifyImportedLazyAtomicGroupSeals();
  const terminalSession = readExperimentalTerminalSession(fs);
  // The rootfs owns its own eager programs (login); only what this composer
  // adds is held to the lazy default.
  const sourceEagerPrograms = eagerWasmPrograms(fs);
  const demo = composeSourceRootfsDemoConfig(
    inputs.demoConfigPath,
    inputs.demoProfileOverlayPath,
  );

  // WHY: the terminal document is image-owned policy. Validate its programs
  // against the unmodified source rootfs before overlays can accidentally make
  // a missing executable appear present.
  requireImageExecutable(fs, terminalSession.initial);
  if (terminalSession.afterExit !== undefined) {
    requireImageExecutable(fs, terminalSession.afterExit);
  }
  const sourceBash = requireLazyBashIdentity(fs);
  // WHY: mandoc is expected to supersede posix-utils-lite's raw `man` applet
  // at the same VFS path (see requireManSupersededByMandoc below). Capture
  // its prior identity now, alongside Bash's, so the overlay's "nothing else
  // changed" check does not flag this one intentional supersession.
  const priorManIdentity = optionalLazyIdentity(fs, "/usr/bin/man");
  const omittedLazyIdentities = [
    sourceBash.identity,
    ...(priorManIdentity ? [priorManIdentity] : []),
  ];
  const unrelatedLazyBefore = lazyRecords(fs, omittedLazyIdentities);

  const bash = readRegularInput(inputs.bashPath, "bash dependency");
  const wldesktop = readRegularInput(
    inputs.wldesktopPath,
    "wldesktop launcher dependency",
  );
  const omarchydesktop = readRegularInput(
    inputs.omarchydesktopPath,
    "omarchydesktop launcher dependency",
  );
  const desktopData = readRegularInput(
    inputs.desktopDataPath,
    "desktop data dependency",
  );
  const libinputQuirks = readRegularInput(
    inputs.libinputQuirksPath,
    "libinput quirks dependency",
  );
  const espeakNgData = readRegularInput(
    inputs.espeakNgDataPath,
    "espeak-ng data dependency",
  );

  // WHY: Bash remains the ordinary account shell and is therefore eager after
  // login. Opening its canonical alias follows a symlink when present,
  // truncating the one lazy inode while preserving both its
  // hard-link ledger and the rootfs's symlink topology.
  writeVfsBinary(fs, REQUIRED_BASH_ALIASES[0], bash, 0o755);
  requireMaterializedBashIdentity(fs, sourceBash, bash);
  requirePreservedLazyState(unrelatedLazyBefore, fs, "Bash materialization");

  populateSourceRootfsShellOverlay(fs, inputs.resolveArtifact);
  requirePreservedLazyState(
    unrelatedLazyBefore,
    fs,
    "production shell overlay",
  );
  requireManSupersededByMandoc(fs, priorManIdentity);
  requireCompleteProductShellContract(fs);

  ensureDirRecursive(fs, "/usr/local/bin");
  // The desktops' launchers are small scripts, written eagerly. Every Wasm
  // program they exec (wlcompositor, wlterm, foot, Quickshell, ...)
  // is a lazy file registered by the overlay above, so a machine that never
  // starts a desktop never fetches them.
  writeVfsBinary(fs, "/usr/local/bin/wldesktop", wldesktop, 0o755);
  writeVfsBinary(fs, "/usr/local/bin/omarchydesktop", omarchydesktop, 0o755);
  // Configs, themes, .desktop entries, the shell's QML, fontconfig and D-Bus
  // configs, and the font: everything the desktops read is image data here,
  // not page staging.
  unpackDataZip(fs, "/usr/share/kandelo", desktopData);
  // wlcompositor's statically linked libinput reads its device quirks from
  // LIBINPUT_QUIRKS_DIR, compiled in as /usr/share/libinput.
  unpackDataZip(fs, "/usr/share/libinput", libinputQuirks);
  // The Quake engine, unzip, and lha are lazy /usr/bin binaries; only this
  // small extraction+launch wrapper is written eagerly.
  writeVfsBinary(
    fs,
    "/usr/local/bin/quake",
    new TextEncoder().encode(QUAKE_LAUNCH_SCRIPT),
    0o755,
  );
  // The quake profile stages quake106.zip into this basedir at page load, and
  // the wrapper (running as the unprivileged demo user) extracts id1/pak0.pak
  // beneath it. The directory must exist (the asset writer does not create
  // parents) and be world-writable so the demo user can create id1/ and write
  // the extracted pak.
  ensureDirRecursive(fs, "/usr/share");
  ensureDirRecursive(fs, "/usr/share/quake", 0o777);
  // ScummVM: the engine and its GUI data are lazy; only the launch wrapper is
  // eager. Game data is the user's own (no Kandelo package carries a
  // commercial SCUMM title), so the profile takes it as an upload into this
  // directory and the unprivileged demo user unzips it in place — it must be
  // world-writable, like the Quake basedir above.
  writeVfsBinary(
    fs,
    "/usr/local/bin/scummvm",
    new TextEncoder().encode(SCUMMVM_LAUNCH_SCRIPT),
    0o755,
  );
  ensureDirRecursive(fs, "/usr/share/scummvm-games", 0o777);
  // Create the id1 game dir too: the bring-your-own-pak ingest writes
  // /usr/share/quake/id1/pak0.pak directly (host.writeFile requires the parent
  // to exist), and that path must work even offline when no quake106.zip was
  // staged and the wrapper's own `mkdir -p id1` never ran.
  ensureDirRecursive(fs, "/usr/share/quake/id1", 0o777);
  // /usr/bin/espeak-ng itself is a lazy file.
  // libespeak-ng's PATH_ESPEAK_DATA is compiled in as /usr/share.
  unpackDataZip(fs, "/usr/share/espeak-ng-data", espeakNgData);
  writeSdl2ShaderPresets(fs);
  // WHY: the package shell must not promise optional programs it does not own.
  // Bind its extra profiles to executable bytes so a metadata-only edit cannot
  // advertise a demo that boots successfully but never launches its workload.
  requireOwnedDemoCommands(fs, demo);
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, demo, 0o644);

  // Checked before saving so a rejected composition writes no output.
  requireLazyShellPrograms(sourceEagerPrograms, fs);

  // WHY: Bash is the one intentional eager identity. Every other source-rootfs
  // first-use download must retain the same path, URL, size, and tree metadata.
  const composedLazyState = lazyState(fs);

  const image = await saveImage(fs, inputs.outFile, {
    expectedMaxByteLength: sourceCapacity.maxByteLength,
    metadata: {
      ...sourceMetadata,
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "build-source-rootfs-shell-image",
      shellComposition: PACKAGE_ROOTFS_SHELL_COMPOSITION,
    },
    normalizeTimestampsMs: sourceDateEpochMilliseconds(
      inputs.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH,
    ),
  });

  const outputMetadata = MemoryFileSystem.readImageMetadata(image);
  if (outputMetadata?.kernelAbi !== ABI_VERSION) {
    throw new Error("composed shell lost its explicit kernel ABI");
  }
  if (
    MemoryFileSystem.readImageCapacity(image).maxByteLength !==
    sourceCapacity.maxByteLength
  ) {
    throw new Error("composed shell changed the rootfs capacity contract");
  }
  const outputFs = MemoryFileSystem.fromImagePreservingCapacity(image);
  // WHY: post-save assertions are a separate import boundary and must verify
  // the exact serialized seals rather than inherit trust from the source fs.
  await outputFs.verifyImportedLazyAtomicGroupSeals();
  requireMaterializedBashIdentity(outputFs, sourceBash, bash);
  requireExpectedLazyState(
    composedLazyState,
    outputFs,
    "serialized source-rootfs shell",
  );
  requireCompleteProductShellContract(outputFs);
  readExperimentalTerminalSession(outputFs);
  return image;
}

function parseArguments(argv: readonly string[]): SourceRootfsShellInputs {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--rootfs",
    "--bash",
    "--wldesktop",
    "--omarchydesktop",
    "--desktop-data",
    "--libinput-quirks",
    "--espeak-ng-data",
    "--demo-config",
    "--demo-profile-overlay",
    "--dependency-contract",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      !allowed.has(flag) ||
      value === undefined ||
      value.length === 0 ||
      values.has(flag)
    ) {
      throw new Error(
        "usage: build-source-rootfs-shell-image.ts " +
          "--rootfs <rootfs.vfs.zst> --bash <bash.wasm> " +
          "--wldesktop <wldesktop> " +
          "--omarchydesktop <omarchydesktop> " +
          "--desktop-data <kandelo-desktop-data.zip> " +
          "--libinput-quirks <libinput-quirks.zip> " +
          "--espeak-ng-data <espeak-ng-data.zip> " +
          "--demo-config <demo.json> --demo-profile-overlay <profiles.json> " +
          "--dependency-contract <dependencies.json> " +
          "--out <shell.vfs.zst>",
      );
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) {
    throw new Error("source-rootfs shell composer is missing a required input");
  }
  return {
    rootfsPath: values.get("--rootfs")!,
    bashPath: values.get("--bash")!,
    wldesktopPath: values.get("--wldesktop")!,
    omarchydesktopPath: values.get("--omarchydesktop")!,
    desktopDataPath: values.get("--desktop-data")!,
    libinputQuirksPath: values.get("--libinput-quirks")!,
    espeakNgDataPath: values.get("--espeak-ng-data")!,
    demoConfigPath: values.get("--demo-config")!,
    demoProfileOverlayPath: values.get("--demo-profile-overlay")!,
    outFile: values.get("--out")!,
    resolveArtifact: strictResolverFromDependencyEnvironment(
      process.env,
      new Set(
        readSourceRootfsShellResolverDependencies(
          values.get("--dependency-contract")!,
        ),
      ),
    ),
  };
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  buildSourceRootfsShellImage(parseArguments(process.argv.slice(2))).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
