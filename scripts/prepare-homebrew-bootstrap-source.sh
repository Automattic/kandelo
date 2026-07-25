#!/usr/bin/env bash
set -euo pipefail

REPOSITORY=""
REVISION=""
SOURCE_CHECKOUT=""
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
  --source-checkout <path>        optional exact resolver-owned checkout
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
        --source-checkout) SOURCE_CHECKOUT="${2:-}"; shift 2 ;;
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

for tool in git node; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "prepare-homebrew-bootstrap-source: $tool not found; run through scripts/dev-shell.sh" >&2
        exit 2
    }
done

# Git is a source parser here, not an ambient developer tool. Remove repository
# redirection, injected `-c` entries, executable lookup, tracing, templates,
# hooks, credential helpers, and worktree state before inspecting either the
# sealed checkout or our object store. Clearing every caller-provided `GIT_*`
# variable also fails closed for variables introduced by future Git versions.
# Exact command-line overrides below neutralize repository-local hook,
# fsmonitor, attribute, exclude, and credential configuration.
REQUESTED_GIT_DIR="$GIT_DIR"
while IFS= read -r git_variable; do
    case "$git_variable" in
        GIT_*)
            unset "$git_variable"
            ;;
    esac
done < <(compgen -A variable)
unset SSH_ASKPASS
unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
    HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN
GIT_DIR="$REQUESTED_GIT_DIR"
export GIT_ATTR_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_OPTIONAL_LOCKS=0
export GIT_PAGER=cat
export GIT_TERMINAL_PROMPT=0

sha256_file() {
    node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
' "$1"
}

sha256_stdin() {
    node --input-type=module -e '
import { createHash } from "node:crypto";
const hash = createHash("sha256");
for await (const chunk of process.stdin) hash.update(chunk);
process.stdout.write(hash.digest("hex"));
'
}

PATCH_FILE="$(cd "$(dirname "$PATCH_FILE")" && pwd)/$(basename "$PATCH_FILE")"
GIT_DIR="$(mkdir -p "$(dirname "$GIT_DIR")" && cd "$(dirname "$GIT_DIR")" && pwd)/$(basename "$GIT_DIR")"
for output in "$ARCHIVE" "$ENV_FILE" "$PROVENANCE"; do
    mkdir -p "$(dirname "$output")"
done

GIT_ISOLATION_ROOT="$(
    mktemp -d "$(dirname "$GIT_DIR")/.kandelo-homebrew-git.XXXXXX"
)"
GIT_HOOKS_DIR="$GIT_ISOLATION_ROOT/hooks"
GIT_TEMPLATE_DIR_PRIVATE="$GIT_ISOLATION_ROOT/template"
mkdir -m 0700 "$GIT_HOOKS_DIR" "$GIT_TEMPLATE_DIR_PRIVATE"
INDEX_TMP="$GIT_ISOLATION_ROOT/index"
ARCHIVE_TMP="$ARCHIVE.tmp.$$"
ENV_TMP="$ENV_FILE.tmp.$$"
PROVENANCE_TMP="$PROVENANCE.tmp.$$"
cleanup() {
    rm -f -- "$INDEX_TMP" "$ARCHIVE_TMP" "$ENV_TMP" "$PROVENANCE_TMP"
    rm -rf -- "$GIT_ISOLATION_ROOT"
}
trap cleanup EXIT

GIT_ISOLATION_ARGS=(
    -c "core.hooksPath=$GIT_HOOKS_DIR"
    -c core.fsmonitor=false
    -c core.untrackedCache=false
    -c core.attributesFile=/dev/null
    -c core.excludesFile=/dev/null
    -c credential.helper=
    -c credential.interactive=false
    -c http.extraHeader=
)
isolated_git() {
    command git "${GIT_ISOLATION_ARGS[@]}" "$@"
}

