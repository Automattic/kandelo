#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
test_root="$(mktemp -d)"
test_root="$(cd "$test_root" && pwd -P)"
trap 'chmod -R u+w "$test_root"; rm -rf "$test_root"' EXIT
fail() { echo "test-package-source-metadata: $*" >&2; exit 1; }
mkdir -p "$test_root/recipe" "$test_root/work" "$test_root/out" "$test_root/source"
cat > "$test_root/recipe/package.toml" <<'TOML'
version = "release-one"
[source]
provider = "archive"
url = "https://example.invalid/source.tar.gz"
sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TOML
unset WASM_POSIX_DEP_VERSION WASM_POSIX_DEP_SOURCE_URL WASM_POSIX_DEP_SOURCE_SHA256
kandelo_package_load_source_metadata "$test_root/recipe"
[ "$WASM_POSIX_DEP_VERSION" = release-one ] || fail 'standalone version did not come from metadata'
if printenv WASM_POSIX_DEP_VERSION >/dev/null; then fail 'standalone metadata leaked into child recipes'; fi
WASM_POSIX_DEP_VERSION=wrong-release
if kandelo_package_load_source_metadata "$test_root/recipe" 2>/dev/null; then fail 'accepted a conflicting resolver release'; fi
unset WASM_POSIX_DEP_VERSION
kandelo_package_load_source_metadata "$test_root/recipe"
printf 'verified\n' > "$test_root/source/marker"
chmod -R a-w "$test_root/source"
printf 'archive evidence\n' > "$test_root/archive"
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_DEP_SOURCE_DIR="$test_root/source"
export WASM_POSIX_DEP_SOURCE_ARCHIVE="$test_root/archive"
export WASM_POSIX_DEP_WORK_DIR="$test_root/work"
export WASM_POSIX_DEP_OUT_DIR="$test_root/out"
mkdir "$test_root/work/source"
printf 'old release\n' > "$test_root/work/source/marker"
kandelo_package_stage_primary_source fixture "$test_root/work/source" "$test_root/work"
[ "$(cat "$test_root/work/source/marker")" = verified ] || fail 'reused a stale private source tree'
[ -w "$test_root/work/source/marker" ] || fail 'private copy is not writable'
[ ! -w "$test_root/source/marker" ] || fail 'made verified input writable'
if kandelo_package_stage_primary_source fixture "$test_root/source" "$test_root/work" 2>/dev/null; then fail 'accepted source/work overlap'; fi
[ "$(cat "$test_root/source/marker")" = verified ] || fail 'modified verified input'
export WASM_POSIX_DEP_K_617578_SRC_DIR="$test_root/source"
mkdir "$test_root/work/aux"
printf 'stale auxiliary input\n' > "$test_root/work/aux/marker"
kandelo_package_stage_source_dependency aux "$test_root/work/aux" "$test_root/work"
[ "$(cat "$test_root/work/aux/marker")" = verified ] || fail 'reused stale auxiliary source'
if kandelo_package_stage_source_dependency aux "$test_root/source" "$test_root/work" 2>/dev/null; then
    fail 'accepted auxiliary source/work overlap'
fi

# Registry-wide guard against restoring a second primary-source identity.
python3 - "$REPO_ROOT" <<'PY'
from pathlib import Path
import re
import sys
import tomllib

root = Path(sys.argv[1])
for manifest in (root / "packages/registry").glob("*/package.toml"):
    recipe = tomllib.loads(manifest.read_text())
    if recipe.get("source", {}).get("provider", "archive") != "archive":
        continue
    script = recipe.get("build", {}).get("script_path")
    if not script:
        continue
    text = (root / script).read_text()
    assert not re.search(r"\$\{WASM_POSIX_DEP_(?:VERSION|SOURCE_URL|SOURCE_SHA256):-", text), script
    if re.search(r"\$WASM_POSIX_DEP_(?:VERSION|SOURCE_URL|SOURCE_SHA256)\b", text):
        assert "kandelo_package_load_source_metadata" in text, script
        helper = 'source "$REPO_ROOT/scripts/package-build-roots.sh"'
        assert helper in text, f"{script}: source metadata helper is not loaded"
        assert text.index(helper) < text.index("kandelo_package_load_source_metadata"), \
            f"{script}: source metadata helper must be loaded before use"
PY
echo 'test-package-source-metadata: ok'
