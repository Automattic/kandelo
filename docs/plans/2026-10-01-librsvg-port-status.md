# librsvg port — status and the real blocker

Status: port started; the blocker is **not Rust**. Everything on the Rust
side is proven ready; the obstacle is a C-dependency version that requires
meson, which the SDK lacks.

## The Rust side is ready

This session proved the whole gtk-rs/librsvg Rust stack compiles for
`wasm32-unknown-kandelo`: the `-sys` crates (glib-sys, cairo-sys-rs), the safe
wrappers (`glib`, incl. the `glib-macros` proc-macro and a large pure-Rust
tree), crate-dependency compilation, offline vendoring, and `-sys` pkg-config
resolution against ported libraries. librsvg 2.54.5's build integration is
also understood: its autotools build runs `$(CARGO) --locked build
--target=$(RUST_TARGET) --lib` to produce `liblibrsvg.a`; porting means
overriding `CARGO`/`RUST_TARGET`/`RUST_TARGET_SUBDIR`, dropping `--locked` so
our `libc` `[patch]`+pin can re-resolve, and supplying the pkg-config env and
vendored deps. None of that is blocked.

## The blocker: pango ≥ 1.46 needs meson, which the SDK does not have

librsvg 2.54.5 `configure.ac` requires:

| dep | librsvg needs | Kandelo has | ok? |
|---|---|---|---|
| cairo | 1.16.0 | 1.16.0 | ✓ |
| glib/gio | 2.50.0 | 2.84.4 | ✓ |
| gdk-pixbuf | 2.20 | 2.36.12 | ✓ |
| harfbuzz | 2.0.0 | 10.1.0 | ✓ |
| libxml2 | 2.9.0 | 2.13.8 | ✓ |
| freetype2 | (iface) 20.0.14 | 2.13.3 | ✓ |
| **pango** | **1.46.0** | **1.42.4** | ✗ |

Kandelo's pango is pinned at **1.42.4 — the last autotools release**; pango
1.43+ switched to **meson**, and the Kandelo SDK ships **no meson** (the dev
shell provides cmake/ninja only; see `docs/package-management.md` "Real
upstream source, hand-rolled build" and its meson follow-up). So pango cannot
be upgraded through the normal path, and librsvg 2.54.5 will not `configure`
against pango 1.42.4.

This is the same SDK gap the docs already flag as a follow-up ("add meson and
a meson cross file to the SDK"). librsvg is simply the first consumer whose
Rust side is ready but whose C stack trips that gap.

## Options (a real decision)

1. **Add meson to the SDK** (compiler wrappers + a meson cross file), then
   upgrade pango to ≥ 1.46 and build librsvg 2.54.x (latest-ish). This is the
   proper fix and unblocks a whole class of packages (glib, pango, gtk, …)
   that currently use hand-rolled builds. Substantial SDK work, separate from
   Rust.
2. **Port an older, Rust-based librsvg** whose pango requirement fits 1.42.4.
   The Rust rewrite landed around librsvg 2.41; librsvg ~2.46/2.48 are
   Rust-based, autotools, and (to confirm) require only pango ≤ 1.42. This is
   buildable on today's C stack but uses older gtk-rs (≈0.8–0.9) and is not
   "latest". The Rust recipe this session established still applies.
3. **Hand-roll a pango ≥ 1.46 build** (compile its sources without meson, as
   some packages already do). Avoids the SDK meson work but is brittle and
   pango-specific.

## Recommendation

The honest finding is that librsvg is blocked on the **pango/meson C-stack
gap**, not on Rust. If "latest librsvg" is the goal, Option 1 (meson in the
SDK) is the real unlock and the highest-leverage platform investment. If a
working Rust-based librsvg sooner matters more than being latest, Option 2 is
tractable now on the proven Rust recipe. No broken librsvg package was
committed; this records the wall and the choice.
