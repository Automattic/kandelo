# Rust packages and the librsvg port — outcome

Status: closed. Records how the investigation from the Rust target
(#1378) to a working librsvg package (#1466) went, which earlier
findings held, and which were wrong. It replaces four exploratory
plan PRs that were not merged: #1447 (dependency packaging), #1450
(glib-sys), #1451 (the gtk-rs stack) and #1454 (librsvg port status).
Current behavior is documented in `docs/rust-target.md`; this file is
history.

## The path

1. **Crate dependencies, vendoring and pkg-config (#1447).** Spikes
   showed ordinary crates.io crates compile for the target, crates can
   be vendored for an offline build, and a `-sys` crate's build script
   finds a ported C library through `wasm32posix-pkg-config` with
   `PKG_CONFIG_ALLOW_CROSS=1`.
2. **glib-sys (#1450) and the gtk-rs stack (#1451).** `glib-sys`,
   `cairo-sys-rs`, and the `glib` wrapper crate (including its
   `glib-macros` proc-macro, built for the host) compiled for the target
   against the ported C libraries.
3. **librsvg blocked (#1454).** librsvg's Rust side was ready, but
   librsvg needs pango 1.46 or newer, Kandelo had pango 1.42.4 (the last
   autotools release), and the SDK could not build Meson projects.
4. **Unblocked and landed (#1466).** Meson support in the SDK, cairo
   1.18.6 and pango 1.56.4 through Meson, a prebuilt std selectable by
   target name, cargo-c, three std fixes, and librsvg 2.63.2 (the
   latest release) plus `rsvg-convert`.

## Findings that held

- Crates compile for the target without per-crate porting, apart from
  two that assume a target the Rust ecosystem knows (below).
- `-sys` crates resolve ported C libraries through pkg-config, through
  `system-deps` as well as the plain `pkg-config` crate.
- `[patch.crates-io] libc = { path = <fork> }` replaces only the fork's
  exact version (0.2.185), so a package must move its lockfile's `libc`
  to that version. librsvg does this with
  `cargo update -p libc --precise <fork version>`; the earlier spikes
  pinned it in `Cargo.toml` instead, which only works for crates you
  own.

## Findings that were wrong or changed

- **gettext is not a gap.** #1447 listed a missing gettext package as
  glib's blocker; Kandelo's musl provides `gettext` and friends, and
  glib builds against them (corrected in #1450).
- **Vendoring std's dependencies is no longer needed.** #1447's recipe
  vendored std's own dependency tree because every build compiled std
  (`-Z build-std`). With std prebuilt in the sysroot, a package vendors
  only its own crates.
- **The blocker was not Rust.** #1454 was right that librsvg's Rust
  side was ready; the pango and Meson gap was the whole blocker.
- **librsvg version.** #1454 targeted librsvg 2.54.5 through autotools.
  With Meson available, the port uses 2.63.2, whose Meson build drives
  cargo-c; that required the prebuilt, by-name target.

## Problems the port found that the spikes did not

The spikes only built crates. Building through Meson and running the
results found:

- rustc reported `-lgcc_s` as a native dependency; Meson's
  `find_library` rejected it (fixed in the std overlay).
- std read errno through a symbol no Kandelo library defines, and
  backtraces through the libunwind API; both trapped when reached
  (fixed in the std overlay, now guarded by an import check in the
  Rust tests).
- `system-deps` 7.0.8 panics on a target name that is not a
  `target-lexicon` triple, and `parking_lot_core` 0.9.12 cannot build
  `libc::timespec` with a struct literal under 32-bit musl's time64
  padding (patched in `packages/registry/librsvg/patches/`).
- cargo finds `.cargo/config.toml` from its working directory, not the
  manifest, so overrides must go in `$CARGO_HOME/config.toml` when Meson
  runs cargo.
- cargo-c names output files per target OS and needed `kandelo` added
  (`sdk/rust/cargo-c-kandelo.patch`).

## Remaining follow-ups

- Recipes that build inside `packages/registry/<name>/` instead of the
  resolver's work directory (pixman, glib, harfbuzz, freetype, libpng,
  fribidi, pcre2, gdk-pixbuf, libcxx, cairo, pango, and fontconfig's
  build directory) break when two resolves of the same package run at
  once against a cold cache.
- Upstream the `system-deps` and `parking_lot` fixes; until then, a
  second Rust package would want a shared home for crate patches.
- Refresh the `libc` fork when std moves to a newer `libc`, or a crate
  requiring a newer version will fail the lockfile pin.
- A `wasm64` Rust target for large Rust programs.
- The gdk-pixbuf SVG loader (gdk-pixbuf and librsvg would depend on
  each other) and GObject introspection (needs to run tools on the
  target during the build) are not built.
- Rust tooling inside Kandelo: see
  `docs/plans/2026-09-30-in-guest-rust-feasibility.md`.
