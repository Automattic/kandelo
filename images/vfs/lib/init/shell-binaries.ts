/**
 * GNU coreutils multicall binary command names.
 *
 * Shared by VFS image builders. Each command has one FHS location, even
 * though the implementation is the same multicall executable.
 */
export const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
] as const;

// FHS 3.0 /bin essentials, plus small recovery/shell utilities. Everything
// else belongs in /usr/bin; administrative chroot belongs in /usr/sbin.
const ESSENTIAL_COREUTILS: ReadonlySet<string> = new Set([
  "cat", "chgrp", "chmod", "chown", "cp", "date", "dd", "df", "echo",
  "false", "ln", "ls", "mkdir", "mknod", "mv", "pwd", "rm", "rmdir",
  "sleep", "stty", "sync", "true", "uname",
]);

export function coreutilsCommandPath(name: string): string {
  if (name === "chroot") return "/usr/sbin/chroot";
  return `${ESSENTIAL_COREUTILS.has(name) ? "/bin" : "/usr/bin"}/${name}`;
}

export interface VfsBinarySpec {
  id: string;
  resolverPath: string;
  vfsPath: string;
  symlinks: readonly string[];
  /** Permission bits for the lazy file; programs default to 0755. A
   *  package's runtime data file (not a program) declares 0644. */
  mode?: number;
  /** The package that provides the file, when it is not `id` — a package
   *  whose runtime data files each need their own spec. */
  dependency?: string;
}

export const SHELL_LAZY_URL_PREFIX = "kandelo-lazy:";

/** The package whose output provides `spec`'s file. */
export function shellLazySpecDependency(spec: VfsBinarySpec): string {
  return spec.dependency ?? spec.id;
}

/** The lazy file's permission bits. */
export function shellLazySpecMode(spec: VfsBinarySpec): number {
  return spec.mode ?? 0o755;
}

export function shellLazyPlaceholderUrl(spec: VfsBinarySpec): string {
  return `${SHELL_LAZY_URL_PREFIX}${spec.resolverPath}`;
}

/**
 * Every program the shell image adds, as a lazy file: the image records its
 * path, size and mode, and the bytes are fetched on first read. Lazy is the
 * default because every visitor downloads the eager image before anything
 * boots, while most machines run only a few of these programs. The composer
 * rejects any other Wasm program it would write eagerly (see
 * EAGER_SHELL_PROGRAMS in build-source-rootfs-shell-image.ts).
 */
