#!/usr/bin/env bash
# Build and exercise the complete ABI 43 Homebrew login product locally.
set -euo pipefail

KANDELO_LOGIN_TAP_ROOT=""
KANDELO_LOGIN_WORK_ROOT=""
KANDELO_LOGIN_BROWSER_DEMO=false
KANDELO_LOGIN_BUILD_USER="kandelo-homebrew-build"
KANDELO_LOGIN_RECIPE_USER="kandelo-homebrew-recipe"
KANDELO_LOGIN_SHARED_TEMP=""
KANDELO_LOGIN_BUILD_USER_CREATED=false
KANDELO_LOGIN_RECIPE_USER_CREATED=false

usage() {
  cat >&2 <<'EOF'
usage: scripts/run-login-stack-local.sh --tap-root <absolute-clean-tap> --work-root <absolute-new-directory> [--browser-demo]

This local-only harness builds the complete selected ABI 43 Formula closure,
composes an immutable review-pending image and closed mirror, and preserves all
evidence below the exclusive work root. It never publishes or changes a
selection lock.
EOF
}

fail() {
  echo "run-login-stack-local.sh: $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root)
      [ -z "$KANDELO_LOGIN_TAP_ROOT" ] && [ "$#" -ge 2 ] || fail "duplicate or incomplete --tap-root"
      KANDELO_LOGIN_TAP_ROOT="$2"
      shift 2
      ;;
    --work-root)
      [ -z "$KANDELO_LOGIN_WORK_ROOT" ] && [ "$#" -ge 2 ] || fail "duplicate or incomplete --work-root"
      KANDELO_LOGIN_WORK_ROOT="$2"
      shift 2
      ;;
    --browser-demo)
      [ "$KANDELO_LOGIN_BROWSER_DEMO" = false ] || fail "duplicate --browser-demo"
      KANDELO_LOGIN_BROWSER_DEMO=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown flag: $1"
      ;;
  esac
done

