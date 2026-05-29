# LOVE framebuffer runtime

This package is the native Kandelo path for running LÖVE-style Lua game demos.
It builds a `wasm32posix` executable with `wasm32posix-c++`, opens
`/dev/fb0`, and renders with a small software backend.

It intentionally does not use Emscripten. The package also bundles
the local game gallery as `love-examples.zip`; the shell VFS image unpacks it
to `/usr/local/share/love/examples` and launches:

```sh
/usr/local/bin/love /usr/local/share/love/examples
```

The upstream LÖVE 11.5 source is still pinned and fetched by the build script
for the port baseline and bundled libraries such as `lodepng`, but the
framebuffer backend here replaces the upstream SDL/OpenGL presentation path.
Lua is provided by the separate `lua` registry package and linked as
`liblua.a`.
