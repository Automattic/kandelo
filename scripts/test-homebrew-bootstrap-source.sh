#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREPARE="$ROOT/scripts/prepare-homebrew-bootstrap-source.sh"
PATCH_FILE="$ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
PATCH_SHA256="9c52238d811616c210cd1ecdd23b0192a3e0333219a70b34d8ea6d77dbcfbf74"
BREW_REPOSITORY="${HOMEBREW_BOOTSTRAP_TEST_BREW_REPOSITORY:-https://github.com/Homebrew/brew.git}"
BREW_REVISION="21aba0bc7080a75753f01c06d2358ca27706bfeb"
TAP_REPOSITORY="${HOMEBREW_BOOTSTRAP_TEST_TAP_REPOSITORY:-https://github.com/kandelo-dev/homebrew-tap-core.git}"
TAP_REVISION="e447c36f78ef5ab1c060087a9965bed00d4bfc13"
TAP_NAME="kandelo-dev/tap-core"
BOTTLE_FORMULA="zlib"
BOTTLE_TAG="wasm32_kandelo"
BOTTLE_SHA256="919fe4746f30a775963040995297c149972874fea50356530a8cb81b70845865"
# This immutable tap revision records a finalized public first-party bottle.
# Keep selection coverage on the production tap and repository-rooted GHCR
# namespace; fetching, pouring, and execution belong to integration tests.
BOTTLE_ROOT_URL="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"

for tool in git node unzip; do
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
    local source_checkout="${5:-}"
    mkdir -p "$output_root"
    local source_args=(
        --repository "$repository"
        --revision "$revision"
    )
    if [ -n "$source_checkout" ]; then
        source_args+=(--source-checkout "$source_checkout")
    fi
    "$PREPARE" \
        "${source_args[@]}" \
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

# Source preparation must not inherit Git config injection, credential
# callbacks, template hooks, or fsmonitor commands from the caller.
HOSTILE_GIT_ROOT="$RUN_ROOT/hostile-git"
HOSTILE_MARKER="$HOSTILE_GIT_ROOT/invoked"
HOSTILE_COMMAND="$HOSTILE_GIT_ROOT/fail-if-invoked"
HOSTILE_EXEC_PATH="$HOSTILE_GIT_ROOT/exec-path"
HOSTILE_TEMPLATE="$HOSTILE_GIT_ROOT/template"
HOSTILE_GLOBAL_CONFIG="$HOSTILE_GIT_ROOT/global.config"
mkdir -p "$HOSTILE_EXEC_PATH" "$HOSTILE_TEMPLATE/hooks"
cat >"$HOSTILE_COMMAND" <<EOF
#!/bin/sh
printf invoked >"$HOSTILE_MARKER"
exit 97
EOF
chmod 0700 "$HOSTILE_COMMAND"
cp "$HOSTILE_COMMAND" "$HOSTILE_EXEC_PATH/git-remote-https"
cp "$HOSTILE_COMMAND" "$HOSTILE_EXEC_PATH/git-upload-pack"
cp "$HOSTILE_COMMAND" "$HOSTILE_TEMPLATE/hooks/post-fetch"
cat >"$HOSTILE_GLOBAL_CONFIG" <<EOF
[core]
    fsmonitor = $HOSTILE_COMMAND
    hooksPath = $HOSTILE_TEMPLATE/hooks
[credential]
    helper = !$HOSTILE_COMMAND
EOF
(
    export GIT_ASKPASS="$HOSTILE_COMMAND"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_GLOBAL="$HOSTILE_GLOBAL_CONFIG"
    export GIT_CONFIG_KEY_0=core.fsmonitor
    export GIT_CONFIG_VALUE_0="$HOSTILE_COMMAND"
    export GIT_EXEC_PATH="$HOSTILE_EXEC_PATH"
    export GIT_TEMPLATE_DIR="$HOSTILE_TEMPLATE"
    export SSH_ASKPASS="$HOSTILE_COMMAND"
    prepare wasm32 "$RUN_ROOT/wasm32-hostile-env"
)
if [ -e "$HOSTILE_MARKER" ] || [ -L "$HOSTILE_MARKER" ]; then
    echo "test-homebrew-bootstrap-source: ambient Git callback executed" >&2
    exit 1
fi

