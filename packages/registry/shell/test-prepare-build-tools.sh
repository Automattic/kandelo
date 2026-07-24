#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=prepare-build-tools.sh
source "$SCRIPT_DIR/prepare-build-tools.sh"

TMP_ROOT="$(mktemp -d)"
cleanup() {
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

test_fail() {
    echo "test-prepare-shell-build-tools: $*" >&2
    exit 1
}

REPO_ROOT="$TMP_ROOT/repo"
install_log="$TMP_ROOT/install.log"

make_repo_fixture() {
    rm -rf "$REPO_ROOT"
    : >"$install_log"
    mkdir -p "$REPO_ROOT/tools/mkrootfs"
    for package_root in "$REPO_ROOT" "$REPO_ROOT/tools/mkrootfs"; do
        printf '{"private":true}\n' >"$package_root/package.json"
        printf '{"lockfileVersion":3}\n' >"$package_root/package-lock.json"
    done
    printf 'committed\n' >"$REPO_ROOT/tracked.txt"
    ln -s tracked.txt "$REPO_ROOT/tracked-link"
    git -C "$REPO_ROOT" init -q
    git -C "$REPO_ROOT" config user.email shell-tools-test@example.invalid
    git -C "$REPO_ROOT" config user.name "Shell tools test"
    git -C "$REPO_ROOT" add .
    git -C "$REPO_ROOT" commit -qm "Packaging: Add source fixture"

    # Source builds consume current Git-owned working bytes, not stale HEAD
    # bytes. Untracked files are deliberately excluded from the snapshot.
    printf 'working tree\n' >"$REPO_ROOT/tracked.txt"
    printf 'not a package input\n' >"$REPO_ROOT/untracked-secret"
}

run_locked_npm_ci() {
    local package_root="$1"
    local state_root="$2"
    printf '%s|%s\n' "$package_root" "$state_root" >>"$install_log"
    mkdir -p "$package_root/node_modules"
    if [ "$package_root" = "${package_root%/tools/mkrootfs}" ]; then
        mkdir -p "$package_root/node_modules/.bin"
        : >"$package_root/node_modules/.bin/tsx"
    else
        mkdir -p "$package_root/node_modules/fflate"
    fi
}

assert_snapshot_install_order() {
    local snapshot="$1"
    local expected="$snapshot|$snapshot/.kandelo-npm-state
$snapshot/tools/mkrootfs|$snapshot/.kandelo-npm-state"
    local actual
    actual="$(cat "$install_log")"
    [ "$actual" = "$expected" ] ||
        test_fail "wrong install order; expected '$expected', got '$actual'"
}

# A clean source build snapshots Git-owned working bytes, preserves symlinks,
# excludes unrelated untracked state, and installs only below the private
# resolver output.
make_repo_fixture
hostile_attributes="$TMP_ROOT/hostile.attributes"
hostile_home="$TMP_ROOT/hostile-git-home"
mkdir "$hostile_home"
printf 'tracked.txt export-ignore\n' >"$hostile_attributes"
git -C "$REPO_ROOT" config core.attributesFile "$hostile_attributes"
printf '[core]\n\tattributesFile = %s\n' "$hostile_attributes" \
    >"$hostile_home/.gitconfig"
snapshot="$TMP_ROOT/snapshot"
(
    # shellcheck disable=SC2030 # deliberately hostile only in this subprocess
    export HOME="$hostile_home"
    export GIT_CONFIG_GLOBAL="$hostile_home/.gitconfig"
    export GIT_DIR="$TMP_ROOT/hostile-git-dir"
    export GIT_WORK_TREE="$TMP_ROOT/hostile-work-tree"
    export GIT_OBJECT_DIRECTORY="$TMP_ROOT/hostile-objects"
    main "$snapshot"
)
assert_snapshot_install_order "$snapshot"
[ "$(cat "$snapshot/tracked.txt")" = "working tree" ] ||
    test_fail "snapshot used stale bytes or ambient Git attributes"
[ -L "$snapshot/tracked-link" ] ||
    test_fail "snapshot did not preserve a tracked symlink"
[ ! -e "$snapshot/untracked-secret" ] ||
    test_fail "snapshot copied an unrelated untracked file"
[ ! -e "$REPO_ROOT/node_modules" ] &&
    [ ! -e "$REPO_ROOT/tools/mkrootfs/node_modules" ] ||
    test_fail "tool preparation mutated the shared checkout"
[ ! -e "$snapshot/.kandelo-changed-files" ] &&
    [ ! -e "$snapshot/.kandelo-deleted-files" ] ||
    test_fail "snapshot leaked its temporary Git inventory"

# Two source builds receive different snapshots and dependency trees. No
# checkout-global path is shared even when resolver fallbacks overlap.
: >"$install_log"
snapshot_one="$TMP_ROOT/concurrent-one"
snapshot_two="$TMP_ROOT/concurrent-two"
main "$snapshot_one" &
one_pid=$!
main "$snapshot_two" &
two_pid=$!
wait "$one_pid" || test_fail "first concurrent tool snapshot failed"
wait "$two_pid" || test_fail "second concurrent tool snapshot failed"
[ -d "$snapshot_one/node_modules" ] &&
    [ -d "$snapshot_two/node_modules" ] &&
    [ "$snapshot_one/node_modules" != "$snapshot_two/node_modules" ] ||
    test_fail "concurrent source builds shared one dependency tree"
[ "$(cut -d'|' -f1 "$install_log" | sort -u | wc -l | tr -d '[:space:]')" -eq 4 ] ||
    test_fail "concurrent source builds did not install into four private package roots"

# Repository-local info attributes are mutable checkout state that cannot be
# overridden through normal Git configuration. Reject them rather than letting
# an untracked export-ignore rule change package inputs.
make_repo_fixture
printf 'tracked.txt export-ignore\n' >"$REPO_ROOT/.git/info/attributes"
if main "$TMP_ROOT/info-attributes-snapshot" \
    >"$TMP_ROOT/info-attributes.out" 2>"$TMP_ROOT/info-attributes.err"; then
    test_fail "accepted repository-local Git info attributes"
fi
[ ! -s "$install_log" ] ||
    test_fail "ran npm before rejecting repository-local Git info attributes"
grep -Fq "Git info attributes are not package inputs" \
    "$TMP_ROOT/info-attributes.err" ||
    test_fail "did not explain the repository-local Git attributes rejection"

# A Git-owned regular lockfile that is replaced by a symlink is rejected before
# any npm process runs.
make_repo_fixture
mv "$REPO_ROOT/package-lock.json" "$TMP_ROOT/root-lock"
ln -s "$TMP_ROOT/root-lock" "$REPO_ROOT/package-lock.json"
if main "$TMP_ROOT/symlinked-lock-snapshot" \
    >"$TMP_ROOT/lock.out" 2>"$TMP_ROOT/lock.err"; then
    test_fail "accepted a symlinked package lock"
fi
[ ! -s "$install_log" ] ||
    test_fail "ran npm before rejecting the symlinked package lock"
grep -Fq "tracked source file is missing or substituted" "$TMP_ROOT/lock.err" ||
    test_fail "did not explain the symlinked package-lock rejection"

# install_tree also refuses a pre-existing/symlinked dependency tree and a
# repository-provided npm configuration.
isolated_package="$TMP_ROOT/isolated-package"
mkdir -p "$isolated_package"
printf '{"private":true}\n' >"$isolated_package/package.json"
printf '{"lockfileVersion":3}\n' >"$isolated_package/package-lock.json"
mkdir "$TMP_ROOT/external-node-modules"
ln -s "$TMP_ROOT/external-node-modules" "$isolated_package/node_modules"
if install_tree test "$isolated_package" "$TMP_ROOT/state" \
    "$isolated_package/node_modules/required" \
    >"$TMP_ROOT/modules.out" 2>"$TMP_ROOT/modules.err"; then
    test_fail "accepted a symlinked dependency tree"
fi
grep -Fq "already contains" "$TMP_ROOT/modules.err" ||
    test_fail "did not explain the symlinked dependency-tree rejection"
rm "$isolated_package/node_modules"
: >"$isolated_package/.npmrc"
if install_tree test "$isolated_package" "$TMP_ROOT/state" \
    "$isolated_package/node_modules/required" \
    >"$TMP_ROOT/npmrc.out" 2>"$TMP_ROOT/npmrc.err"; then
    test_fail "accepted repository npm configuration"
fi
grep -Fq "not an approved package input" "$TMP_ROOT/npmrc.err" ||
    test_fail "did not explain the repository npm-config rejection"

# A successful npm exit is insufficient unless the locked install produced the
# tool the composer will execute.
rm "$isolated_package/.npmrc"
run_locked_npm_ci() {
    local package_root="$1"
    mkdir -p "$package_root/node_modules"
}
if install_tree test "$isolated_package" "$TMP_ROOT/state" \
    "$isolated_package/node_modules/required" \
    >"$TMP_ROOT/output.out" 2>"$TMP_ROOT/output.err"; then
    test_fail "accepted an install missing its required output"
fi
grep -Fq "missing required output" "$TMP_ROOT/output.err" ||
    test_fail "did not explain the incomplete install"

# Exercise the real env-isolation wrapper with a fake npm executable. Hostile
# credentials and config must be absent, while the private configuration and
# exact public registry must be explicit.
fake_bin="$TMP_ROOT/fake-bin"
mkdir "$fake_bin"
cat >"$fake_bin/node" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$fake_bin/npm" <<'EOF'
#!/bin/sh
set -eu
bin_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
env | sort >"$bin_dir/environment.log"
printf '%s\n' "$@" >"$bin_dir/arguments.log"
EOF
chmod +x "$fake_bin/node" "$fake_bin/npm"
(
    # Reload the production implementation after the failure-case overrides.
    source "$SCRIPT_DIR/prepare-build-tools.sh"
    NPM_BIN="$fake_bin/npm"
    NODE_BIN="$fake_bin/node"
    export GH_TOKEN=forbidden
    export GITHUB_TOKEN=forbidden
    export NPM_TOKEN=forbidden
    export NODE_AUTH_TOKEN=forbidden
    export NPM_CONFIG_USERCONFIG="$TMP_ROOT/hostile-user.npmrc"
    export NPM_CONFIG_GLOBALCONFIG="$TMP_ROOT/hostile-global.npmrc"
    export NPM_CONFIG_REGISTRY="https://attacker.invalid/"
    export npm_config_userconfig="$TMP_ROOT/hostile-lower-user.npmrc"
    export npm_config_globalconfig="$TMP_ROOT/hostile-lower-global.npmrc"
    export npm_config_registry="https://lower-attacker.invalid/"
    export NODE_OPTIONS="--require=$TMP_ROOT/attacker.js"
    export NODE_PATH="$TMP_ROOT/attacker-node-path"
    # shellcheck disable=SC2031 # independent hostile subprocess environment
    export HOME="$TMP_ROOT/hostile-home"
    run_locked_npm_ci "$isolated_package" "$TMP_ROOT/scrubbed-state"
)
if grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_USERCONFIG|NPM_CONFIG_GLOBALCONFIG|NPM_CONFIG_REGISTRY|NODE_OPTIONS|NODE_PATH)=' \
    "$fake_bin/environment.log"; then
    test_fail "npm inherited a hostile credential or configuration variable"
fi
grep -Fq "HOME=$TMP_ROOT/scrubbed-state/home" "$fake_bin/environment.log" ||
    test_fail "npm did not receive its isolated HOME"
grep -Fqx "npm_config_userconfig=$TMP_ROOT/scrubbed-state/user.npmrc" \
    "$fake_bin/environment.log" ||
    test_fail "npm did not receive its private user configuration"
grep -Fqx "npm_config_globalconfig=$TMP_ROOT/scrubbed-state/global.npmrc" \
    "$fake_bin/environment.log" ||
    test_fail "npm did not receive its private global configuration"
grep -Fq 'npm_config_registry=https://registry.npmjs.org/' \
    "$fake_bin/environment.log" ||
    test_fail "npm did not receive the canonical public registry"
grep -Fq -- '--registry=https://registry.npmjs.org/' \
    "$fake_bin/arguments.log" ||
    test_fail "npm command did not pin the canonical public registry"
[ ! -s "$TMP_ROOT/scrubbed-state/user.npmrc" ] &&
    [ ! -s "$TMP_ROOT/scrubbed-state/global.npmrc" ] ||
    test_fail "isolated npm configuration files must start empty"

echo "test-prepare-shell-build-tools: ok"
