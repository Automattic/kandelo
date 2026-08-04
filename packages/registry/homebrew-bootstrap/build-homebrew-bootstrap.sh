#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
SOURCE_CHECKOUT="${WASM_POSIX_BUILD_GIT_HOMEBREW_BREW_DIR:-}"
SOURCE_COMMIT="${WASM_POSIX_BUILD_GIT_HOMEBREW_BREW_COMMIT:-}"
RUBY_DEP="${WASM_POSIX_DEP_RUBY_DIR:-}"
LOCK="$REPO_ROOT/homebrew/homebrew-bootstrap-source-lock.json"
VERIFY="$REPO_ROOT/scripts/verify-homebrew-bootstrap-source-lock.mjs"
DETERMINISTIC_ZIP="$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh"

if [ -z "$OUT_DIR" ]; then
  echo "ERROR: homebrew-bootstrap is a resolver-owned build; WASM_POSIX_DEP_OUT_DIR is required" >&2
  exit 2
fi
if [ -z "$SOURCE_CHECKOUT" ] || [ -z "$SOURCE_COMMIT" ]; then
  echo "ERROR: homebrew-bootstrap requires build.toml git input homebrew_brew (DIR and COMMIT)" >&2
  exit 2
fi
if [ -z "$RUBY_DEP" ] || [ ! -d "$RUBY_DEP" ] || [ -L "$RUBY_DEP" ]; then
  echo "ERROR: homebrew-bootstrap requires its resolved Ruby dependency" >&2
  exit 2
fi
if [ ! -f "$RUBY_DEP/ruby.wasm" ] || [ -L "$RUBY_DEP/ruby.wasm" ] ||
   [ ! -f "$RUBY_DEP/ruby-runtime.zip" ] ||
   [ -L "$RUBY_DEP/ruby-runtime.zip" ]; then
  echo "ERROR: Ruby dependency omits ruby.wasm or ruby-runtime.zip" >&2
  exit 2
fi
if [ ! -f "$LOCK" ] || [ -L "$LOCK" ]; then
  echo "ERROR: homebrew-bootstrap source lock must be a regular non-symlink file" >&2
  exit 2
fi
if [ ! -f "$VERIFY" ] || [ -L "$VERIFY" ]; then
  echo "ERROR: homebrew-bootstrap source-lock verifier must be a regular non-symlink file" >&2
  exit 2
fi
if [ ! -x "$DETERMINISTIC_ZIP" ] || [ -L "$DETERMINISTIC_ZIP" ]; then
  echo "ERROR: deterministic ZIP producer must be a regular executable" >&2
  exit 2
