#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGER="$REPO_ROOT/scripts/stage-homebrew-bootstrap-browser-asset.sh"
RUN_SH="$REPO_ROOT/run.sh"
SUITE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-bootstrap-stage.XXXXXX")"

cleanup() {
  case "$SUITE_ROOT" in
    "${TMPDIR:-/tmp}"/kandelo-bootstrap-stage.*)
      rm -rf -- "$SUITE_ROOT"
      ;;
  esac
}
trap cleanup EXIT

fail() {
  echo "test-stage-homebrew-bootstrap-browser-asset: $*" >&2
  exit 1
}

source_archive="$SUITE_ROOT/homebrew-bootstrap.zip"
public_dir="$SUITE_ROOT/public"
browser_asset="$public_dir/homebrew-bootstrap.zip"
mkdir "$public_dir"
printf 'canonical bootstrap bytes\n' >"$source_archive"

bash "$STAGER" "$source_archive" "$browser_asset"
cmp "$source_archive" "$browser_asset" ||
  fail "initial staging changed the canonical package bytes"
[ "$(stat -c '%a' "$browser_asset")" = 644 ] ||
  fail "staged browser asset does not have mode 0644"

printf 'stale bootstrap bytes\n' >"$browser_asset"
bash "$STAGER" "$source_archive" "$browser_asset"
cmp "$source_archive" "$browser_asset" ||
  fail "stale browser asset was not atomically replaced"

printf 'preserve destination\n' >"$browser_asset"
cp "$browser_asset" "$SUITE_ROOT/preserved"
if bash "$STAGER" "$SUITE_ROOT/missing.zip" "$browser_asset" >/dev/null 2>&1; then
  fail "missing canonical package output was accepted"
fi
cmp "$SUITE_ROOT/preserved" "$browser_asset" ||
  fail "missing input changed the prior browser asset"

mkdir "$SUITE_ROOT/not-a-file"
if bash "$STAGER" "$SUITE_ROOT/not-a-file" "$browser_asset" >/dev/null 2>&1; then
  fail "non-regular canonical package output was accepted"
fi
cmp "$SUITE_ROOT/preserved" "$browser_asset" ||
  fail "non-regular input changed the prior browser asset"

rm "$browser_asset"
ln -s "$SUITE_ROOT/preserved" "$browser_asset"
if bash "$STAGER" "$source_archive" "$browser_asset" >/dev/null 2>&1; then
  fail "symlink browser destination was accepted"
fi
[ -L "$browser_asset" ] || fail "rejected destination symlink was replaced"

browser_function="$SUITE_ROOT/prepare-browser-homebrew-bootstrap-function.sh"
sed -n '/^prepare_browser_homebrew_bootstrap()/,/^}/p' "$RUN_SH" \
  >"$browser_function"

fixture="$SUITE_ROOT/repository"
mkdir -p "$fixture/scripts" "$fixture/apps/browser-demos/public" \
  "$fixture/resolved"
cp "$STAGER" "$fixture/scripts/stage-homebrew-bootstrap-browser-asset.sh"
cp "$source_archive" "$fixture/resolved/homebrew-bootstrap.zip"
cat >"$fixture/scripts/resolve-binary.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\$#" -eq 1 ]
[ "\$1" = programs/homebrew-bootstrap/homebrew-bootstrap.zip ]
printf '%s\n' '$fixture/resolved/homebrew-bootstrap.zip'
EOF
chmod +x "$fixture/scripts/resolve-binary.sh"
cat >"$fixture/fake-xtask" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >'$fixture/resolve-args'
EOF
chmod +x "$fixture/fake-xtask"

(
  REPO_ROOT="$fixture"
  CI_BROWSER_SOURCE_AUTHORITY=""
  FETCH_ONLY_ARGS=(--fetch-only)
  step() { :; }
  err() { printf '%s\n' "$*" >&2; }
  pkg_xtask_bin() { printf '%s\n' "$fixture/fake-xtask"; }
  pkg_output_rel() {
    [ "$1" = homebrew-bootstrap ]
    [ "$2" = homebrew-bootstrap.zip ]
    [ "$3" = wasm32 ]
    printf '%s\n' homebrew-bootstrap/homebrew-bootstrap.zip
  }
  # shellcheck source=/dev/null
  source "$browser_function"
  prepare_browser_homebrew_bootstrap
)

grep -Fxq \
  'build-deps --arch wasm32 --binaries-dir REPO/local-binaries --fetch-only resolve homebrew-bootstrap' \
  <(sed "s#$fixture#REPO#g" "$fixture/resolve-args") ||
  fail "ordinary browser preparation did not resolve the canonical package fetch-only"
cmp "$source_archive" \
  "$fixture/apps/browser-demos/public/homebrew-bootstrap.zip" ||
  fail "ordinary browser preparation did not stage the resolver-selected bytes"

if grep -Fq 'homebrew-bootstrap' \
  <(sed -n '/^BROWSER_FETCH_SKIP_PKGS=/p' "$RUN_SH"); then
  fail "ordinary browser package fetching still excludes homebrew-bootstrap"
fi

echo "test-stage-homebrew-bootstrap-browser-asset: ok"
