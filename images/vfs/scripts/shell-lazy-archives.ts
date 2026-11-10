import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../host/src/vfs/image-helpers";
import {
  extractZipEntry,
  parseZipCentralDirectory,
  type ZipEntry,
} from "../../../host/src/vfs/zip";

const symlinkTargetDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const textEncoder = new TextEncoder();

/**
 * The address an image records for a lazy archive: its package-mirror path in
 * the `kandelo-lazy:` grammar the shell's lazy files use. Deployments resolve
 * it to the member by rule (`normalizeImageOwnedLazyReference`), so nothing
 * keeps a list of archive names.
 */
export function shellLazyArchiveAddress(resolverPath: string): string {
  return `kandelo-lazy:${resolverPath}`;
}

/** Shared guest paths whose trust roots are published by ca-certificates. */
export const SHELL_CA_BUNDLE = {
  uri: shellLazyArchiveAddress("programs/ca-certificates.zip"),
  guestPaths: ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"],
} as const;

export interface ShellLazyArchiveSpec {
  id: string;
  dependency: string;
  resolverPath: string;
  /** Derived from `resolverPath` by `shellLazyArchiveAddress`. */
  archiveUrl: string;
  mountPrefix: "/" | `/${string}/`;
  requiredMember: string;
}

function withArchiveAddresses<const T extends readonly Omit<ShellLazyArchiveSpec, "archiveUrl">[]>(
  specs: T,
): readonly (T[number] & { archiveUrl: string })[] {
  return specs.map((spec) => ({ ...spec, archiveUrl: shellLazyArchiveAddress(spec.resolverPath) }));
}

/**
 * `<pkg>-docs` packages that ship a program's upstream manual pages, each with
 * the page whose presence proves the archive is mounted. They all mount at
 * `/usr/`, so pages land in `/usr/share/man`, where the man front-end looks.
 * See docs/porting-guide.md "Shipping man pages".
 */
const UPSTREAM_MAN_PAGE_ARCHIVES = [
  ["attr-docs", "share/man/man1/getfattr.1"],
  ["bash-docs", "share/man/man1/bash.1"],
  ["bc-docs", "share/man/man1/bc.1"],
  ["byacc-docs", "share/man/man1/yacc.1"],
  ["bzip2-docs", "share/man/man1/bzip2.1"],
  ["cage-docs", "share/man/man1/cage.1"],
  ["cpython-docs", "share/man/man1/python3.1"],
  ["curl-docs", "share/man/man1/curl.1"],
  ["dbus-docs", "share/man/man1/dbus-daemon.1"],
  ["diffutils-docs", "share/man/man1/diff.1"],
  ["elinks-docs", "share/man/man1/elinks.1"],
  ["file-docs", "share/man/man1/file.1"],
  ["findutils-docs", "share/man/man1/find.1"],
  ["flex-docs", "share/man/man1/flex.1"],
  ["foot-docs", "share/man/man1/foot.1"],
  ["gawk-docs", "share/man/man1/gawk.1"],
  ["git-docs", "share/man/man1/git.1"],
  ["grep-docs", "share/man/man1/grep.1"],
  ["gzip-docs", "share/man/man1/gzip.1"],
  ["jq-docs", "share/man/man1/jq.1"],
  ["labwc-docs", "share/man/man1/labwc.1"],
  ["less-docs", "share/man/man1/less.1"],
  ["lhasa-docs", "share/man/man1/lha.1"],
  ["love-docs", "share/man/man6/love.6"],
  ["m4-docs", "share/man/man1/m4.1"],
  ["make-docs", "share/man/man1/make.1"],
  ["mandoc-docs", "share/man/man1/man.1"],
  ["mariadb-docs", "share/man/man1/mysql.1"],
  ["nano-docs", "share/man/man1/nano.1"],
  ["netcat-docs", "share/man/man1/netcat.1"],
  ["nethack-docs", "share/man/man6/nethack.6"],
  ["perl-docs", "share/man/man1/perl.1"],
  ["php-docs", "share/man/man1/php.1"],
  ["ruby-docs", "share/man/man1/ruby.1"],
  ["scummvm-docs", "share/man/man6/scummvm.6"],
  ["sed-docs", "share/man/man1/sed.1"],
  ["sfwbar-docs", "share/man/man1/sfwbar.1"],
  ["sway-docs", "share/man/man1/sway.1"],
  ["swaybg-docs", "share/man/man1/swaybg.1"],
  ["tar-docs", "share/man/man1/tar.1"],
  ["tmux-docs", "share/man/man1/tmux.1"],
  ["unzip-docs", "share/man/man1/unzip.1"],
  ["vim-docs", "share/man/man1/vim.1"],
  ["wget-docs", "share/man/man1/wget.1"],
  ["xz-docs", "share/man/man1/xz.1"],
  ["zip-docs", "share/man/man1/zip.1"],
  ["zstd-docs", "share/man/man1/zstd.1"],
] as const;