fi

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
DEFAULT_WORK_ROOT="${OUT_DIR}.homebrew-bootstrap-work"
OWNS_WORK_ROOT=0
if [ -z "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
  if [ -e "$DEFAULT_WORK_ROOT" ] || [ -L "$DEFAULT_WORK_ROOT" ]; then
    echo "ERROR: homebrew-bootstrap work root already exists: $DEFAULT_WORK_ROOT" >&2
    exit 1
  fi
  OWNS_WORK_ROOT=1
fi
kandelo_package_prepare_build_roots "$DEFAULT_WORK_ROOT" wasm32
kandelo_package_require_disjoint_paths \
  WASM_POSIX_DEP_WORK_DIR "$KANDELO_PACKAGE_WORK_DIR" \
  WASM_POSIX_DEP_OUT_DIR "$KANDELO_PACKAGE_OUT_DIR"

WORK_ROOT="$KANDELO_PACKAGE_WORK_DIR"
BUILD_DIR="$WORK_ROOT/homebrew-bootstrap-package"
if [ -e "$BUILD_DIR" ] || [ -L "$BUILD_DIR" ]; then
  echo "ERROR: homebrew-bootstrap build directory already exists: $BUILD_DIR" >&2
  exit 1
fi
mkdir -m 0700 "$BUILD_DIR"
cleanup() {
  rm -rf -- "$BUILD_DIR"
  if [ "$OWNS_WORK_ROOT" -eq 1 ]; then
    rmdir "$WORK_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

read_lock_field() {
  node "$VERIFY" --lock "$LOCK" --field "$1"
}

PACKAGE_NAME="${WASM_POSIX_DEP_NAME:-}"
PACKAGE_VERSION="${WASM_POSIX_DEP_VERSION:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
SOURCE_REPOSITORY="$(read_lock_field source.repository)"
LOCKED_REVISION="$(read_lock_field source.revision)"
PATCH_PATH="$(read_lock_field patch.path)"
PATCH_SHA256="$(read_lock_field patch.sha256)"
PATCH_FILE="$REPO_ROOT/$PATCH_PATH"
LICENSE_EVIDENCE_PATH="$(read_lock_field license.kandelo_patch.evidence_path)"
LICENSE_EVIDENCE="$REPO_ROOT/$LICENSE_EVIDENCE_PATH"
GIT_VERSION="$(git --version)"
GIT_VERSION="${GIT_VERSION#git version }"

if [ ! -f "$PATCH_FILE" ] || [ -L "$PATCH_FILE" ]; then
  echo "ERROR: reviewed Homebrew patch must be a regular non-symlink file: $PATCH_FILE" >&2
  exit 2
fi
if [ ! -f "$LICENSE_EVIDENCE" ] || [ -L "$LICENSE_EVIDENCE" ]; then
  echo "ERROR: Homebrew patch license evidence must be a regular non-symlink file: $LICENSE_EVIDENCE" >&2
  exit 2
fi

node "$VERIFY" \
  --lock "$LOCK" \
  --package-name "$PACKAGE_NAME" \
  --package-version "$PACKAGE_VERSION" \
  --target-arch "$TARGET_ARCH" \
  --source-url "$SOURCE_URL" \
  --source-sha256 "$SOURCE_SHA256" \
  --git-commit "$SOURCE_COMMIT" \
  --git-version "$GIT_VERSION" \
  --patch-path "$PATCH_PATH" \
  --license-evidence "$LICENSE_EVIDENCE" \
  --source-checkout "$SOURCE_CHECKOUT"

# The source checkout is resolver-provisioned, exact, and sealed. Source
# preparation imports only its Git objects into this private work directory;
# no credential or network state participates in the package build.
unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN
export SOURCE_DATE_EPOCH=0
export TZ=UTC
export LC_ALL=C
export LANG=C

ARCHIVE="$BUILD_DIR/homebrew-bootstrap.zip"
ENV_FILE="$BUILD_DIR/brew.env"
PROVENANCE="$BUILD_DIR/homebrew-source.json"
PORTABLE_RUBY_ARCHIVE="$BUILD_DIR/homebrew-portable-ruby.zip"
"$REPO_ROOT/scripts/prepare-homebrew-bootstrap-source.sh" \
  --repository "$SOURCE_REPOSITORY" \
  --revision "$LOCKED_REVISION" \
  --source-checkout "$SOURCE_CHECKOUT" \
  --patch "$PATCH_FILE" \
  --expected-patch-sha256 "$PATCH_SHA256" \
  --arch wasm32 \
  --git-dir "$BUILD_DIR/homebrew-brew.git" \
  --archive "$ARCHIVE" \
  --env "$ENV_FILE" \
  --provenance "$PROVENANCE"

# Homebrew's own launcher selects vendor/portable-ruby/current and derives the
# version from this exact source tree. Build that ordinary upstream namespace
# from Kandelo's source-matched Ruby outputs; no deployed Homebrew prefix is
# involved in either the bytes or their eventual mount point.
PORTABLE_RUBY_VERSION="$({
  unzip -p "$ARCHIVE" Library/Homebrew/vendor/portable-ruby-version
} 2>/dev/null)"
if [[ ! "$PORTABLE_RUBY_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(_[0-9]+)?$ ]]; then
  echo "ERROR: Homebrew source has an invalid portable Ruby version" >&2
  exit 1
fi
RUBY_VERSION="${PORTABLE_RUBY_VERSION%%_*}"
RUBY_ABI="${RUBY_VERSION%.*}.0"
RUBY_RBCONFIG="usr/lib/ruby/$RUBY_ABI/wasm32-none/rbconfig.rb"
if ! unzip -p "$RUBY_DEP/ruby-runtime.zip" "$RUBY_RBCONFIG" 2>/dev/null |
     grep -Fq "ruby lib version ($RUBY_VERSION)"; then
  echo "ERROR: Ruby dependency does not match portable Ruby $RUBY_VERSION" >&2
  exit 1
fi

while IFS= read -r member; do
  member_path="${member%/}"
  if { [[ "$member_path" != usr ]] && [[ "$member_path" != usr/* ]]; } ||
     [[ "$member_path" == *\\* ]] ||
     [[ "/$member_path/" == *'/../'* ]] ||
     [[ "/$member_path/" == *'/./'* ]] ||
     [[ "/$member_path/" == *'//'* ]]; then
    echo "ERROR: Ruby runtime has an unsafe member: $member" >&2
    exit 1
  fi
done < <(unzip -Z1 "$RUBY_DEP/ruby-runtime.zip")

PORTABLE_STAGE="$BUILD_DIR/portable-ruby-stage"
RUNTIME_STAGE="$BUILD_DIR/ruby-runtime-stage"
mkdir -m 0700 "$PORTABLE_STAGE" "$RUNTIME_STAGE"
unzip -q "$RUBY_DEP/ruby-runtime.zip" -d "$RUNTIME_STAGE"
VERSION_STAGE="$PORTABLE_STAGE/$PORTABLE_RUBY_VERSION"
mkdir -p "$VERSION_STAGE"
cp -R "$RUNTIME_STAGE/usr/." "$VERSION_STAGE/"
if [ -e "$VERSION_STAGE/bin/ruby" ] || [ -L "$VERSION_STAGE/bin/ruby" ]; then
  echo "ERROR: Ruby runtime unexpectedly contains bin/ruby" >&2
  exit 1
fi
mkdir -p "$VERSION_STAGE/bin"
cp "$RUBY_DEP/ruby.wasm" "$VERSION_STAGE/bin/ruby"
chmod 0755 "$VERSION_STAGE/bin/ruby"
ln -s "$PORTABLE_RUBY_VERSION" "$PORTABLE_STAGE/current"
"$DETERMINISTIC_ZIP" "$PORTABLE_STAGE" "$PORTABLE_RUBY_ARCHIVE"

OUTPUT="$KANDELO_PACKAGE_OUT_DIR/homebrew-bootstrap.zip"
ENV_OUTPUT="$KANDELO_PACKAGE_OUT_DIR/homebrew-brew.env"
PORTABLE_RUBY_OUTPUT="$KANDELO_PACKAGE_OUT_DIR/homebrew-portable-ruby.zip"
if [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ] ||
   [ -e "$ENV_OUTPUT" ] || [ -L "$ENV_OUTPUT" ] ||
   [ -e "$PORTABLE_RUBY_OUTPUT" ] || [ -L "$PORTABLE_RUBY_OUTPUT" ]; then
  echo "ERROR: homebrew-bootstrap output already exists" >&2
  exit 1
fi
cp "$ARCHIVE" "$OUTPUT"
cp "$ENV_FILE" "$ENV_OUTPUT"
cp "$PORTABLE_RUBY_ARCHIVE" "$PORTABLE_RUBY_OUTPUT"
node "$VERIFY" \
  --lock "$LOCK" \
  --package-name "$PACKAGE_NAME" \
  --package-version "$PACKAGE_VERSION" \
  --target-arch "$TARGET_ARCH" \
  --source-url "$SOURCE_URL" \
  --source-sha256 "$SOURCE_SHA256" \
  --git-commit "$SOURCE_COMMIT" \
  --git-version "$GIT_VERSION" \
  --patch-path "$PATCH_PATH" \
  --license-evidence "$LICENSE_EVIDENCE" \
  --source-checkout "$SOURCE_CHECKOUT" \
  --provenance "$PROVENANCE" \
  --archive "$OUTPUT"

echo "==> Built provenance-locked Homebrew bootstrap: $OUTPUT + $ENV_OUTPUT + $PORTABLE_RUBY_OUTPUT"
