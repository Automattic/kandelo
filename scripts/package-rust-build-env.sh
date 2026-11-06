# shellcheck shell=bash
# Source inside a subshell: these Cargo overrides must not escape to the
# repository's host Cargo (including install_local_binary).
# Usage: kandelo_package_rust_build_env REPO SRC WORK PATCHES
# Keep helper-owned dependency trees out of any upstream Cargo workspace.
# Path dependencies stay below src for reproducible crate identities, but
# must not become workspace members (including the private std/libc tree).
kandelo_package_rust_prepare_workspace() {
    python3 - "$1/Cargo.toml" <<'PY'
import json
from pathlib import Path
import re
import sys
import tomllib

manifest = Path(sys.argv[1])
source = manifest.read_text()
data = tomllib.loads(source)
workspace = data.get("workspace", {})
if not isinstance(workspace, dict):
    raise SystemExit("Cargo workspace must be a table")
existing = workspace.get("exclude", [])
if not isinstance(existing, list) or not all(isinstance(item, str) for item in existing):
    raise SystemExit("Cargo workspace.exclude must be an array of strings")
private = [".kandelo-rust", ".kandelo-patched-crates", ".kandelo-vendor"]
missing = [path for path in private if path not in existing]
if not missing:
    raise SystemExit(0)
header = re.search(r"(?m)^[ \t]*\[workspace\][ \t]*(?:#[^\n]*)?$", source)
if header is None:
    updated = source + "\n[workspace]\nexclude = " + json.dumps(missing + existing) + "\n"
else:
    start = header.end()
    next_table = re.search(r"(?m)^[ \t]*\[", source[start:])
    end = len(source) if next_table is None else start + next_table.start()
    section = source[start:end]
    if "exclude" in workspace:
        array = re.search(r"(?m)^[ \t]*(?:exclude|\"exclude\"|'exclude')[ \t]*=[ \t]*\[", section)
        if array is None:
            raise SystemExit("Cannot locate Cargo workspace.exclude array")
        position = start + array.end()
        prefix = ", ".join(json.dumps(path) for path in missing) + ", "
        updated = source[:position] + prefix + source[position:]
    else:
        updated = source[:start] + "\nexclude = " + json.dumps(missing) + source[start:]
# Validate before writing. Preserve every upstream workspace setting and
# refuse an unsupported representation instead of partially rewriting it.
parsed = tomllib.loads(updated)
expected = {**workspace, "exclude": missing + existing}
if parsed.get("workspace") != expected:
    raise SystemExit("Cargo workspace settings changed while adding private exclusions")
manifest.write_text(updated)
PY
}

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
    kandelo_package_rust_prepare_workspace "$src" || return
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