[ -n "$KANDELO_LOGIN_TAP_ROOT" ] || fail "--tap-root is required"
[ -n "$KANDELO_LOGIN_WORK_ROOT" ] || fail "--work-root is required"
case "$KANDELO_LOGIN_TAP_ROOT:$KANDELO_LOGIN_WORK_ROOT" in
  /*:/*) ;;
  *) fail "tap and work roots must be absolute" ;;
esac
[ "$KANDELO_LOGIN_TAP_ROOT" != / ] && [ "$KANDELO_LOGIN_WORK_ROOT" != / ] || fail "root paths are forbidden"
[ -d "$KANDELO_LOGIN_TAP_ROOT" ] && [ ! -L "$KANDELO_LOGIN_TAP_ROOT" ] || fail "tap root must be a real directory"
KANDELO_LOGIN_TAP_ROOT="$(cd "$KANDELO_LOGIN_TAP_ROOT" && pwd -P)"
[ ! -e "$KANDELO_LOGIN_WORK_ROOT" ] && [ ! -L "$KANDELO_LOGIN_WORK_ROOT" ] || fail "work root must not exist"
KANDELO_LOGIN_WORK_PARENT="$(dirname "$KANDELO_LOGIN_WORK_ROOT")"
[ -d "$KANDELO_LOGIN_WORK_PARENT" ] && [ ! -L "$KANDELO_LOGIN_WORK_PARENT" ] || fail "work-root parent must be a real directory"
KANDELO_LOGIN_WORK_PARENT="$(cd "$KANDELO_LOGIN_WORK_PARENT" && pwd -P)"
[ "$KANDELO_LOGIN_WORK_ROOT" = "$KANDELO_LOGIN_WORK_PARENT/$(basename "$KANDELO_LOGIN_WORK_ROOT")" ] || fail "work root must be below its physical parent"

KANDELO_LOGIN_INVOKING_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
KANDELO_LOGIN_KANDELO_COMMIT="$(git -C "$KANDELO_LOGIN_INVOKING_ROOT" rev-parse HEAD)"
KANDELO_LOGIN_TAP_COMMIT="$(git -C "$KANDELO_LOGIN_TAP_ROOT" rev-parse HEAD)"
for commit in "$KANDELO_LOGIN_KANDELO_COMMIT" "$KANDELO_LOGIN_TAP_COMMIT"; do
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "Kandelo and tap commits must be exact 40-character SHA-1 identities"
done
[ -z "$(git -C "$KANDELO_LOGIN_TAP_ROOT" status --short --untracked-files=all)" ] || fail "tap checkout must be completely clean"
KANDELO_LOGIN_LOCK="$KANDELO_LOGIN_INVOKING_ROOT/homebrew/main-shell-migration-lock.json"
[ "$(jq -er '.catalog.tap_commit' "$KANDELO_LOGIN_LOCK")" = "$KANDELO_LOGIN_TAP_COMMIT" ] || fail "tap HEAD differs from the migration lock"
[ "$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' "$KANDELO_LOGIN_INVOKING_ROOT/crates/shared/src/lib.rs")" = 43 ] || fail "the harness requires ABI 43"
[ "$(jq -r '.packages | length' "$KANDELO_LOGIN_LOCK")" = 36 ] || fail "product lock must select exactly 36 roots"
[ "$(jq -r '.formula_closure | length' "$KANDELO_LOGIN_LOCK")" = 43 ] || fail "product lock must resolve exactly 43 Formulae"
[ -n "${IN_NIX_SHELL:-}" ] || fail "run through scripts/dev-shell.sh"
[ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || fail "ambient Playwright browser cache authority is forbidden"
[ "$(uname -s)" = Linux ] || fail "ABI 43 bottle builds require a native Linux execution lane"
[ -d /run/systemd/system ] || fail "the Linux builder requires a running systemd manager"
[ -x /usr/bin/sudo ] || fail "the Linux builder requires /usr/bin/sudo"
/usr/bin/sudo -n true >/dev/null 2>&1 || fail "the Linux builder requires noninteractive sudo"
for protected_tool in \
  /usr/bin/systemd-run /usr/bin/systemctl /usr/bin/getent \
  /usr/bin/findmnt /usr/bin/pgrep \
  /usr/sbin/useradd /usr/sbin/userdel /usr/sbin/nologin; do
  [ -f "$protected_tool" ] && [ ! -L "$protected_tool" ] &&
    [ -x "$protected_tool" ] &&
    [ "$(stat -c '%u' "$protected_tool" 2>/dev/null || true)" = 0 ] ||
    fail "the Linux builder lacks protected host tool $protected_tool"
done
KANDELO_LOGIN_PKILL_TARGET="$(readlink -f -- /usr/bin/pkill 2>/dev/null || true)"
KANDELO_LOGIN_PKILL_PARENT="$(dirname /usr/bin/pkill)"
KANDELO_LOGIN_PKILL_PARENT_MODE="$(
  stat -c '%a' "$KANDELO_LOGIN_PKILL_PARENT" 2>/dev/null || true
)"
if [ -L /usr/bin/pkill ]; then
  [ "$KANDELO_LOGIN_PKILL_TARGET" = /usr/bin/pgrep ] &&
    [ "$(stat -c '%u' /usr/bin/pkill 2>/dev/null || true)" = 0 ] &&
    [ "$(stat -c '%u' "$KANDELO_LOGIN_PKILL_PARENT" 2>/dev/null || true)" = 0 ] &&
    [[ "$KANDELO_LOGIN_PKILL_PARENT_MODE" =~ ^[0-7]{3,4}$ ]] &&
    [ $((8#$KANDELO_LOGIN_PKILL_PARENT_MODE & 0022)) -eq 0 ] ||
    fail "the Linux builder has an unsafe /usr/bin/pkill alias"
else
  KANDELO_LOGIN_PKILL_MODE="$(stat -c '%a' /usr/bin/pkill 2>/dev/null || true)"
  [ -f /usr/bin/pkill ] && [ -x /usr/bin/pkill ] &&
    [ "$(stat -c '%u' /usr/bin/pkill 2>/dev/null || true)" = 0 ] &&
    [[ "$KANDELO_LOGIN_PKILL_MODE" =~ ^[0-7]{3,4}$ ]] &&
    [ $((8#$KANDELO_LOGIN_PKILL_MODE & 0022)) -eq 0 ] ||
    fail "the Linux builder lacks protected host tool /usr/bin/pkill"
fi
/usr/bin/sudo -n -- /usr/bin/systemctl show --property=Version --value \
  >/dev/null || fail "the Linux builder cannot access the systemd manager"
/usr/bin/systemd-run --help | grep -F -- '--expand-environment=' >/dev/null ||
  fail "the Linux builder cannot preserve exact Brew arguments"
for reserved_user in "$KANDELO_LOGIN_BUILD_USER" "$KANDELO_LOGIN_RECIPE_USER"; do
  ! /usr/bin/getent passwd "$reserved_user" >/dev/null ||
    fail "reserved Homebrew identity already exists: $reserved_user"
done
if [ -e /opt/kandelo/homebrew ] || [ -L /opt/kandelo/homebrew ]; then
  fail "ambient /opt/kandelo/homebrew state is forbidden; use a fresh Linux builder"
fi

# Validate only the active Ruby Formula and its declared recipe closure. The
# tap deliberately retains historical campaign evidence; it is not executable
# source for the current Formula and must not be confused with that closure.
bash "$KANDELO_LOGIN_INVOKING_ROOT/scripts/homebrew-validate-formula-source-closure.sh" \
  --tap-root "$KANDELO_LOGIN_TAP_ROOT" \
  --reviewed-tap-root "$KANDELO_LOGIN_TAP_ROOT" \
  --tap-repository kandelo-dev/homebrew-tap-core \
  --tap-name kandelo-dev/tap-core \
  --formula ruby \
  --base-ref "$KANDELO_LOGIN_TAP_COMMIT"
KANDELO_LOGIN_RUBY_RECIPE="$KANDELO_LOGIN_TAP_ROOT/Kandelo/recipes/ruby"
KANDELO_LOGIN_RUBY_CLOSURE="$(mktemp "$KANDELO_LOGIN_WORK_PARENT/.kandelo-login-ruby-closure.XXXXXX")"
trap 'rm -f -- "$KANDELO_LOGIN_RUBY_CLOSURE"; if [ -n "${KANDELO_LOGIN_RUBY_VALIDATION_ROOT:-}" ]; then rm -rf -- "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT"; fi' EXIT
{
  printf '%s\n' "$KANDELO_LOGIN_TAP_ROOT/Formula/ruby.rb" "$KANDELO_LOGIN_RUBY_RECIPE/recipe.json"
  jq -er '.files[].path' "$KANDELO_LOGIN_RUBY_RECIPE/recipe.json" |
    while IFS= read -r relative; do
      case "$relative" in
        ""|/*|*..*|*\\*) fail "Ruby recipe has an unsafe declared path" ;;
      esac
      printf '%s/%s\n' "$KANDELO_LOGIN_RUBY_RECIPE" "$relative"
    done
} >"$KANDELO_LOGIN_RUBY_CLOSURE"
while IFS= read -r path; do
  [ -f "$path" ] && [ ! -L "$path" ] || fail "Ruby declared source is not a regular file: $path"
done <"$KANDELO_LOGIN_RUBY_CLOSURE"
while IFS=$'\t' read -r expected relative; do
  [ "$(sha256sum "$KANDELO_LOGIN_RUBY_RECIPE/$relative" | awk '{print $1}')" = "$expected" ] || fail "Ruby declared source digest changed: $relative"
done < <(jq -r '.files[] | [.sha256,.path] | @tsv' "$KANDELO_LOGIN_RUBY_RECIPE/recipe.json")
if xargs -r grep -nE 'kandelo-posix-spawn[.]patch|github[.]com/Automattic/kandelo/pull/1166|ac_cv_func_vfork=no|828441ed6cd84b13ed064137ee5442c16a36ee44f7e3bdbb69557218277b63ea' <"$KANDELO_LOGIN_RUBY_CLOSURE"; then
  fail "active Ruby declared source closure contains retired PR #1166 input"
fi
grep -F 'url "https://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.5.tar.gz"' "$KANDELO_LOGIN_TAP_ROOT/Formula/ruby.rb" >/dev/null || fail "Ruby source URL changed"
grep -F 'sha256 "7d6149079a63f8ae1d326c9fa65c6019ba2dc3155eae7b39159817911c88958e"' "$KANDELO_LOGIN_TAP_ROOT/Formula/ruby.rb" >/dev/null || fail "Ruby source digest changed"
grep -F 'UPSTREAM_PROCESS_C_SHA256="39286bbe88bc5e8627f91ac780aa00403052cb1f700c2f25b5407b7af807e608"' "$KANDELO_LOGIN_RUBY_RECIPE/build.sh" >/dev/null || fail "Ruby pristine process.c marker changed"

KANDELO_LOGIN_RUBY_VALIDATION_ROOT="$(mktemp -d "$KANDELO_LOGIN_WORK_PARENT/.kandelo-login-ruby-source.XXXXXX")"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/ruby.tar.gz" \
  https://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.5.tar.gz
[ "$(sha256sum "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/ruby.tar.gz" | awk '{print $1}')" = "7d6149079a63f8ae1d326c9fa65c6019ba2dc3155eae7b39159817911c88958e" ] || fail "Ruby upstream archive digest changed"
mkdir "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/source"
tar -xzf "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/ruby.tar.gz" --strip-components=1 -C "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/source"
KANDELO_LOGIN_RUBY_TREE_SHA256="$(
  cd "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/source"
  find -P . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
)"
[ "$(sha256sum "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/source/process.c" | awk '{print $1}')" = "39286bbe88bc5e8627f91ac780aa00403052cb1f700c2f25b5407b7af807e608" ] || fail "extracted Ruby process.c is not pristine upstream"
! grep -F 'kandelo_execarg_can_posix_spawn' "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/source/process.c" >/dev/null || fail "extracted Ruby source contains PR #1166 residue"

mkdir "$KANDELO_LOGIN_WORK_ROOT"
chmod 0700 "$KANDELO_LOGIN_WORK_ROOT"
KANDELO_LOGIN_SOURCE="$KANDELO_LOGIN_WORK_ROOT/kandelo-source"
(
  cd "$KANDELO_LOGIN_INVOKING_ROOT"
  git worktree add --detach "$KANDELO_LOGIN_SOURCE" "$KANDELO_LOGIN_KANDELO_COMMIT"
)
git -C "$KANDELO_LOGIN_SOURCE" submodule sync --recursive
git -C "$KANDELO_LOGIN_SOURCE" \
  -c 'url.https://github.com/.insteadOf=git@github.com:' \
  submodule update --init --recursive
mkdir "$KANDELO_LOGIN_WORK_ROOT/source-evidence"
cp -p "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT/source/process.c" "$KANDELO_LOGIN_WORK_ROOT/source-evidence/ruby-process.c"
jq -nS \
  --arg archive_sha256 7d6149079a63f8ae1d326c9fa65c6019ba2dc3155eae7b39159817911c88958e \
  --arg tree_sha256 "$KANDELO_LOGIN_RUBY_TREE_SHA256" \
  --arg process_c_sha256 39286bbe88bc5e8627f91ac780aa00403052cb1f700c2f25b5407b7af807e608 \
  '{schema:1, source:"pristine-upstream", archive_sha256:$archive_sha256, tree_sha256:$tree_sha256, process_c_sha256:$process_c_sha256, configured:false}' \
  >"$KANDELO_LOGIN_WORK_ROOT/source-evidence/ruby-pristine-source.json"
rm -rf -- "$KANDELO_LOGIN_RUBY_VALIDATION_ROOT"
KANDELO_LOGIN_RUBY_VALIDATION_ROOT=""
rm -f -- "$KANDELO_LOGIN_RUBY_CLOSURE"
trap - EXIT

cleanup_formula_identities() {
  local original_status="$?"
  local cleanup_status=0
  trap - EXIT
  if [ -n "$KANDELO_LOGIN_SHARED_TEMP" ]; then
    case "$KANDELO_LOGIN_SHARED_TEMP" in
      /tmp/kandelo-homebrew.??????)
        if [ -d "$KANDELO_LOGIN_SHARED_TEMP" ] &&
           [ ! -L "$KANDELO_LOGIN_SHARED_TEMP" ]; then
          /usr/bin/sudo -n -- /usr/bin/rm -rf -- \
            "$KANDELO_LOGIN_SHARED_TEMP" || cleanup_status=1
        else
          echo "run-login-stack-local.sh: refusing unsafe shared-temp cleanup" >&2
          cleanup_status=1
        fi
        ;;
      *)
        echo "run-login-stack-local.sh: refusing unrecognized shared-temp cleanup" >&2
        cleanup_status=1
        ;;
    esac
  fi
  if [ "$KANDELO_LOGIN_RECIPE_USER_CREATED" = true ]; then
    /usr/bin/sudo -n -- /usr/sbin/userdel "$KANDELO_LOGIN_RECIPE_USER" ||
      cleanup_status=1
  fi
  if [ "$KANDELO_LOGIN_BUILD_USER_CREATED" = true ]; then
    /usr/bin/sudo -n -- /usr/sbin/userdel -r "$KANDELO_LOGIN_BUILD_USER" ||
      cleanup_status=1
  fi
  if [ "$original_status" -ne 0 ]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}

# The normal publisher executes Formula Ruby as a dedicated identity and tap
# recipes as a second, less-privileged identity. The local product harness uses
# the same boundary; otherwise Formula tests fall back to the invoking user's
# checkout and undeclared host tools instead of the sealed test projection.
trap cleanup_formula_identities EXIT
/usr/bin/sudo -n -- /usr/sbin/useradd --system --user-group --create-home \
  --home-dir "/home/$KANDELO_LOGIN_BUILD_USER" --shell /usr/sbin/nologin \
  "$KANDELO_LOGIN_BUILD_USER"
KANDELO_LOGIN_BUILD_USER_CREATED=true
/usr/bin/sudo -n -- /usr/sbin/useradd --system --user-group --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin \
  "$KANDELO_LOGIN_RECIPE_USER"
KANDELO_LOGIN_RECIPE_USER_CREATED=true
[ "$(/usr/bin/id -u "$KANDELO_LOGIN_BUILD_USER")" != "$(/usr/bin/id -u)" ] &&
  [ "$(/usr/bin/id -u "$KANDELO_LOGIN_RECIPE_USER")" != "$(/usr/bin/id -u)" ] &&
  [ "$(/usr/bin/id -u "$KANDELO_LOGIN_RECIPE_USER")" != \
    "$(/usr/bin/id -u "$KANDELO_LOGIN_BUILD_USER")" ] ||
  fail "isolated Homebrew identities are not distinct"
if /usr/bin/sudo -n -H -u "$KANDELO_LOGIN_BUILD_USER" -- \
  /usr/bin/sudo -n true >/dev/null 2>&1; then
  fail "Formula build identity unexpectedly has sudo access"
fi
if /usr/bin/sudo -n -H -u "$KANDELO_LOGIN_RECIPE_USER" -- \
  /usr/bin/sudo -n true >/dev/null 2>&1; then
  fail "tap recipe identity unexpectedly has sudo access"
fi
KANDELO_LOGIN_SHARED_TEMP="$(mktemp -d /tmp/kandelo-homebrew.XXXXXX)"
/usr/bin/sudo -n -- /usr/bin/chown root:root "$KANDELO_LOGIN_SHARED_TEMP"
/usr/bin/sudo -n -- /usr/bin/chmod 1777 "$KANDELO_LOGIN_SHARED_TEMP"
[ "$(stat -c '%u:%g:%a' "$KANDELO_LOGIN_SHARED_TEMP")" = "0:0:1777" ] ||
  fail "shared Formula temporary root is not protected"

cd "$KANDELO_LOGIN_SOURCE"
npm ci 2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/npm-root-ci.log"
npm --prefix apps/browser-demos ci \
  2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/npm-browser-demos-ci.log"
KANDELO_LOGIN_NODE_BIN="$(command -v node)"
case "$KANDELO_LOGIN_NODE_BIN" in
  /nix/store/*/bin/node) ;;
  *)
    fail "Formula browser provisioning resolved an undeclared Node: $KANDELO_LOGIN_NODE_BIN"
    ;;