export const SHELL_LAZY_ARCHIVE_SPECS = withArchiveAddresses([
  {
    id: "rust-docs",
    dependency: "rust-docs",
    resolverPath: "programs/wasm32/rust-docs.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/man/man1/rustc.1",
  },
  {
    id: "rust-profiler-runtime",
    dependency: "rust-profiler-runtime-bundle",
    resolverPath: "programs/wasm32/rust-profiler-runtime.zip",
    mountPrefix: "/usr/",
    requiredMember: "lib/rustlib/wasm32-unknown-kandelo-std/lib/libprofiler_builtins.rlib",
  },
  {
    id: "rust-std",
    dependency: "rustc",
    resolverPath: "programs/wasm32/rustc/rust-std.zip",
    mountPrefix: "/usr/",
    requiredMember: "lib/rustlib/wasm32-unknown-kandelo-std/target.json",
  },
  {
    id: "harper",
    dependency: "harper-browser-bundle",
    resolverPath: "programs/wasm32/harper.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/harper-cli",
  },
  {
    id: "composer",
    dependency: "composer",
    resolverPath: "programs/wasm32/composer.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/composer",
  },
  {
    id: "freeciv",
    dependency: "freeciv-browser-bundle",
    resolverPath: "programs/wasm32/freeciv-browser-bundle/freeciv.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/freeciv-play",
  },
  {
    id: "love-examples",
    dependency: "love",
    resolverPath: "programs/love/share/love-examples.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/love/examples/main.lua",
  },
  {
    id: "vim",
    dependency: "vim-browser-bundle",
    resolverPath: "programs/wasm32/vim.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/vim",
  },
  {
    id: "nethack",
    dependency: "nethack-browser-bundle",
    resolverPath: "programs/wasm32/nethack.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/nethack",
  },
  {
    id: "ruby",
    dependency: "ruby-browser-bundle",
    resolverPath: "programs/wasm32/ruby.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/ruby",
  },
  {
    id: "python",
    dependency: "python-browser-bundle",
    resolverPath: "programs/wasm32/python-browser-bundle/python.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/python3",
  },
  {
    id: "node",
    dependency: "node-browser-bundle",
    resolverPath: "programs/wasm32/node.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/node",
  },
  {
    id: "perl",
    dependency: "perl-browser-bundle",
    resolverPath: "programs/wasm32/perl.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/perl",
  },
  {
    id: "man",
    dependency: "mandoc-browser-bundle",
    resolverPath: "programs/wasm32/man.zip",
    mountPrefix: "/usr/",
    requiredMember: "bin/mandoc",
  },
  {
    id: "coreutils-docs",
    dependency: "coreutils-docs",
    resolverPath: "programs/wasm32/coreutils-docs.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/man/man1/ls.1",
  },
  {
    id: "lsof-docs",
    dependency: "lsof-docs",
    resolverPath: "programs/wasm32/lsof-docs.zip",
    mountPrefix: "/usr/",
    requiredMember: "share/man/man8/lsof.8",
  },
  ...UPSTREAM_MAN_PAGE_ARCHIVES.map(([name, requiredMember]) => ({
    id: name,
    dependency: name,
    resolverPath: `programs/wasm32/${name}.zip`,
    mountPrefix: "/usr/" as const,
    requiredMember,
  })),
  {
    id: "kandelo-sdk",
    dependency: "kandelo-sdk-browser-bundle",
    resolverPath: "programs/wasm32/kandelo-sdk.zip",
    mountPrefix: "/usr/",
    // A regular file: the SDK tool names are symlinks to the driver.
    requiredMember: "bin/kandelo-cc",
  },
] as const);

