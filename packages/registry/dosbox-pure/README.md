# DOSBox Pure on Kandelo

This package builds DOSBox Pure 1.0 Preview 8's libretro core and a small
Kandelo frontend. DOS x86 programs run in the normal interpreter core
inside one Wasm process. Video uses `/dev/fb0`, audio uses OSS `/dev/dsp`,
and files use Kandelo's VFS. There is no separate browser emulator or
Emscripten filesystem.

Build with `./run.sh build dosbox-pure`. Image builders should install
the declared `dosbox-pure.wasm` output at `/usr/bin/dosbox-pure`. The
package is in the supported local-build set. The browser shell installs
the engine, `dos-play` and its catalog lazily. The DOS games Activity lives
in the base shell image.

For focused development, use main's partial-image path:

```sh
./run.sh partial shell dosbox-pure curl unzip python-browser-bundle
./run.sh browser --partial
```

This keeps DOS games and the base shell activity, including the shared
content importer, while omitting the other activities. It is development
evidence for those packages; the canonical shell still carries the full
activity set and needs its own integration build.

## Running content

Inside a machine containing the executable, run:

```sh
dosbox-pure --info
dosbox-pure /home/maker/games/game.zip
dosbox-pure /home/maker/games/keen/KEEN1.EXE --keypad-arrows
dosbox-pure /home/maker/games/dosbox.conf
```

The core accepts DOS programs, ZIPs, disk images and DOSBox configuration
files. A directly loaded configuration follows regular DOSBox behavior:
its autoexec must mount the content directory explicitly, for example:

```ini
[autoexec]
mount c /home/maker/games/keen
c:
keen1.exe
```

ZIPs are opened by the core; they need not be unpacked in the browser.
Supply your own game files. No commercial game, operating-system image,
SoundFont or ROM is bundled.

Keyboard input uses the foreground terminal's MEDIUMRAW stream, or
`/dev/input/event0` when there is no terminal. The mouse uses
`/dev/input/mice`. Press and release Ctrl+Shift+F12 to quit cleanly; ordinary DOS
Ctrl+C stays available to the emulated program. SIGINT, SIGTERM and
SIGHUP also request an orderly exit and core unload. `--keypad-arrows`
maps the navigation cluster to keypad keys for older games that expect
those scan codes; normal navigation keys are the default.

The frontend requires an absolute `HOME` or `XDG_DATA_HOME`. ZIP write
overlays go under `$XDG_DATA_HOME/dosbox-pure/saves`, or
`$HOME/.local/share/dosbox-pure/saves`. Optional core system files go in
the adjacent `system` directory. Directly loaded games write into their
own content directory, which must be writable. These files persist only
when the containing Kandelo machine is saved; a temporary machine's
files disappear with the machine. A ZIP save overlay is distinct from a
whole-emulator save state.

## Demo launcher

The browser shell installs `dos-play` and the engine lazily. The launcher
uses the shell image's curl, unzip, grep, coreutils and `/bin/sh`; image
builders installing the runtime files separately must provide those tools.
It downloads game content only when invoked:

```sh
dos-play --list
dos-play keen1
dos-play dosdefender
dos-play vitetris
dos-play anarch
dos-play ./GAME.EXE
dos-play /home/maker/games/game.zip
```

Additional arguments go to DOSBox Pure, for example
`dos-play vitetris --frames 600` for a bounded diagnostic run. Local content
must use an absolute path or begin with `./` or `../`. Local ZIPs stay
packed and use DOSBox Pure's save overlays.

| ID | Pinned download | License and input |
|---|---|---|
| `keen1` | Commander Keen 1 v1.31, 153,012-byte ZIP from the Commander Genius project's SourceForge archive | Apogee shareware, copyright id Software. Complete first episode; preserves every original file including `VENDOR.DOC` and `ORDER.FRM`. Arrows move, Ctrl jumps, Alt uses the pogo stick once collected. |
| `dosdefender` | DOS Defender 1.0.1, 10,012-byte COM | Unlicense; mouse. Version 1.1 removed mouse input in favor of gamepads, which this frontend does not yet support. |
| `vitetris` | DOS 0.55, 177,514-byte ZIP | BSD-2-Clause; keyboard. Runs the bundled 16-bit `TETRIS16.EXE`; DOSBox provides the ANSI console support it uses. Retains both executables and all documentation. |
| `anarch` | DOS port commit `c447c17754c4b2472a6899f18ded3d3c888d7fd9`, 236,370-byte ZIP | CC0-1.0 for the game/port; DOS32/A has its own notice. Keyboard and mouse; upstream does not implement saving. |