esac
bash scripts/homebrew-provision-formula-browser.sh \
  --shared-temp "$KANDELO_LOGIN_SHARED_TEMP" \
  --build-user "$KANDELO_LOGIN_BUILD_USER" \
  --sudo-bin /usr/bin/sudo \
  --node-bin "$KANDELO_LOGIN_NODE_BIN" \
  --browser-app "$KANDELO_LOGIN_SOURCE/apps/browser-demos" \
  2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/formula-browser-provision.log"
KANDELO_LOGIN_FORMULA_BROWSER_CACHE="$KANDELO_LOGIN_SHARED_TEMP/ms-playwright"
[ -d "$KANDELO_LOGIN_FORMULA_BROWSER_CACHE" ] &&
  [ ! -L "$KANDELO_LOGIN_FORMULA_BROWSER_CACHE" ] &&
  [ "$(stat -c '%u:%g' "$KANDELO_LOGIN_FORMULA_BROWSER_CACHE")" = "0:0" ] ||
  fail "Formula browser cache is not the exact protected prepared directory"
bash scripts/build-musl.sh 2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/build-musl.log"
bash build.sh 2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/build.log"
# The reusable bottle workflow separately builds the package-owned kernel.
# Besides validating the kernel's host-adapter export contract, that path
# installs the exact admitted bytes at host/wasm/kandelo-kernel.wasm for the
# closed Formula-test runtime, which deliberately exposes no local-binaries
# source authority.
bash packages/registry/kernel/build-kernel.sh \
  2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/build-formula-test-kernel.log"
KANDELO_LOGIN_FORMULA_TEST_KERNEL="$(bash scripts/resolve-binary.sh kernel.wasm)"
[ -f "$KANDELO_LOGIN_FORMULA_TEST_KERNEL" ] &&
  [ ! -L "$KANDELO_LOGIN_FORMULA_TEST_KERNEL" ] ||
  fail "Formula test kernel is not one pinned admitted generation member"
cmp "$KANDELO_LOGIN_FORMULA_TEST_KERNEL" \
  "$KANDELO_LOGIN_SOURCE/host/wasm/kandelo-kernel.wasm" ||
  fail "Formula test runtime kernel differs from its admitted generation"
bash scripts/build-programs.sh 2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/build-programs.log"

# Materialize the same closed Formula-test checker and selected program index
# as the reusable bottle workflow. Formula tests receive this exact immutable
# projection, not Cargo/Nix authority or the live detached checkout.
KANDELO_LOGIN_HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
[ -n "$KANDELO_LOGIN_HOST_TARGET" ] || fail "unable to resolve the Rust host target"
cargo build --release -p xtask --target "$KANDELO_LOGIN_HOST_TARGET" --quiet
KANDELO_LOGIN_XTASK_BIN="$KANDELO_LOGIN_SOURCE/target/$KANDELO_LOGIN_HOST_TARGET/release/xtask"
[ -f "$KANDELO_LOGIN_XTASK_BIN" ] && [ ! -L "$KANDELO_LOGIN_XTASK_BIN" ] &&
  [ -x "$KANDELO_LOGIN_XTASK_BIN" ] &&
  [ "$(realpath -- "$KANDELO_LOGIN_XTASK_BIN")" = "$KANDELO_LOGIN_XTASK_BIN" ] ||
  fail "prepared Formula test xtask is not an exact executable"
sealed_xtask="$(
  bash scripts/seal-homebrew-formula-checker.sh \
    --root "$KANDELO_LOGIN_SOURCE" --checker "$KANDELO_LOGIN_XTASK_BIN"
)"
[ "$sealed_xtask" = "$KANDELO_LOGIN_XTASK_BIN" ] ||
  fail "Formula test checker seal selected another executable"
# Formula support evaluates before the isolated launcher can copy this checker
# into its private root-owned projection. Transfer the already detached,
# authenticated inode to root now so both the outer Formula evaluation and the
# later isolated test receive the same ownership boundary.
/usr/bin/sudo -n -- /usr/bin/chown root:root "$KANDELO_LOGIN_XTASK_BIN"
KANDELO_LOGIN_XTASK_SHA256="$(sha256sum "$KANDELO_LOGIN_XTASK_BIN" | awk '{print $1}')"
KANDELO_LOGIN_XTASK_UID="$(stat -c '%u' "$KANDELO_LOGIN_XTASK_BIN")"
[[ "$KANDELO_LOGIN_XTASK_SHA256" =~ ^[0-9a-f]{64}$ ]] &&
  [ "$KANDELO_LOGIN_XTASK_UID" = 0 ] &&
  [ "$(stat -c '%a:%h:%u' "$KANDELO_LOGIN_XTASK_BIN")" = "555:1:0" ] ||
  fail "Formula test checker seal has an invalid identity"
reseal_formula_test_checker() {
  local context="$1"
  local actual_sha256 resealed_sha256 resealed_xtask

  [ -f "$KANDELO_LOGIN_XTASK_BIN" ] &&
    [ ! -L "$KANDELO_LOGIN_XTASK_BIN" ] &&
    [ -x "$KANDELO_LOGIN_XTASK_BIN" ] &&
    [ "$(realpath -- "$KANDELO_LOGIN_XTASK_BIN")" = "$KANDELO_LOGIN_XTASK_BIN" ] &&
    [ "$(stat -c '%a:%h:%u' "$KANDELO_LOGIN_XTASK_BIN")" = "555:1:0" ] ||
    fail "Formula test checker identity changed during $context"
  actual_sha256="$(sha256sum "$KANDELO_LOGIN_XTASK_BIN" 2>/dev/null || true)"
  actual_sha256="${actual_sha256%% *}"
  [ "$actual_sha256" = "$KANDELO_LOGIN_XTASK_SHA256" ] ||
    fail "Formula test checker bytes changed during $context"
  if ! resealed_xtask="$(
    /usr/bin/sudo -n -- bash \
      "$KANDELO_LOGIN_SOURCE/scripts/seal-homebrew-formula-checker.sh" \
      --root "$KANDELO_LOGIN_SOURCE" --checker "$KANDELO_LOGIN_XTASK_BIN"
  )"; then
    fail "Formula test checker reseal failed after $context"
  fi
  resealed_sha256="$(sha256sum "$KANDELO_LOGIN_XTASK_BIN" 2>/dev/null || true)"
  resealed_sha256="${resealed_sha256%% *}"
  [ "$resealed_xtask" = "$KANDELO_LOGIN_XTASK_BIN" ] &&
    [ "$(stat -c '%a:%h:%u' "$KANDELO_LOGIN_XTASK_BIN")" = "555:1:$KANDELO_LOGIN_XTASK_UID" ] &&
    [ "$resealed_sha256" = "$KANDELO_LOGIN_XTASK_SHA256" ] ||
    fail "Formula test checker reseal failed after $context"
}
# build-programs links libc++ from the developer resolver cache for ordinary
# in-worktree builds. Formula isolation cannot admit that mutable, external
# path. Match the reusable package-toolchain contract by replacing the three
# links with exact files inside the sysroot before it becomes protected input.
KANDELO_LOGIN_LIBCXX_PREFIX="$("$KANDELO_LOGIN_XTASK_BIN" \
  build-deps --arch wasm32 path libcxx)"
[ -d "$KANDELO_LOGIN_LIBCXX_PREFIX/include/c++/v1" ] &&
  [ ! -L "$KANDELO_LOGIN_LIBCXX_PREFIX/include/c++/v1" ] ||
  fail "resolved libc++ headers are not one real directory"
for archive in libc++.a libc++abi.a; do
  [ -f "$KANDELO_LOGIN_LIBCXX_PREFIX/lib/$archive" ] &&
    [ ! -L "$KANDELO_LOGIN_LIBCXX_PREFIX/lib/$archive" ] ||
    fail "resolved libc++ archive is not one regular file: $archive"
  rm -f "$KANDELO_LOGIN_SOURCE/sysroot/lib/$archive"
  install -m 0644 "$KANDELO_LOGIN_LIBCXX_PREFIX/lib/$archive" \
    "$KANDELO_LOGIN_SOURCE/sysroot/lib/$archive"