/** Data the canonical shell can load on first use: trust roots, speech, cursors, keymaps and desktops.
 * Kept separate from the shared tool archives: service-image builders do not
 * declare espeak-ng or wayland-demo and must not acquire those dependencies.
 */
export const SHELL_LAZY_DATA_ARCHIVE_SPECS = withArchiveAddresses([
  {
    id: "cursor-theme",
    dependency: "bibata-cursor-theme",
    resolverPath: "programs/wasm32/bibata-cursor-theme.zip",
    mountPrefix: "/usr/share/",
    requiredMember: "icons/default/index.theme",
  },
  {
    id: "ca-certificates",
    dependency: "ca-certificates",
    resolverPath: "programs/ca-certificates.zip",
    mountPrefix: "/",
    requiredMember: "etc/ssl/cert.pem",
  },
  {
    id: "espeak-ng-data",
    dependency: "espeak-ng",
    resolverPath: "programs/espeak-ng/espeak-ng-data.zip",
    mountPrefix: "/usr/share/espeak-ng-data/",
    requiredMember: "phondata",
  },
  {
    id: "desktop-data",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/kandelo-desktop-data.zip",
    mountPrefix: "/usr/share/kandelo/",
    requiredMember: "themes/tokyo-night/theme.conf",
  },
  {
    // libxkbcommon's compiled-in root. Only Wayland clients and compositors
    // compile keymaps from names, so a shell that never starts a desktop
    // never fetches the 3.3 MB of rules, symbols and geometry.
    id: "xkeyboard-config",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/xkeyboard-config.zip",
    mountPrefix: "/usr/share/X11/xkb/",
    requiredMember: "rules/evdev",
  },
] as const);

/**
 * Every `/etc/profile.d` script the shell image ships, in one call.
 *
 * WHY THIS EXISTS AS A SINGLE ENTRY POINT: two builders produce shell-family
 * images — `shell-vfs-build.ts` (the layered service-demo base) and
 * `source-rootfs-shell-overlay.ts` (the `browser-main-shell` product the
 * browser actually boots). When they each listed the individual
 * `register*ShellProfile` calls, adding one script to the set updated only
 * the builder the author happened to be editing: `00-kandelo-shell.sh` was
 * added to the first and shipped absent from the second, so every
 * shell-family machine lost the maker account's prompt, history file, locale,
 * terminal type, and TLS trust anchors. Adding a script here reaches both
 * images by construction; there is no second list to keep in step.
 */
export function registerShellProfileScripts(
  fs: VfsImageFilesystem,
  includesPackage: (pkg: string) => boolean = () => true,
): void {
  for (const script of SHELL_PROFILE_SCRIPTS) {
    // A partial shell (images/vfs/scripts/shell-selection.ts) omits a script
    // whose package it does not carry: python.sh pointing PYTHONHOME at an
    // absent interpreter would describe software the image does not have.
    if ("owner" in script && !includesPackage(script.owner)) continue;
    script.register(fs);
  }
}

/**
 * The one list. Each entry pairs the guest path with the registrar that
 * writes it, so "what the images ship" and "what a test may assert" are the
 * same declaration rather than two that can disagree.
 */
const SHELL_PROFILE_SCRIPTS = [
  {
    path: "/etc/profile.d/00-kandelo-shell.sh",
    register: registerDemoShellProfile,
  },
  {
    path: "/etc/profile.d/python.sh",
    register: registerPythonShellProfile,
    owner: "python-browser-bundle",
  },
  {
    path: "/etc/profile.d/node.sh",
    register: registerNodeShellProfile,
    owner: "node-browser-bundle",
  },
  {
    path: "/etc/profile.d/man.sh",
    register: registerManShellProfile,
    owner: "mandoc-browser-bundle",
  },
  {
    path: "/etc/profile.d/rust.sh",
    register: registerRustShellProfile,
    owner: "kandelo-rustc",
  },
] as const satisfies ReadonlyArray<{
  path: string;
  register: (fs: VfsImageFilesystem) => void;
  /** The package the script configures, when it configures one. */
  owner?: string;
}>;

