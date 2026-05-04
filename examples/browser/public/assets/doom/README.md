# DOOM WAD asset (deprecated location)

The DOOM browser demo (`examples/browser/pages/doom/`) used to load
the IWAD from `/assets/doom/doom1.wad`. As of fbdoom rev2, the WAD is
bundled inside the fbdoom package archive — `build-fbdoom.sh` writes
it to `examples/libs/fbdoom/doom1.wad`, which `install_release`
symlinks at `binaries/programs/wasm32/fbdoom/doom1.wad`. The demo
imports it via Vite's `?url` and never touches this `public/`
directory.

This README is kept as a breadcrumb. Drop a `doom1.wad` here only if
you're patching the demo to use a custom IWAD outside the package
flow — otherwise everything you need is in `examples/libs/fbdoom/`.