done
rm -rf "$KANDELO_LOGIN_SOURCE/sysroot/include/c++/v1"
cp -a "$KANDELO_LOGIN_LIBCXX_PREFIX/include/c++/v1" \
  "$KANDELO_LOGIN_SOURCE/sysroot/include/c++/v1"
(
  # shellcheck disable=SC1091
  . "$KANDELO_LOGIN_SOURCE/scripts/homebrew-patched-launcher.sh"
  homebrew_assert_tree_symlinks_contained \
    "$KANDELO_LOGIN_SOURCE/sysroot" sysroot
) || fail "materialized Formula sysroot is not self-contained"
# The reusable publisher admits an exact package generation before this
# fetch-only loop. Local Task 20 evidence has no published ABI 43 generation,
# so build the current-source rootfs once into the canonical resolver cache,
# then prove it is byte-identical to the rootfs already built above. Formula
# execution still receives only the immutable fetch-only projection.
"$KANDELO_LOGIN_XTASK_BIN" build-deps --arch wasm32 \
  --binaries-dir "$KANDELO_LOGIN_SOURCE/binaries" \
  --force-source-build resolve rootfs \
  2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/formula-runtime-rootfs-build.log"
cmp "$KANDELO_LOGIN_SOURCE/host/wasm/rootfs.vfs" \
  "$KANDELO_LOGIN_SOURCE/binaries/programs/wasm32/rootfs.vfs" ||
  fail "Formula runtime rootfs differs from the exact product rootfs"
for package in dash coreutils grep sed rootfs; do
  "$KANDELO_LOGIN_XTASK_BIN" build-deps --arch wasm32 \
    --binaries-dir "$KANDELO_LOGIN_SOURCE/binaries" --fetch-only resolve "$package"
done
KANDELO_LOGIN_PROGRAM_CACHE="$($KANDELO_LOGIN_XTASK_BIN build-deps cache-root)"
case "$KANDELO_LOGIN_PROGRAM_CACHE" in
  /*) ;;
  *) fail "Formula test program cache root is not absolute" ;;
esac
bash scripts/materialize-resolver-binaries.sh \
  "$KANDELO_LOGIN_SOURCE/binaries" "$KANDELO_LOGIN_PROGRAM_CACHE"
KANDELO_LOGIN_FORMULA_TEST_INDEX="$KANDELO_LOGIN_SOURCE/target/$KANDELO_LOGIN_HOST_TARGET/release/formula-test-program-packages.json"
WASM_POSIX_DEPS_REGISTRY="$KANDELO_LOGIN_SOURCE/packages/registry" \
  "$KANDELO_LOGIN_XTASK_BIN" build-deps program-index-selected \
    --source-repo-root "$KANDELO_LOGIN_SOURCE" \
    dash,coreutils,grep,sed,rootfs "$KANDELO_LOGIN_FORMULA_TEST_INDEX"
[ -f "$KANDELO_LOGIN_FORMULA_TEST_INDEX" ] &&
  [ ! -L "$KANDELO_LOGIN_FORMULA_TEST_INDEX" ] &&
  [ "$(realpath -- "$KANDELO_LOGIN_FORMULA_TEST_INDEX")" = \
    "$KANDELO_LOGIN_FORMULA_TEST_INDEX" ] ||
  fail "Formula test program index is not one exact file"

KANDELO_LOGIN_LOCAL_TAP="$KANDELO_LOGIN_WORK_ROOT/tap-local"
git clone --no-local --no-checkout \
  "$KANDELO_LOGIN_TAP_ROOT" "$KANDELO_LOGIN_LOCAL_TAP"
git -C "$KANDELO_LOGIN_LOCAL_TAP" checkout --detach "$KANDELO_LOGIN_TAP_COMMIT"
[ -z "$(git -C "$KANDELO_LOGIN_LOCAL_TAP" status --short --untracked-files=all)" ] || \
  fail "detached local tap clone is dirty"
git -C "$KANDELO_LOGIN_LOCAL_TAP" config user.name 'Brandon Payton'
git -C "$KANDELO_LOGIN_LOCAL_TAP" config user.email 'brandon@happycode.net'
git -C "$KANDELO_LOGIN_LOCAL_TAP" rm -r --ignore-unmatch \
  Kandelo/formula Kandelo/link Kandelo/reports Kandelo/metadata.json
cat >"$KANDELO_LOGIN_LOCAL_TAP/local-test-provenance.json" <<'EOF'
{
  "schema": 1,
  "provenance_kind": "local-test",
  "promotable": false,
  "published": false
}
EOF
git -C "$KANDELO_LOGIN_LOCAL_TAP" add local-test-provenance.json
GIT_AUTHOR_NAME='Brandon Payton' GIT_AUTHOR_EMAIL='brandon@happycode.net' \
GIT_COMMITTER_NAME='Brandon Payton' GIT_COMMITTER_EMAIL='brandon@happycode.net' \
  git -C "$KANDELO_LOGIN_LOCAL_TAP" commit -m 'Local-test: Initialize ABI 43 bottle catalog'

KANDELO_LOGIN_HOMEBREW_COMMIT=a92554a538e81fad0c5074443885dbcc4c36221d
KANDELO_LOGIN_HOMEBREW_ROOT="$KANDELO_LOGIN_WORK_ROOT/homebrew-implementation"
git clone --filter=blob:none --no-checkout https://github.com/Homebrew/brew.git "$KANDELO_LOGIN_HOMEBREW_ROOT"
git -C "$KANDELO_LOGIN_HOMEBREW_ROOT" fetch --depth=1 origin "$KANDELO_LOGIN_HOMEBREW_COMMIT"
git -C "$KANDELO_LOGIN_HOMEBREW_ROOT" checkout --detach "$KANDELO_LOGIN_HOMEBREW_COMMIT"
[ -z "$(git -C "$KANDELO_LOGIN_HOMEBREW_ROOT" status --short --untracked-files=all)" ] || fail "reviewed Homebrew checkout is dirty"
bash scripts/homebrew-prepare-host-prefix.sh --layout-mode canonical --prefix /opt/kandelo/homebrew
rm -f /opt/kandelo/homebrew/bin/brew
ln -s "$KANDELO_LOGIN_HOMEBREW_ROOT/bin/brew" /opt/kandelo/homebrew/bin/brew
export HOMEBREW_BREW_FILE=/opt/kandelo/homebrew/bin/brew
export HOMEBREW_BREW_COMMIT="$KANDELO_LOGIN_HOMEBREW_COMMIT"
export HOMEBREW_CACHE="$KANDELO_LOGIN_WORK_ROOT/homebrew-cache"
export HOMEBREW_TEMP="$KANDELO_LOGIN_WORK_ROOT/homebrew-temp"
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_ANALYTICS=1
export HOMEBREW_DEVELOPER=1
mkdir "$HOMEBREW_CACHE" "$HOMEBREW_TEMP"
[ "$($HOMEBREW_BREW_FILE --prefix)" = /opt/kandelo/homebrew ] || fail "reviewed Homebrew selected the wrong prefix"
[ "$($HOMEBREW_BREW_FILE --cellar)" = /opt/kandelo/homebrew/Cellar ] || fail "reviewed Homebrew selected the wrong Cellar"

KANDELO_LOGIN_BOTTLE_CACHE="$KANDELO_LOGIN_WORK_ROOT/bottle-cache"
KANDELO_LOGIN_BUILD_ROOT="$KANDELO_LOGIN_WORK_ROOT/formula-builds"
KANDELO_LOGIN_SIDECAR_ROOT="$KANDELO_LOGIN_WORK_ROOT/sidecars"
KANDELO_LOGIN_RESOLVED_TAPS="$KANDELO_LOGIN_WORK_ROOT/resolved-taps.json"
KANDELO_LOGIN_BOTTLE_ROOT=https://ghcr.io/v2/kandelo-dev/homebrew-tap-core
mkdir "$KANDELO_LOGIN_BOTTLE_CACHE" "$KANDELO_LOGIN_BUILD_ROOT" "$KANDELO_LOGIN_SIDECAR_ROOT"
KANDELO_LOGIN_FORBIDDEN_ROOTS_JSON="$(
  jq -n --arg work "$KANDELO_LOGIN_WORK_ROOT" \
    --arg build "$KANDELO_LOGIN_BUILD_ROOT" \
    --arg temp "$HOMEBREW_TEMP" \
    --arg shared_temp "$KANDELO_LOGIN_SHARED_TEMP" \
    '[$work,$build,$temp,$shared_temp] | unique'
)"
jq -e 'length > 0 and all(.[]; startswith("/"))' \
  <<<"$KANDELO_LOGIN_FORBIDDEN_ROOTS_JSON" >/dev/null || \
  fail "local sidecar forbidden roots are invalid"
jq -nS \
  --arg kandelo_commit "$KANDELO_LOGIN_KANDELO_COMMIT" \
  --arg tap_commit "$KANDELO_LOGIN_TAP_COMMIT" \
  --arg homebrew_commit "$KANDELO_LOGIN_HOMEBREW_COMMIT" \
  --arg ruby_tree_sha256 "$KANDELO_LOGIN_RUBY_TREE_SHA256" \
  '{schema:1, provenance:{schema:1, provenance_kind:"local-test", promotable:false, published:false}, kandelo_commit:$kandelo_commit, tap_commit:$tap_commit, homebrew_commit:$homebrew_commit, abi:43, ruby_pristine_tree_sha256:$ruby_tree_sha256, formulae:[]}' \
  >"$KANDELO_LOGIN_WORK_ROOT/bottle-build-report.json"

refresh_resolved_taps() {
  local checkout_commit
  checkout_commit="$(git -C "$KANDELO_LOGIN_LOCAL_TAP" rev-parse HEAD)"
  rm -f "$KANDELO_LOGIN_RESOLVED_TAPS"
  python3 scripts/homebrew-dependency-taps.py resolve \
    --tap-root "$KANDELO_LOGIN_LOCAL_TAP" \
    --tap-name kandelo-dev/tap-core \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$KANDELO_LOGIN_TAP_COMMIT" \
    --checkout-commit "$checkout_commit" \
    --out "$KANDELO_LOGIN_RESOLVED_TAPS"
  export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_LOGIN_RESOLVED_TAPS"
  export KANDELO_HOMEBREW_TAP_SOURCE_COMMIT="$KANDELO_LOGIN_TAP_COMMIT"
  export KANDELO_HOMEBREW_PREPARED_TAP_COMMIT="$checkout_commit"
}

commit_local_tap() {
  local subject="$1"
  git -C "$KANDELO_LOGIN_LOCAL_TAP" add Formula Kandelo local-test-provenance.json
  GIT_AUTHOR_NAME='Brandon Payton' GIT_AUTHOR_EMAIL='brandon@happycode.net' \
  GIT_COMMITTER_NAME='Brandon Payton' GIT_COMMITTER_EMAIL='brandon@happycode.net' \
    git -C "$KANDELO_LOGIN_LOCAL_TAP" commit -m "$subject"
}

mapfile -t KANDELO_LOGIN_FORMULAE < <(jq -er '.formula_closure[]' homebrew/main-shell-migration-lock.json)
[ "${#KANDELO_LOGIN_FORMULAE[@]}" -eq 43 ] || fail "runtime Formula closure is incomplete"
# Use the same strict Formula parser as bottle construction to prove every
# exact same-tap dependency precedes its consumer in the costly build loop.
declare -A KANDELO_LOGIN_FORMULA_POSITION=()
for index in "${!KANDELO_LOGIN_FORMULAE[@]}"; do
  KANDELO_LOGIN_FORMULA_POSITION["${KANDELO_LOGIN_FORMULAE[$index]}"]="$index"
done
for full_name in "${KANDELO_LOGIN_FORMULAE[@]}"; do
  formula="${full_name##*/}"
  while IFS= read -r dependency; do
    [ -n "${KANDELO_LOGIN_FORMULA_POSITION[$dependency]+set}" ] || \
      fail "Formula build sequence omits dependency $dependency of $full_name"
    [ "${KANDELO_LOGIN_FORMULA_POSITION[$dependency]}" -lt \
      "${KANDELO_LOGIN_FORMULA_POSITION[$full_name]}" ] || \
      fail "Formula dependency must precede its consumer: $dependency -> $full_name"
  done < <(ruby scripts/homebrew-formula-runtime-closure.rb \
    "$KANDELO_LOGIN_LOCAL_TAP" kandelo-dev/tap-core "$formula" --direct)
