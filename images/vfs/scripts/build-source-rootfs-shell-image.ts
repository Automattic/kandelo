/** Compose the canonical browser shell from resolver-owned package outputs. */
import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ABI_VERSION, ERRNO } from "../../../host/src/generated/abi";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  resolveDemoDockActions,
  resolveDemoInit,
  validateKandeloDemoConfig,
  type DemoDockMenuEntryConfig,
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
  NETHACK_PLAYGROUND,
  SHELL_CA_BUNDLE,
  SHELL_LAZY_ARCHIVE_SPECS,
  SHELL_LAZY_DATA_ARCHIVE_SPECS,
  registerDeclaredShellLazyArchive,
  type ShellLazyArchiveResolver,
} from "./shell-lazy-archives";
import {
  populateSourceRootfsShellOverlay,
  PACKAGE_ROOTFS_SHELL_COMPOSITION,
} from "./source-rootfs-shell-overlay";
import type { ProgramOriginalResolver } from "./program-originals";

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
  caBundlePath: string;
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
  resolveOriginal?: ProgramOriginalResolver;
  sourceDateEpoch?: string;
}

// Every image binds bash as /bin/sh (docs/package-management.md); check
// the sh aliases, not only the bash names, so a regression cannot pass.
const REQUIRED_BASH_ALIASES = [
  "/bin/bash",
  "/bin/sh",
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
const EAGER_SHELL_PROGRAMS: ReadonlySet<string> = new Set(["/bin/bash"]);
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

function requireRegularInput(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
}

function readRegularInput(path: string, label: string): Uint8Array {
  requireRegularInput(path, label);
  return new Uint8Array(readFileSync(path));
}

/**
 * Unpack a package's data zip under `root`, as ordinary files (0644).
 *
 * Used for the small libinput device-quirk database kept available at boot.
 * Optional speech and desktop data use lazy archives instead.
 */
function unpackDataZip(fs: KandeloImageFs, root: string, zipBytes: Uint8Array): void {
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
function writeSdl2ShaderPresets(fs: KandeloImageFs): void {
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
  freeciv: {
    executable: "/usr/bin/freeciv-play",
    command: "/usr/bin/freeciv-play",
  },
  love: {
    executable: "/usr/bin/love",
    command: "/usr/bin/love /usr/share/love/examples/pong",
  },
  doom: {
    executable: "/usr/bin/doom-launch",
    command: "/usr/bin/doom-launch",
  },
  modeset: {
    executable: "/usr/bin/modeset",
    command: "/usr/bin/modeset",
  },
  quake: {
    executable: "/usr/bin/quake",
    command: "/usr/bin/quake",
  },
  scummvm: {
    executable: "/usr/bin/scummvm",
    command: "/usr/bin/scummvm",
  },
  "ffmpeg-fbdev": {
    executable: "/usr/bin/ffmpeg",
    command: "/usr/bin/ffmpeg -nostdin -re -f lavfi -i testsrc=duration=60:size=320x240:rate=10 -f lavfi -i sine=duration=60 -map 0:v -pix_fmt bgra -f fbdev /dev/fb0 -map 1:a -f oss /dev/dsp",
  },
  "ffmpeg-video": {
    executable: "/usr/bin/ffplay",
    command: "/usr/bin/ffplay -loop 0 /usr/share/big-buck-bunny.mp4",
  },
  ffplay: {
    executable: "/usr/bin/ffplay",
    command: "/usr/bin/ffplay -autoexit -f lavfi 'testsrc=duration=60:size=320x240:rate=10[out0];sine=duration=60[out1]'",
  },
} as const;

/**
 * The game machines' supervisor loop, shared by their launch wrappers.
 *
 * Kandelo exchange hands a dropped WAD, pak or zip to a handler running as
 * the handler account (docs/architecture.md, "Kandelo exchange"). The handler
 * puts the file in place and asks the running game to pick it up by sending
 * SIGHUP to the wrapper, whose pid it reads from a pid file. The wrapper runs
 * the engine as its child: on SIGHUP it stops the engine (SIGTERM, then waits
 * so the display is free) and starts it again; when the engine exits for any
 * other reason the wrapper exits with its status, so the shell prompt returns
 * and the machine's dock actions, which stop the display owner and type their
 * own command, work as before. Ctrl+C is forwarded as SIGTERM, which the
 * engine does not ignore in this non-interactive shell (SIGINT is ignored in
 * an asynchronous list).
 *
 * `supervise PIDFILE ARGS...` expects a function `start_engine` that starts
 * the engine in the background with ARGS, its standard input redirected from
 * descriptor 3 (`<&3 3<&-`), and sets `engine` to its pid. Why fd 3: POSIX
 * gives an asynchronous list in a shell without job control /dev/null as its
 * standard input, and these engines read the keyboard from standard input,
 * so an engine started with a bare `&` never saw a key. supervise saves the
 * terminal on fd 3 before the first start.
 */
const SUPERVISE_FUNCTION = `supervise() {
    pidfile="$1"
    shift
    exec 3<&0
    echo $$ > "$pidfile"
    restart=0
    trap 'restart=1; kill -TERM "$engine" 2>/dev/null' HUP
    trap 'kill -TERM "$engine" 2>/dev/null; wait "$engine"; rm -f "$pidfile"; exit 130' INT TERM
    while :; do
        restart=0
        start_engine "$@"
        status=0
        wait "$engine" || status=$?
        # A trapped signal ends the wait early; wait for the engine itself.
        while kill -0 "$engine" 2>/dev/null; do wait "$engine" || status=$?; done
        [ "$restart" = 1 ] || break
    done
    rm -f "$pidfile"
    exit "$status"
}
`;

/**
 * fbDOOM's machine command, /usr/bin/doom-launch: DOOM with the user's
 * WAD when one has been sent to the machine, else the shareware one, under
 * the supervisor above. The doom WAD handler writes the user's WAD and sends
 * SIGHUP, so the next DOOM plays it.
 */
const DOOM_LAUNCH_SCRIPT = `#!/bin/sh
USER_WAD=/var/games/doom/user.wad
${SUPERVISE_FUNCTION}
start_engine() {
    wad=/usr/share/doom/doom1.wad
    [ -f "$USER_WAD" ] && wad="$USER_WAD"
    /usr/bin/fbdoom -iwad "$wad" "$@" <&3 3<&- &
    engine=$!
}
supervise /run/user/1000/doom-launch.pid "$@"
`;

/**
 * The Kandelo exchange handlers for the game machines, run by kxchgd as the
 * handler account with the batch directory as $1. Each acts only while its
 * game's wrapper runs (its pid file names a live process); otherwise the
 * batch goes to the catch-all, which saves it to ~/Downloads, so dropping a
 * .zip on a plain shell is never mistaken for a game upload.
 */
const GAME_HANDLER_PRELUDE = `#!/bin/sh
batch="$1"
status() { setfattr -n user.kandelo.status -v "$1" "$batch" 2>/dev/null || true; }
wrapper_pid() {
    pid=$(cat "$1" 2>/dev/null) && kill -0 "$pid" 2>/dev/null && echo "$pid"
}
first_entry() { for entry in "$batch"/*; do echo "$entry"; return; done; }
`;

const DOOM_LOAD_WAD_HANDLER = `${GAME_HANDLER_PRELUDE}
pid=$(wrapper_pid /run/user/1000/doom-launch.pid) || exec /usr/libexec/kandelo/exchange-save "$batch"
wad=$(first_entry)
cp "$wad" /var/games/doom/user.wad.tmp && mv -f /var/games/doom/user.wad.tmp /var/games/doom/user.wad || {
    status "failed: could not store the WAD"
    exit 1
}
status "loading $(basename "$wad")"
kill -HUP "$pid"
`;

const QUAKE_LOAD_PAK_HANDLER = `${GAME_HANDLER_PRELUDE}
pid=$(wrapper_pid /run/user/1000/quake-launch.pid) || exec /usr/libexec/kandelo/exchange-save "$batch"
pak=$(first_entry)
dest=/var/games/quake/id1/pak0.pak
cp "$pak" "$dest.tmp" && mv -f "$dest.tmp" "$dest" || {
    status "failed: could not store the pak"
    exit 1
}
status "loading $(basename "$pak")"
kill -HUP "$pid"
`;

const SCUMMVM_LOAD_ZIP_HANDLER = `${GAME_HANDLER_PRELUDE}
wrapper_pid /run/user/1000/scummvm-launch.pid >/dev/null || exec /usr/libexec/kandelo/exchange-save "$batch"
GAMES=/var/games/scummvm
for zip in "$batch"/*; do
    if ! unzip -o -q "$zip" -d "$GAMES"; then
        status "failed: $(basename "$zip") is not a zip archive"
        exit 1
    fi
done
status "extracted into $GAMES; add it from the launcher"
`;

/**
 * The emulator launcher, written eagerly to /usr/bin/retro-run. It picks one
 * of the three lazy emulators (fceumm, genesis-plus-gx, snes9x) for a ROM and
 * execs it:
 * `retro-run game.sfc`, passing any further options (`--state FILE`) to the
 * emulator. With no argument it runs the NES starter ROM.
 * `retro-run --identify FILE` prints the system it detected (nes, md, sms, gg
 * or sfc) and exits 0, or exits 1 when FILE is not a ROM. `retro-run --keys
 * [FILE]` prints which key is which button for that ROM's emulator.
 *
 * WHY it reads the ROM instead of trusting its extension: dumps circulate with
 * wrong or generic extensions (.bin, .smc for a HiROM game), so the system is
 * identified the way emulator frontends identify a headerless dump: the iNES
 * magic at offset 0, "SEGA" at 0x100 for Mega Drive, "TMR SEGA" near the end
 * of a Master System or Game Gear ROM, and for SNES the header checksum and
 * its complement at the LoROM/HiROM header offsets (with and without a
 * 512-byte copier header). A file that matches none of them is rejected with
 * a message rather than handed to an arbitrary core.
 *
 * The cores themselves take the system type from the path's extension, so
 * the launcher runs the ROM through a symlink named for what it detected.
 */
const RETRO_RUN_SCRIPT = `#!/bin/bash
# Pick the emulator core for a ROM from the ROM's own bytes, then exec it.
#
# Every process this script starts takes real time on Kandelo, so it reads the
# ROM's first 64 KiB once and does everything else with bash builtins. Probing
# each offset with its own dd|od|tr pipeline took about 25 processes to reach
# the SNES test, and seconds before a SNES game started.
IDENTIFY=""; KEYS=""
case "\${1:-}" in
    --identify) IDENTIFY=1; shift ;;
    --keys) KEYS=1; shift ;;
esac
ROM=\${1:-/usr/share/retro-emulators/roms/240pee.nes}
RUN=\${XDG_RUNTIME_DIR:-/run/user/$UID}/retro

if [ ! -r "$ROM" ] || [ -d "$ROM" ]; then
    echo "retro-run: cannot read ROM: $ROM" >&2
    exit 1
fi

# Every signature below lies in the first 66,016 bytes.
HEX=$(od -An -tx1 -v -N 66016 "$ROM" | tr -d ' \\n')
# $1=offset $2=count -> H=lowercase hex of those bytes (shorter past the end)
hex_at() { H=\${HEX:$(( $1 * 2 )):$(( $2 * 2 ))}; }

# A SNES header stores a checksum and its bitwise complement side by side.
snes_header_at() {
    hex_at "$1" 4
    [ \${#H} -eq 8 ] || return 1
    [ $(( 16#\${H:0:4} ^ 16#\${H:4:4} )) -eq 65535 ]
}

CORE=""; EXT=""
hex_at 0 4
if [ "$H" = "4e45531a" ]; then
    CORE=/usr/bin/fceumm; EXT=nes
else
    hex_at 256 4
    if [ "$H" = "53454741" ]; then
        CORE=/usr/bin/genesis-plus-gx; EXT=md
    fi
fi
if [ -z "$CORE" ]; then
    for off in 32752 16368 8176; do
        hex_at "$off" 8
        if [ "$H" = "544d522053454741" ]; then
            CORE=/usr/bin/genesis-plus-gx; EXT=sms
            # Region nibble: 5-7 are Game Gear, 3-4 are Master System.
            hex_at $((off + 15)) 1
            case \${H:0:1} in 5|6|7) EXT=gg ;; esac
            break
        fi
    done
fi
if [ -z "$CORE" ]; then
    for off in 32732 65500 33244 66012; do
        if snes_header_at "$off"; then
            CORE=/usr/bin/snes9x; EXT=sfc
            break
        fi
    done
fi
if [ -z "$CORE" ]; then
    echo "retro-run: $ROM is not a recognised NES, SNES, Mega Drive, Master System or Game Gear ROM" >&2
    exit 1
fi
# --identify FILE: name the system and stop, for callers deciding whether a
# file is a ROM at all (the ROM exchange handler).
if [ -n "$IDENTIFY" ]; then echo "$EXT"; exit 0; fi

# The cores read the system type from the path's extension, so give the ROM
# a name that carries what its contents said. The rest of the name is the
# ROM's own: FCEUmm takes an iNES 1.0 ROM's TV system from tags such as
# "(E)" or "(Europe)" in it, and a European game named "rom" runs at NTSC
# speed and pitch. Only a conservative character set survives.
NAME=\${ROM##*/}
BASE=\${NAME%.*}
BASE=\${BASE//[^A-Za-z0-9 ._()!,&+-]/_}
BASE=\${BASE:0:120}
case "$BASE" in ""|.*|-*) BASE="rom$BASE" ;; esac
case "$ROM" in /*) ;; *) ROM="$PWD/$ROM" ;; esac
[ -d "$RUN" ] || mkdir -p "$RUN" || exit 1
LINK="$RUN/$BASE.$EXT"
ln -sf "$ROM" "$LINK" || exit 1
[ -n "$KEYS" ] && exec "$CORE" "$LINK" --keys
exec "$CORE" "$LINK" "\${@:2}"
`;

/**
 * kandelo-terminal, written eagerly to /usr/bin/kandelo-terminal: asks the
 * page showing the machine to open a terminal with a command typed at its
 * prompt (web-libs/kandelo-session/src/terminal-request.ts). The ROM exchange
 * handler uses it so a dropped game is a visible, repeatable command.
 */
const KANDELO_TERMINAL_SCRIPT = `#!/bin/sh
# kandelo-terminal [--display] [--title TITLE] COMMAND-LINE
#
# Ask the page showing this machine to open a terminal and type COMMAND-LINE
# at its prompt, as the user would, so the command is visible and can be run
# again from that terminal's history. COMMAND-LINE is one shell command line,
# used as written. --display: the command draws on the framebuffer, so the
# page stops whatever holds the display and shows it.
#
# The request is a Kandelo exchange output of type
# application/x-kandelo-terminal-command. Publishing it fails, and so does
# this command (exit 1), when nothing outside the machine takes outputs; a
# page that does not open terminals keeps it as an ordinary output.
usage() {
    echo "usage: kandelo-terminal [--display] [--title TITLE] COMMAND-LINE" >&2
    exit 2
}
display=""
title=""
while [ $# -gt 0 ]; do
    case "$1" in
        --display) display=1; shift ;;
        --title) [ $# -ge 2 ] || usage; title=$2; shift 2 ;;
        --) shift; break ;;
        -*) usage ;;
        *) break ;;
    esac
done
[ $# -eq 1 ] && [ -n "$1" ] || usage
command=$1
[ -n "$title" ] || title=$command

json_string() {
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')"
}
file=$(mktemp "\${KANDELO_WORK:-\${TMPDIR:-/tmp}}/terminal-request.XXXXXX") || exit 1
{
    printf '{"version":1,"command":%s,"title":%s' "$(json_string "$command")" "$(json_string "$title")"
    [ -z "$display" ] || printf ',"display":"framebuffer"'
    printf '}\\n'
} > "$file" || { rm -f "$file"; exit 1; }
kandelo-publish --mime application/x-kandelo-terminal-command \\
    --name "terminal-\${file##*.}.json" "$file" >/dev/null
rc=$?
rm -f "$file"
exit $rc
`;

/**
 * The Kandelo exchange handler for a dropped ROM, on every shell machine: it
 * keeps the drop in ~/roms and starts the emulator on its first ROM, so
 * dropping a game, or a folder of them, on the machine plays it. The
 * machine's view brings the display forward when the emulator binds /dev/fb0.
 *
 * WHY it takes every drop and reads contents: ROM collections name files
 * .rom, .bin or nothing at all, and arrive as folders, so no extension rule
 * can pick them out. A drop with no ROM in it goes to exchange-save, exactly
 * as the 99-save catch-all would have handled it.
 *
 * The emulator runs outside any terminal (kxchgd gives handlers /dev/null as
 * stdin), so it reads keys from the machine's keyboard device rather than
 * from a terminal (packages/registry/retro-emulators/frontend/main.c).
 *
 * A dropped ROM replaces the game that is playing: the handler stops the
 * emulator a previous drop or a terminal started (its pid file names it) and
 * waits until it is gone, so the display is free. A display held by another
 * program is not taken; the emulator's own failure (EBUSY on /dev/fb0) is
 * reported as the batch's status.
 */
const RETRO_LOAD_ROM_HANDLER = `#!/bin/sh
batch="$1"
status() { setfattr -n user.kandelo.status -v "$1" "$batch" 2>/dev/null || true; }
RUNTIME=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
PIDFILE=$RUNTIME/retro.pid
LOG=$RUNTIME/retro.log

# A ROM is recognised by its contents (retro-run --identify), not its name:
# collections name ROMs .rom, .bin or nothing at all, and arrive as folders.
# Only names that could be a ROM are read, so a dropped photo or archive
# costs one directory walk. The first ROM in path order is played.
could_be_rom() {
    base=\${1##*/}
    case "$base" in
        .*) return 1 ;;
        *.*) ;;
        *) return 0 ;;
    esac
    case "$base" in
        *.[nN][eE][sS]|*.[sS][fF][cC]|*.[sS][mM][cC]|*.[mM][dD]|*.[gG][eE][nN]|*.[sS][mM][dD]) return 0 ;;
        *.[sS][mM][sS]|*.[gG][gG]|*.[rR][oO][mM]|*.[bB][iI][nN]) return 0 ;;
    esac
    return 1
}
rom=$(find "$batch" -type f | sort | while IFS= read -r f; do
    could_be_rom "$f" || continue
    /usr/bin/retro-run --identify "$f" >/dev/null 2>&1 && { printf '%s\\n' "$f"; break; }
done)
# Not a game: what any other drop gets.
[ -n "$rom" ] || exec /usr/libexec/kandelo/exchange-save "$batch"

# The batch is removed when this handler exits, so the drop is kept in
# ~/roms as it arrived: a file as itself, a folder with what is in it.
dir="$HOME/roms"
mkdir -p "$dir" || { status "failed: could not create $dir"; exit 1; }
for entry in "$batch"/*; do
    cp -Rf "$entry" "$dir/" || { status "failed: could not store $(basename "$entry") in $dir"; exit 1; }
done
path=\${rom#"$batch"/}
name=\${rom##*/}

# The game runs as a command in a terminal of its own, typed at the prompt:
# the user sees what the drop ran, and once the game exits, Up and Enter run
# it again. kandelo-terminal asks the page for that terminal. Where nothing
# outside the machine opens one (the Node host, or no page taking outputs),
# the game starts in the background instead, as below.
quoted=$(printf '%s' "$path" | sed "s/'/'\\\\\\\\''/g")
if /usr/bin/kandelo-terminal --display --title "$name" "retro-run ~/roms/'$quoted'" 2>/dev/null; then
    status "opened a terminal: retro-run ~/roms/$path"
    exit 0
fi

old=$(cat "$PIDFILE" 2>/dev/null)
if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    status "stopping the current game"
    kill -TERM "$old"
    tries=0
    while kill -0 "$old" 2>/dev/null; do
        tries=$((tries + 1))
        [ "$tries" -le 50 ] || { status "failed: the running emulator (pid $old) did not stop"; exit 1; }
        sleep 0.1
    done
fi
rm -f "$PIDFILE"

status "starting $name"
/usr/bin/retro-run "$dir/$path" </dev/null >"$LOG" 2>&1 &
pid=$!
# The emulator publishes its pid once it holds the display, sound and
# keyboard. The first start of a core fetches it, which can take a while.
tries=0
while :; do
    [ "$(cat "$PIDFILE" 2>/dev/null)" = "$pid" ] && { status "playing $name"; exit 0; }
    if ! kill -0 "$pid" 2>/dev/null; then
        # The emulator's own lines start with "[" and its key list with
        # "Keys for" or two spaces; the last other line is the error.
        why=$(grep -v -e '^\\[' -e '^Keys for ' -e '^  ' "$LOG" | tail -n 1)
        [ -n "$why" ] || why=$(tail -n 1 "$LOG")
        case "$why" in
            "open /dev/fb0: "*busy*) why="another program holds the display; stop it and drop the ROM again" ;;
        esac
        status "failed: $why"
        exit 1
    fi
    tries=$((tries + 1))
    [ "$tries" -le 1200 ] || { status "failed: the emulator did not start within 2 minutes (see $LOG)"; exit 1; }
    sleep 0.1
done
`;

/** The image's exchange rules (in /etc): the game machines' and the ROM rule. */
const GAME_EXCHANGE_RULES: ReadonlyArray<{ name: string; handler: string; script: string; rule: string }> = [
  {
    name: "50-doom-wad.handler",
    handler: "/usr/libexec/kandelo/doom-load-wad",
    script: DOOM_LOAD_WAD_HANDLER,
    rule: "# A WAD for DOOM: it restarts with it.\nmatch extension .wad\nkind file\nmax-bytes 33554432\nrun /usr/libexec/kandelo/doom-load-wad\n",
  },
  {
    name: "50-quake-pak.handler",
    handler: "/usr/libexec/kandelo/quake-load-pak",
    script: QUAKE_LOAD_PAK_HANDLER,
    rule: "# A pak0.pak for Quake: it restarts with it.\nmatch extension .pak\nkind file\nmax-bytes 33554432\nrun /usr/libexec/kandelo/quake-load-pak\n",
  },
  {
    name: "50-scummvm-zip.handler",
    handler: "/usr/libexec/kandelo/scummvm-load-zip",
    script: SCUMMVM_LOAD_ZIP_HANDLER,
    rule: "# Game data for ScummVM, zipped: extracted for its launcher.\nmatch extension .zip\nkind file\nmax-bytes 536870912\nrun /usr/libexec/kandelo/scummvm-load-zip\n",
  },
  {
    // Sorted after the game machines' rules and before the 99-save
    // catch-all: it takes every drop, plays one holding a ROM, and hands
    // anything else to exchange-save as the catch-all would.
    name: "90-retro-rom.handler",
    handler: "/usr/libexec/kandelo/retro-load-rom",
    script: RETRO_LOAD_ROM_HANDLER,
    rule: [
      "# A drop holding a NES, SNES, Mega Drive, Master System or Game Gear",
      "# ROM, whatever it is named: kept in ~/roms and played. Anything",
      "# else is saved to ~/Downloads, as the 99-save catch-all would.",
      "kind any",
      "max-bytes 16777216",
      "run /usr/libexec/kandelo/retro-load-rom",
      "",
    ].join("\n"),
  },
];

/**
 * The Quake software demo's launch wrapper, written eagerly to
 * /usr/bin/quake. It extracts id1/pak0.pak from id's original shareware
 * archive on first launch using the image's own lazy tools (unzip -> lha), then
 * execs the lazy engine at /usr/libexec/quake with the shareware basedir. Using an
 * absolute engine path avoids recursing back into this wrapper via PATH. The
 * step is idempotent and surfaces failure honestly; the engine then reports its
 * own missing-data error rather than faking success. The engine runs under
 * the supervisor, so a pak0.pak sent to the machine restarts it.
 */
const QUAKE_LAUNCH_SCRIPT = `#!/bin/sh
set -e
BASE=/var/games/quake
PAK="$BASE/id1/pak0.pak"
ZIP=/usr/share/quake/quake106.zip
if [ ! -f "$PAK" ] && [ -f "$ZIP" ]; then
    /usr/bin/quake-data shareware "$ZIP" "$BASE"
fi
${SUPERVISE_FUNCTION}
start_engine() {
    /usr/libexec/quake -basedir "$BASE" "$@" <&3 3<&- &
    engine=$!
}
supervise /run/user/1000/quake-launch.pid "$@"
`;

/**
 * fbDOOM's launch wrapper, written eagerly to /usr/bin/fbdoom; the
 * engine is the lazy /usr/libexec/fbdoom. Doom keeps its settings in the user's
 * config file ($HOME/.fdoom.tar/default.cfg, read at startup and saved again
 * when Doom quits; fbdoom's 0009 patch restores both) and has no system-wide
 * one. As a distribution's skeleton files would, the wrapper writes
 * this machine's defaults into a missing config on first launch:
 *
 * - screenblocks 10: the full-width view with the status bar. Doom's own
 *   default, 9, insets the view inside a tiled border; 11 hides the status
 *   bar. Doom's menu (Options, Screen Size) still changes it, and the choice
 *   is saved like any other setting.
 *
 * Keys missing from the file keep Doom's defaults, and an existing config is
 * never touched. exec keeps the process the display's owner, so the machine's
 * dock and "Load WAD" signal Doom itself.
 */
const FBDOOM_LAUNCH_SCRIPT = `#!/bin/sh
if [ -n "\${HOME:-}" ] && [ ! -e "$HOME/.fdoom.tar/default.cfg" ]; then
    mkdir -p "$HOME/.fdoom.tar" && printf 'screenblocks 10\\n' > "$HOME/.fdoom.tar/default.cfg"
fi
exec /usr/libexec/fbdoom "$@"
`;

/**
 * The ScummVM demo's launch wrapper, written eagerly to /usr/bin/scummvm.
 * It execs the lazy engine at /usr/libexec/scummvm (an absolute path, so PATH
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
 * The engine runs under the shared supervisor. Zipped game data sent to the
 * machine (Kandelo exchange) is extracted into $GAMES by the scummvm zip
 * handler while ScummVM keeps running, so the user keeps their place in the
 * launcher; the handler acts only while this wrapper's pid file names it.
 *
 * Because the engine runs as an asynchronous list in a non-interactive shell,
 * POSIX has it start with SIGINT and SIGQUIT ignored, so Ctrl+C at the
 * machine's terminal (and the ScummVM machine's dock action, which sends
 * exactly that) would kill only this wrapper and orphan an engine still
 * holding the display. The supervisor forwards the interrupt as SIGTERM,
 * which the engine does not ignore (SDL turns it into a normal quit), and
 * waits for it, so the shell prompt returns only once the display is free.
 */
const SCUMMVM_LAUNCH_SCRIPT = `#!/bin/sh
set -e
GAMES=/var/games/scummvm
INI="\${HOME:-/home/maker}/scummvm.ini"
if [ ! -f "$INI" ]; then
    printf '[scummvm]\\ngui_scale=100\\nbrowser_lastpath=%s\\n' "$GAMES" > "$INI"
fi
export SDL_AUDIODRIVER=dsp
if [ -z "\${XDG_RUNTIME_DIR:-}" ] || [ ! -S "$XDG_RUNTIME_DIR/\${WAYLAND_DISPLAY:-wayland-0}" ]; then
    export SDL_VIDEODRIVER=kmsdrm
    export SDL_EVDEV_DEVICES=2:/dev/input/event0,1:/dev/input/event1
fi
set +e
${SUPERVISE_FUNCTION}
start_engine() {
    /usr/libexec/scummvm --config="$INI" "$@" <&3 3<&- &
    engine=$!
}
supervise /run/user/1000/scummvm-launch.pid "$@"
`;

/**
 * The freeware games the ScummVM machine can fetch: one tracked data file,
 * repository-owned like the demo config and the SDL2 presets, read directly.
 *
 * The rights holders made these games freeware and the ScummVM project
 * distributes them. No package carries one: `scummvm-play` downloads the
 * archive from inside the machine the first time it is asked to, through
 * the guest's ordinary HTTPS path (in a browser, the machine's CORS proxy,
 * because downloads.scummvm.org grants no CORS). The file therefore lands in
 * the image as the catalog that script reads, and the ScummVM profile's dock
 * menu in /etc/kandelo/demo.json must list exactly its games
 * (`requireScummvmFreewareMenu`), so a menu entry can never name a game the
 * machine cannot fetch, nor a fetchable game go missing from the menu.
 *
 * A game the catalog knows but this build cannot run is `unavailable`, with
 * the reason: the menu shows it disabled, so the gap stays visible.
 */
const SCUMMVM_FREEWARE_CATALOG_SOURCE = fileURLToPath(
  new URL("../../../packages/registry/shell/scummvm-freeware-games.json", import.meta.url),
);
const SCUMMVM_PLAY_CATALOG = "/usr/share/scummvm-play/games.tsv";
const SCUMMVM_PLAY_COMMAND = "/usr/bin/scummvm-play";
/** The dock action whose menu lists the catalog. */
const SCUMMVM_FREEWARE_MENU_ACTION = "freeware";

export interface ScummvmFreewareGame {
  id: string;
  title: string;
  /** The engine plugin the game loads (lib<engine>.so). */
  engine: string;
  url: string;
  /** The digest ScummVM publishes beside the archive (<archive>.sha256). */
  sha256: string;
  /**
   * The archive's size. scummvm-play reports progress against it: guest
   * downloads reach the program as chunked responses, so curl itself never
   * learns the total.
   */
  bytes: number;
}

export interface ScummvmFreewareCatalog {
  games: ScummvmFreewareGame[];
  unavailable: Array<{ id: string; title: string; reason: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadScummvmFreewareCatalog(
  path = SCUMMVM_FREEWARE_CATALOG_SOURCE,
): ScummvmFreewareCatalog {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const fail = (message: string): never => {
    throw new Error(`ScummVM freeware catalog ${path}: ${message}`);
  };
  if (!isRecord(value) || value.version !== 1) fail("must be version 1");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.games) || !Array.isArray(record.unavailable)) {
    fail("must list games and unavailable");
  }
  const ids = new Set<string>();
  const id = (entry: Record<string, unknown>): string => {
    const value = entry.id;
    // An id is a scummvm-play argument and a directory name.
    if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      fail(`invalid id ${JSON.stringify(value)}`);
    }
    if (ids.has(value as string)) fail(`duplicate id ${value}`);
    ids.add(value as string);
    return value as string;
  };
  // Titles become one TSV field and a status line.
  const text = (value: unknown, field: string): string =>
    typeof value === "string" && value.length > 0 && !/[\t\r\n]/.test(value)
      ? value
      : fail(`${field} must be one line of text`);
  const games = (record.games as unknown[]).map((entry): ScummvmFreewareGame => {
    if (!isRecord(entry)) fail("every game must be an object");
    const game = entry as Record<string, unknown>;
    const gameId = id(game);
    // The builder names no URL itself (nothing it composes is fetched at
    // build time), so the catalog's are checked by their parts.
    const url = typeof game.url === "string" && URL.canParse(game.url)
      ? new URL(game.url)
      : null;
    if (
      url === null
      || url.protocol !== "https:"
      || url.hostname !== "downloads.scummvm.org"
      || !url.pathname.startsWith("/frs/")
    ) {
      fail(`${gameId} must download over HTTPS from the ScummVM project's /frs/ archive`);
    }
    if (typeof game.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(game.sha256)) {
      fail(`${gameId} needs a lowercase hex SHA-256`);
    }
    if (!Number.isSafeInteger(game.bytes) || (game.bytes as number) <= 0) {
      fail(`${gameId} needs its archive size in bytes`);
    }
    return {
      id: gameId,
      title: text(game.title, `${gameId}.title`),
      engine: text(game.engine, `${gameId}.engine`),
      url: game.url as string,
      sha256: game.sha256 as string,
      bytes: game.bytes as number,
    };
  });
  const unavailable = (record.unavailable as unknown[]).map((entry) => {
    if (!isRecord(entry)) fail("every unavailable game must be an object");
    const game = entry as Record<string, unknown>;
    const gameId = id(game);
    return {
      id: gameId,
      title: text(game.title, `${gameId}.title`),
      reason: text(game.reason, `${gameId}.reason`),
    };
  });
  return { games, unavailable };
}

/** "69 MB", or "59 KB" below a megabyte: the menu's and the script's size. */
export function formatDownloadSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${Math.round(bytes / 1_000_000)} MB`
    : `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

/** The dock menu entries the catalog requires, in catalog order. */
export function scummvmFreewareMenuEntries(
  catalog: ScummvmFreewareCatalog,
): DemoDockMenuEntryConfig[] {
  return [
    ...catalog.games.map((game) => ({
      id: game.id,
      label: game.title,
      detail: formatDownloadSize(game.bytes),
      restart: `${SCUMMVM_PLAY_COMMAND} ${game.id}`,
    })),
    ...catalog.unavailable.map((game) => ({
      id: game.id,
      label: game.title,
      unavailable: game.reason,
    })),
  ];
}

/** One game per line: id, bytes, size label, SHA-256, URL, title. */
function scummvmPlayCatalogTsv(catalog: ScummvmFreewareCatalog): string {
  return catalog.games
    .map((game) => [
      game.id,
      String(game.bytes),
      formatDownloadSize(game.bytes),
      game.sha256,
      game.url,
      game.title,
    ].join("\t") + "\n")
    .join("");
}

/**
 * `/usr/bin/scummvm-play GAME`, the ScummVM machine's dock actions:
 * fetch a catalog game, verify it, unpack it, and start it. `--list` prints
 * the catalog, so the same games are a command away in the terminal.
 *
 * - Archives larger than the proxy's 100 MiB response limit start with
 *   32 MiB ranges; smaller archives start with one request. On failure both
 *   switch to 16 MiB ranges and keep every complete range. The download
 *   runs in the background so the script can report progress against the
 *   catalog's size, including the active attempt, and the trap stops it on
 *   Ctrl+C:
 *   a background job in a non-interactive shell ignores SIGINT, so the
 *   dock's interrupt would otherwise leave curl running.
 * - The SHA-256 makes a changed or truncated download a loud failure instead
 *   of a game that half-starts. The archive is deleted once unpacked, so the
 *   filesystem holds one copy, beside the game's own licence files.
 * - ScummVM itself finds the game: `--add --recursive` runs only its
 *   detection (compiled into the program, so no engine plugin loads) and
 *   records each game it adds as a launcher target. One target starts
 *   directly; a collection (the WAGE games) opens the launcher instead.
 *   `.targets` is written last, so a session that stopped partway fetches
 *   again rather than trusting a partial unpack.
 *
 * Every step announces itself as a `scummvm-play: ` line and the download
 * as a `#### N%` line: the dock shows both while the display is dark.
 */
export const SCUMMVM_PLAY_SCRIPT = `#!/bin/sh
set -e
CATALOG=${SCUMMVM_PLAY_CATALOG}
GAMES=/var/games/scummvm
TAB=$(printf '\\t')
RANGE_LIMIT=$((100 * 1024 * 1024))
RANGE_SIZE=$((32 * 1024 * 1024))
FALLBACK_SIZE=$((16 * 1024 * 1024))
MAX_ATTEMPTS=3
say() { echo "scummvm-play: $*" >&2; }
download() {
    expected_status=$1
    expected_bytes=$2
    max_attempts=$3
    shift 3
    attempt=1
    while [ "$attempt" -le "$max_attempts" ]; do
        rm -f "$ZIP.part" "$ZIP.status"
        curl -fsSL -o "$ZIP.part" -w '%{http_code}' "$@" "$URL" > "$ZIP.status" &
        fetch=$!
        trap 'kill "$fetch" 2>/dev/null; rm -f "$ZIP" "$ZIP.part" "$ZIP.status"; exit 130' INT TERM
        while kill -0 "$fetch" 2>/dev/null; do
            got=0
            if [ -f "$ZIP" ]; then got=$(wc -c < "$ZIP"); fi
            if [ -f "$ZIP.part" ]; then got=$((got + $(wc -c < "$ZIP.part"))); fi
            percent=$((got * 100 / BYTES))
            if [ "$percent" -gt 99 ]; then percent=99; fi
            printf '#### %d%%\\r' "$percent" >&2
            sleep 1
        done
        status=0
        wait "$fetch" || status=$?
        response=$(cat "$ZIP.status" 2>/dev/null || true)
        received=0
        if [ -f "$ZIP.part" ]; then received=$(wc -c < "$ZIP.part"); fi
        if [ "$status" -eq 0 ] && [ "$response" = "$expected_status" ] &&
           [ "$received" -eq "$expected_bytes" ]; then
            if [ "$expected_status" = 206 ]; then
                if ! cat "$ZIP.part" >> "$ZIP"; then return 1; fi
            elif ! mv "$ZIP.part" "$ZIP"; then
                return 1
            fi
            rm -f "$ZIP.part" "$ZIP.status"
            trap - INT TERM
            return 0
        fi
        rm -f "$ZIP.part" "$ZIP.status"
        if [ "$expected_status" = 206 ] && [ "$response" = 200 ]; then
            trap - INT TERM
            return 2
        fi
        if [ "$attempt" -eq "$max_attempts" ]; then break; fi
        attempt=$((attempt + 1))
        say "Retrying download (attempt $attempt/$max_attempts)..."
        sleep "$((attempt - 1))"
    done
    trap - INT TERM
    return 1
}
download_ranges() {
    chunk_size=$1
    attempts=$2
    : > "$ZIP"
    offset=0
    while [ "$offset" -lt "$BYTES" ]; do
        end=$((offset + chunk_size - 1))
        if [ "$end" -ge "$BYTES" ]; then end=$((BYTES - 1)); fi
        if download 206 "$((end - offset + 1))" "$attempts" -r "$offset-$end"; then
            offset=$((end + 1))
        else
            range_status=$?
            if [ "$chunk_size" -eq "$FALLBACK_SIZE" ]; then return "$range_status"; fi
            say "Retrying in 16 MiB ranges..."
            chunk_size=$FALLBACK_SIZE
            attempts=$MAX_ATTEMPTS
        fi
    done
}
if [ "\${1:-}" = "--list" ]; then
    cut -f1,3,6 "$CATALOG"
    exit 0
fi
case "\${1:-}" in
    ""|*[!a-z0-9-]*)
        echo "usage: scummvm-play GAME (scummvm-play --list shows the games)" >&2
        exit 2
        ;;
esac
LINE=$(grep "^$1$TAB" "$CATALOG" || true)
if [ -z "$LINE" ]; then
    say "No game called $1 (scummvm-play --list shows the games)"
    exit 2
fi
IFS="$TAB" read -r ID BYTES SIZE SHA256 URL TITLE <<ROW
$LINE
ROW
DIR="$GAMES/$ID"
ZIP="$GAMES/$ID.zip"
if [ ! -f "$DIR/.targets" ]; then
    say "Downloading $TITLE ($SIZE) from downloads.scummvm.org..."
    rm -f "$ZIP" "$ZIP.part" "$ZIP.status"
    downloaded=0
    if [ "$BYTES" -gt "$RANGE_LIMIT" ]; then
        if download_ranges "$RANGE_SIZE" 1; then downloaded=1; fi
    elif download 200 "$BYTES" 1; then
        downloaded=1
    else
        say "Retrying in 16 MiB ranges..."
        if download_ranges "$FALLBACK_SIZE" "$MAX_ATTEMPTS"; then
            downloaded=1
        elif [ "$?" -eq 2 ]; then
            say "Range requests unavailable; retrying the full download..."
            rm -f "$ZIP"
            if download 200 "$BYTES" "$((MAX_ATTEMPTS - 1))"; then downloaded=1; fi
        fi
    fi
    if [ "$downloaded" -eq 0 ]; then
        rm -f "$ZIP" "$ZIP.part" "$ZIP.status"
        say "Download failed"
        exit 1
    fi
    rm -f "$ZIP.status"
    printf '#### 100%%\\n' >&2
    say "Verifying the download (SHA-256)..."
    if ! echo "$SHA256  $ZIP" | sha256sum -c - >/dev/null 2>&1; then
        rm -f "$ZIP"
        say "Checksum mismatch; refusing to run the download"
        exit 1
    fi
    say "Unpacking the game..."
    rm -rf "$DIR"
    mkdir -p "$DIR"
    if ! unzip -o -q "$ZIP" -d "$DIR"; then
        rm -rf "$ZIP" "$DIR"
        say "Unpacking failed"
        exit 1
    fi
    rm -f "$ZIP"
    say "Adding it to ScummVM..."
    /usr/bin/scummvm --add --recursive -p "$DIR" \\
        | sed -n 's/^  Target: *//p' > "$DIR/.targets.partial"
    mv "$DIR/.targets.partial" "$DIR/.targets"
fi
if [ "$(grep -c . "$DIR/.targets" || true)" = 1 ]; then
    say "Starting $TITLE..."
    exec /usr/bin/scummvm "$(cat "$DIR/.targets")"
fi
say "Opening the ScummVM launcher; $TITLE is in its game list"
exec /usr/bin/scummvm
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
  fs: KandeloImageFs,
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

/**
 * The ScummVM profile's dock actions may run only catalog games, and its
 * freeware menu must list the whole catalog, in order. The overlay JSON is
 * tracked so the browser can read the menu without building the image; this
 * keeps that copy and the catalog from drifting apart.
 */
function requireScummvmFreewareMenu(
  demoBytes: Uint8Array,
  catalog: ScummvmFreewareCatalog,
): void {
  const config = parseKandeloDemoConfig(decodeUtf8(demoBytes, "composed demo config"));
  if (config === null) {
    throw new Error("composed demo config has an unsupported version");
  }
  const actions = resolveDemoDockActions(config, "scummvm");
  const gameIds = new Set(catalog.games.map((game) => game.id));
  for (const action of actions) {
    if (!("restart" in action)) continue;
    const gameId = action.restart.startsWith(`${SCUMMVM_PLAY_COMMAND} `)
      ? action.restart.slice(SCUMMVM_PLAY_COMMAND.length + 1)
      : "";
    if (!gameIds.has(gameId)) {
      throw new Error(
        `scummvm dock action ${action.id} must run ${SCUMMVM_PLAY_COMMAND} with a catalog game`,
      );
    }
  }
  const menu = actions.find((action) => action.id === SCUMMVM_FREEWARE_MENU_ACTION);
  const expected = scummvmFreewareMenuEntries(catalog);
  if (menu === undefined || !("menu" in menu) || !isDeepStrictEqual(menu.menu, expected)) {
    throw new Error(
      `scummvm dock action ${SCUMMVM_FREEWARE_MENU_ACTION} must list the freeware `
        + "catalog (packages/registry/shell/scummvm-freeware-games.json); expected menu:\n"
        + JSON.stringify(expected, null, 2),
    );
  }
}

function requireImageExecutable(
  fs: KandeloImageFs,
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
  fs: KandeloImageFs,
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

/**
 * Identity is the inode NUMBER alone, where it used to be the inode number and
 * a generation counter.
 *
 * The counter existed because inode numbers can be REUSED: delete a file and a
 * later one may take its number, so two different files would compare equal.
 * The module mints inode numbers from a counter that only rises and never
 * hands one back, so within a build an inode number identifies one file for
 * the whole life of the tree, and there is nothing for a generation to
 * disambiguate.
 *
 * `bigint` because the module's inode numbers are 64-bit; comparing them
 * loosely would defeat the point of comparing them at all.
 */
function sameLazyIdentity(
  entry: { ino: number | bigint },
  identity: LazyIdentity,
): boolean {
  return Number(entry.ino) === identity.ino;
}

type LazyRecords = {
  files: ReturnType<KandeloImageFs["lazyEntries"]>["files"];
  trees: ReturnType<KandeloImageFs["lazyEntries"]>["archives"];
};

function lazyRecords(
  fs: KandeloImageFs,
  omittedIdentities: readonly LazyIdentity[] = [],
): LazyRecords {
  const { files, archives } = fs.lazyEntries();
  return {
    files: files.filter(
      (entry) =>
        !omittedIdentities.some((identity) => sameLazyIdentity(entry, identity)),
    ),
    trees: archives,
  };
}

/**
 * The lazy state that must survive a SAVE.
 *
 * Inode numbers are deliberately dropped. The writer assigns them when it lays
 * out the image, so a saved copy legitimately renumbers every file -- comparing
 * them across a serialization asserts that the writer did NOT do its job.
 *
 * What is compared is what a save must not change: WHICH paths are deferred,
 * how big each really is, which archive backs it, and the fetch description it
 * carries. A lost file, a changed size, a re-pointed archive or a dropped
 * description all still fail this.
 */
function serializedLazyState(
  fs: KandeloImageFs,
  omittedIdentities: readonly LazyIdentity[] = [],
): string {
  const { files, trees } = lazyRecords(fs, omittedIdentities);
  const withoutIno = ({ ino: _ino, ...rest }: { ino: bigint }) => rest;
  return stableJson({ files: files.map(withoutIno), trees });
}

/**
 * Render a lazy record as text for comparison.
 *
 * `JSON.stringify` THROWS on a `bigint` and renders a `Uint8Array` as an object
 * of indices, and a lazy record carries both: inode numbers are 64-bit and a
 * fetch description is bytes. The descriptor is rendered as hex because it is
 * OPAQUE -- decoding it to print something friendlier would make this
 * comparison depend on a format the kernel promises not to read.
 *
 * It is ONE function because it was briefly two: `lazyState` got the replacer
 * and `requirePreservedLazyState` kept a bare `JSON.stringify`, so the second
 * threw "Do not know how to serialize a BigInt" in a product build that the
 * test suites never reached. Two renderers of the same record could also drift
 * into disagreeing about equality, which is worse than throwing.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    typeof inner === "bigint"
      ? inner.toString()
      : inner instanceof Uint8Array
        ? Buffer.from(inner).toString("hex")
        : inner,
  );
}

/** The lazy identity at `path`, or null if `path` is not a lazy file. */
function optionalLazyIdentity(
  fs: KandeloImageFs,
  path: string,
): LazyIdentity | null {
  if (!fs.isPathDeferred(path)) return null;
  return { ino: Number(fs.lstat(path).ino) };
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
  fs: KandeloImageFs,
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
  fs: KandeloImageFs,
  label: string,
): void {
  const after = serializedLazyState(fs);
  if (after !== before) {
    throw new Error(
      `${label} changed rootfs lazy file or tree identities\n` +
        `before=${before}\nafter=${after}`,
    );
  }
}

function requirePreservedLazyState(
  expected: LazyRecords,
  fs: KandeloImageFs,
  label: string,
): void {
  const actual = lazyRecords(fs);
  const actualFiles = new Set(actual.files.map(stableJson));
  const actualTrees = new Set(actual.trees.map(stableJson));
  for (const entry of expected.files) {
    if (!actualFiles.has(stableJson(entry))) {
      throw new Error(`${label} changed a rootfs lazy file identity`);
    }
  }
  for (const entry of expected.trees) {
    if (!actualTrees.has(stableJson(entry))) {
      throw new Error(`${label} changed a rootfs lazy tree identity`);
    }
  }
}

function requireCompleteProductShellContract(fs: KandeloImageFs): void {
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (!fs.isPathDeferred(spec.vfsPath)) {
      throw new Error(
        `source-rootfs shell omitted production lazy utility ${spec.vfsPath}`,
      );
    }
  }
  // Asked of the TREE rather than of a list of URLs. The contract being checked
  // is that the shipped shell can actually run each of these -- which is that
  // the member is present and still deferred, not that some table mentions a
  // URL. A URL is the archive's transport and lives in the fetch description
  // the kernel carries without reading; a rebuild that changed one would fail
  // this check while shipping exactly the right contents.
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    const member = `${spec.mountPrefix}${spec.requiredMember}`;
    if (!fs.isPathDeferred(member)) {
      throw new Error(
        `source-rootfs shell omitted production lazy archive ${spec.archiveUrl}` +
          ` (${member} is not a deferred member of it)`,
      );
    }
  }
  for (const path of [
    "/etc/gitconfig",
    "/etc/profile",
    "/home/projects",
    `${NETHACK_PLAYGROUND}/perm`,
    `${NETHACK_PLAYGROUND}/record`,
  ]) {
    fs.stat(path);
  }
  // Group-owned state written only through the set-group-ID binary, so every
  // user can save and none can edit another's game.
  const nethack = fs.stat("/usr/bin/nethack");
  const playground = fs.stat(NETHACK_PLAYGROUND);
  const save = fs.stat(`${NETHACK_PLAYGROUND}/save`);
  const projects = fs.stat("/home/projects");
  if (
    projects.uid !== 1000 ||
    projects.gid !== 1000 ||
    (projects.mode & 0o777) !== 0o755
  ) {
    throw new Error("source-rootfs shell lost the persistent projects directory contract");
  }
  if (
    nethack.uid !== 0 ||
    (nethack.mode & 0o7777) !== 0o2755 ||
    [playground, save].some((dir) =>
      dir.uid !== 0 || dir.gid !== nethack.gid || (dir.mode & 0o7777) !== 0o2775
    )
  ) {
    throw new Error("source-rootfs shell lost the NetHack playground contract");
  }
}

function removeEagerShellCaBundle(fs: KandeloImageFs, zipBytes: Uint8Array): void {
  const entries = parseZipCentralDirectory(zipBytes).filter(entry => !entry.isDirectory);
  if (entries.length !== SHELL_CA_BUNDLE.guestPaths.length) {
    throw new Error("CA archive must contain exactly the two trust-root files");
  }
  const stats = SHELL_CA_BUNDLE.guestPaths.map((path) => {
    const entry = entries.find(entry => `/${entry.fileName}` === path);
    const stat = fs.lstat(path);
    if (!entry || entry.isSymlink ||
        (stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE ||
        (stat.mode & 0o7777) !== 0o644 || stat.uid !== 0 || stat.gid !== 0 ||
        stat.deferred || !Buffer.from(fs.readFile(path)).equals(extractZipEntry(zipBytes, entry))) {
      throw new Error(`rootfs CA bundle does not match its declared artifact: ${path}`);
    }
    return stat;
  });
  if (stats[0].ino === stats[1].ino) {
    throw new Error("rootfs CA paths must be independently replaceable files");
  }
  // WHY: the verified archive replaces these with two independent lazy files.
  // Removing a copied eager file is required before registering its lazy entry.
  for (const path of SHELL_CA_BUNDLE.guestPaths) fs.unlink(path);
}

function requireLazyShellData(fs: KandeloImageFs): void {
  for (const path of SHELL_CA_BUNDLE.guestPaths) {
    if (!fs.isPathDeferred(path)) {
      throw new Error(`source-rootfs shell must defer CA data ${path}`);
    }
  }
  for (const spec of SHELL_LAZY_DATA_ARCHIVE_SPECS) {
    const path = `${spec.mountPrefix}${spec.requiredMember}`;
    if (!fs.isPathDeferred(path)) {
      throw new Error(`source-rootfs shell must defer optional data ${path}`);
    }
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

function readVfsBytes(fs: KandeloImageFs, path: string): Uint8Array {
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
function eagerWasmPrograms(fs: KandeloImageFs): Set<string> {
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
  fs: KandeloImageFs,
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
  fs: KandeloImageFs,
): SourceBashIdentity {
  const bashPath = REQUIRED_BASH_ALIASES[0];
  if (!fs.stat(bashPath).deferred) {
    throw new Error(`${bashPath} must be a lazy source-rootfs entry`);
  }
  const identity = { ino: Number(fs.stat(bashPath).ino) };
  // The hardlinks are DERIVED from the tree rather than read from a list the
  // filesystem kept beside it. A hardlink is one inode reachable by several
  // paths, so the paths sharing this inode ARE the hardlinks -- and a list that
  // could disagree with the tree is a list that eventually will.
  const hardlinkPaths = fs
    .lazyEntries()
    .files.filter((entry) => Number(entry.ino) === identity.ino)
    .map((entry) => entry.path)
    .sort();
  const aliases: BashAliasContract[] = [];
  for (const alias of REQUIRED_BASH_ALIASES) {
    const linkStat = fs.lstat(alias);
    const stat = fs.stat(alias);
    // Through `stat`, not `lstat`: an alias may be a symlink, and what must
    // match is the file it RESOLVES to.
    if (Number(stat.ino) !== identity.ino || !stat.deferred) {
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
  fs: KandeloImageFs,
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
    if (fs.isPathDeferred(path)) {
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
    if (Number(stat.ino) !== Number(canonical.ino) || stat.deferred) {
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
  // READING THE METADATA LOADS THE IMAGE, and the loader refuses one that
  // declares an ABI it does not speak. So a WRONG ABI arrives here as `EPROTO`
  // rather than as a number this gate can compare, and the gate's own message
  // — which names the requirement and is the reason a build's failure is
  // actionable — would never be reached.
  //
  // The refusal is the loader's and stays the loader's; what this adds is the
  // sentence a person building an image needs. A MISSING declaration still
  // reaches the comparison below, because an image that declares no ABI makes
  // no claim for the loader to refuse.
  let sourceMetadata;
  try {
    sourceMetadata = KandeloImageFs.readImageMetadata(rootfs);
  } catch (error) {
    if ((error as { errno?: number } | null)?.errno === ERRNO.EPROTO) {
      throw new Error(
        `rootfs dependency must explicitly declare kernel ABI ${ABI_VERSION}; ` +
          `it declares a different one and this reader cannot say which — ` +
          `rebuild it`,
      );
    }
    throw error;
  }
  if (sourceMetadata?.kernelAbi !== ABI_VERSION) {
    throw new Error(
      `rootfs dependency must explicitly declare kernel ABI ${ABI_VERSION}; ` +
        `got ${String(sourceMetadata?.kernelAbi)}`,
    );
  }
  const sourceCapacity = KandeloImageFs.readImageCapacity(rootfs);
  // The load AUTHENTICATES. Verification runs inside the module's
  // `sm_load_image`, so the source image gains its authority only after its
  // activation cohorts checked out -- there is no window between importing and
  // authenticating, and no second call to forget.
  const fs = KandeloImageFs.create();
  fs.loadImage(rootfs);
  const terminalSession = readExperimentalTerminalSession(fs);
  // The rootfs owns its own eager programs (login); only what this composer
  // adds is held to the lazy default.
  const sourceEagerPrograms = eagerWasmPrograms(fs);
  const demo = composeSourceRootfsDemoConfig(
    inputs.demoConfigPath,
    inputs.demoProfileOverlayPath,
  );
  const scummvmCatalog = loadScummvmFreewareCatalog();

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
  const caBundle = readRegularInput(inputs.caBundlePath, "rootfs CA bundle dependency");
  requireRegularInput(inputs.desktopDataPath, "desktop data dependency");
  const libinputQuirks = readRegularInput(
    inputs.libinputQuirksPath,
    "libinput quirks dependency",
  );
  requireRegularInput(inputs.espeakNgDataPath, "espeak-ng data dependency");

  // WHY: Bash remains the ordinary account shell and is therefore eager after
  // login. Opening its canonical alias follows a symlink when present,
  // truncating the one lazy inode while preserving both its
  // hard-link ledger and the rootfs's symlink topology.
  writeVfsBinary(fs, REQUIRED_BASH_ALIASES[0], bash, 0o755);
  requireMaterializedBashIdentity(fs, sourceBash, bash);
  requirePreservedLazyState(unrelatedLazyBefore, fs, "Bash materialization");

  populateSourceRootfsShellOverlay(fs, inputs.resolveArtifact, {
    existingProgramDependencies: SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCY_SET,
    resolveOriginal: inputs.resolveOriginal,
  });
  requirePreservedLazyState(
    unrelatedLazyBefore,
    fs,
    "production shell overlay",
  );
  requireManSupersededByMandoc(fs, priorManIdentity);
  requireCompleteProductShellContract(fs);

  ensureDirRecursive(fs, "/usr/bin");
  // The desktops' launchers are small scripts, written eagerly. Every Wasm
  // program they exec (wlcompositor, wlterm, foot, Quickshell, ...)
  // is a lazy file registered by the overlay above, so a machine that never
  // starts a desktop never fetches them.
  writeVfsBinary(fs, "/usr/bin/wldesktop", wldesktop, 0o755);
  writeVfsBinary(fs, "/usr/bin/omarchydesktop", omarchydesktop, 0o755);
  // WHY: CA, speech and desktop data need not be fetched to boot a shell.
  // Register the exact package ZIPs at their compiled-in guest paths: normal
  // open/read triggers a verified first-use fetch on both Node and browser.
  removeEagerShellCaBundle(fs, caBundle);
  const dataArchivePaths = {
    "ca-certificates": inputs.caBundlePath,
    "desktop-data": inputs.desktopDataPath,
    "espeak-ng-data": inputs.espeakNgDataPath,
  };
  for (const spec of SHELL_LAZY_DATA_ARCHIVE_SPECS) {
    registerDeclaredShellLazyArchive(fs, spec, () => dataArchivePaths[spec.id]);
  }
  // wlcompositor's statically linked libinput reads its device quirks from
  // LIBINPUT_QUIRKS_DIR, compiled in as /usr/share/libinput.
  unpackDataZip(fs, "/usr/share/libinput", libinputQuirks);
  // fbDOOM is a lazy /usr/bin binary; only its launch wrapper is eager.
  writeVfsBinary(
    fs,
    "/usr/bin/fbdoom",
    new TextEncoder().encode(FBDOOM_LAUNCH_SCRIPT),
    0o755,
  );
  // The Quake engine, unzip, and lha are lazy /usr/bin binaries; only this
  // small extraction+launch wrapper is written eagerly.
  writeVfsBinary(
    fs,
    "/usr/bin/quake",
    new TextEncoder().encode(QUAKE_LAUNCH_SCRIPT),
    0o755,
  );
  // The verified shareware archive is static data. The unprivileged wrapper
  // extracts its playable data into /var/games/quake, never into /usr.
  ensureDirRecursive(fs, "/usr/share");
  ensureDirRecursive(fs, "/usr/share/quake");
  // ScummVM: the engine, its plugins and its GUI data are lazy; only the launch
  // wrapper, scummvm-play and its catalog are eager. Game data is either the
  // user's own upload or a freeware game scummvm-play fetches; both land in
  // /var/games/scummvm; the image account owns that mutable game directory.
  writeVfsBinary(
    fs,
    "/usr/bin/scummvm",
    new TextEncoder().encode(SCUMMVM_LAUNCH_SCRIPT),
    0o755,
  );
  writeVfsBinary(
    fs,
    SCUMMVM_PLAY_COMMAND,
    new TextEncoder().encode(SCUMMVM_PLAY_SCRIPT),
    0o755,
  );
  ensureDirRecursive(fs, "/usr/share/scummvm-play");
  writeVfsBinary(
    fs,
    SCUMMVM_PLAY_CATALOG,
    new TextEncoder().encode(scummvmPlayCatalogTsv(scummvmCatalog)),
    0o644,
  );
  ensureDirRecursive(fs, "/var/games/scummvm");
  // DOOM: the machine command supervises fbdoom; a WAD sent to the machine
  // lands in /var/games/doom, owned by the unprivileged handler account.
  writeVfsBinary(fs, "/usr/bin/doom-launch", new TextEncoder().encode(DOOM_LAUNCH_SCRIPT), 0o755);
  ensureDirRecursive(fs, "/usr/share/doom");
  // The emulators and their starter ROMs are lazy; only the launcher that
  // picks one for a ROM is eager. A dropped ROM runs through it too (the
  // retro ROM exchange handler below).
  writeVfsBinary(fs, "/usr/bin/retro-run", new TextEncoder().encode(RETRO_RUN_SCRIPT), 0o755);
  writeVfsBinary(fs, "/usr/bin/kandelo-terminal", new TextEncoder().encode(KANDELO_TERMINAL_SCRIPT), 0o755);
  // The image's Kandelo exchange handlers and their rules. The rules
  // go in the image's rule directory, which the base rootfs declares
  // (images/rootfs/MANIFEST) with the ownership kxchgd checks; creating it
  // here would hide a base that lacks it. Rule files are root-owned and not
  // group- or world-writable, as kxchgd requires.
  const rulesDir = "/etc/kandelo/exchange-handlers.d";
  let rulesStat;
  try {
    rulesStat = fs.stat(rulesDir);
  } catch (error) {
    throw new Error(`source rootfs is missing ${rulesDir} (images/rootfs/MANIFEST)`, { cause: error });
  }
  if ((rulesStat.mode & FILE_TYPE_MASK) !== DIRECTORY_MODE) {
    throw new Error(`${rulesDir} must be a directory`);
  }
  ensureDirRecursive(fs, "/usr/libexec/kandelo");
  for (const { name, handler, script, rule } of GAME_EXCHANGE_RULES) {
    writeVfsBinary(fs, handler, new TextEncoder().encode(script), 0o755);
    writeVfsBinary(fs, `${rulesDir}/${name}`, new TextEncoder().encode(rule), 0o644);
  }
  // Create the id1 game dir too: the pak handler writes
  // /var/games/quake/id1/pak0.pak directly, and that path must work even
  // offline when no quake106.zip was staged and the wrapper's own
  // `mkdir -p id1` never ran.
  ensureDirRecursive(fs, "/var/games/quake/id1");
  ensureDirRecursive(fs, "/var/games/doom");
  for (const path of ["/var/games/quake", "/var/games/quake/id1", "/var/games/doom", "/var/games/scummvm"]) {
    fs.chown(path, 1000, 1000);
    fs.chmod(path, 0o755);
  }
  writeSdl2ShaderPresets(fs);
  // WHY: the package shell must not promise optional programs it does not own.
  // Bind its extra profiles to executable bytes so a metadata-only edit cannot
  // advertise a demo that boots successfully but never launches its workload.
  requireOwnedDemoCommands(fs, demo);
  requireScummvmFreewareMenu(demo, scummvmCatalog);
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, demo, 0o644);

  // Checked before saving so a rejected composition writes no output.
  requireLazyShellPrograms(sourceEagerPrograms, fs);
  requireLazyShellData(fs);

  // WHY: Bash is the one intentional eager identity. Every other source-rootfs
  // first-use download must retain the same path, URL, size, and tree metadata.
  const composedLazyState = serializedLazyState(fs);

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

  const outputMetadata = KandeloImageFs.readImageMetadata(image);
  if (outputMetadata?.kernelAbi !== ABI_VERSION) {
    throw new Error("composed shell lost its explicit kernel ABI");
  }
  if (
    KandeloImageFs.readImageCapacity(image).maxByteLength !==
    sourceCapacity.maxByteLength
  ) {
    throw new Error("composed shell changed the rootfs capacity contract");
  }
  // A separate import boundary on purpose: the post-save assertions check the
  // bytes that were WRITTEN rather than inheriting trust from the tree that
  // wrote them. Loading them back is what authenticates their seals.
  const outputFs = KandeloImageFs.create();
  outputFs.loadImage(image);
  requireMaterializedBashIdentity(outputFs, sourceBash, bash);
  requireExpectedLazyState(
    composedLazyState,
    outputFs,
    "serialized source-rootfs shell",
  );
  requireCompleteProductShellContract(outputFs);
  requireLazyShellData(outputFs);
  readExperimentalTerminalSession(outputFs);
  return image;
}

function parseArguments(argv: readonly string[]): SourceRootfsShellInputs {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--rootfs",
    "--ca-bundle",
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
          "--rootfs <rootfs.vfs.zst> --ca-bundle <ca-certificates.zip> --bash <bash.wasm> " +
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
    caBundlePath: values.get("--ca-bundle")!,
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