# Reproducible package builds consume the resolver's sealed checkout instead
# of fetching Homebrew a second time. Preparing from that checkout must not
# mutate it or change any emitted bytes.
SOURCE_CHECKOUT="$RUN_ROOT/source-checkout"
git init -q "$SOURCE_CHECKOUT"
git -C "$SOURCE_CHECKOUT" fetch -q --depth=1 "$RUN_ROOT/wasm32/brew.git" "$BREW_REVISION"
git -C "$SOURCE_CHECKOUT" checkout -q --detach FETCH_HEAD
cp "$SOURCE_CHECKOUT/.git/config" "$RUN_ROOT/source-checkout.config.before"
SOURCE_STATUS_BEFORE="$(git -C "$SOURCE_CHECKOUT" status --porcelain=v1 --untracked-files=all)"
prepare wasm32 "$RUN_ROOT/wasm32-local" \
    "$BREW_REPOSITORY" "$BREW_REVISION" "$SOURCE_CHECKOUT"
SOURCE_STATUS_AFTER="$(git -C "$SOURCE_CHECKOUT" status --porcelain=v1 --untracked-files=all)"
if [ "$SOURCE_STATUS_BEFORE" != "$SOURCE_STATUS_AFTER" ]; then
    echo "test-homebrew-bootstrap-source: local source checkout was mutated" >&2
    exit 1
fi
if ! cmp -s "$SOURCE_CHECKOUT/.git/config" "$RUN_ROOT/source-checkout.config.before"; then
    echo "test-homebrew-bootstrap-source: local source Git configuration was mutated" >&2
    exit 1
fi

# A sealed source checkout with executable local Git behavior is rejected
# before Git can run it. Resolver-owned checkouts carry only the allowlisted
# structural keys exercised by the successful preparation above.
git -C "$SOURCE_CHECKOUT" config core.fsmonitor "$HOSTILE_COMMAND"
set +e
prepare wasm32 "$RUN_ROOT/hostile-source-config-output" \
    "$BREW_REPOSITORY" "$BREW_REVISION" "$SOURCE_CHECKOUT" \
    >"$RUN_ROOT/hostile-source-config.log" 2>&1
HOSTILE_SOURCE_CONFIG_STATUS=$?
set -e
git -C "$SOURCE_CHECKOUT" config --unset core.fsmonitor
if [ "$HOSTILE_SOURCE_CONFIG_STATUS" -eq 0 ]; then
    echo "test-homebrew-bootstrap-source: executable source Git config unexpectedly accepted" >&2
    exit 1
fi
grep -Fq 'source checkout has unsupported local Git configuration: core.fsmonitor' \
    "$RUN_ROOT/hostile-source-config.log"
if [ -e "$HOSTILE_MARKER" ] || [ -L "$HOSTILE_MARKER" ]; then
    echo "test-homebrew-bootstrap-source: source Git callback executed before rejection" >&2
    exit 1
fi

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
LAYOUT_METADATA="$RUN_ROOT/homebrew-bootstrap-layout.json"

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
if ! cmp -s "$ARCHIVE32" "$RUN_ROOT/wasm32-hostile-env/homebrew-brew.zip" ||
   ! cmp -s "$PROVENANCE32" "$RUN_ROOT/wasm32-hostile-env/homebrew-source.json"; then
    echo "test-homebrew-bootstrap-source: ambient Git state changed source identity" >&2
    exit 1
fi
if ! cmp -s "$ARCHIVE32" "$RUN_ROOT/wasm32-local/homebrew-brew.zip" ||
   ! cmp -s "$PROVENANCE32" "$RUN_ROOT/wasm32-local/homebrew-source.json"; then
    echo "test-homebrew-bootstrap-source: local checkout changed source identity" >&2
    exit 1
fi

printf '\n# dirty source fixture\n' >>"$SOURCE_CHECKOUT/README.md"
set +e
prepare wasm32 "$RUN_ROOT/dirty-source-output" \
    "$BREW_REPOSITORY" "$BREW_REVISION" "$SOURCE_CHECKOUT" \
    >"$RUN_ROOT/dirty-source.log" 2>&1
DIRTY_SOURCE_STATUS=$?
set -e
if [ "$DIRTY_SOURCE_STATUS" -eq 0 ]; then
    echo "test-homebrew-bootstrap-source: dirty source checkout unexpectedly accepted" >&2
    exit 1
