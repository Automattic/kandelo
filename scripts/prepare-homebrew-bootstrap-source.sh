#!/usr/bin/env bash
set -euo pipefail

REPOSITORY=""
REVISION=""
PATCH_FILE=""
EXPECTED_PATCH_SHA256=""
ARCH=""
GIT_DIR=""
ARCHIVE=""
ENV_FILE=""
PROVENANCE=""

usage() {
    cat <<'EOF'
Usage: scripts/prepare-homebrew-bootstrap-source.sh [options]

Fetch one exact upstream Homebrew revision, apply Kandelo's reviewed platform
patch to a temporary Git index, and write deterministic bootstrap inputs.

Options:
  --repository <url>              upstream Homebrew Git repository
  --revision <sha>                exact 40-character upstream commit
  --patch <path>                  Kandelo Homebrew patch
  --expected-patch-sha256 <sha>   reviewed patch digest
  --arch <wasm32|wasm64>          guest Homebrew userland architecture
  --git-dir <path>                reusable bare Git object store
  --archive <path>                output patched Homebrew ZIP
  --env <path>                    output Homebrew brew.env
  --provenance <path>             output source provenance JSON
  -h, --help                      print this help

Run through scripts/dev-shell.sh.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repository) REPOSITORY="${2:-}"; shift 2 ;;
        --revision) REVISION="${2:-}"; shift 2 ;;
        --patch) PATCH_FILE="${2:-}"; shift 2 ;;
        --expected-patch-sha256) EXPECTED_PATCH_SHA256="${2:-}"; shift 2 ;;
        --arch) ARCH="${2:-}"; shift 2 ;;
        --git-dir) GIT_DIR="${2:-}"; shift 2 ;;
        --archive) ARCHIVE="${2:-}"; shift 2 ;;
        --env) ENV_FILE="${2:-}"; shift 2 ;;
        --provenance) PROVENANCE="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *)
            echo "prepare-homebrew-bootstrap-source: unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

require_value() {
    local flag="$1"
    local value="$2"
    if [ -z "$value" ]; then
        echo "prepare-homebrew-bootstrap-source: --$flag is required" >&2
        exit 2
    fi
}

require_value repository "$REPOSITORY"
require_value revision "$REVISION"
require_value patch "$PATCH_FILE"
require_value expected-patch-sha256 "$EXPECTED_PATCH_SHA256"
require_value arch "$ARCH"
require_value git-dir "$GIT_DIR"
require_value archive "$ARCHIVE"
require_value env "$ENV_FILE"
require_value provenance "$PROVENANCE"

