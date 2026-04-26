# DOOM WAD asset

The DOOM browser demo (`examples/browser/pages/doom/`) loads a DOOM
IWAD from `/assets/doom/doom1.wad` at runtime via the in-memory VFS's
`registerLazyFile` mechanism.

The WAD is **not committed** to this repo: it's a binary asset (~4 MB)
that's freely redistributable but lives outside the source tree.
Download or copy a compatible WAD into this directory before running
the demo.

Compatible options:

- **DOOM shareware** (`doom1.wad`, ~4.2 MB) — id Software's freely
  redistributable shareware episode. Ships in many Linux package
  repositories (`apt install doom-wad-shareware` on Debian/Ubuntu).
- **Freedoom Phase 1** (`freedoom1.wad`) — a fully free / open content
  replacement that fbDOOM accepts as a drop-in IWAD. Released by the
  Freedoom project under a BSD-style license:
  <https://github.com/freedoom/freedoom/releases>. Rename to
  `doom1.wad` after extraction.

After placing the file:

```
examples/browser/public/assets/doom/doom1.wad
```

…the demo at `/doom/` will pick it up on first level load.