verify_local_git_config() {
    local label="$1"
    shift
    local config_keys
    local key
    if ! config_keys="$(
        isolated_git "$@" config --local --no-includes --name-only --list
    )"; then
        echo "prepare-homebrew-bootstrap-source: cannot inspect $label Git configuration" >&2
        exit 2
    fi
    if [ -n "$config_keys" ]; then
        while IFS= read -r key; do
            case "$key" in
                core.repositoryformatversion|core.filemode|core.bare|\
                core.logallrefupdates|core.ignorecase|core.precomposeunicode|\
                remote.origin.url|remote.origin.fetch)
                    ;;
                *)
                    echo "prepare-homebrew-bootstrap-source: $label has unsupported local Git configuration: $key" >&2
                    exit 2
                    ;;
            esac
        done <<<"$config_keys"
    fi
}

if [ -n "$SOURCE_CHECKOUT" ]; then
    if [ ! -d "$SOURCE_CHECKOUT" ] || [ -L "$SOURCE_CHECKOUT" ]; then
        echo "prepare-homebrew-bootstrap-source: --source-checkout is not a real Git worktree: $SOURCE_CHECKOUT" >&2
        exit 2
    fi
    SOURCE_CHECKOUT="$(cd "$SOURCE_CHECKOUT" && pwd -P)"
    if [ "$(isolated_git -C "$SOURCE_CHECKOUT" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]; then
        echo "prepare-homebrew-bootstrap-source: --source-checkout is not a Git worktree: $SOURCE_CHECKOUT" >&2
        exit 2
    fi
    verify_local_git_config "source checkout" -C "$SOURCE_CHECKOUT"
    SOURCE_REVISION="$(isolated_git -C "$SOURCE_CHECKOUT" rev-parse 'HEAD^{commit}')"
    if [ "$SOURCE_REVISION" != "$REVISION" ]; then
        echo "prepare-homebrew-bootstrap-source: source checkout HEAD $SOURCE_REVISION does not match $REVISION" >&2
        exit 1
    fi
    SOURCE_STATUS="$(
        isolated_git -C "$SOURCE_CHECKOUT" status \
            --porcelain=v1 --untracked-files=all --ignored=matching
    )"
    if [ -n "$SOURCE_STATUS" ]; then
        echo "prepare-homebrew-bootstrap-source: source checkout is dirty" >&2
        printf '%s\n' "$SOURCE_STATUS" >&2
        exit 1
    fi
fi

ACTUAL_PATCH_SHA256="$(sha256_file "$PATCH_FILE")"
if [ "$ACTUAL_PATCH_SHA256" != "$EXPECTED_PATCH_SHA256" ]; then
    echo "prepare-homebrew-bootstrap-source: patch sha256 $ACTUAL_PATCH_SHA256 does not match reviewed $EXPECTED_PATCH_SHA256" >&2
    exit 1
fi

if [ ! -d "$GIT_DIR" ]; then
    isolated_git init --bare -q --template="$GIT_TEMPLATE_DIR_PRIVATE" "$GIT_DIR"
fi
verify_local_git_config "bare object store" --git-dir="$GIT_DIR"
if ! IS_BARE_REPOSITORY="$(isolated_git --git-dir="$GIT_DIR" rev-parse --is-bare-repository 2>/dev/null)"; then
    IS_BARE_REPOSITORY=""
fi
if [ "$IS_BARE_REPOSITORY" != "true" ]; then
    echo "prepare-homebrew-bootstrap-source: --git-dir is not a bare Git repository: $GIT_DIR" >&2
    exit 2
fi

git_store() {
    command git "${GIT_ISOLATION_ARGS[@]}" --git-dir="$GIT_DIR" "$@"
}

if [ -z "$SOURCE_CHECKOUT" ]; then
    if git_store remote get-url origin >/dev/null 2>&1; then
        git_store remote set-url origin "$REPOSITORY"
    else
        git_store remote add origin "$REPOSITORY"
    fi
    echo "==> Fetching Homebrew $REVISION"
    git_store fetch -q --no-tags --depth=1 origin "$REVISION"
    RESOLVED_REVISION="$(git_store rev-parse 'FETCH_HEAD^{commit}')"