done
for full_name in "${KANDELO_LOGIN_FORMULAE[@]}"; do
  formula="${full_name##*/}"
  formula_out="$KANDELO_LOGIN_BUILD_ROOT/$formula"
  mkdir "$formula_out"
  formula_source_root="$formula_out/formula-source"
  formula_verify_root="$formula_out/formula-verify"
  build_tap_commit="$(git -C "$KANDELO_LOGIN_LOCAL_TAP" rev-parse HEAD)"
  git -C "$KANDELO_LOGIN_LOCAL_TAP" worktree add --detach \
    "$formula_source_root" "$build_tap_commit"
  build_formula_sha256="$(sha256sum "$formula_source_root/Formula/$formula.rb" | awk '{print $1}')"
  runtime_evidence="$formula_out/runtime-evidence.json"
  selection_receipt="$formula_out/selection-receipt.json"
  sidecars="$KANDELO_LOGIN_SIDECAR_ROOT/$formula"
  refresh_resolved_taps
  formula_host_cache="$KANDELO_LOGIN_SHARED_TEMP/cache-$formula"
  formula_host_temp="$KANDELO_LOGIN_SHARED_TEMP/temp-$formula"
  mkdir "$formula_host_cache" "$formula_host_temp"
  formula_isolation_env=(
    HOMEBREW_CACHE="$formula_host_cache"
    HOMEBREW_TEMP="$formula_host_temp"
    PLAYWRIGHT_BROWSERS_PATH="$KANDELO_LOGIN_SHARED_TEMP/ms-playwright"
    KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE="$KANDELO_LOGIN_BOTTLE_CACHE"
    KANDELO_HOMEBREW_BUILD_USER="$KANDELO_LOGIN_BUILD_USER"
    KANDELO_HOMEBREW_RECIPE_USER="$KANDELO_LOGIN_RECIPE_USER"
    KANDELO_HOMEBREW_SHARED_TEMP="$KANDELO_LOGIN_SHARED_TEMP"
    KANDELO_HOMEBREW_SUDO_BIN=/usr/bin/sudo
    KANDELO_HOMEBREW_SYSTEMD_RUN_BIN=/usr/bin/systemd-run
    KANDELO_HOMEBREW_SYSTEMCTL_BIN=/usr/bin/systemctl
    KANDELO_HOMEBREW_GETENT_BIN=/usr/bin/getent
    KANDELO_HOMEBREW_PGREP_BIN=/usr/bin/pgrep
    KANDELO_HOMEBREW_PKILL_BIN=/usr/bin/pkill
    WASM_POSIX_XTASK_BIN="$KANDELO_LOGIN_XTASK_BIN"
  )
  formula_build_evidence_env=()
  if [ "$formula" = ruby ]; then
    formula_build_evidence_env+=(KANDELO_HOMEBREW_LOCAL_BUILD_EVIDENCE="$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence")
  fi
  env "${formula_isolation_env[@]}" "${formula_build_evidence_env[@]}" \
    bash scripts/homebrew-bottle-build.sh \
    --tap-root "$KANDELO_LOGIN_LOCAL_TAP" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-name kandelo-dev/tap-core \
    --formula "$formula" \
    --arch wasm32 \
    --out "$formula_out" \
    --bottle-root-url "$KANDELO_LOGIN_BOTTLE_ROOT" \
    --retire-source-install \
    2>&1 | tee "$formula_out/build.log"
  # shellcheck disable=SC1090
  . "$formula_out/build.env"
  bottle_sha256="$(sha256sum "$BOTTLE_ARCHIVE" | awk '{print $1}')"
  bottle_bytes="$(wc -c <"$BOTTLE_ARCHIVE" | tr -d '[:space:]')"
  bottle_url="$KANDELO_LOGIN_BOTTLE_ROOT/$formula/blobs/sha256:$bottle_sha256"
  formula_key="kandelo-dev/tap-core/$formula"
  rebuild="$(jq -er --arg key "$formula_key" '.[$key].bottle.rebuild' "$BOTTLE_JSON")"
  cellar="$(jq -er --arg key "$formula_key" '.[$key].bottle.cellar' "$BOTTLE_JSON")"
  composed_formula="$formula_out/$formula.rb"
  ruby scripts/homebrew-compose-formula-bottle.rb \
    "$formula_source_root/Formula/$formula.rb" \
    "$KANDELO_LOGIN_TAP_ROOT/Formula/$formula.rb" \
    "$KANDELO_LOGIN_BOTTLE_ROOT" "$rebuild" wasm32_kandelo "$cellar" \
    "$bottle_sha256" discard "$composed_formula"
  # Mirror the publication workflow's split authority: verification sees the
  # exact build checkout plus only the reconstructed target bottle block,
  # while provenance hashes the unmodified Formula bytes Homebrew evaluated.
  git -C "$KANDELO_LOGIN_LOCAL_TAP" worktree add --detach \
    "$formula_verify_root" "$build_tap_commit"
  mv "$composed_formula" "$formula_verify_root/Formula/$formula.rb"
  ruby scripts/homebrew-formula-source-digest.rb \
    --equivalent-excluding-bottle \
    "$formula_source_root/Formula/$formula.rb" \
    "$formula_verify_root/Formula/$formula.rb" >/dev/null || \
    fail "local $formula verification Formula drifted outside its bottle block"
  jq -nS \
    --arg url "$bottle_url" --arg sha256 "$bottle_sha256" \
    --argjson bytes "$bottle_bytes" \
    '{schema:1,status:"success",bottle:{mode:"local-dry-run",url:$url,sha256:$sha256,bytes:$bytes},fetch:[("selected local-test bottle sha256:" + $sha256)]}' \
    >"$selection_receipt"
  env "${formula_isolation_env[@]}" \
  KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE="$KANDELO_LOGIN_BOTTLE_CACHE" \
  KANDELO_HOMEBREW_PREPARED_TAP_COMMIT="$build_tap_commit" \
    bash scripts/homebrew-verify-poured-bottle.sh \
      --tap-root "$formula_verify_root" \
      --tap-repository kandelo-dev/homebrew-tap-core \
      --tap-name kandelo-dev/tap-core \
      --tap-commit "$KANDELO_LOGIN_TAP_COMMIT" \
      --tap-checkout-commit "$build_tap_commit" \
      --formula "$formula" --arch wasm32 --abi 43 \
      --bottle "$BOTTLE_ARCHIVE" --bottle-json "$BOTTLE_JSON" \
      --bottle-url "$bottle_url" --bottle-sha256 "$bottle_sha256" \
      --bottle-bytes "$bottle_bytes" --bottle-root-url "$KANDELO_LOGIN_BOTTLE_ROOT" \
      --dependency-provenance "$DEPENDENCY_PROVENANCE" \
      --selection-receipt "$selection_receipt" \
      --sysroot-build-root "$KANDELO_LOGIN_SOURCE" \
      --out "$runtime_evidence" \
      2>&1 | tee "$formula_out/verify.log"
  if [ "$formula" = ruby ]; then
    ! grep -F 'make install failed, copying lib manually' \
      "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/homebrew-install.log" \
      >/dev/null || fail "Ruby used the payload-reducing fallback instead of normal upstream install"
    ruby_pkg_version="$(jq -er --arg key "$formula_key" '.[$key].formula.pkg_version' "$BOTTLE_JSON")"
    ruby_prefix="ruby/$ruby_pkg_version/bin/"
    mapfile -t ruby_inventory < <(
      tar -tzf "$BOTTLE_ARCHIVE" |
        awk -v prefix="$ruby_prefix" 'index($0,prefix)==1 {name=substr($0,length(prefix)+1); if (name != "" && name !~ /\//) print name}' |
        LC_ALL=C sort -u
    )
    expected_ruby_inventory="$(jq -cS '.product.ruby.required_stock_executables | sort' "$KANDELO_LOGIN_LOCK")"
    actual_ruby_inventory="$(printf '%s\n' "${ruby_inventory[@]}" | jq -Rsc 'split("\n")[:-1] | sort')"
    [ "$actual_ruby_inventory" = "$expected_ruby_inventory" ] || \
      fail "Ruby installed executable inventory differs from normal upstream install: $actual_ruby_inventory"
    mapfile -t ruby_runtime_inventory < <(
      unzip -Z1 "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/ruby-runtime.zip" |
        awk 'index($0,"usr/bin/")==1 {name=substr($0,length("usr/bin/")+1); if (name != "" && name !~ /\//) print name}' |
        LC_ALL=C sort -u
    )
    actual_ruby_runtime_inventory="$(printf '%s\n' "${ruby_runtime_inventory[@]}" | jq -Rsc 'split("\n")[:-1] | sort')"
    [ "$actual_ruby_runtime_inventory" = "$expected_ruby_inventory" ] || \
      fail "Ruby runtime archive executable inventory differs from normal upstream install: $actual_ruby_runtime_inventory"
    ruby_member="${ruby_prefix}ruby"
    archive_ruby_sha256="$(tar -xOf "$BOTTLE_ARCHIVE" "$ruby_member" | sha256sum | awk '{print $1}')"
    retained_ruby_sha256="$(sha256sum "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/instrumented-ruby.wasm" | awk '{print $1}')"
    [ "$archive_ruby_sha256" = "$retained_ruby_sha256" ] || \
      fail "final bottle bin/ruby is not the root-spilled fork-instrumented recipe artifact"
    for define in HAVE_VFORK HAVE_WORKING_VFORK HAVE_WORKING_FORK; do
      grep -Eq "^#define $define 1$" \
        "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/config.h" || \
        fail "Ruby retained config.h omits $define"
    done
    jq -nS \
      --argjson installed "$actual_ruby_inventory" \
      --argjson runtime_archive "$actual_ruby_runtime_inventory" \
      --arg bottle_sha256 "$bottle_sha256" \
      --arg ruby_sha256 "$archive_ruby_sha256" \
      --arg config_h_sha256 "$(sha256sum "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/config.h" | awk '{print $1}')" \
      --arg config_log_sha256 "$(sha256sum "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/config.log" | awk '{print $1}')" \
      --arg process_c_sha256 "$(sha256sum "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/process.c" | awk '{print $1}')" \
      --arg runtime_archive_sha256 "$(sha256sum "$KANDELO_LOGIN_WORK_ROOT/ruby-build-evidence/ruby-runtime.zip" | awk '{print $1}')" '
      {
        schema:1,
        provenance:{schema:1,provenance_kind:"local-test",promotable:false,published:false},
        install_path:"normal-upstream-install",
        runtime_archive_executables:$runtime_archive,
        bottle_archive_executables:$installed,
        installed_executables:$installed,
        bottle_sha256:$bottle_sha256,
        runtime_archive_sha256:$runtime_archive_sha256,
        final_ruby_sha256:$ruby_sha256,
        config_h_sha256:$config_h_sha256,
        config_log_sha256:$config_log_sha256,
        process_c_sha256:$process_c_sha256,
        config_defines:["HAVE_VFORK","HAVE_WORKING_VFORK","HAVE_WORKING_FORK"],
        root_spilled_and_fork_instrumented_recipe_artifact:true
      }' \
      >"$KANDELO_LOGIN_WORK_ROOT/ruby-installed-inventory.json"
  fi
  mkdir "$sidecars"
  KANDELO_HOMEBREW_TAP_ROOT="$formula_verify_root" \
  KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$formula_source_root" \
  KANDELO_HOMEBREW_BUILD_ROOT="$KANDELO_LOGIN_SOURCE" \
  KANDELO_HOMEBREW_SIDECAR_ROOT="$sidecars" \
  KANDELO_HOMEBREW_FORMULA="$formula" \
  KANDELO_HOMEBREW_ARCH=wasm32 \
  KANDELO_HOMEBREW_RELEASE_TAG=bottles-abi-v43 \
  KANDELO_HOMEBREW_TAP_REPOSITORY=kandelo-dev/homebrew-tap-core \
  KANDELO_HOMEBREW_TAP_NAME=kandelo-dev/tap-core \
  KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$BOTTLE_ARCHIVE" \
  KANDELO_HOMEBREW_BOTTLE_JSON="$BOTTLE_JSON" \
  KANDELO_HOMEBREW_BOTTLE_ROOT_URL="$KANDELO_LOGIN_BOTTLE_ROOT" \
  KANDELO_HOMEBREW_BOTTLE_URL="$bottle_url" \
  KANDELO_HOMEBREW_BOTTLE_SHA256="$bottle_sha256" \
  KANDELO_HOMEBREW_BOTTLE_BYTES="$bottle_bytes" \
  KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE="$DEPENDENCY_PROVENANCE" \
  KANDELO_HOMEBREW_RUNTIME_EVIDENCE="$runtime_evidence" \
  KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$KANDELO_LOGIN_FORBIDDEN_ROOTS_JSON" \
  KANDELO_HOMEBREW_PROVENANCE_KIND=local-test \
  KANDELO_HOMEBREW_PREPARED_TAP_COMMIT="$build_tap_commit" \
  bash scripts/homebrew-generate-sidecars-from-env.sh
  reseal_formula_test_checker "$formula sidecar generation"
  sidecar_formula_report="$sidecars/Kandelo/formula/$formula.json"
  [ -f "$sidecar_formula_report" ] && [ ! -L "$sidecar_formula_report" ] || \
    fail "local $formula sidecar formula report is not a regular file"
  archived_formula_sha256="$(
    jq -er '
      .packages[0].bottles[0].archived_formula_sha256 |
      select(type == "string" and test("^[0-9a-f]{64}$"))
    ' "$sidecars/sidecars-input.json"
  )"
  archived_formula_report_sha256="$(
    jq -er '
      .bottles[0].built_from.formula_sha256 |
      select(type == "string" and test("^[0-9a-f]{64}$"))
    ' "$sidecar_formula_report"
  )"
  [ "$(jq -er '.packages[0].formula_source_sha256' "$sidecars/sidecars-input.json")" = "$build_formula_sha256" ] || \
    fail "local $formula sidecar build-source Formula identity differs from the exact evaluated bytes"
  [ "$archived_formula_report_sha256" = "$archived_formula_sha256" ] || \
    fail "local $formula sidecar built-from Formula identity differs from the exact archived receipt"
  rsync -a --delete "$sidecars/Kandelo/" "$KANDELO_LOGIN_LOCAL_TAP/Kandelo/"
  cp -p "$sidecars/Formula/$formula.rb" "$KANDELO_LOGIN_LOCAL_TAP/Formula/$formula.rb"
  cp -p "$sidecars/local-test-provenance.json" "$KANDELO_LOGIN_LOCAL_TAP/local-test-provenance.json"
  commit_local_tap "Local-test: Bind ABI 43 $formula bottle and evidence"
  cp -p "$BOTTLE_ARCHIVE" "$KANDELO_LOGIN_BOTTLE_CACHE/$bottle_sha256.tar.gz"
  next_report="$formula_out/bottle-build-report.next.json"
  jq \
    --arg formula "$formula" --arg sha256 "$bottle_sha256" \
    --argjson bytes "$bottle_bytes" --arg bottle_url "$bottle_url" \
    --arg prepared_tap_commit "$(git -C "$KANDELO_LOGIN_LOCAL_TAP" rev-parse HEAD)" \
    --slurpfile runtime "$runtime_evidence" \
    '.formulae += [{formula:$formula,arch:"wasm32",kandelo_abi:43,sha256:$sha256,bytes:$bytes,url:$bottle_url,prepared_tap_commit:$prepared_tap_commit,runtime_evidence:$runtime[0],provenance:{schema:1,provenance_kind:"local-test",promotable:false,published:false}}]' \
    "$KANDELO_LOGIN_WORK_ROOT/bottle-build-report.json" >"$next_report"
  mv "$next_report" "$KANDELO_LOGIN_WORK_ROOT/bottle-build-report.json"