/** Guest paths of every script `registerShellProfileScripts` writes. */
export const SHELL_PROFILE_SCRIPT_PATHS: readonly string[] =
  SHELL_PROFILE_SCRIPTS.map((script) => script.path);

export function registerRustShellProfile(fs: VfsImageFilesystem): void {
  ensureDirRecursive(fs, "/etc/profile.d");
  // The prebuilt standard library uses musl's time64 ABI on this target.
  writeVfsFile(fs, "/etc/profile.d/rust.sh",
    "export RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1\n", 0o644);
}

// The maker account's interactive identity: prompt, history file, locale,
// terminal type, and the TLS trust anchors curl/wget/etc. expect at their
// well-known paths. `/bin/login -p -f maker` (the image's
// experimental-terminal-session initial program) sets HOME/USER/LOGNAME/PATH
// from /etc/passwd and preserves the caller's TERM, but nothing sets these
// the rest of the way — that used to be the browser app's job (a SHELL_ENV
// array baked into live-setup.ts); it belongs here instead, so every host
// that boots this image (not just the one browser app) gets the same
// interactive shell. Named with a "00-" prefix so it runs before any other
// profile.d script that wants to override a piece of this baseline (e.g.
// the node image's PS1) for its own derived identity.
export function registerDemoShellProfile(fs: VfsImageFilesystem): void {
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(
    fs,
    "/etc/profile.d/00-kandelo-shell.sh",
    "# The demo account's interactive shell identity. login sets HOME/USER/\n" +
      "# LOGNAME/PATH from /etc/passwd already; this fills in the rest.\n" +
      'if [ "${HOME:-}" = /home/maker ]; then\n' +
      "  export PS1='\\u@\\h:\\W\\$ '\n" +
      '  export HISTFILE="$HOME/.bash_history"\n' +
      "  export TMPDIR=/tmp\n" +
      "  export LANG=en_US.UTF-8\n" +
      "  export TERM=xterm-256color\n" +
      "  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\n" +
      "  export SSL_CERT_DIR=/etc/ssl/certs\n" +
      "fi\n",
    0o644,
  );
}

// The python lazy-archive mounts a statically-linked CPython at /usr/bin with
// its standard library at /usr/lib/python3.13. A static build ships no
// platform-dependent (lib-dynload) modules, so CPython's exec_prefix probe
// fails and prints "Could not find platform dependent libraries <exec_prefix>"
// to stderr on every launch (the pure-Python stdlib still self-locates, so the
// REPL otherwise works). Pinning PYTHONHOME=/usr makes exec_prefix explicit —
// the interpreter stops probing and the REPL starts cleanly. This mirrors the
// dedicated python VFS product, which sets the same value in its boot env.
// Sourced by /etc/profile for interactive login shells.
export function registerPythonShellProfile(fs: VfsImageFilesystem): void {
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(
    fs,
    "/etc/profile.d/python.sh",
    "# Static CPython ships no lib-dynload; pin the prefix so exec_prefix\n" +
      "# resolves without probing and the REPL starts without a warning.\n" +
      "export PYTHONHOME=/usr\n",
    0o644,
  );
}

/**
 * npm's settings for this image.
 *
 * `node`, `npm` and `npx` come from the `node` lazy-archive above, so they
 * are part of the shell image on every machine it carries, and so are the
 * settings npm needs to run here. The cache goes to `/tmp` because that is
 * the ephemeral scratch mount — npm's default (`$HOME/.npm`) would spend the
 * image's own live-filesystem budget on a package cache. The rest turn off
 * npm's interactive decoration: the funding/audit summaries, the progress
 * bar, and the "new version available" check, which needs a network round
 * trip to the registry that has nothing to do with the command being run.
 *
 * WHY THESE ARE IMAGE-WIDE AND NOT PER-MACHINE: the shell image ships one
 * `/etc/profile.d` shared by every profile it declares. These settings are
 * true of npm wherever it runs in this image; the parts of the old
 * node-image profile that named ONE machine — a `spidermonkey-node$` prompt
 * and a seeded `package.json` in `$HOME` — are deliberately not here. A
 * machine's name now comes from its `identity.title` in
 * `/etc/kandelo/demo.json`, and a bare-shell user must not find a stray
 * `package.json` in their home directory.
 */