else
    # Package builds import the exact revision from the resolver's sealed local
    # checkout without reaching the network or mutating that checkout. Before
    # this local upload-pack runs, global/system/injected configuration is
    # disabled and every source-local key outside the inert structural
    # allowlist above is rejected, including hooks, fsmonitor, credentials,
    # upload-pack hooks, URL rewrites, and aliases.
    echo "==> Importing Homebrew $REVISION from exact source checkout"
    git_store fetch -q --no-tags --depth=1 "$SOURCE_CHECKOUT" "$REVISION"
    RESOLVED_REVISION="$(git_store rev-parse 'FETCH_HEAD^{commit}')"
fi

if [ "$RESOLVED_REVISION" != "$REVISION" ]; then
    echo "prepare-homebrew-bootstrap-source: resolved $RESOLVED_REVISION, expected $REVISION" >&2
    exit 1
fi

export GIT_INDEX_FILE="$INDEX_TMP"
git_store read-tree "$REVISION"
if ! git_store apply --cached --check --whitespace=nowarn "$PATCH_FILE"; then
    echo "prepare-homebrew-bootstrap-source: Kandelo patch does not apply to pinned Homebrew $REVISION" >&2
    exit 1
fi
git_store apply --cached --whitespace=nowarn "$PATCH_FILE"

mapfile -t CHANGED_PATHS < <(
    git_store diff --cached --name-only "$REVISION" -- | LC_ALL=C sort
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

UPSTREAM_TREE="$(git_store rev-parse "$REVISION^{tree}")"
PATCHED_TREE="$(git_store write-tree)"
unset GIT_INDEX_FILE
if [ "$PATCHED_TREE" = "$UPSTREAM_TREE" ]; then
    echo "prepare-homebrew-bootstrap-source: patch produced the unmodified upstream tree" >&2
    exit 1
fi

UPSTREAM_COMMIT_TIME="$(git_store show -s --format=%ct "$REVISION")"
if ! [[ "$UPSTREAM_COMMIT_TIME" =~ ^[1-9][0-9]*$ ]]; then
    echo "prepare-homebrew-bootstrap-source: upstream commit has an invalid timestamp" >&2
    exit 1
fi

# A fixed mtime makes both serializations reproducible. The normalized tar
# digest is a second provenance identity for the patched Git tree used by the ZIP.
PATCHED_TREE_SHA256="$({
    TZ=UTC git_store archive --format=tar --mtime="@$UPSTREAM_COMMIT_TIME" "$PATCHED_TREE"
} | sha256_stdin)"
TZ=UTC git_store archive --format=zip --mtime="@$UPSTREAM_COMMIT_TIME" \
    -o "$ARCHIVE_TMP" "$PATCHED_TREE"
ARCHIVE_SHA256="$(sha256_file "$ARCHIVE_TMP")"

BOTTLE_TAG="${ARCH}_kandelo"
cat >"$ENV_TMP" <<EOF
HOMEBREW_NO_ANALYTICS=1
HOMEBREW_NO_AUTO_UPDATE=1
HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1
HOMEBREW_KANDELO_BOTTLE_TAG=$BOTTLE_TAG
EOF

node --input-type=module - \
    "$PROVENANCE_TMP" "$REPOSITORY" "$REVISION" "$ACTUAL_PATCH_SHA256" \
    "$PATCHED_TREE" "$PATCHED_TREE_SHA256" "$ARCHIVE_SHA256" "$ARCH" "$BOTTLE_TAG" <<'NODE'
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
] = process.argv.slice(2);

const provenance = {
  schema: 1,
  homebrew_repository: repository,
  homebrew_revision: revision,
  homebrew_patch_sha256: patchSha256,
  homebrew_patched_tree_git_oid: patchedTreeGitOid,
  homebrew_patched_tree_sha256: patchedTreeSha256,
  homebrew_archive_sha256: archiveSha256,
  homebrew_bottle_arch: arch,
  homebrew_bottle_tag: bottleTag,
};
writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`);
NODE

mv "$ARCHIVE_TMP" "$ARCHIVE"
mv "$ENV_TMP" "$ENV_FILE"
mv "$PROVENANCE_TMP" "$PROVENANCE"

echo "==> Prepared patched Homebrew $REVISION ($ARCHIVE_SHA256)"