done

jq -e --argjson expected "$(printf '%s\n' "${KANDELO_LOGIN_FORMULAE[@]}" | jq -Rsc 'split("\n")[:-1]')" '
  (.packages | length) == 43 and
  ([.packages[].full_name] == $expected) and
  all(.packages[]; ([.bottles[] | select(.arch == "wasm32" and .status == "success" and .kandelo_abi == 43)] | length) == 1) and
  ([.packages[].bottles[].kandelo_abi] | all(. == 43))
' "$KANDELO_LOGIN_LOCAL_TAP/Kandelo/metadata.json" >/dev/null || fail "final local catalog is not the complete pure ABI 43 closure"
[ "$(jq '.formulae | length' "$KANDELO_LOGIN_WORK_ROOT/bottle-build-report.json")" = 43 ] || fail "bottle report omitted a Formula"

# The published-sidecar boundary must reject this exact local catalog before
# it can copy a byte or mutate a tap.
if bash scripts/homebrew-publish-sidecars.sh \
  --tap-root "$KANDELO_LOGIN_WORK_ROOT/must-not-publish" \
  --release-tag bottles-abi-v43 --status success \
  --formula ruby --arch wasm32 --sidecar-root "$KANDELO_LOGIN_LOCAL_TAP" \
  >"$KANDELO_LOGIN_WORK_ROOT/publisher-rejection.log" 2>&1; then
  fail "published-sidecar validator accepted local-test provenance"
