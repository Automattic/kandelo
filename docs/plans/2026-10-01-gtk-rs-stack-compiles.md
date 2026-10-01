# The gtk-rs stack compiles for Kandelo (toward librsvg)

Status: validated via spikes (2026-10-01). Beyond glib-sys
(`docs/plans/2026-10-01-glib-sys-compiles.md`), both a second `-sys` crate and
the full safe-wrapper layer now compile for `wasm32-unknown-kandelo` against
ported C libraries. This de-risks the bulk of librsvg's Rust dependency tree.

## Results

- **cairo-sys-rs 0.20** compiles for the target against the ported cairo
  (1.16.0 + pixman/freetype/fontconfig/libpng/glib/zlib). Same recipe as
  glib-sys.
- **the `glib` safe-wrapper crate (0.20) compiles** for the target. This is
  the significant one: it pulls
  - the `-sys` layer (glib-sys, gobject-sys, gio-sys),
  - **`glib-macros`, a proc-macro crate** — proc-macros build for the HOST
    during cross-compilation, and the private-sysroot `rustc` wrapper handles
    that (host `std` is symlinked into the sysroot), so the proc-macro path
    works,
  - a large pure-Rust tree (futures-*, smallvec, …),
  - real glib API (`GString`, `translate::ToGlibPtr`) in the spike.

So the gtk-rs **wrapper** layer — not just the raw `-sys` bindings — compiles
on Kandelo, using the recipe from the glib-sys doc (pin `libc = "=0.2.185"` +
`[patch]` the fork; `wasm32posix-pkg-config` + `PKG_CONFIG_ALLOW_CROSS=1` +
`PKG_CONFIG_PATH`).

## What this leaves for librsvg

The crate-compilation path is now largely de-risked (sys + wrapper + proc-macro
+ big pure-Rust trees all build). Remaining, in rough order:

1. **Build the last C libraries** librsvg's bindings need: `pango`,
   `gdk-pixbuf`, `harfbuzz` (in the registry; pango pulls
   harfbuzz/fontconfig/freetype — mostly cached). Then `pango-sys`/`pango`,
   `gdk-pixbuf-sys`/`gdk-pixbuf`, `cairo-rs` wrappers (same recipe).
2. **librsvg's own crate** + its large pure-Rust tree (cssparser, selectors,
   markup5ever, rgb, …) — expected to compile (pure Rust), unverified.
3. **librsvg's build-system integration** — librsvg builds its Rust crate as a
   staticlib inside an autotools/meson build and links it into the C-API
   library. Packaging that means a `packages/registry/librsvg/` whose
   `build-librsvg.sh` drives both the SDK (C side) and the Rust toolchain
   (crate side), with vendored crate deps (M7.3 §2) and the pkg-config env.
   This is the remaining substantial port.

## Spikes

`.context/rust-m73c/{cairosys,glibwrap}/` (gitignored). Recreate from the
glib-sys recipe.