fi
grep -Fq 'source checkout is dirty' "$RUN_ROOT/dirty-source.log"

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

node --input-type=module - "$LAYOUT_METADATA" <<'NODE'
import { writeFileSync } from "node:fs";
const path = process.argv[2];
const prefix = "/home/linuxbrew/.linuxbrew";
writeFileSync(path, `${JSON.stringify({
  schema: 1,
  guest: { uid: 1000, gid: 1000, home: "/home/linuxbrew" },
  prefix,
  eagerRootfsPackages: ["dash", "bash", "coreutils", "gawk", "grep", "sed", "findutils"],
  eagerRootfsOutputs: [{ package: "posix-utils-lite", path: "/usr/bin/locale" }],
  repository: {
    path: prefix,
    state: "mutable-working-repository",
    initialSourceProvenance: "/etc/kandelo/homebrew-image.json",
  },
  entrypoints: ["brew", "ruby", "gem", "bundle", "bundler"].map((name) => ({
    path: `/usr/bin/${name}`,
  })),
  writableDirectories: ["Cellar", "Library/Taps", "var/homebrew/locks"].map((suffix) => ({
    path: `${prefix}/${suffix}`,
  })),
  protectedFiles: [{
    path: "/etc/kandelo/homebrew-image.json",
    owner: "root",
    mode: "0444",
  }],
}, null, 2)}\n`);
NODE

node "$ROOT/scripts/write-homebrew-bootstrap-metadata.mjs" \
    --source "$PROVENANCE32" \
    --layout "$LAYOUT_METADATA" \
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
if (metadata.guest_layout?.path !== "/etc/kandelo/homebrew-bootstrap-layout.json") {
  throw new Error("metadata is missing the guest-layout path");
}
if (!/^[0-9a-f]{64}$/.test(metadata.guest_layout?.sha256)) {
  throw new Error("metadata is missing the guest-layout digest");
}
if (metadata.guest_layout?.repository_state !== "mutable-working-repository") {
  throw new Error("metadata does not describe the live working repository truthfully");
}
if (JSON.stringify(metadata.guest_layout?.eager_rootfs_outputs) !==
    JSON.stringify([{ package: "posix-utils-lite", path: "/usr/bin/locale" }])) {
  throw new Error("metadata does not bind the eager rootfs output closure");
}
NODE

grep -Fxq 'HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo' "$RUN_ROOT/wasm32/brew.env"
grep -Fxq 'HOMEBREW_KANDELO_BOTTLE_TAG=wasm64_kandelo' "$RUN_ROOT/wasm64/brew.env"
grep -Fxq 'HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1' "$RUN_ROOT/wasm32/brew.env"
grep -Fq 'scripts/homebrew-bootstrap-layout.ts' "$ROOT/scripts/build-homebrew-bootstrap.sh"
grep -Fq -- '--print-rootfs-eager-arguments' "$ROOT/scripts/build-homebrew-bootstrap.sh"
grep -Fq -- '^(lazy_url|src)=binaries\/.*\.wasm$' "$ROOT/scripts/build-homebrew-bootstrap.sh"
grep -Fq -- '--layout "$BOOTSTRAP_LAYOUT"' "$ROOT/scripts/build-homebrew-bootstrap.sh"

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

TAP_OWNER="${TAP_NAME%%/*}"
TAP_SHORT_NAME="${TAP_NAME#*/}"
if [ -z "$TAP_OWNER" ] || [ -z "$TAP_SHORT_NAME" ] || \
    [ "$TAP_SHORT_NAME" != "${TAP_SHORT_NAME#*/}" ] || \
    [ "$TAP_NAME" != "$TAP_OWNER/$TAP_SHORT_NAME" ]; then
    echo "test-homebrew-bootstrap-source: invalid canonical tap name: $TAP_NAME" >&2
    exit 1
fi
TAP_ROOT="$EXTRACT_ROOT/Library/Taps/$TAP_OWNER/homebrew-$TAP_SHORT_NAME"
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
    "$TAP_NAME/$BOTTLE_FORMULA" \
    "$TAP_NAME" \
    "$BOTTLE_TAG" "$BOTTLE_SHA256" "$BOTTLE_ROOT_URL"

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
