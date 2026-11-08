#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$here" wasm32
source "$repo/sdk/activate.sh"
work="$KANDELO_PACKAGE_WORK_DIR"
stage="$work/fixture"
mkdir -p "$stage"
cp -R "$here/fixture/." "$stage/"
# Cargo authenticates the unmodified crate archives against the checked-in
# lockfile. Only sources enter this fixture; all compilation happens in guests.
(cd "$stage" && cargo vendor --locked --versioned-dirs vendor > "$work/vendor-config.toml")
mkdir -p "$stage/.cargo"
cat > "$stage/.cargo/config.toml" <<'TOML'
[source.crates-io]
replace-with = "vendored-sources"
[source.vendored-sources]
directory = "vendor"
TOML
archive="$work/rust-native-fixtures.zip"
bash "$repo/images/vfs/scripts/create-deterministic-zip.sh" "$stage" "$archive"
mkdir -p "${WASM_POSIX_DEP_OUT_DIR:?resolver output required}/share/kandelo"
cp "$archive" "$WASM_POSIX_DEP_OUT_DIR/share/kandelo/rust-native-fixtures.zip"
