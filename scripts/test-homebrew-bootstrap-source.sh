#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREPARE="$ROOT/scripts/prepare-homebrew-bootstrap-source.sh"
PATCH_FILE="$ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
PATCH_SHA256="288602a306b7a045b53f57aa83d7da6eecff407a16b0c3f3840e51cd3a91be5e"
BREW_REPOSITORY="${HOMEBREW_BOOTSTRAP_TEST_BREW_REPOSITORY:-https://github.com/Homebrew/brew.git}"
BREW_REVISION="21aba0bc7080a75753f01c06d2358ca27706bfeb"
TAP_REPOSITORY="${HOMEBREW_BOOTSTRAP_TEST_TAP_REPOSITORY:-https://github.com/kandelo-dev/homebrew-tap-core.git}"
TAP_REVISION="da5f694d1c9c01656bfd1beeb78a710af3a25d6e"
HELLO_SHA256="b31c5b52e72da1686d8d95cdfe04883e400a273d4cc3d7e15eda95ba5a57183d"
# This pinned pre-relocation revision records the real historical Automattic
# bottle. The new tap has no bottle metadata until its first publication.
HELLO_ROOT_URL="https://ghcr.io/v2/automattic/kandelo-homebrew"

for tool in git node sha256sum unzip; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "test-homebrew-bootstrap-source: $tool not found; run through scripts/dev-shell.sh" >&2
        exit 2
    }
done

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-homebrew-bootstrap-source.XXXXXX")"
RUN_ROOT="$(cd "$RUN_ROOT" && pwd -P)"
cleanup() {
    rm -rf "$RUN_ROOT"
}
trap cleanup EXIT

prepare() {
    local arch="$1"
    local output_root="$2"
    local repository="${3:-$BREW_REPOSITORY}"
    local revision="${4:-$BREW_REVISION}"
    mkdir -p "$output_root"
    "$PREPARE" \
        --repository "$repository" \
        --revision "$revision" \
        --patch "$PATCH_FILE" \
        --expected-patch-sha256 "$PATCH_SHA256" \
        --arch "$arch" \
        --git-dir "$output_root/brew.git" \
        --archive "$output_root/homebrew-brew.zip" \
        --env "$output_root/brew.env" \
        --provenance "$output_root/homebrew-source.json"
}

prepare wasm32 "$RUN_ROOT/wasm32"
prepare wasm64 "$RUN_ROOT/wasm64"
(
    export TZ=EST5
    prepare wasm32 "$RUN_ROOT/wasm32-est"
)
(
    export TZ=HST10
    prepare wasm32 "$RUN_ROOT/wasm32-hst"
)

set +e
"$PREPARE" \
    --repository "$BREW_REPOSITORY" \
    --revision "$BREW_REVISION" \
    --patch "$PATCH_FILE" \
    --expected-patch-sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --arch wasm32 \
    --git-dir "$RUN_ROOT/bad-digest/brew.git" \
    --archive "$RUN_ROOT/bad-digest/homebrew-brew.zip" \
    --env "$RUN_ROOT/bad-digest/brew.env" \
    --provenance "$RUN_ROOT/bad-digest/homebrew-source.json" \
    >"$RUN_ROOT/bad-digest.log" 2>&1
BAD_DIGEST_STATUS=$?
set -e
if [ "$BAD_DIGEST_STATUS" -eq 0 ]; then
    echo "test-homebrew-bootstrap-source: incorrect reviewed patch digest unexpectedly accepted" >&2
    exit 1
fi
grep -Fq 'does not match reviewed' "$RUN_ROOT/bad-digest.log"

NON_BARE_REPOSITORY="$RUN_ROOT/non-bare-store"
NON_BARE_ORIGIN="https://example.invalid/original.git"
git init -q "$NON_BARE_REPOSITORY"
git -C "$NON_BARE_REPOSITORY" remote add origin "$NON_BARE_ORIGIN"
set +e
"$PREPARE" \
    --repository "$BREW_REPOSITORY" \
    --revision "$BREW_REVISION" \
    --patch "$PATCH_FILE" \
    --expected-patch-sha256 "$PATCH_SHA256" \
    --arch wasm32 \
    --git-dir "$NON_BARE_REPOSITORY/.git" \
    --archive "$RUN_ROOT/non-bare-output/homebrew-brew.zip" \
    --env "$RUN_ROOT/non-bare-output/brew.env" \
    --provenance "$RUN_ROOT/non-bare-output/homebrew-source.json" \
    >"$RUN_ROOT/non-bare.log" 2>&1