fi
grep -F 'local-test provenance is not publishable' "$KANDELO_LOGIN_WORK_ROOT/publisher-rejection.log" >/dev/null || fail "publisher rejection did not report the local provenance boundary"

KANDELO_LOGIN_BOOTSTRAP="$KANDELO_LOGIN_WORK_ROOT/homebrew-bootstrap"
mkdir "$KANDELO_LOGIN_BOOTSTRAP"
bash scripts/prepare-homebrew-bootstrap-source.sh \
  --repository https://github.com/Homebrew/brew.git \
  --revision d6c1be418446eec7de09fc72441ba4462282a142 \
  --patch "$KANDELO_LOGIN_SOURCE/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch" \
  --expected-patch-sha256 faf62befeb70033ea450e88eb1b21427e221030a7f6b6ce932ad2c7c728ac2bc \
  --arch wasm32 --git-dir "$KANDELO_LOGIN_BOOTSTRAP/git" \
  --archive "$KANDELO_LOGIN_BOOTSTRAP/homebrew-bootstrap.zip" \
  --env "$KANDELO_LOGIN_BOOTSTRAP/homebrew-brew.env" \
  --provenance "$KANDELO_LOGIN_BOOTSTRAP/provenance.json"

KANDELO_HOMEBREW_TAP_SOURCE_COMMIT="$KANDELO_LOGIN_TAP_COMMIT" \
bash scripts/build-homebrew-main-shell-closure.sh \
  --tap-root "$KANDELO_LOGIN_LOCAL_TAP" \
  --expected-tap-sha "$KANDELO_LOGIN_TAP_COMMIT" \
  --work-dir "$KANDELO_LOGIN_WORK_ROOT/composition" \
  --out "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.zst" \
  --report "$KANDELO_LOGIN_WORK_ROOT/composition-report.json" \
  --bottle-cache "$KANDELO_LOGIN_BOTTLE_CACHE" \
  --package-tree-spec "$KANDELO_LOGIN_SOURCE/homebrew/main-shell-brew-package-tree.json" \
  --package-tree-archive "$KANDELO_LOGIN_BOOTSTRAP/homebrew-bootstrap.zip" \
  --homebrew-bootstrap-env "$KANDELO_LOGIN_BOOTSTRAP/homebrew-brew.env" \
  --lazy-shell --review-pending-artifact

KANDELO_LOGIN_PREPARED_TAP_COMMIT="$(
  git -C "$KANDELO_LOGIN_LOCAL_TAP" rev-parse HEAD
)"
jq -e \
  --arg source "$KANDELO_LOGIN_TAP_COMMIT" \
  --arg prepared "$KANDELO_LOGIN_PREPARED_TAP_COMMIT" '
  .local_test.source_tap_commit == $source and
  .local_test.prepared_tap_commit == $prepared and
  .local_test.staged_tap.source_commit == $source and
  .local_test.staged_tap.prepared_commit == $prepared and
  .local_test.staged_tap.path ==
    "/opt/kandelo/homebrew/var/kandelo/local-test/homebrew-tap-core.bundle" and
  (.local_test.staged_tap.sha256 | test("^[0-9a-f]{64}$")) and
  .local_test.staged_tap.bytes > 0
' "$KANDELO_LOGIN_WORK_ROOT/composition-report.json" >/dev/null || \
  fail "composition omitted the exact source/prepared local tap bundle"

KANDELO_LOGIN_MIRROR="$KANDELO_LOGIN_WORK_ROOT/composition/bottle-mirror"
KANDELO_LOGIN_MIRROR_PLAN="$KANDELO_LOGIN_MIRROR/kandelo-homebrew-bottle-mirror-plan.json"
[ -f "$KANDELO_LOGIN_MIRROR_PLAN" ] || fail "composition omitted the closed bottle mirror"
KANDELO_LOGIN_RSS_REPORT="$KANDELO_LOGIN_WORK_ROOT/process-tree-rss.json"
npx tsx --test scripts/homebrew-main-shell-image-contract.test.ts \
  2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/image-contract.log"
npx tsx scripts/homebrew-main-shell-node-smoke.ts \
  --image "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.zst" \
  --migration-lock "$KANDELO_LOGIN_SOURCE/homebrew/main-shell-migration-lock.json" \
  --homebrew-bootstrap-spec "$KANDELO_LOGIN_SOURCE/homebrew/main-shell-brew-package-tree.json" \
  --homebrew-bootstrap-archive "$KANDELO_LOGIN_BOOTSTRAP/homebrew-bootstrap.zip" \
  --homebrew-bootstrap-env "$KANDELO_LOGIN_BOOTSTRAP/homebrew-brew.env" \
  --homebrew-bootstrap-state deferred \
  --homebrew-runtime-support "$KANDELO_LOGIN_SOURCE/homebrew/main-shell-homebrew-runtime-support.json" \
  --demo-config "$KANDELO_LOGIN_SOURCE/homebrew/main-shell-demo.json" \
  --transport-mode closed --bottle-mirror-plan "$KANDELO_LOGIN_MIRROR_PLAN" \
  --rss-report "$KANDELO_LOGIN_RSS_REPORT" \
  --composition-report "$KANDELO_LOGIN_WORK_ROOT/composition-report.json" \
  --privileged-product "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.privileged.vfs" \
  2>&1 | tee "$KANDELO_LOGIN_WORK_ROOT/node-smoke.log"

KANDELO_LOGIN_FIXTURE="$KANDELO_LOGIN_WORK_ROOT/homebrew-login-lifecycle-fixture.json"
npx tsx scripts/create-homebrew-guest-lifecycle-fixture.ts \
  --transport-mode closed \
  --image "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.zst" \
  --homebrew-bootstrap-spec "$KANDELO_LOGIN_SOURCE/homebrew/main-shell-brew-package-tree.json" \
  --homebrew-bootstrap-archive "$KANDELO_LOGIN_BOOTSTRAP/homebrew-bootstrap.zip" \
  --homebrew-bootstrap-env "$KANDELO_LOGIN_BOOTSTRAP/homebrew-brew.env" \
  --bottle-mirror "$KANDELO_LOGIN_MIRROR" \
  --composition-report "$KANDELO_LOGIN_WORK_ROOT/composition-report.json" \
  --privileged-product "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.privileged.vfs" \
  --fixed-asset-url-root https://closed.kandelo.invalid/login-product/ \
  --core-revision "$KANDELO_LOGIN_TAP_COMMIT" \
  --canary-revision "$KANDELO_LOGIN_TAP_COMMIT" \
  --timeout-ms 1800000 --out "$KANDELO_LOGIN_FIXTURE"

KANDELO_LOGIN_DEPLOY_PRODUCT="$KANDELO_LOGIN_WORK_ROOT/browser-login-product"
KANDELO_LOGIN_BROWSER_ASSETS=apps/browser-demos/public/homebrew-login-product
mkdir "$KANDELO_LOGIN_DEPLOY_PRODUCT" "$KANDELO_LOGIN_BROWSER_ASSETS"
cp -p "$KANDELO_LOGIN_FIXTURE" \
  "$KANDELO_LOGIN_DEPLOY_PRODUCT/$(basename "$KANDELO_LOGIN_FIXTURE")"