The bundled 32-bit `TETRIS.EXE` started CWSDPMI and then displayed a black
screen in the browser probe. Its cause remains unresolved; the catalog
explicitly selects the working 16-bit build. Anarch's DOS extender path
also runs, so the observed failure is specific to the TETRIS.EXE probe.

The catalog records exact sizes and SHA-256 hashes. The launcher checks
both before extracting pinned archives, retains every upstream file, and
copies DOS Defender's matching Unlicense notice alongside its standalone
binary. A ready marker is written last; incomplete downloads cannot become
installed games. The next launch uses the installed copy. Catalog updates
invalidate the marker. A concurrent download of the same game fails visibly;
a machine terminated abruptly may leave a lock directory, whose path the
error reports and which can be removed after confirming no download runs.

Installed games, notices and DOS writes live under
`$XDG_DATA_HOME/dos-play`, defaulting to `$HOME/.local/share/dos-play`.
Downloads require network access to SourceForge, GitHub, victornils.net and GitLab
(through the configured network proxy on browser hosts). The games are not
bundled into the image. Like other guest files, these persist across machine
restarts only if the machine is saved. The script does not delete game files
on ordinary exit. No catalog-wide speed or audio-quality claim follows from
an interpreter smoke test.

Upstream sources: [DOS Defender releases](https://github.com/skeeto/dosdefender-ld31/releases),
[vitetris](https://victornils.net/tetris/),
[Anarch DOS](https://gitlab.com/wuuff/anarch-dos).
This product uses DOS/32 Advanced DOS Extender technology.

### Commander Keen distribution

The catalog offers **Commander Keen 1: Marooned on Mars (Apogee shareware)**.
Its original `VENDOR.DOC` permits free online distribution of the complete,
unmodified first episode and requires Apogee attribution. It excludes registered
episodes and requires separate permission for software bundles and retail media.
Kandelo includes the URL and pinned hash; the game is downloaded on demand and
its data is absent from Kandelo package archives and shell images. All program
files, notices and ordering information are kept intact in the user's computer.

The exact archive is the Commander Genius project's
[keen1.zip](https://sourceforge.net/projects/clonekeenplus/files/Downloads/keen1.zip/),
SHA-256 `3d0730f7e4b7c10967609faf5290768eae40b9b6f685060a0ac17c258521a364`.
The [archived publisher page](https://www.frag-net.com/past/www.3drealms.com/keen1/index.html)
distinguishes shareware episode 1 from the paid episodes. Full commercial Keen
episodes remain user-supplied content; an engine's open-source license does not
grant rights to those game data files.

### Presenting the demo

Open the base shell's **Activities → Apps & Tools → DOS games → Start**.
The activity downloads and starts Keen 1. Press Ctrl to enter a level from the
world map; arrows move, Ctrl jumps and Alt uses the pogo stick once collected.
F3 remaps controls (Z/X for jump/pogo is convenient on a Mac), and F2 toggles
Keen's sound. Use **Choose game** on the graphics
dock to switch to DOS Defender, vitetris or Anarch. **Load game** accepts local
content through the shared importer; a ZIP or folder can also be dropped onto
the computer. **Guide** explains the controls, and Ctrl+Shift+F12 quits DOSBox.

For a live presentation, launch the games once beforehand to populate the
download cache and keep the computer in Library to reuse its files. A useful
sequence is Keen for keyboard play, DOS Defender for mouse capture and firing,
then dropping a game ZIP to demonstrate content detection. First-use downloads
remain visible in the terminal; the DOSBox engine remains lazy in the base image.

## Drag-and-drop in the base shell

The base Kandelo shell includes a shared guest-side game importer. Drop a
ZIP, executable, ROM or game folder onto the normal shell. ZIPs are unpacked
before detection; the importer checks DOS headers, calls `retro-run --identify`
for console ROMs and uses ScummVM's own recursive detection. Windows PE/NE
programs are excluded from DOS launch. Known DOS extender companions stay
with their game files rather than appearing as separate games.

A valid MZ program with an unfamiliar filename suffix gets a temporary
8.3 `.EXE` hard link in the same directory for DOSBox's program selector.
The original and its companion files stay in place; the alias is removed on
ordinary exit. This requires a writable game directory, as provided by imports.

One clear match opens an ordinary terminal with `dos-play PATH`,
`retro-run PATH` or a ScummVM command. Multiple games, mixed runtimes, raw COM/BAT files
and uncertain LE/LX executables open a terminal picker. Choosing a game then
uses the existing display handoff. `game-play DIRECTORY|ZIP` offers the same
inspection and picker from a terminal. These commands are repeatable through
normal shell history. The standalone DOSBox package still accepts explicit
local paths through `dos-play`; automatic imports belong to the base shell.

On a Node host without an external terminal consumer, exchange imports are
retained with a command to run manually. `game-play` can execute the selected
game in its current terminal when no separate terminal can be opened.

Imports, original ZIPs, unpacked files, notices and detection configurations
live under `$XDG_DATA_HOME/kandelo/game-imports` (by default
`$HOME/.local/share/kandelo/game-imports`). Original archives are retained
because a ZIP can itself be a game's data file. Raw-ROM-only drops retain
Kandelo's existing `~/roms` behavior. Files are ordinary guest filesystem
state and follow the computer's normal save/persistence behavior.

Unknown archives are saved unchanged to `~/Downloads`. Rejected archives
also go to the ordinary save handler and report the import failure. The
importer accepts single-disk stored/deflated ZIPs, bounds the central directory
before allocating it and limits imports to 1,024 entries, 16 path levels and
512 MiB of retained plus unpacked data. It rejects encrypted/ZIP64 archives,
links, special files, unsafe paths and conflicting names. Nested archives
inside an extracted ZIP are retained as data; they are not recursively
expanded. Streams use the ordinary save handler.

## Initial limits and evidence

The frontend scales the core's video to the platform's 640 by 400
framebuffer and respects its reported display aspect ratio. Higher
resolution content is downscaled. Audio is stereo signed 16-bit PCM. The
frontend requests a 32 KiB OSS ring and primes a 64 ms silent lead before
the first samples, so frame scheduling jitter need not interrupt playback;
when the sink is suspended or full, samples are dropped so input and
emulation can continue. The browser still requires a user gesture for
audible playback. Quitting cancels queued PCM before closing the audio
device, so a suspended browser clock cannot hold the game open. Gamepad input,
frontend save-state controls, external
disk-control UI, accelerated 3dfx rendering and multiplayer are not
implemented by this frontend.

`--frames N` runs at most N emulation frames and unloads cleanly. It is
useful for bounded diagnostics, not a statement about game speed. No
general game compatibility or real-time performance guarantee is made.

The package's `test/runtime.test.ts` exercises actual DOS instructions,
BIOS keyboard input, DOS file creation, repeated process launches, and
ZIP save overlays through the Node host. The browser counterpart is
`apps/browser-demos/test/dosbox-pure.spec.ts`; it also checks VGA pixels
and browser keyboard input through a PTY. The tiny COM fixture is
authored in the test and requires neither downloaded games nor a DOS
installation. `apps/browser-demos/test/dosbox-audio.spec.ts` generates a
continuous PC-speaker tone and checks real AudioWorklet PCM for recurring
playback gaps, with physical speaker output muted by the shared test fixture.
This is a continuity check, not a general game audio-quality claim.
`test/launcher.test.ts` exercises the actual guest shell,
curl, digest checking, extraction, notice retention, cached execution and
checksum-failure cleanup using a deterministic local archive.
`apps/browser-demos/test/dos-play-catalog.spec.ts` is the network acceptance
check for the shipped shell image and real upstream downloads. These checks
do not establish general DOS game compatibility or audio quality.
`apps/browser-demos/test/game-content-drop.spec.ts` checks the base shell's
DOS, ROM and ScummVM imports, mixed-content picker and rejected archives.
`host/test/shell-dos-import.test.ts` checks the installed shell commands and
lazy engine loading through the Node host. Native import logic checks live
in `tests/package-system/game-import_test.py`.

## Optional follow-up: x86-to-Wasm generation

An x86-to-Wasm recompiler is optional future work, not a prerequisite for
this interpreter port or a committed delivery milestone. The build
explicitly sets `DISABLE_DYNAREC=1`, and the frontend reports that JIT
execution is unavailable.

DOSBox's existing dynamic backends emit native CPU instructions and
jump into an executable buffer. Kandelo processes execute Wasm; bytes
written into linear memory do not become callable code through
`mprotect(PROT_EXEC)`. Removing the disable flag cannot supply the
missing backend. This boundary applies on Node and browser hosts.

A future backend could translate hot x86 blocks into validated Wasm
modules and load callable functions through a suitable runtime path.
That work would need to cover code-cache lifetime, self-modifying x86
code and invalidation, control flow, CPU flags and exceptions, and
consistent Node/browser behavior. [v86's design](https://github.com/copy/v86/blob/master/docs/how-it-works.md)
is a useful reference. Representative game measurements should decide
whether to undertake the project; no speedup is assumed here.