NON_BARE_STATUS=$?
set -e
if [ "$NON_BARE_STATUS" -eq 0 ]; then
    echo "test-homebrew-bootstrap-source: non-bare object store unexpectedly accepted" >&2
    exit 1
fi
grep -Fq 'is not a bare Git repository' "$RUN_ROOT/non-bare.log"
if [ "$(git -C "$NON_BARE_REPOSITORY" remote get-url origin)" != "$NON_BARE_ORIGIN" ]; then
    echo "test-homebrew-bootstrap-source: rejected non-bare repository origin was mutated" >&2
    exit 1
fi

ARCHIVE32="$RUN_ROOT/wasm32/homebrew-brew.zip"
ARCHIVE64="$RUN_ROOT/wasm64/homebrew-brew.zip"
PROVENANCE32="$RUN_ROOT/wasm32/homebrew-source.json"
PROVENANCE64="$RUN_ROOT/wasm64/homebrew-source.json"
IMAGE_METADATA="$RUN_ROOT/homebrew-image.json"

if ! cmp -s "$ARCHIVE32" "$ARCHIVE64"; then
    echo "test-homebrew-bootstrap-source: patched archive is not reproducible across preparations" >&2
    exit 1
fi
for timezone_root in "$RUN_ROOT/wasm32-est" "$RUN_ROOT/wasm32-hst"; do
    if ! cmp -s "$ARCHIVE32" "$timezone_root/homebrew-brew.zip"; then
        echo "test-homebrew-bootstrap-source: patched archive depends on the builder timezone" >&2
        exit 1
    fi
    if ! cmp -s "$PROVENANCE32" "$timezone_root/homebrew-source.json"; then
        echo "test-homebrew-bootstrap-source: source provenance depends on the builder timezone" >&2
        exit 1
    fi
done

node --input-type=module - \
    "$PROVENANCE32" "$PROVENANCE64" "$ARCHIVE32" "$PATCH_SHA256" "$BREW_REVISION" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [wasm32Path, wasm64Path, archivePath, patchSha, revision] = process.argv.slice(2);
const wasm32 = JSON.parse(readFileSync(wasm32Path, "utf8"));
const wasm64 = JSON.parse(readFileSync(wasm64Path, "utf8"));
const archiveSha = createHash("sha256").update(readFileSync(archivePath)).digest("hex");