export const SHELL_LAZY_BINARY_SPECS = [
  { id: "redis-cli", dependency: "redis", resolverPath: "programs/redis/redis-cli.wasm", vfsPath: "/usr/bin/redis-cli", symlinks: [] },
  { id: "mariadb", dependency: "mariadb", resolverPath: "programs/mariadb/mariadb.wasm", vfsPath: "/usr/bin/mariadb", symlinks: ["/usr/bin/mysql"] },
  {
    id: "coreutils",
    resolverPath: "programs/coreutils.wasm",
    vfsPath: "/bin/coreutils",
    symlinks: [...COREUTILS_NAMES, "["].map(coreutilsCommandPath),
  },
  {
    id: "grep",
    resolverPath: "programs/grep.wasm",
    vfsPath: "/bin/grep", symlinks: ["/bin/egrep", "/bin/fgrep"],
  },
  {
    id: "sed",
    resolverPath: "programs/sed.wasm",
    vfsPath: "/bin/sed", symlinks: [],
  },
  { id: "bc", resolverPath: "programs/bc.wasm", vfsPath: "/usr/bin/bc", symlinks: [] },
  { id: "file", resolverPath: "programs/file/file.wasm", vfsPath: "/usr/bin/file", symlinks: [] },
  { id: "less", resolverPath: "programs/less.wasm", vfsPath: "/usr/bin/less", symlinks: [] },
  { id: "m4", resolverPath: "programs/m4.wasm", vfsPath: "/usr/bin/m4", symlinks: [] },
  { id: "make", resolverPath: "programs/make.wasm", vfsPath: "/usr/bin/make", symlinks: [] },
  { id: "tar", resolverPath: "programs/tar.wasm", vfsPath: "/bin/tar", symlinks: [] },
  { id: "curl", resolverPath: "programs/curl.wasm", vfsPath: "/usr/bin/curl", symlinks: [] },
  {
    id: "netcat",
    resolverPath: "programs/netcat/nc.wasm",
    vfsPath: "/usr/bin/nc", symlinks: ["/usr/bin/netcat"],
  },
  { id: "wget", resolverPath: "programs/wget.wasm", vfsPath: "/usr/bin/wget", symlinks: [] },
  { id: "git", resolverPath: "programs/git/git.wasm", vfsPath: "/usr/bin/git", symlinks: [] },
  { id: "jq", resolverPath: "programs/jq.wasm", vfsPath: "/usr/bin/jq", symlinks: [] },
  { id: "wasm-fork-instrument", resolverPath: "programs/wasm-fork-instrument.wasm", vfsPath: "/usr/bin/wasm-fork-instrument", symlinks: [] },
  { id: "php", resolverPath: "programs/php/php.wasm", vfsPath: "/usr/bin/php", symlinks: [] },
  { id: "ffmpeg", resolverPath: "programs/ffmpeg/ffmpeg.wasm", vfsPath: "/usr/bin/ffmpeg", symlinks: [] },
  { id: "ffprobe", dependency: "ffmpeg", resolverPath: "programs/ffmpeg/ffprobe.wasm", vfsPath: "/usr/bin/ffprobe", symlinks: [] },
  { id: "ffplay", dependency: "ffmpeg", resolverPath: "programs/ffmpeg/ffplay.wasm", vfsPath: "/usr/bin/ffplay", symlinks: [] },
  {
    id: "git-remote-http",
    resolverPath: "programs/git/git-remote-http.wasm",
    vfsPath: "/usr/bin/git-remote-http", symlinks: ["/usr/bin/git-remote-https", "/usr/bin/git-remote-ftp", "/usr/bin/git-remote-ftps"],
  },
  {
    id: "gzip",
    resolverPath: "programs/gzip.wasm",
    vfsPath: "/bin/gzip", symlinks: ["/bin/gunzip", "/bin/zcat"],
  },
  {
    id: "bzip2",
    resolverPath: "programs/bzip2.wasm",
    vfsPath: "/usr/bin/bzip2", symlinks: ["/usr/bin/bunzip2", "/usr/bin/bzcat"],
  },
  {
    id: "xz",
    resolverPath: "programs/xz.wasm",
    vfsPath: "/usr/bin/xz", symlinks: ["/usr/bin/unxz", "/usr/bin/xzcat", "/usr/bin/lzma", "/usr/bin/unlzma", "/usr/bin/lzcat"],
  },
  {
    id: "zstd",
    resolverPath: "programs/zstd.wasm",
    vfsPath: "/usr/bin/zstd", symlinks: ["/usr/bin/unzstd", "/usr/bin/zstdcat"],
  },
  { id: "zip", resolverPath: "programs/zip.wasm", vfsPath: "/usr/bin/zip", symlinks: [] },
  {
    id: "unzip",
    resolverPath: "programs/unzip.wasm",
    vfsPath: "/usr/bin/unzip", symlinks: ["/usr/bin/zipinfo", "/usr/bin/funzip"],
  },
  { id: "lsof", resolverPath: "programs/lsof.wasm", vfsPath: "/usr/bin/lsof", symlinks: [] },
  { id: "nano", resolverPath: "programs/nano.wasm", vfsPath: "/usr/bin/nano", symlinks: [] },
  { id: "tmux", resolverPath: "programs/tmux.wasm", vfsPath: "/usr/bin/tmux", symlinks: [] },
  { id: "termchat", resolverPath: "programs/termchat/termchat.wasm", vfsPath: "/usr/bin/termchat", symlinks: [] },
  // The Omarchy desktop's terminal. Large, so it stays lazy: no other
  // machine sharing this image pays to fetch it.
  { id: "foot", resolverPath: "programs/foot.wasm", vfsPath: "/usr/bin/foot", symlinks: [] },
  { id: "love", resolverPath: "programs/love/love.wasm", vfsPath: "/usr/bin/love", symlinks: [] },
  // The cage kiosk compositor (the cage machine's command).
  { id: "cage", resolverPath: "programs/cage/cage.wasm", vfsPath: "/usr/bin/cage", symlinks: [] },
  // The sway machine's compositor, the bar and message clients it execs by
  // name, its IPC client, and the upstream config the session includes
  // with the wallpaper that config names.
  { id: "sway", resolverPath: "programs/sway/sway.wasm", vfsPath: "/usr/bin/sway", symlinks: [] },
  {
    id: "swaybar",
    dependency: "sway",
    resolverPath: "programs/sway/swaybar.wasm",
    vfsPath: "/usr/bin/swaybar",
    symlinks: [],
  },
  {
    id: "swaynag",
    dependency: "sway",
    resolverPath: "programs/sway/swaynag.wasm",
    vfsPath: "/usr/bin/swaynag",
    symlinks: [],
  },
  {
    id: "swaymsg",
    dependency: "sway",
    resolverPath: "programs/sway/swaymsg.wasm",
    vfsPath: "/usr/bin/swaymsg",
    symlinks: [],
  },
  {
    id: "sway-wallpaper",
    dependency: "sway",
    resolverPath: "programs/sway/Sway_Wallpaper_Blue_1920x1080.png",
    vfsPath: "/usr/share/backgrounds/sway/Sway_Wallpaper_Blue_1920x1080.png",
    symlinks: [],
    mode: 0o644,
  },
  // swaybg draws the wallpaper sway's config names; sway execs it by name.
  { id: "swaybg", resolverPath: "programs/swaybg.wasm", vfsPath: "/usr/bin/swaybg", symlinks: [] },
  // Shared desktop panel, its real loadable app menu, configuration and
  // launchers. Keep optional desktop bytes lazy in the ordinary shell image.
  { id: "sfwbar", resolverPath: "programs/sfwbar/sfwbar.wasm", vfsPath: "/usr/bin/sfwbar", symlinks: [] },
  {
    id: "kandelo-sfwbar",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/kandelo-sfwbar",
    vfsPath: "/usr/bin/kandelo-sfwbar",
    symlinks: [],
    mode: 0o755,
  },
  {
    id: "sfwbar-appmenu",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/appmenu.so",
    vfsPath: "/usr/lib/sfwbar/appmenu.so",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "sfwbar-config",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/sfwbar.config",
    vfsPath: "/etc/xdg/sfwbar/sfwbar.config",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "sfwbar-sway-config",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/sway.config",
    vfsPath: "/etc/xdg/sfwbar/sway.config",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "sfwbar-winops",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/winops.widget",
    vfsPath: "/etc/xdg/sfwbar/winops.widget",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "kandelo-terminal",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/kandelo-terminal",
    vfsPath: "/usr/bin/kandelo-terminal",
    symlinks: [],
    mode: 0o755,
  },
  {
    id: "sfwbar-terminal-desktop",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/kandelo-terminal.desktop",
    vfsPath: "/usr/share/applications/kandelo-terminal.desktop",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "sfwbar-scummvm-desktop",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/scummvm.desktop",
    vfsPath: "/usr/share/applications/scummvm.desktop",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "sfwbar-wayland-demo-desktop",
    dependency: "sfwbar",
    resolverPath: "programs/sfwbar/wayland-demo.desktop",
    vfsPath: "/usr/share/applications/wayland-demo.desktop",
    symlinks: [],
    mode: 0o644,
  },
  // The stacking desktop and its notification client stay lazy like sway.
  { id: "labwc", resolverPath: "programs/labwc/labwc.wasm", vfsPath: "/usr/bin/labwc", symlinks: [] },
  {
    id: "labnag",
    dependency: "labwc",
    resolverPath: "programs/labwc/labnag.wasm",
    vfsPath: "/usr/bin/labnag",
    symlinks: [],
  },
  {
    id: "labwc-config",
    dependency: "labwc",
    resolverPath: "programs/labwc/labwc-rc.xml",
    vfsPath: "/etc/xdg/labwc/rc.xml",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "labwc-menu",
    dependency: "labwc",
    resolverPath: "programs/labwc/labwc-menu.xml",
    vfsPath: "/etc/xdg/labwc/menu.xml",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "labwc-foot-config",
    dependency: "labwc",
    resolverPath: "programs/labwc/labwc-foot.ini",
    vfsPath: "/etc/xdg/labwc/foot.ini",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "sway-config",
    dependency: "sway",
    resolverPath: "programs/sway/sway.conf",
    vfsPath: "/etc/sway/config",
    symlinks: [],
    mode: 0o644,
  },
  { id: "dosbox-pure", resolverPath: "programs/dosbox-pure/dosbox-pure.wasm", vfsPath: "/usr/bin/dosbox-pure", symlinks: [] },
  { id: "dos-play", dependency: "dosbox-pure", resolverPath: "programs/dosbox-pure/bin/dos-play", vfsPath: "/usr/bin/dos-play", symlinks: [], mode: 0o755 },
  ...["games.tsv", "DOSDEF-UNLICENSE.txt"].map((file) => ({
    id: `dos-play-${file}`, dependency: "dosbox-pure",
    resolverPath: `programs/dosbox-pure/share/dos-play/${file}`,
    vfsPath: `/usr/share/dos-play/${file}`, symlinks: [], mode: 0o644,
  })),
  // ScummVM: the engine and the GUI data it reads from /usr/share/scummvm
  // (the package's declared runtime_files). /usr/bin/scummvm is the
  // image's launch wrapper, which execs this engine.
  { id: "scummvm", resolverPath: "programs/scummvm/scummvm.wasm", vfsPath: "/usr/libexec/scummvm", symlinks: [] },
  {
    id: "scummvm-theme-remastered",
    dependency: "scummvm",
    resolverPath: "programs/scummvm/share/scummvm/scummremastered.zip",
    vfsPath: "/usr/share/scummvm/scummremastered.zip", symlinks: [],
    mode: 0o644,
  },
  {
    id: "scummvm-theme-modern",
    dependency: "scummvm",
    resolverPath: "programs/scummvm/share/scummvm/scummmodern.zip",
    vfsPath: "/usr/share/scummvm/scummmodern.zip", symlinks: [],
    mode: 0o644,
  },
  {
    id: "scummvm-theme-classic",
    dependency: "scummvm",
    resolverPath: "programs/scummvm/share/scummvm/scummclassic.zip",
    vfsPath: "/usr/share/scummvm/scummclassic.zip", symlinks: [],
    mode: 0o644,
  },
  {
    id: "scummvm-gui-icons",
    dependency: "scummvm",
    resolverPath: "programs/scummvm/share/scummvm/gui-icons.dat",
    vfsPath: "/usr/share/scummvm/gui-icons.dat", symlinks: [],
    mode: 0o644,
  },
  {
    id: "scummvm-fonts",
    dependency: "scummvm",
    resolverPath: "programs/scummvm/share/scummvm/fonts.dat",
    vfsPath: "/usr/share/scummvm/fonts.dat", symlinks: [],
    mode: 0o644,
  },
  // ScummVM's engine plugins (the package's lib/scummvm runtime files).
  // ScummVM dlopen()s only the engine a game needs, so each is its own lazy
  // file: a machine downloads the engines of the games it plays.
  ...[
    "scumm", "sky", "drascula", "dreamweb", "queen", "got", "griffon",
    "lure", "adl", "parallaction", "cge", "cge2", "sludge", "wage",
  ].map((engine) => ({
    id: `scummvm-engine-${engine}`,
    dependency: "scummvm",
    resolverPath: `programs/scummvm/lib/scummvm/lib${engine}.so`,
    vfsPath: `/usr/lib/scummvm/lib${engine}.so`,
    symlinks: [] as string[],
    mode: 0o644,
  })),
  // retro-emulators: three emulators, each a libretro core named for itself
  // and linked with one small frontend, plus a starter ROM for each (the
  // package's declared runtime_files). retro-nes, retro-genesis and
  // retro-snes are shorter names for them. /usr/bin/retro-run is the image's
  // launcher; it picks the emulator from the ROM's contents.
  {
    id: "fceumm",
    dependency: "retro-emulators",
    resolverPath: "programs/retro-emulators/fceumm.wasm",
    vfsPath: "/usr/bin/fceumm",
    symlinks: ["/usr/bin/retro-nes"],
  },
  {
    id: "genesis-plus-gx",
    dependency: "retro-emulators",
    resolverPath: "programs/retro-emulators/genesis-plus-gx.wasm",
    vfsPath: "/usr/bin/genesis-plus-gx",
    symlinks: ["/usr/bin/retro-genesis"],
  },
  {
    id: "snes9x",
    dependency: "retro-emulators",
    resolverPath: "programs/retro-emulators/snes9x.wasm",
    vfsPath: "/usr/bin/snes9x",
    symlinks: ["/usr/bin/retro-snes"],
  },
  {
    id: "retro-emulators-rom-nes",
    dependency: "retro-emulators",
    resolverPath: "programs/retro-emulators/share/retro-emulators/roms/240pee.nes",
    vfsPath: "/usr/share/retro-emulators/roms/240pee.nes",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "retro-emulators-rom-md",
    dependency: "retro-emulators",
    resolverPath: "programs/retro-emulators/share/retro-emulators/roms/240pSuite-md-1.21.bin",
    vfsPath: "/usr/share/retro-emulators/roms/240pSuite-md-1.21.bin",
    symlinks: [],
    mode: 0o644,
  },
  {
    id: "retro-emulators-rom-snes",
    dependency: "retro-emulators",
    resolverPath: "programs/retro-emulators/share/retro-emulators/roms/240pSuite-snes-1.03.sfc",
    vfsPath: "/usr/share/retro-emulators/roms/240pSuite-snes-1.03.sfc",
    symlinks: [],
    mode: 0o644,
  },
  // The Omarchy shell (omarchydesktop starts it) and the Qt client the
  // launcher offers. quickshell.wasm alone is 82 MB.
  { id: "quickshell", resolverPath: "programs/quickshell.wasm", vfsPath: "/usr/bin/quickshell", symlinks: [] },
  { id: "qtgallery", resolverPath: "programs/qtgallery.wasm", vfsPath: "/usr/bin/qtgallery", symlinks: [] },
  {
    id: "dbus",
    resolverPath: "programs/dbus/dbus-daemon.wasm",
    vfsPath: "/usr/bin/dbus-daemon", symlinks: [],
  },
  // The Wayland desktops' in-tree programs. The desktops' launchers exec them
  // by name from PATH; a lazy file is an ordinary executable there, so only a
  // machine that starts a desktop fetches them. notify-send statically links
  // glib and gio (~5.8 MB), which alone would outweigh much of the eager image.
  {
    id: "wlcompositor",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/wlcompositor.wasm",
    vfsPath: "/usr/bin/wlcompositor", symlinks: [],
  },
  {
    id: "wlterm",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/wlterm.wasm",
    vfsPath: "/usr/bin/wlterm", symlinks: [],
  },
  {
    id: "wlclock",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/wlclock.wasm",
    vfsPath: "/usr/bin/wlclock", symlinks: [],
  },
  {
    id: "wlpaint",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/wlpaint.wasm",
    vfsPath: "/usr/bin/wlpaint", symlinks: [],
  },
  {
    id: "klauncher",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/klauncher.wasm",
    vfsPath: "/usr/bin/klauncher", symlinks: [],
  },
  {
    id: "notify-send",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/notify-send.wasm",
    vfsPath: "/usr/bin/notify-send", symlinks: [],
  },
  {
    id: "kclipd",
    dependency: "wayland-demo",
    resolverPath: "programs/wayland-demo/kclipd.wasm",
    vfsPath: "/usr/bin/kclipd", symlinks: [],
  },
  // The single-program machines' workloads. Each machine's profile command
  // execs its program, which is the first read of these bytes.
  {
    id: "sdl2",
    dependency: "sdl2-demo",
    resolverPath: "programs/sdl2.wasm",
    vfsPath: "/usr/bin/sdl2", symlinks: [],
  },
  // /usr/bin/fbdoom is the image's launch wrapper (build-source-rootfs-shell-image.ts).
  { id: "fbdoom", resolverPath: "programs/fbdoom/fbdoom.wasm", vfsPath: "/usr/libexec/fbdoom", symlinks: [] },
  { id: "modeset", resolverPath: "programs/modeset.wasm", vfsPath: "/usr/bin/modeset", symlinks: [] },
  {
    id: "espeak-ng",
    resolverPath: "programs/espeak-ng/espeak-ng.wasm",
    vfsPath: "/usr/bin/espeak-ng", symlinks: [],
  },
  { id: "sqlite-cli", resolverPath: "programs/sqlite3.wasm", vfsPath: "/usr/bin/sqlite3", symlinks: [] },
  { id: "lhasa", resolverPath: "programs/lha.wasm", vfsPath: "/usr/bin/lha", symlinks: [] },
  { id: "tyrquake", resolverPath: "programs/tyrquake/quake.wasm", vfsPath: "/usr/libexec/quake", symlinks: [] },
  { id: "elinks", resolverPath: "programs/elinks.wasm", vfsPath: "/usr/bin/elinks", symlinks: [] },
] as const satisfies readonly VfsBinarySpec[];