if ! [[ "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
    echo "prepare-homebrew-bootstrap-source: revision must be a full 40-character commit id" >&2
    exit 2
fi
if ! [[ "$EXPECTED_PATCH_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "prepare-homebrew-bootstrap-source: expected patch sha256 must be 64 lowercase hex characters" >&2
    exit 2
fi
case "$ARCH" in
    wasm32|wasm64) ;;
    *)
        echo "prepare-homebrew-bootstrap-source: unsupported architecture: $ARCH" >&2
        exit 2
        ;;
esac
if [ ! -f "$PATCH_FILE" ]; then
    echo "prepare-homebrew-bootstrap-source: patch not found: $PATCH_FILE" >&2
    exit 2
fi

for tool in git node sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "prepare-homebrew-bootstrap-source: $tool not found; run through scripts/dev-shell.sh" >&2
        exit 2
    }
done

PATCH_FILE="$(cd "$(dirname "$PATCH_FILE")" && pwd)/$(basename "$PATCH_FILE")"
GIT_DIR="$(mkdir -p "$(dirname "$GIT_DIR")" && cd "$(dirname "$GIT_DIR")" && pwd)/$(basename "$GIT_DIR")"
for output in "$ARCHIVE" "$ENV_FILE" "$PROVENANCE"; do
    mkdir -p "$(dirname "$output")"
done

ACTUAL_PATCH_SHA256="$(sha256sum "$PATCH_FILE" | awk '{print $1}')"
if [ "$ACTUAL_PATCH_SHA256" != "$EXPECTED_PATCH_SHA256" ]; then
    echo "prepare-homebrew-bootstrap-source: patch sha256 $ACTUAL_PATCH_SHA256 does not match reviewed $EXPECTED_PATCH_SHA256" >&2
    exit 1
fi

if [ ! -d "$GIT_DIR" ]; then
    git init --bare -q "$GIT_DIR"
fi
if ! IS_BARE_REPOSITORY="$(git --git-dir="$GIT_DIR" rev-parse --is-bare-repository 2>/dev/null)"; then
    IS_BARE_REPOSITORY=""
fi
if [ "$IS_BARE_REPOSITORY" != "true" ]; then
    echo "prepare-homebrew-bootstrap-source: --git-dir is not a bare Git repository: $GIT_DIR" >&2
    exit 2
fi
if git --git-dir="$GIT_DIR" remote get-url origin >/dev/null 2>&1; then
    git --git-dir="$GIT_DIR" remote set-url origin "$REPOSITORY"
else
    git --git-dir="$GIT_DIR" remote add origin "$REPOSITORY"
fi

echo "==> Fetching Homebrew $REVISION"
git --git-dir="$GIT_DIR" fetch -q --depth=1 origin "$REVISION"
RESOLVED_REVISION="$(git --git-dir="$GIT_DIR" rev-parse 'FETCH_HEAD^{commit}')"
if [ "$RESOLVED_REVISION" != "$REVISION" ]; then
    echo "prepare-homebrew-bootstrap-source: fetched $RESOLVED_REVISION, expected $REVISION" >&2
    exit 1
fi

INDEX_TMP="$GIT_DIR/kandelo-bootstrap-index.$$"
ARCHIVE_TMP="$ARCHIVE.tmp.$$"
ENV_TMP="$ENV_FILE.tmp.$$"
PROVENANCE_TMP="$PROVENANCE.tmp.$$"
cleanup() {
    rm -f "$INDEX_TMP" "$ARCHIVE_TMP" "$ENV_TMP" "$PROVENANCE_TMP"
}
trap cleanup EXIT

GIT_INDEX_FILE="$INDEX_TMP" git --git-dir="$GIT_DIR" read-tree "$REVISION"
if ! GIT_INDEX_FILE="$INDEX_TMP" git --git-dir="$GIT_DIR" \
    apply --cached --check --whitespace=nowarn "$PATCH_FILE"; then
    echo "prepare-homebrew-bootstrap-source: Kandelo patch does not apply to pinned Homebrew $REVISION" >&2
    exit 1
fi
GIT_INDEX_FILE="$INDEX_TMP" git --git-dir="$GIT_DIR" \
    apply --cached --whitespace=nowarn "$PATCH_FILE"

mapfile -t CHANGED_PATHS < <(
    GIT_INDEX_FILE="$INDEX_TMP" git --git-dir="$GIT_DIR" \
        diff --cached --name-only "$REVISION" -- | LC_ALL=C sort
)
EXPECTED_PATHS=(
    "Library/Homebrew/extend/os/mac/utils/bottles.rb"
    "Library/Homebrew/github_packages.rb"
    "Library/Homebrew/hardware.rb"
    "Library/Homebrew/utils/bottles.rb"
    "bin/brew"
)
if [ "${CHANGED_PATHS[*]}" != "${EXPECTED_PATHS[*]}" ]; then
    printf 'prepare-homebrew-bootstrap-source: patch changed unexpected paths:\n' >&2
    printf '  %s\n' "${CHANGED_PATHS[@]}" >&2
    exit 1
fi

UPSTREAM_TREE="$(git --git-dir="$GIT_DIR" rev-parse "$REVISION^{tree}")"
PATCHED_TREE="$(GIT_INDEX_FILE="$INDEX_TMP" git --git-dir="$GIT_DIR" write-tree)"
if [ "$PATCHED_TREE" = "$UPSTREAM_TREE" ]; then
    echo "prepare-homebrew-bootstrap-source: patch produced the unmodified upstream tree" >&2
    exit 1
fi

PORTABLE_RUBY_VERSION_PATH="Library/Homebrew/vendor/portable-ruby-version"
PORTABLE_RUBY_VERSION="$(
    git --git-dir="$GIT_DIR" show "$PATCHED_TREE:$PORTABLE_RUBY_VERSION_PATH"
)"
if ! [[ "$PORTABLE_RUBY_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(_[0-9]+)?$ ]]; then
    echo "prepare-homebrew-bootstrap-source: pinned Homebrew has an unsafe portable Ruby version: $PORTABLE_RUBY_VERSION" >&2
    exit 1
fi
PORTABLE_RUBY_VERSION_BYTES="$(
    git --git-dir="$GIT_DIR" cat-file -s "$PATCHED_TREE:$PORTABLE_RUBY_VERSION_PATH"
)"
if [ "$PORTABLE_RUBY_VERSION_BYTES" -ne "$((${#PORTABLE_RUBY_VERSION} + 1))" ]; then
    echo "prepare-homebrew-bootstrap-source: portable Ruby version file must contain one version and a newline" >&2
    exit 1
fi

UPSTREAM_COMMIT_TIME="$(git --git-dir="$GIT_DIR" show -s --format=%ct "$REVISION")"
if ! [[ "$UPSTREAM_COMMIT_TIME" =~ ^[1-9][0-9]*$ ]]; then
    echo "prepare-homebrew-bootstrap-source: upstream commit has an invalid timestamp" >&2
    exit 1
fi

# A fixed mtime makes both serializations reproducible. The normalized tar
# digest is a second provenance identity for the patched Git tree used by the ZIP.
PATCHED_TREE_SHA256="$({
    TZ=UTC git --git-dir="$GIT_DIR" archive --format=tar --mtime="@$UPSTREAM_COMMIT_TIME" "$PATCHED_TREE"
} | sha256sum | awk '{print $1}')"
TZ=UTC git --git-dir="$GIT_DIR" archive --format=zip --mtime="@$UPSTREAM_COMMIT_TIME" \
    -o "$ARCHIVE_TMP" "$PATCHED_TREE"
