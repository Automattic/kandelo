#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
SOURCE_CHECKOUT="${WASM_POSIX_BUILD_GIT_HOMEBREW_BREW_DIR:-}"
SOURCE_COMMIT="${WASM_POSIX_BUILD_GIT_HOMEBREW_BREW_COMMIT:-}"
LOCK="$REPO_ROOT/homebrew/homebrew-bootstrap-source-lock.json"
VERIFY="$REPO_ROOT/scripts/verify-homebrew-bootstrap-source-lock.mjs"

if [ -z "$OUT_DIR" ]; then
  echo "ERROR: homebrew-bootstrap is a resolver-owned build; WASM_POSIX_DEP_OUT_DIR is required" >&2
  exit 2
fi
if [ -z "$SOURCE_CHECKOUT" ] || [ -z "$SOURCE_COMMIT" ]; then
  echo "ERROR: homebrew-bootstrap requires build.toml git input homebrew_brew (DIR and COMMIT)" >&2
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

OUTPUT="$KANDELO_PACKAGE_OUT_DIR/homebrew-bootstrap.zip"
if [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  echo "ERROR: homebrew-bootstrap output already exists: $OUTPUT" >&2
  exit 1
fi
cp "$ARCHIVE" "$OUTPUT"
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

echo "==> Built provenance-locked Homebrew bootstrap: $OUTPUT"