function assertEqual(expected, actual, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

assertEqual(revision, wasm32.homebrew_revision, "upstream revision");
assertEqual(patchSha, wasm32.homebrew_patch_sha256, "patch sha256");
assertEqual(archiveSha, wasm32.homebrew_archive_sha256, "archive sha256");
assertEqual("wasm32", wasm32.homebrew_bottle_arch, "wasm32 provenance arch");
assertEqual("wasm32_kandelo", wasm32.homebrew_bottle_tag, "wasm32 provenance tag");
assertEqual("wasm64", wasm64.homebrew_bottle_arch, "wasm64 provenance arch");
assertEqual("wasm64_kandelo", wasm64.homebrew_bottle_tag, "wasm64 provenance tag");
assertEqual(wasm32.homebrew_patched_tree_git_oid, wasm64.homebrew_patched_tree_git_oid, "patched tree oid");
assertEqual(wasm32.homebrew_patched_tree_sha256, wasm64.homebrew_patched_tree_sha256, "patched tree sha256");
assertEqual(wasm32.homebrew_archive_sha256, wasm64.homebrew_archive_sha256, "reproducible archive sha256");
if (!/^[0-9a-f]{64}$/.test(wasm32.homebrew_patched_tree_sha256)) {
  throw new Error("patched tree sha256 is not lowercase hex");
}
NODE

node "$ROOT/scripts/write-homebrew-bootstrap-metadata.mjs" \
    --source "$PROVENANCE32" \
    --abi 39 \
    --out "$IMAGE_METADATA"
node --input-type=module - "$IMAGE_METADATA" "$PATCH_SHA256" "$BREW_REVISION" <<'NODE'
import { readFileSync } from "node:fs";
const [metadataPath, patchSha, revision] = process.argv.slice(2);
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
if (metadata.created_by !== "scripts/build-homebrew-bootstrap.sh") throw new Error("wrong metadata producer");
if (metadata.kandelo_abi !== 39) throw new Error("wrong metadata ABI");
if (metadata.homebrew_revision !== revision) throw new Error("wrong metadata upstream revision");
if (metadata.homebrew_patch_sha256 !== patchSha) throw new Error("wrong metadata patch digest");
if (metadata.homebrew_bottle_tag !== "wasm32_kandelo") throw new Error("wrong metadata bottle tag");
if (!/^[0-9a-f]{64}$/.test(metadata.homebrew_patched_tree_sha256)) {
  throw new Error("metadata is missing the patched tree digest");
}
if (!/^[0-9a-f]{64}$/.test(metadata.homebrew_archive_sha256)) {
  throw new Error("metadata is missing the archive digest");
}
NODE

grep -Fxq 'HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo' "$RUN_ROOT/wasm32/brew.env"
grep -Fxq 'HOMEBREW_KANDELO_BOTTLE_TAG=wasm64_kandelo' "$RUN_ROOT/wasm64/brew.env"
grep -Fxq 'HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1' "$RUN_ROOT/wasm32/brew.env"
grep -Fq '/usr/bin/brew l 0777 0 0 target=/home/linuxbrew/.linuxbrew/bin/brew' \
    "$ROOT/scripts/build-homebrew-bootstrap.sh"

EXTRACT_ROOT="$RUN_ROOT/prefix"
mkdir -p "$EXTRACT_ROOT"
unzip -q "$ARCHIVE32" -d "$EXTRACT_ROOT"
grep -Fq 'WASM_32BIT_ARCHS  = [:wasm32].freeze' "$EXTRACT_ROOT/Library/Homebrew/hardware.rb"
grep -Fq 'HOMEBREW_KANDELO_BOTTLE_TAG' "$EXTRACT_ROOT/Library/Homebrew/utils/bottles.rb"

SYSTEM_ENV_ROOT="$RUN_ROOT/system/etc/homebrew"
mkdir -p "$SYSTEM_ENV_ROOT" "$EXTRACT_ROOT/etc/homebrew" \
    "$RUN_ROOT/home/.homebrew" "$RUN_ROOT/homebrew-temp"
cp "$RUN_ROOT/wasm32/brew.env" "$SYSTEM_ENV_ROOT/brew.env"
cat >"$EXTRACT_ROOT/etc/homebrew/brew.env" <<'EOF'
HOMEBREW_KANDELO_BOTTLE_TAG=wasm64_kandelo
EOF
cat >"$RUN_ROOT/home/.homebrew/brew.env" <<'EOF'
HOMEBREW_KANDELO_BOTTLE_TAG=wasm64_kandelo
EOF

# Redirect the guest-only absolute paths in this extracted test copy. The real
# guest uses the same system environment file, alias, and canonical prefix.
ALIAS_BREW="$RUN_ROOT/alias/usr/bin/brew"
node --input-type=module - \
    "$EXTRACT_ROOT/bin/brew" "$SYSTEM_ENV_ROOT/brew.env" \
    "$ALIAS_BREW" "$EXTRACT_ROOT" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [brewPath, systemEnvPath, aliasPath, prefixPath] = process.argv.slice(2);
const source = readFileSync(brewPath, "utf8");
const replacements = [
  ['"/etc/homebrew/brew.env"', JSON.stringify(systemEnvPath), 2, "system brew.env"],
  ['"/usr/bin/brew"', JSON.stringify(aliasPath), 1, "guest brew alias"],
  ['"/home/linuxbrew/.linuxbrew"', JSON.stringify(prefixPath), 1, "guest Homebrew prefix"],
];
let patched = source;
for (const [literal, replacement, expected, label] of replacements) {
  const callSites = patched.split(literal).length - 1;
  if (callSites !== expected) throw new Error(`expected ${expected} ${label} call sites, got ${callSites}`);
  patched = patched.replaceAll(literal, replacement);
}
writeFileSync(brewPath, patched);
NODE

mkdir -p "$(dirname "$ALIAS_BREW")"
ln -s "$EXTRACT_ROOT/bin/brew" "$ALIAS_BREW"
ALIAS_PREFIX="$(
    HOME="$RUN_ROOT/home" HOMEBREW_TEMP="$RUN_ROOT/homebrew-temp" \
        "$ALIAS_BREW" --prefix
)"
if [ "$ALIAS_PREFIX" != "$EXTRACT_ROOT" ]; then
    echo "test-homebrew-bootstrap-source: alias resolved prefix $ALIAS_PREFIX, expected $EXTRACT_ROOT" >&2
    exit 1
fi
ALIAS_REPOSITORY="$(
    HOME="$RUN_ROOT/home" HOMEBREW_TEMP="$RUN_ROOT/homebrew-temp" \
        "$ALIAS_BREW" --repository
)"
if [ "$ALIAS_REPOSITORY" != "$EXTRACT_ROOT" ]; then
    echo "test-homebrew-bootstrap-source: alias resolved repository $ALIAS_REPOSITORY, expected $EXTRACT_ROOT" >&2
    exit 1
