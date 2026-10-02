# Rust packages with dependencies — findings (M7.3)

Status: mechanisms validated via spikes (2026-09-30). The three integration
pieces a dependency-bearing Rust package needs — crate deps that compile for
the target, offline/reproducible vendoring, and pkg-config resolution of
ported C libraries from `-sys` crate `build.rs` — all work. This de-risks the
path to the gtk-rs `-sys` crates and ultimately librsvg (whose Rust core is
behind a C/GObject API).

Builds on the Rust target (#1378) and the Rust-package pattern
(`packages/registry/rustdemo`, M7.2).

## 1. crates.io dependencies compile for the target

A `staticlib` crate depending on `crc32fast` (which pulls `cfg-if`) built
cleanly for `wasm32-unknown-kandelo` with `-Z build-std`. No target-specific
friction in ordinary pure-Rust dependencies.

## 2. Offline, reproducible vendoring

`-Z build-std` compiles `std`'s own dependency tree (`rustc-literal-escaper`,
`hashbrown`, …), so a naive `cargo vendor` of only the package's deps +
`replace-with = "vendored-sources"` + `--offline` fails: the vendor dir lacks
the sysroot crates. The fix is to vendor BOTH sets:

```
cargo vendor --sync "$(rustc --print sysroot)/lib/rustlib/src/rust/library/Cargo.toml" vendor
```

With the private sysroot's `rustc` wrapper, use its library manifest
(`$KANDELO_RUST_DIR/sysroot/.../library/Cargo.toml`) as the `--sync` target.
Then `[source.crates-io] replace-with = "vendored-sources"` +
`cargo build --offline` succeeds (verified: 42 crates vendored, offline build
exit 0). For a package, commit the `vendor/` tree (or a pinned subset) so the
build is offline and reproducible per the package contract.

## 3. pkg-config resolution of ported C libraries from `-sys` crates

The SDK's `wasm32posix-pkg-config` honors `PKG_CONFIG_PATH` for dep-cache
`.pc` files (`sdk/src/bin/pkg-config.ts`). A ported library resolves directly:

```
PKG_CONFIG_PATH=<dep-prefix>/lib/pkgconfig wasm32posix-pkg-config --cflags --libs zlib
#  -> -I<prefix>/include -L<prefix>/lib -lz
```

A `-sys`-style crate whose `build.rs` uses the `pkg-config` crate resolves the
target library when invoked with:

```
PKG_CONFIG=wasm32posix-pkg-config
PKG_CONFIG_ALLOW_CROSS=1        # the pkg-config crate refuses cross by default
PKG_CONFIG_PATH=<dep-prefix>/lib/pkgconfig
```

Verified: a crate with `pkg_config::Config::new().probe("zlib")` in `build.rs`
built for the target against the resolved zlib package (exit 0). zlib stands
in for the gtk-rs libraries; the mechanism is the same.

## Remaining concrete steps to glib-sys → cairo-sys → librsvg

The mechanisms above are generic; the specific gtk-rs chain still needs:

1. **Build the C libraries.** glib and cairo are in `packages/registry/`.
   NOTE: **gettext is missing** from the registry and glib needs
   `libintl`/gettext — this is the one dependency gap flagged for librsvg
   (`docs/plans/2026-09-07-...` M7 notes). Close it (or confirm glib can build
   `--without-gettext` / with a stub) before glib builds.
2. **system-deps, not raw pkg-config.** The gtk-rs `-sys` crates
   (`glib-sys`, `cairo-sys-rs`) use the `system-deps` build crate, which reads
   `[package.metadata.system-deps]` and calls pkg-config with its own
   conventions. It honors `PKG_CONFIG_*`, but confirm it accepts the target
   sysroot and the ported `.pc` Requires-chain (glib's `.pc` pulls libffi,
   pcre2, …). A `system-deps` cross-config or `SYSTEM_DEPS_*` override may be
   needed.
3. **Assemble a dependency-bearing Rust package** combining §2 (vendored
   deps) and §3 (pkg-config env) in a `build-<name>.sh`, extending the
   `rustdemo` pattern.
4. **librsvg** proper: its build runs cargo inside autotools/meson; drive that
   through the SDK + the Rust toolchain. Tracked separately as the port.

## Spike reproduction

The spike crates are under the gitignored `.context/rust-m73/` (vendoring:
`vend/`; pkg-config `-sys`: `zsys/`). Recreate from the recipes above.