export function registerNodeShellProfile(fs: VfsImageFilesystem): void {
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(
    fs,
    "/etc/profile.d/node.sh",
    "# npm settings for this image. node/npm/npx arrive from the node\n" +
      "# lazy-archive on first use; the cache lives on the ephemeral /tmp\n" +
      "# scratch mount rather than spending the image's own space, and the\n" +
      "# interactive decoration (funding/audit summaries, progress bar,\n" +
      "# update check) is off.\n" +
      "export npm_config_cache=/tmp/.npm-cache\n" +
      "export npm_config_registry=https://registry.npmjs.org/\n" +
      "export npm_config_fund=false\n" +
      "export npm_config_audit=false\n" +
      "export npm_config_progress=false\n" +
      "export npm_config_update_notifier=false\n" +
      "export NPM_CONFIG_FUND=false\n" +
      "export NPM_CONFIG_AUDIT=false\n" +
      "export NPM_CONFIG_PROGRESS=false\n" +
      "export NPM_CONFIG_UPDATE_NOTIFIER=false\n",
    0o644,
  );
}

// mandoc's `man` front-end pipes to a pager when stdout is a terminal. Page
// through `less -R` (raw mode so mandoc's bold/overstrike and any SGR escape
// sequences render correctly instead of printing as literal escapes); less
// is a shipped shell lazy-archive dependency and lazy-loads on first use,
// same as coreutils' cat. /etc/man.conf gives the manpath root the docs
// archives fill.
export function registerManShellProfile(fs: VfsImageFilesystem): void {
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(
    fs,
    "/etc/profile.d/man.sh",
    "# mandoc: page formatted output through less (raw mode so mandoc's\n" +
      "# bold/overstrike and any SGR escape sequences render correctly\n" +
      "# instead of printing as literal escapes); less is a shell\n" +
      "# lazy-archive dependency and lazy-loads on first use, just like\n" +
      "# coreutils' cat. Search /usr/share/man for man pages.\n" +
      "export MANPAGER='less -R'\n" +
      "export MANPATH=/usr/share/man\n",
    0o644,
  );
}

/**
 * posix-utils-lite installs a raw `man` applet at /usr/bin/man in the base
 * rootfs (cats the raw troff source with no formatting). The mandoc
 * lazy-archive's `bin/man` member mounts a formatting `man` front-end at the
 * exact same path, so registering the archive over an existing applet would
 * throw EEXIST. Clear the applet's entry first so the archive's own symlink
 * can claim /usr/bin/man — mandoc must win. The command has only that one
 * installed location; the image does not create a second /bin/man alias.
 */
export function displacePosixUtilsLiteManApplet(fs: VfsImageFilesystem): void {
  try {
    fs.lstat("/usr/bin/man");
  } catch {
    return;
  }
  fs.unlink("/usr/bin/man");
}

export interface DeclaredShellLazyArchive {
  spec: ShellLazyArchiveSpec;
  sourcePath: string;
  /** The one exact byte sequence used for indexing and integrity metadata. */
  bytes: Uint8Array;
  entries: ZipEntry[];
  symlinkTargets: Map<string, string>;
  integrity: {
    compressedBytes: number;
    sha256: string;
  };
}

export type ShellLazyArchiveResolver = (
  resolverPath: string,
  dependency: string,
) => string;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function readSymlinkTargets(
  dependency: string,
  sourcePath: string,
  bytes: Uint8Array,
  entries: ZipEntry[],
): Map<string, string> {
  const targets = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isSymlink) continue;
    const targetBytes = extractZipEntry(bytes, entry);
    const context = `${dependency} output ${sourcePath} symlink ${entry.fileName}`;
    if (targetBytes.byteLength === 0) {
      throw new Error(`${context} has an empty target`);
    }
    if (targetBytes.includes(0)) {
      throw new Error(`${context} target contains a NUL byte`);
    }

    let target: string;
    try {
      target = symlinkTargetDecoder.decode(targetBytes);
    } catch {
      throw new Error(`${context} target is not valid UTF-8`);
    }
    if (!bytesEqual(targetBytes, textEncoder.encode(target))) {
      throw new Error(`${context} target cannot be preserved byte-for-byte`);
    }
    targets.set(entry.fileName, target);
  }
  return targets;
}