for source in \
  "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.zst" \
  "$KANDELO_LOGIN_WORK_ROOT/composition-report.json" \
  "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.privileged.vfs" \
  "$KANDELO_LOGIN_SOURCE/homebrew/main-shell-brew-package-tree.json" \
  "$KANDELO_LOGIN_BOOTSTRAP/homebrew-bootstrap.zip" \
  "$KANDELO_LOGIN_BOOTSTRAP/homebrew-brew.env" \
  "$KANDELO_LOGIN_MIRROR"/*; do
  asset="$(basename "$source")"
  cp -p "$source" "$KANDELO_LOGIN_DEPLOY_PRODUCT/$asset"
  cp -p "$source" "$KANDELO_LOGIN_BROWSER_ASSETS/$asset"
done

KANDELO_LOGIN_BROWSER_REPORT="$KANDELO_LOGIN_WORK_ROOT/browser-report.json"
KANDELO_LOGIN_BROWSER_IDENTITIES="$KANDELO_LOGIN_WORK_ROOT/browser-identities.json"
(
  cd apps/browser-demos
  CI=1 \
  KANDELO_PLAYWRIGHT_PORT=56431 \
  KANDELO_PLAYWRIGHT_VITE_MODE=homebrew-closed-acceptance \
  KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT=/homebrew-login-product \
  KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE=1 \
  KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH="$KANDELO_LOGIN_FIXTURE" \
  KANDELO_LOGIN_RSS_REPORT_PATH="$KANDELO_LOGIN_RSS_REPORT" \
  KANDELO_LOGIN_BROWSER_IDENTITY_PATH="$KANDELO_LOGIN_BROWSER_IDENTITIES" \
  npx playwright test test/homebrew-login-lifecycle.spec.ts \
    --project=chromium --project=firefox --project=webkit \
    --workers=1 --reporter=json \
    --output="$KANDELO_LOGIN_WORK_ROOT/playwright-output" \
    >"$KANDELO_LOGIN_BROWSER_REPORT"
)
jq -e '.stats.expected == 3 and .stats.unexpected == 0 and .stats.flaky == 0 and .stats.skipped == 0' "$KANDELO_LOGIN_BROWSER_REPORT" >/dev/null || fail "three-engine generated login product lifecycle did not report exactly three passes"
jq -e '
  .schema == 1 and
  .provenance == {schema:1,provenance_kind:"local-test",promotable:false,published:false} and
  ([.browsers[].project] | sort) == ["chromium","firefox","webkit"] and
  all(.browsers[]; (.version | type == "string" and length > 0) and (.userAgent | type == "string" and length > 0))
' "$KANDELO_LOGIN_BROWSER_IDENTITIES" >/dev/null || fail "three-engine browser identity evidence is incomplete"
jq -e '
  .schema == 1 and .unit == "KiB" and
  .provenance == {schema:1,provenance_kind:"local-test",promotable:false,published:false} and
  ([.samples[].phase] | sort) == (["before-boot","before-boot","before-ruby","before-ruby","peak","peak","after-child-reaping","after-child-reaping","after-three-repetitions","after-three-repetitions"] | sort) and
  ([.samples[].roots[].label] | sort) == (["node","node","node","node","node","chromium","chromium","chromium","chromium","chromium"] | sort) and
  all(.samples[]; (.roots | length) == 1 and all(.roots[]; .rss_kib > 0 and (.processes | length) > 0))
' "$KANDELO_LOGIN_RSS_REPORT" >/dev/null || fail "Node and Chromium five-phase RSS evidence is incomplete"

kernel_path="$(bash scripts/resolve-binary.sh kernel.wasm)"
image_sha256="$(sha256sum "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.zst" | awk '{print $1}')"
kernel_sha256="$(sha256sum "$kernel_path" | awk '{print $1}')"
privileged_product="${KANDELO_LOGIN_WORK_ROOT}/main-shell.vfs.privileged.vfs"
privileged_sha256="$(sha256sum "$privileged_product" | awk '{print $1}')"
jq -nS \
  --arg kandelo_commit "$KANDELO_LOGIN_KANDELO_COMMIT" \
  --arg tap_commit "$KANDELO_LOGIN_TAP_COMMIT" \
  --arg prepared_tap_commit "$KANDELO_LOGIN_PREPARED_TAP_COMMIT" \
  --arg image_sha256 "$image_sha256" --arg kernel_sha256 "$kernel_sha256" \
  --arg privileged_product_sha256 "$privileged_sha256" \
  --slurpfile bottles "$KANDELO_LOGIN_WORK_ROOT/bottle-build-report.json" \
  --slurpfile composition "$KANDELO_LOGIN_WORK_ROOT/composition-report.json" \
  --slurpfile browsers "$KANDELO_LOGIN_BROWSER_REPORT" \
  --slurpfile browser_identities "$KANDELO_LOGIN_BROWSER_IDENTITIES" \
  --slurpfile ruby_inventory "$KANDELO_LOGIN_WORK_ROOT/ruby-installed-inventory.json" \
  --slurpfile rss "$KANDELO_LOGIN_RSS_REPORT" '
  {
    schema:1,
    status:"success",
    provenance:{schema:1,provenance_kind:"local-test",promotable:false,published:false},
    kandelo_commit:$kandelo_commit,
    tap_commit:$tap_commit,
    prepared_tap_commit:$prepared_tap_commit,
    abi:43,
    formula_roots:36,
    formula_closure:43,
    image_sha256:$image_sha256,
    kernel_sha256:$kernel_sha256,
    privileged_product_sha256:$privileged_product_sha256,
    bottles:$bottles[0],
    composition:$composition[0],
    ruby:$ruby_inventory[0],
    browsers:{identities:$browser_identities[0].browsers,stats:$browsers[0].stats},
    rss:$rss[0],
    commands:[
      {name:"automatic maker login",status:"passed"},
      {name:"id",status:"passed"},
      {name:"sudo -l",status:"passed"},
      {name:"sudo id",status:"passed"},
      {name:"failed-password rejection",status:"passed"},
      {name:"ordinary login after logout",status:"passed"},
      {name:"nosuid execution rejection",status:"passed"},
      {name:"Ruby spawning through vfork",status:"passed"},
      {name:"brew tap/install/execute",status:"passed"}
    ],
    vfork_fork_mode_evidence:($bottles[0].formulae[] | select(.formula == "ruby") | .runtime_evidence)
  }' \
  >"$KANDELO_LOGIN_WORK_ROOT/evidence.json"
{
  printf '# ABI 43 local login product evidence\n\n'
  printf -- '- Status: success (local-test; non-promotable; unpublished)\n'
  printf -- '- Kandelo: `%s`\n' "$KANDELO_LOGIN_KANDELO_COMMIT"
  printf -- '- Tap source: `%s`\n' "$KANDELO_LOGIN_TAP_COMMIT"
  printf -- '- Prepared local tap: `%s`\n' "$KANDELO_LOGIN_PREPARED_TAP_COMMIT"
  printf -- '- ABI: 43\n- Roots: 36\n- Formula closure: 43\n'
  printf -- '- Image SHA-256: `%s`\n' "$image_sha256"
  printf -- '- Kernel SHA-256: `%s`\n' "$kernel_sha256"
  printf -- '- Privileged product SHA-256: `%s`\n\n' "$privileged_sha256"
  printf '## Ruby\n\n'
  jq -r '
    "- Install path: `" + .install_path + "`",
    "- Runtime archive executables: `" + (.runtime_archive_executables | join(", ")) + "`",
    "- Bottle/installed executables: `" + (.installed_executables | join(", ")) + "`",
    "- Final instrumented Ruby SHA-256: `" + .final_ruby_sha256 + "`",
    "- Config defines: `" + (.config_defines | join(", ")) + "`"
  ' "$KANDELO_LOGIN_WORK_ROOT/ruby-installed-inventory.json"
  printf '\n## Browsers\n\n'
  jq -r '.browsers[] | "- " + .project + ": `" + .version + "` (`" + .userAgent + "`)"' \
    "$KANDELO_LOGIN_BROWSER_IDENTITIES"
  printf '\n## Lifecycle\n\n'
  jq -r '.commands[] | "- " + .name + ": " + .status' \
    "$KANDELO_LOGIN_WORK_ROOT/evidence.json"
  printf '\n## RSS\n\n'
  jq -r '.samples[] | "- " + .roots[0].label + " / " + .phase + ": " + (.roots[0].rss_kib | tostring) + " KiB across " + (.roots[0].processes | length | tostring) + " exact processes"' \
    "$KANDELO_LOGIN_RSS_REPORT"
  printf '\nExact Node and Chromium process-tree inventories are in `process-tree-rss.json`; no broad extrapolation is made.\n'
  printf '\nAll 43 Formula/bottle identities and the Ruby vfork fork-mode record are in `evidence.json`.\n'
} >"$KANDELO_LOGIN_WORK_ROOT/evidence.md"

# The closed Playwright lane needed these exact bytes under Vite's public
# directory. The deployable build owns the separate verified input above; do
# not leave a second output path that would collide with its emitted assets.
rm -rf -- "$KANDELO_LOGIN_BROWSER_ASSETS"

if [ "$KANDELO_LOGIN_BROWSER_DEMO" = true ]; then
  printf 'Preserved local-test assets. Manual root-product command (from the detached source):\n'
  printf 'KANDELO_LOCAL_LOGIN_PRODUCT_ROOT=%q KANDELO_BROWSER_DEMO_INPUTS=main,kandelo,network,homebrew-vfs-test,sqlite-test,benchmark,php-test VITE_BASE=/ npm --prefix apps/browser-demos run build\n' \
    "$KANDELO_LOGIN_DEPLOY_PRODUCT"
fi
printf 'run-login-stack-local.sh: exact browser build input: %s\n' \
  "$KANDELO_LOGIN_DEPLOY_PRODUCT"
printf 'run-login-stack-local.sh: complete local-test evidence: %s\n' "$KANDELO_LOGIN_WORK_ROOT/evidence.json"
