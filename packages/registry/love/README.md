# Native LÖVE 11.5 port

The port from `emdash/love-target-resolution-upscale` builds with the current
Kandelo SDK and links the upstream LÖVE OpenGL renderer and Box2D physics.
The filesystem backend uses POSIX files. SDL2 owns the EGL window and input
on both standalone KMSDRM and Wayland displays. Inside a Wayland session,
SDL receives keyboard, text, pointer, wheel, focus and close events from the
compositor, leaving physical input and DRM master to the desktop.
SDL2 supplies the actual drawable size, including output scale, to LÖVE.
Lua 5.2 is a separate registry library; FreeType and zlib use main's recipes.
Audio uses SDL2's OSS driver on `/dev/dsp`, with a checksum-pinned stb_vorbis
source dependency for Ogg decoding. No browser audio API is called by the game.

The browser gallery's **LÖVE games** machine starts Pong. Its **Games** menu
launches Pong, Snake, Breakout, Asteroids, BYTEPATH or SNKRX.
The executable and game archive are lazy package files: other shell profiles
do not download them at boot. The game archive mounts at `/usr/` and supplies
`/usr/share/love/examples`.

On the **Omarchy-style desktop**, press Ctrl+Space and select a game by name
in the application launcher. The six entries use the same executable and
lazy game archive. The runtime detects `WAYLAND_DISPLAY` or a compositor
socket in `XDG_RUNTIME_DIR` (default `/tmp`); `SDL_VIDEODRIVER=wayland`
explicitly requests this backend and initialization failures are reported.
Outside a desktop session, SDL2 selects its KMSDRM backend. This build has
no udev, so the launcher supplies SDL's supported `SDL_EVDEV_DEVICES` list for
`/dev/input/event{0,1}`. LÖVE's upstream SDL mouse module is compiled unchanged;
SDL reads `EVIOCGABS` bounds and maps absolute device units to window pixels.
The launcher no longer reads evdev coordinates or owns a separate KMS surface.
Ctrl+W closes the focused game through Wayland's ordinary window-close event.

The core examples scale a stable playfield and convert pointer coordinates
through the same letterboxed transform. BYTEPATH and SNKRX receive small
upstream portability patches adding resize callbacks: their existing logical
canvas and pointer scales follow a compositor's tiled configure, including
when it changes a window that the game requested as fixed-size.

Run a game from a Kandelo shell with, for example:

```sh
love /usr/share/love/examples/pong
love /usr/share/love/examples/bytepath
love /usr/share/love/examples/snkrx
```

The four core games share `game-demos/main.lua`, with small entry points that
select their initial game. Esc returns to the in-game core gallery; choose
BYTEPATH or SNKRX through the dock menu. BYTEPATH starts with its console;
type `help` or `start`. SNKRX uses mouse clicks in its menu/shop and keyboard
steering in the arena.

## Audio

The source now implements mono/stereo static Ogg Vorbis and WAV sources,
file-backed Ogg streams, independent clones, overlapping voices, volume,
pitch, looping, pause/resume, stop, and seek/tell in seconds or sample frames.
Static clones share decoded 16-bit PCM; stream clones have independent decoders.
Streams retain a 2048-frame decode window rather than a full decoded track.
The backend retains up to 256 active or paused voices. The SDL callback mixes
playing voices to 48 kHz stereo, with linear interpolation for pitch/sample-rate
conversion and final clipping.
Playing sources remain alive when Lua drops its last reference; device close
joins the callback before source data and SDL are released.

BYTEPATH and SNKRX use their original Ogg assets and game audio calls.
Pong, Snake, Breakout, and Asteroids have generated PCM effects for collisions,
scores, pickups, shots, and explosions. Press **M** to mute these core games.
The browser still requires a user gesture to enable its audio sink. Node uses
Kandelo's existing paced headless sink, which does not output to Mac speakers.
The physical OSS output is exclusive, so simultaneous audio clients can fail
with a busy device; the backend reports device/decode failures as Lua errors.

The wasm32 package and shell demo image have been rebuilt with this backend.
Browser tests observe actual Web Audio samples from all six games. Older
binaries may still use the silent backend. Run
`love /usr/share/love/examples/audio-check` to exercise source controls,
cloning, garbage collection, streaming/loop boundaries, and failure reporting.
The repeated browser-memory switching test also includes LÖVE as an audio
consumer. These automated checks use headless Chromium, Firefox, and
Playwright WebKit; they do not require desktop-control permission. Playwright
WebKit coverage does not establish native Safari support. The full native
Safari repeated-switch follow-up remains incomplete. The same source API
fixture also runs through Node's paced headless audio sink, which does not
output to physical speakers.

Audio-only programs can disable the window and graphics modules in `conf.lua`:

```lua
function love.conf(t)
  t.window = false
  t.modules.graphics = false
  t.modules.window = false
end
```

This uses the same audio, timer, filesystem and data paths on both hosts.
Graphical games require an active OpenGL ES context, which Node does not
provide. The port supports the window and graphics modules together or both
disabled; other windowless graphics configurations fail explicitly.

## Compatibility boundaries

SDL2's KMSDRM backend does not provide system cursor themes. LÖVE reports
`getSystemCursor` as unsupported on that backend; SNKRX's optional Steam-button
hand cursor falls back to the default pointer so hovering still works.
Cursor sizing on high-density displays remains deferred to compositor work.

This is a partial LÖVE port. Audio capture, queueable sources, spatial audio,
effects, and codecs other than Vorbis and WAV are not implemented. WAV is
supported for static sources only. Effect setters return false, and spatial
calls fail explicitly. Video decoding, Steam integration, LÖVE thread channels
and general LuaJIT native FFI loading are not supported.
The FFI compatibility module handles the byte buffers used by these games;
`ffi.load` fails explicitly. This is not a promise that arbitrary LÖVE games
run without further porting work.

BYTEPATH and SNKRX sources are immutable, checksum-verified source packages.
Their upstream assets, licenses and credits are retained; bundled desktop
runtimes, builds and BYTEPATH's tutorial are excluded. BYTEPATH's Steam module
is disabled; SNKRX's Steam calls use an explicitly disabled adapter. The
runtime uses BYTEPATH's declared LÖVE 0.10 color convention and shader defaults
at the GLES/WebGL compatibility boundary. It does not replace the games'
rendering code or strip their visual effects.
An upstream BYTEPATH intro defect is patched: delayed glitch callbacks ignore
character arrays replaced by animated status text, avoiding an invalid index.

## Building

```sh
./run.sh build love
./run.sh build shell-vfs
./run.sh browser
```

The recipe stages and patches verified sources inside its resolver work root,
compiles through the worktree SDK with a private libc++ sysroot, and installs
`love.wasm` plus `share/love-examples.zip` into the resolver output directory.
It never writes generated artifacts into the registry checkout.
