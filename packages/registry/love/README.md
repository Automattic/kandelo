# LOVE native runtime

This package is the native Kandelo path for running LÖVE-style Lua game demos.
It builds a `wasm32posix` executable with `wasm32posix-c++`, opens
`/dev/dri/card0`, and presents frames through KMS/EGL/GLES. It falls back to
`/dev/fb0` only when direct rendering is unavailable.

It intentionally does not use Emscripten. The package also bundles
the local game gallery, BYTEPATH, and SNKRX as `love-examples.zip`; the shell
VFS image unpacks it to `/usr/local/share/love/examples` and launches:

```sh
/usr/local/bin/love /usr/local/share/love/examples
```

BYTEPATH can be launched directly with:

```sh
/usr/local/bin/love /usr/local/share/love/examples/bytepath
```

SNKRX can be launched directly with:

```sh
/usr/local/bin/love /usr/local/share/love/examples/snkrx
```

The upstream LÖVE 11.5 source is still pinned and fetched by the build script
for the port baseline and bundled libraries such as `lodepng`, but the
Kandelo backend replaces the upstream SDL presentation path with the kernel's
direct-rendering surface. Lua is provided by the separate `lua` registry
package and linked as `liblua.a`. The native backend reads `love.conf` before
opening the KMS presenter, allocates scanout buffers at the game-requested
window size, and leaves browser-side upscaling to the Kandelo KMS surface.

The BYTEPATH staging step pins upstream `a327ex/BYTEPATH` and keeps the MIT
game code plus permissive Lua dependencies needed for gameplay. It omits the
bundled Windows runtime, tutorial archive, GPL windfield dependency, and audio
assets; Kandelo supplies small compatibility shims for the omitted runtime
pieces.

The SNKRX staging step pins upstream `a327ex/SNKRX` and keeps the MIT game
code. Upstream notes that assets have separate licenses, so Kandelo omits the
sound/font/image/media assets and supplies framebuffer-friendly placeholders
and no-op audio/Steam shims.
