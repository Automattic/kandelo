# DOOM WAD asset

The DOOM browser demo (`examples/browser/pages/doom/`) loads a DOOM
IWAD from `/assets/doom/doom1.wad` at runtime via the in-memory VFS's
`registerLazyFile` mechanism.

The WAD itself is **not committed** to this repo (binary asset, ~28 MB).
`examples/libs/fbdoom/build-fbdoom.sh` fetches **Freedoom Phase 1**
(v0.13.0, BSD-style licence — see <https://freedoom.github.io/>) into
this directory automatically. The download URL and SHA-256 are pinned
in the build script, so the result is reproducible.

If a `doom1.wad` is already present here, the build script leaves it
alone — drop in the original DOOM shareware iwad (also freely
redistributable) instead if you prefer.