fi
ALIAS_VERSION="$(
    HOME="$RUN_ROOT/home" HOMEBREW_TEMP="$RUN_ROOT/homebrew-temp" \
        "$ALIAS_BREW" --version
)"
case "$ALIAS_VERSION" in
    Homebrew*) ;;
    *)
        echo "test-homebrew-bootstrap-source: alias did not start Homebrew: $ALIAS_VERSION" >&2
        exit 1
        ;;
esac

TAP_ROOT="$EXTRACT_ROOT/Library/Taps/automattic/homebrew-kandelo-homebrew"
git init -q "$TAP_ROOT"
git -C "$TAP_ROOT" remote add origin "$TAP_REPOSITORY"
git -C "$TAP_ROOT" fetch -q --depth=1 origin "$TAP_REVISION"
RESOLVED_TAP_REVISION="$(git -C "$TAP_ROOT" rev-parse 'FETCH_HEAD^{commit}')"
if [ "$RESOLVED_TAP_REVISION" != "$TAP_REVISION" ]; then
    echo "test-homebrew-bootstrap-source: fetched tap $RESOLVED_TAP_REVISION, expected $TAP_REVISION" >&2
    exit 1
fi
git -C "$TAP_ROOT" checkout -q --detach "$TAP_REVISION"

env -u HOMEBREW_KANDELO_BOTTLE_TAG -u KANDELO_HOMEBREW_BOTTLE_TAG \
    HOME="$RUN_ROOT/home" \
    HOMEBREW_TEMP="$RUN_ROOT/homebrew-temp" \
    "$EXTRACT_ROOT/bin/brew" ruby \
    "$ROOT/homebrew/test/kandelo_platform_tags.rb"
env -u HOMEBREW_KANDELO_BOTTLE_TAG -u KANDELO_HOMEBREW_BOTTLE_TAG \
    HOME="$RUN_ROOT/home" \
    HOMEBREW_TEMP="$RUN_ROOT/homebrew-temp" \
    "$EXTRACT_ROOT/bin/brew" ruby \
    "$ROOT/homebrew/test/kandelo_bootstrap_bottle_selection.rb" \
    automattic/kandelo-homebrew/hello \
    automattic/kandelo-homebrew \
    wasm32_kandelo "$HELLO_SHA256" "$HELLO_ROOT_URL"

# A reviewed patch must fail closed when its pinned upstream context drifts.
DRIFT_WORKTREE="$RUN_ROOT/drift-worktree"
git init -q "$DRIFT_WORKTREE"
git -C "$DRIFT_WORKTREE" remote add origin "$BREW_REPOSITORY"
git -C "$DRIFT_WORKTREE" fetch -q --depth=1 origin "$BREW_REVISION"
git -C "$DRIFT_WORKTREE" checkout -q --detach "$BREW_REVISION"
node --input-type=module - "$DRIFT_WORKTREE/Library/Homebrew/hardware.rb" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const source = readFileSync(path, "utf8");
const changed = source.replace(
  "    ARM_ARCHS         = ARM_64BIT_ARCHS\n",
  "    ARM_ARCHS         = T.let(ARM_64BIT_ARCHS, T::Array[Symbol])\n",
);
if (changed === source) throw new Error("drift fixture did not change Homebrew patch context");
writeFileSync(path, changed);
NODE
git -C "$DRIFT_WORKTREE" add Library/Homebrew/hardware.rb
DRIFT_REVISION="$({
    printf 'Homebrew patch drift fixture\n'
} | GIT_AUTHOR_NAME=Kandelo GIT_AUTHOR_EMAIL=noreply@kandelo.invalid \
    GIT_COMMITTER_NAME=Kandelo GIT_COMMITTER_EMAIL=noreply@kandelo.invalid \
    GIT_AUTHOR_DATE='2026-07-14T00:00:00Z' GIT_COMMITTER_DATE='2026-07-14T00:00:00Z' \
    git -C "$DRIFT_WORKTREE" commit-tree "$(git -C "$DRIFT_WORKTREE" write-tree)" -p "$BREW_REVISION")"

set +e
prepare wasm32 "$RUN_ROOT/drift-output" "$DRIFT_WORKTREE" "$DRIFT_REVISION" \
    >"$RUN_ROOT/drift.log" 2>&1
DRIFT_STATUS=$?
set -e
if [ "$DRIFT_STATUS" -eq 0 ]; then
    echo "test-homebrew-bootstrap-source: changed upstream context unexpectedly accepted the patch" >&2
    exit 1
fi
grep -Fq 'Kandelo patch does not apply to pinned Homebrew' "$RUN_ROOT/drift.log"

echo "test-homebrew-bootstrap-source: pass"