/**
 * Load one declared browser-bundle output through the package resolver.
 *
 * The shell composer must never recreate these ZIPs. The package output is
 * the distribution identity consumed later by Node and browser hosts, so the
 * exact bytes returned here are also the bytes indexed and used to derive the
 * lazy-archive integrity metadata.
 */
export function loadDeclaredShellLazyArchive(
  spec: ShellLazyArchiveSpec,
  resolveArtifact: ShellLazyArchiveResolver,
): DeclaredShellLazyArchive {
  const sourcePath = resolveArtifact(spec.resolverPath, spec.dependency);
  const bytes = new Uint8Array(readFileSync(sourcePath));
  let entries: ZipEntry[];
  try {
    entries = parseZipCentralDirectory(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${spec.dependency} output ${sourcePath} is not a valid lazy ZIP: ${message}`,
    );
  }

  const requiredMemberEntries = entries.filter(
    (entry) =>
      entry.fileName === spec.requiredMember &&
      !entry.isDirectory &&
      !entry.isSymlink,
  );
  if (requiredMemberEntries.length !== 1) {
    throw new Error(
      `${spec.dependency} output ${sourcePath} must contain exactly one ` +
      `regular member ${spec.requiredMember}; found ${requiredMemberEntries.length}`,
    );
  }

  const symlinkTargets = readSymlinkTargets(
    spec.dependency,
    sourcePath,
    bytes,
    entries,
  );

  return {
    spec,
    sourcePath,
    bytes,
    entries,
    symlinkTargets,
    integrity: {
      compressedBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

/** Register one package-owned archive without rebuilding or rereading it. */
export function registerDeclaredShellLazyArchive(
  fs: VfsImageFilesystem,
  spec: ShellLazyArchiveSpec,
  resolveArtifact: ShellLazyArchiveResolver,
): DeclaredShellLazyArchive {
  const archive = loadDeclaredShellLazyArchive(spec, resolveArtifact);
  const integrity = {
    sha256: archive.integrity.sha256,
    bytes: archive.integrity.compressedBytes,
  };
  // The image writer takes the whole archive in one call. The method is
  // optional on the interface, so a filesystem without it must fail loudly
  // here rather than register nothing quietly.
  if (!fs.registerLazyArchive) {
    throw new Error(
      `${spec.archiveUrl}: filesystem cannot register a lazy archive`,
    );
  }
  fs.registerLazyArchive({
    url: spec.archiveUrl,
    entries: archive.entries,
    mountPrefix: spec.mountPrefix,
    symlinkTargets: archive.symlinkTargets,
    integrity,
  });
  return archive;
}

// ── NetHack's shared game state ────────────────────────────────────
//
// NetHack keeps saves, scores, bones and its lock file in one directory shared
// by every player (its compiled-in VAR_PLAYGROUND). Distributions make that
// work for any user without letting users touch each other's games: the
// directory and its files belong to group `games`, players cannot write them,
// and the game binary is set-group-ID `games`. This is the layout Debian's
// nethack-common/nethack-console tmpfiles.d entries and Fedora's spec install,
// and it is upstream's own `make install`, which creates `save/` — the step
// whose absence made every save fail with "Cannot open save file.".
//
// Applied after the archive is registered because `/usr/bin/nethack` is one of
// its members. Its set-group-ID bit is honoured because the archive declares a
// digest the kernel checks before serving any member.

/** Must match NETHACK_VAR_PLAYGROUND in packages/registry/nethack/build-nethack.sh. */
export const NETHACK_PLAYGROUND = "/var/games/nethack";
const NETHACK_BINARY = "/usr/bin/nethack";

/** Install NetHack's playground and binary ownership into the shell image. */
export function installNethackGames(fs: VfsImageFilesystem): void {
  if (!fs.isPathDeferred(NETHACK_BINARY)) {
    throw new Error(`${NETHACK_BINARY} must be registered before its game state`);
  }
  const games = groupId(fs, "games");

  ensureDirRecursive(fs, "/var/games");
  for (const dir of [NETHACK_PLAYGROUND, `${NETHACK_PLAYGROUND}/save`]) {
    ensureDirRecursive(fs, dir);
    fs.chown(dir, 0, games);
    fs.chmod(dir, 0o2775);
  }
  // `perm` must exist: NetHack locks by hard-linking to it. The others are
  // pre-created as Debian does so a fresh image already shows their owner.
  for (const name of ["perm", "record", "logfile", "xlogfile"]) {
    const file = `${NETHACK_PLAYGROUND}/${name}`;
    writeVfsFile(fs, file, "", 0o664);
    fs.chown(file, 0, games);
    fs.chmod(file, 0o664);
  }
  // chown before chmod: a chown may clear set-ID, and the chmod restates it.
  fs.chown(NETHACK_BINARY, 0, games);
  fs.chmod(NETHACK_BINARY, 0o2755);
}

function groupId(fs: VfsImageFilesystem, name: string): number {
  let content: string;
  try {
    content = readVfsText(fs, "/etc/group");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read /etc/group for group ${name}: ${message}`);
  }
  for (const line of content.split("\n")) {
    const [group, , gid] = line.split(":");
    if (group === name && /^[0-9]+$/.test(gid ?? "")) return Number(gid);
  }
  throw new Error(`/etc/group has no ${name} group`);
}