ARCHIVE_SHA256="$(sha256sum "$ARCHIVE_TMP" | awk '{print $1}')"

BOTTLE_TAG="${ARCH}_kandelo"
cat >"$ENV_TMP" <<EOF
HOMEBREW_NO_ANALYTICS=1
HOMEBREW_NO_AUTO_UPDATE=1
# Kandelo Formulae live in explicit Git taps. Homebrew's official core API has
# no wasm32_kandelo package index, so use Homebrew's documented tap-checkout
# path instead of requesting an invented core-platform identity.
HOMEBREW_NO_INSTALL_FROM_API=1
# This is the state Homebrew itself sets when it automatically falls back from
# its package API. It prevents unrelated commands for explicit custom taps from
# cloning homebrew/core, while an explicit core request still fails truthfully
# until the user taps core.
HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1
# Homebrew filters caller SSL variables before running its own Git and curl
# subprocesses. Select its supported managed-CA path, which the bootstrap
# layout aliases to the image-owned system trust bundle.
HOMEBREW_FORCE_BREWED_CA_CERTIFICATES=1
# The bootstrap supplies a reviewed Git binary directly. Naming its absolute
# path lets Homebrew's own Git shim take the non-search path before its fallback
# process substitution, preserving Git remote-helper protocol stdin.
HOMEBREW_GIT_PATH=/usr/bin/git
HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1
HOMEBREW_KANDELO_BOTTLE_TAG=$BOTTLE_TAG
EOF

node --input-type=module - \
    "$PROVENANCE_TMP" "$REPOSITORY" "$REVISION" "$ACTUAL_PATCH_SHA256" \
    "$PATCHED_TREE" "$PATCHED_TREE_SHA256" "$ARCHIVE_SHA256" "$ARCH" "$BOTTLE_TAG" \
    "$PORTABLE_RUBY_VERSION" <<'NODE'
import { writeFileSync } from "node:fs";

const [
  output,
  repository,
  revision,
  patchSha256,
  patchedTreeGitOid,
  patchedTreeSha256,
  archiveSha256,
  arch,
  bottleTag,
  portableRubyVersion,
] = process.argv.slice(2);

const provenance = {
  schema: 2,
  homebrew_repository: repository,
  homebrew_revision: revision,
  homebrew_patch_sha256: patchSha256,
  homebrew_patched_tree_git_oid: patchedTreeGitOid,
  homebrew_patched_tree_sha256: patchedTreeSha256,
  homebrew_archive_sha256: archiveSha256,
  homebrew_bottle_arch: arch,
  homebrew_bottle_tag: bottleTag,
  homebrew_portable_ruby_version: portableRubyVersion,
};
writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`);
NODE

mv "$ARCHIVE_TMP" "$ARCHIVE"
mv "$ENV_TMP" "$ENV_FILE"
mv "$PROVENANCE_TMP" "$PROVENANCE"

echo "==> Prepared patched Homebrew $REVISION ($ARCHIVE_SHA256)"
