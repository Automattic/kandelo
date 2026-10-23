# shellcheck shell=bash
# Source inside a subshell: these Cargo overrides must not escape to the
# repository's host Cargo (including install_local_binary).
# Usage: kandelo_package_rust_build_env REPO SRC WORK PATCHES
kandelo_package_rust_build_env() {
    local repo="$1" src="$2" work="$3" patches="$4"
    # Keep path dependencies below the application's workspace. Cargo hashes
    # absolute identities for path dependencies outside it, even when rustc
    # remaps source locations.
    local rust_dir="$src/.kandelo-rust" patched="$src/.kandelo-patched-crates"
    local fork_libc version config vendor patch entry crate
    # Apply to std as well as the application. Panic locations and crate
    # metadata otherwise embed the resolver's random work directory, making
    # two builds of one cache key disagree. Encoded flags preserve spaces.
    local guest_flags
    printf -v guest_flags '%s\037%s\037%s' \
        '--cap-lints=warn' \
        "--remap-path-prefix=$repo=/kandelo/source" \
        "--remap-path-prefix=$work=/kandelo/build"
    export CARGO_ENCODED_RUSTFLAGS="${CARGO_ENCODED_RUSTFLAGS:+${CARGO_ENCODED_RUSTFLAGS}$'\037'}$guest_flags"
    # A resolver cache may be inside the Kandelo checkout. Standalone
    # upstream crates must not accidentally join the repository workspace.
    if ! grep -Eq '^\[workspace(\]|\.)' "$src/Cargo.toml"; then
        printf '\n[workspace]\nexclude = [".kandelo-rust/**", ".kandelo-patched-crates/**", ".kandelo-vendor/**"]\n' >> "$src/Cargo.toml"
    fi
    export CARGO_HOME="$work/guest-cargo-home"
    mkdir -p "$CARGO_HOME"
    KANDELO_RUST_DIR="$rust_dir" bash "$repo/scripts/build-rust-sysroot.sh" || return
    fork_libc="$rust_dir/sysroot/libc-kandelo"
    version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$fork_libc/Cargo.toml" | head -n1)"
    [ -n "$version" ] || return 1
    export RUSTC="$rust_dir/rustc-kandelo" RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1
    config="$CARGO_HOME/config.toml"
    printf '[patch.crates-io]\nlibc = { path = "%s" }\n' "$fork_libc" > "$config"
    (cd "$src" && cargo update -p libc --precise "$version") || return
    vendor="$src/.kandelo-vendor"
    # Cargo authenticates every registry crate against the lockfile checksum.
    (cd "$src" && cargo vendor --locked --versioned-dirs "$vendor" > "$work/vendor-config.toml") || return
    export CARGO_NET_OFFLINE=true
    mkdir -p "$patched"
    local -a updates=()
    for patch in "$patches"/*.patch; do
        [ -f "$patch" ] || continue
        entry="$(basename "$patch" .patch)"
        crate="${entry%-*}"
        version="${entry##*-}"
        [ -d "$vendor/$entry" ] || { echo "ERROR: patch $entry is absent from Cargo.lock" >&2; return 1; }
        cp -R "$vendor/$entry" "$patched/$entry"
        rm -f "$patched/$entry/.cargo-checksum.json"
        patch -d "$patched/$entry" -p1 < "$patch" || return
        printf '%s = { path = "%s", package = "%s" }\n' \
            "${crate//-/_}_${version//./_}" "$patched/$entry" "$crate" >> "$config"
        updates+=(-p "$crate@$version")
    done
    cat "$work/vendor-config.toml" >> "$config"
    # Registry dependencies normally receive Cargo's lint cap. A [patch]
    # path override loses it; newer compiler warnings must not turn an old
    # dependency's deny(warnings/dead_code) into a consumer build failure.
    # The lint cap above applies to the guest Cargo invocation, including
    # these path overrides, while its subshell keeps host Cargo untouched.
    if [ "${#updates[@]}" -gt 0 ]; then
        (cd "$src" && cargo update --offline "${updates[@]}") || return
    fi
}