function readVfsText(fs: VfsImageFilesystem, path: string): string {
  const size = fs.stat(path).size;
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.read(fd, bytes.subarray(offset), null, bytes.length - offset);
      if (count <= 0) break;
      offset += count;
    }
    return new TextDecoder().decode(bytes.subarray(0, offset));
  } finally {
    fs.close(fd);
  }
}

// ── Shared runtime terminfo database ───────────────────────────────
//
// Unlike the archives above, the terminfo database is not fetched lazily on
// first use: every ncurses/termcap-linked guest program (less, vim, ...)
// resolves $TERM against /usr/share/terminfo on every run (ncurses is built
// --with-default-terminfo-dir=/usr/share/terminfo), so it must be present
// from boot. It is also small, so materializing it eagerly at build time —
// rather than through the lazy-archive/deferred-tree machinery above — is
// the simplest honest fit.

export const NCURSES_TERMINFO_RUNTIME_FILE = {
  dependency: "ncurses",
  resolverPath: "programs/ncurses/terminfo.zip",
  /** Zip members are rooted at share/terminfo/..., mounted under /usr/. */
  mountPrefix: "/usr/",
  requiredEntry: "share/terminfo/x/xterm-256color",
} as const;

/**
 * Eagerly materialize the package-owned ncurses terminfo database into the
 * image at /usr/share/terminfo. The archive is ncurses's `[[runtime_files]]
 * terminfo.zip` artifact (see packages/registry/ncurses/build-ncurses.sh); the
 * shell composer must never recompile or curate it — it only unpacks the
 * exact declared bytes.
 */
export function populateTerminfoDatabase(
  fs: VfsImageFilesystem,
  resolveArtifact: ShellLazyArchiveResolver,
): void {
  const sourcePath = resolveArtifact(
    NCURSES_TERMINFO_RUNTIME_FILE.resolverPath,
    NCURSES_TERMINFO_RUNTIME_FILE.dependency,
  );
  const bytes = new Uint8Array(readFileSync(sourcePath));
  let entries: ZipEntry[];
  try {
    entries = parseZipCentralDirectory(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ncurses terminfo output ${sourcePath} is not a valid ZIP: ${message}`,
    );
  }

  const requiredEntries = entries.filter(
    (entry) =>
      entry.fileName === NCURSES_TERMINFO_RUNTIME_FILE.requiredEntry &&
      !entry.isDirectory &&
      !entry.isSymlink,
  );
  if (requiredEntries.length !== 1) {
    throw new Error(
      `ncurses terminfo output ${sourcePath} must contain exactly one ` +
        `regular ${NCURSES_TERMINFO_RUNTIME_FILE.requiredEntry}; ` +
        `found ${requiredEntries.length}`,
    );
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.isSymlink) {
      throw new Error(
        `ncurses terminfo output ${sourcePath} has an unexpected symlink ` +
          `entry ${entry.fileName}`,
      );
    }
    const destPath = `${NCURSES_TERMINFO_RUNTIME_FILE.mountPrefix}${entry.fileName}`;
    ensureDirRecursive(fs, dirname(destPath));
    const data = extractZipEntry(bytes, entry);
    writeVfsBinary(fs, destPath, data, (entry.mode & 0o777) || 0o644);
  }
}
