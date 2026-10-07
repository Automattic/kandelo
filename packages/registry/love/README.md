# Native LÖVE 11.5 port

The port from `emdash/love-target-resolution-upscale` builds with the current
Kandelo SDK and links the upstream LÖVE OpenGL renderer and Box2D physics.
The Kandelo window/filesystem backends use POSIX files, KMS/EGL/GLES on
`/dev/dri/card0` and evdev keyboard/pointer input on `/dev/input/event{0,1}`.
Lua 5.2 is a separate registry library; FreeType and zlib use main's recipes.

The browser gallery's **LÖVE games** machine starts Pong. Its **Games** menu
launches Pong, Snake, Breakout, Asteroids, BYTEPATH or SNKRX.
The executable and game archive are lazy package files: other shell profiles
do not download them at boot. The game archive mounts at `/usr/` and supplies
`/usr/share/love/examples`.

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

## Compatibility boundaries

This is a partial LÖVE port. Audio output is unavailable: it logs that it runs
silently, and audio sources never report successful playback. Video decoding,
Steam integration, LÖVE thread channels and general LuaJIT native FFI loading
are not supported.
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
