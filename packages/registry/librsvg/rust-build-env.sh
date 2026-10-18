# shellcheck shell=bash
#
# Prepare a staged librsvg source tree to build its Rust crates for
# wasm32-unknown-kandelo-std. Sourced by build-librsvg.sh (the library,
# through upstream's meson + cargo-c) and by the rsvg-convert package (the
# program, through cargo).
#
#   librsvg_rust_build_env <repo-root> <src-dir> <work-dir> <dep-pkg-config-path>
#
# On return the environment selects:
#
#   - a private Rust sysroot (prebuilt std, libc fork, std overlay)
#     assembled in <work-dir>/rust, so a package build shares no mutable
#     state with other checkouts;
#   - the crate graph: Cargo.lock's libc moved to the fork's exact version
#     (a [patch] replaces only that version), the other crates vendored
#     from Cargo.lock and checked against its sha256 values, the crates in
#     patches/ overridden, then offline. The overrides live in
#     $CARGO_HOME/config.toml: meson runs cargo from its build directory
#     with --manifest-path, and cargo finds .cargo/config.toml from its
#     working directory, not from the manifest;
#   - pkg-config for the gtk-rs -sys crates and librsvg's build script,
#     static, over the dependency closure (what librsvg's meson.build sets
#     for a static build).
#
# Also sets LIBRSVG_RUST_TARGET and LIBRSVG_RUSTC (the sysroot's rustc
# wrapper, which meson must use to query the target).

librsvg_rust_build_env() {
    local repo_root="$1" src_dir="$2" work_dir="$3" dep_pkg_config_path="$4"
    local patches_dir="$repo_root/packages/registry/librsvg/patches"

    LIBRSVG_RUST_TARGET="wasm32-unknown-kandelo-std"

    # --- Private Rust sysroot -------------------------------------------
    local rust_dir="$work_dir/rust"
    echo "==> Assembling the Rust sysroot for $LIBRSVG_RUST_TARGET..."
    KANDELO_RUST_DIR="$rust_dir" bash "$repo_root/scripts/build-rust-sysroot.sh"
    LIBRSVG_RUSTC="$rust_dir/rustc-kandelo"
    local fork_libc="$rust_dir/libc-kandelo"
    [ -x "$LIBRSVG_RUSTC" ] || { echo "ERROR: rustc wrapper missing at $LIBRSVG_RUSTC" >&2; return 1; }
    local fork_libc_version
    fork_libc_version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$fork_libc/Cargo.toml" | head -n1)"
    [ -n "$fork_libc_version" ] || { echo "ERROR: cannot read the libc fork version" >&2; return 1; }

    export RUSTC="$LIBRSVG_RUSTC"
    export RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1
    # WHY a directory of its own: the package resolver already exports
    # <work-dir>/cargo-home as the recipe's CARGO_HOME. The vendored-crate
    # config written below would land there and outlive the caller's
    # subshell, and the repo's own cargo (install_local_binary's xtask)
    # would then resolve Kandelo's crates against librsvg's vendor tree.
    export CARGO_HOME="$work_dir/librsvg-cargo-home"
    local cargo_config="$CARGO_HOME/config.toml"
    mkdir -p "$CARGO_HOME"

    # --- Crate graph: the libc fork, vendored crates, patched crates ----
    # `cargo update --precise` fails if any crate in the graph requires a
    # newer libc than the fork provides.
    printf '[patch.crates-io]\nlibc = { path = "%s" }\n' "$fork_libc" > "$cargo_config"
    echo "==> Pinning libc to the Kandelo fork ($fork_libc_version)..."
    (cd "$src_dir" && cargo update -p libc --precise "$fork_libc_version") || return 1

    echo "==> Vendoring crates from Cargo.lock..."
    local vendor_dir="$work_dir/vendor"
    (cd "$src_dir" && cargo vendor --locked --versioned-dirs "$vendor_dir" \
        > "$work_dir/vendor-config.toml") || return 1
    export CARGO_NET_OFFLINE=true

    # Crates that do not build for a Rust target not built into rustc and
    # its ecosystem; patches/ fixes each at that boundary (see the patch
    # headers). A patched crate is a path override of its vendored copy;
    # the `package` key lets two versions of one crate coexist.
    local patched_dir="$work_dir/patched-crates"
    rm -rf "$patched_dir"
    mkdir -p "$patched_dir"
    printf '[patch.crates-io]\nlibc = { path = "%s" }\n' "$fork_libc" > "$cargo_config"
    local -a update_args=()
    local patch crate_dir crate crate_version
    for patch in "$patches_dir"/*.patch; do
        crate_dir="$(basename "$patch" .patch)"   # <name>-<version>
        crate="${crate_dir%-*}"
        crate_version="${crate_dir##*-}"
        [ -d "$vendor_dir/$crate_dir" ] || {
            echo "ERROR: $crate_dir is not in the crate graph; drop or refresh $patch" >&2
            return 1
        }
        cp -R "$vendor_dir/$crate_dir" "$patched_dir/$crate_dir"
        rm -f "$patched_dir/$crate_dir/.cargo-checksum.json"
        patch -d "$patched_dir/$crate_dir" -p1 < "$patch" || return 1
        echo "${crate//-/_}_${crate_version//./_} = { path = \"$patched_dir/$crate_dir\", package = \"$crate\" }" \
            >> "$cargo_config"
        update_args+=(-p "$crate@$crate_version")
    done
    cat "$work_dir/vendor-config.toml" >> "$cargo_config"
    # Point the lockfile entries of the patched crates at their overrides.
    (cd "$src_dir" && cargo update --offline "${update_args[@]}") || return 1

    # --- pkg-config -----------------------------------------------------
    export PKG_CONFIG_PATH="$dep_pkg_config_path"
    export PKG_CONFIG="$(command -v wasm32posix-pkg-config)"
    export PKG_CONFIG_ALLOW_CROSS=1
    export PKG_CONFIG_ALL_STATIC=1
    export SYSTEM_DEPS_LINK=static
}
