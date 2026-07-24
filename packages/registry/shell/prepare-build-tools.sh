#!/usr/bin/env bash
# Create an isolated source/tool snapshot for the shell package's composer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NPM_BIN=""
NODE_BIN=""

usage() {
    echo "usage: prepare-build-tools.sh <new-source-snapshot>" >&2
}

fail() {
    echo "prepare-shell-build-tools: $*" >&2
    return 1
}

validate_regular_file() {
    local path="$1"
    local label="$2"
    if [ ! -f "$path" ] || [ -L "$path" ]; then
        fail "$label must be a regular non-symlink file: $path"
        return 1
    fi
}

copy_checkout_inputs() (
    local snapshot="$1"
    local changed_list="$snapshot/.kandelo-changed-files"
    local deleted_list="$snapshot/.kandelo-deleted-files"
    local git_bin git_state git_path info_attributes
    local relative source destination index_record mode

    git_bin="$(type -P git || true)"
    if [ -z "$git_bin" ]; then
        fail "git is required; run the package build through scripts/dev-shell.sh"
        return 1
    fi
    git_state="${snapshot}.kandelo-git-state"
    if [ -e "$git_state" ] || [ -L "$git_state" ]; then
        fail "new source snapshot has a reserved Git-state sibling: $git_state"
        return 1
    fi
    mkdir -p "$git_state/home" "$git_state/xdg"
    trap 'rm -rf -- "$git_state"' EXIT
    git_path="$(dirname "$git_bin"):/usr/bin:/bin"

    isolated_git() {
        # WHY: Git archive/diff behavior can otherwise inherit a developer's
        # attributes, replacement refs, object/index selectors, or external
        # diff configuration. The snapshot is a package input, so only the
        # checkout's tracked bytes may determine it.
        env -i \
            PATH="$git_path" \
            HOME="$git_state/home" \
            XDG_CONFIG_HOME="$git_state/xdg" \
            LANG=C \
            LC_ALL=C \
            GIT_CONFIG_NOSYSTEM=1 \
            GIT_CONFIG_SYSTEM=/dev/null \
            GIT_CONFIG_GLOBAL=/dev/null \
            GIT_ATTR_NOSYSTEM=1 \
            GIT_NO_REPLACE_OBJECTS=1 \
            GIT_OPTIONAL_LOCKS=0 \
            GIT_TERMINAL_PROMPT=0 \
            "$git_bin" \
                -c core.attributesFile=/dev/null \
                -c core.fsmonitor=false \
                -c core.untrackedCache=false \
                -c diff.external= \
                -C "$REPO_ROOT" \
                "$@"
    }

    info_attributes="$(isolated_git rev-parse --git-path info/attributes)" || {
        fail "could not locate repository-local Git attributes"
        return 1
    }
    case "$info_attributes" in
        /*) ;;
        *) info_attributes="$REPO_ROOT/$info_attributes" ;;
    esac
    if [ -e "$info_attributes" ] || [ -L "$info_attributes" ]; then
        fail "repository-local Git info attributes are not package inputs: $info_attributes"
        return 1
    fi

    # Start from one immutable Git archive for speed, then overlay current
    # tracked working-tree bytes. This preserves local package iteration while
    # excluding ignored/untracked files and checkout-global build products.
    if ! isolated_git archive --format=tar HEAD |
        tar -xf - -C "$snapshot"; then
        fail "could not materialize the committed source snapshot"
        return 1
    fi
    for relative in "$changed_list" "$deleted_list"; do
        if [ -e "$relative" ] || [ -L "$relative" ]; then
            fail "source snapshot contains a reserved preparation path: $relative"
            return 1
        fi
    done
    isolated_git diff \
        --no-ext-diff --no-textconv \
        --no-renames --name-only -z --diff-filter=ACMRTUXB HEAD -- \
        >"$changed_list" || {
        fail "could not enumerate tracked working-tree changes"
        return 1
    }
    isolated_git diff \
        --no-ext-diff --no-textconv \
        --no-renames --name-only -z --diff-filter=D HEAD -- \
        >"$deleted_list" || {
        fail "could not enumerate deleted tracked paths"
        return 1
    }

    while IFS= read -r -d '' relative; do
        case "$relative" in
            ""|/*|..|../*|*/..|*/../*)
                fail "Git returned an unsafe source path: $relative"
                return 1
                ;;
        esac

        source="$REPO_ROOT/$relative"
        destination="$snapshot/$relative"
        index_record="$(isolated_git ls-files --stage -- "$relative")"
        mode="${index_record%% *}"
        if [ "$mode" = "160000" ]; then
            # Gitlinks are not shell-composer inputs. In particular, the musl
            # checkout is owned by the separate toolchain wave.
            continue
        fi
        if { [ -e "$destination" ] || [ -L "$destination" ]; } &&
           { [ -d "$destination" ] && [ ! -L "$destination" ]; }; then
            fail "tracked source overlay would replace a directory: $relative"
            return 1
        fi
        rm -f "$destination"
        mkdir -p "$(dirname "$destination")"
        case "$mode" in
            100644|100755)
                if [ ! -f "$source" ] || [ -L "$source" ]; then
                    fail "tracked source file is missing or substituted: $source"
                    return 1
                fi
                cp -p "$source" "$destination"
                ;;
            120000)
                if [ ! -L "$source" ]; then
                    fail "tracked source symlink is missing or substituted: $source"
                    return 1
                fi
                cp -P "$source" "$destination"
                ;;
            *)
                fail "unsupported Git mode $mode for source path: $relative"
                return 1
                ;;
        esac
    done <"$changed_list"

    while IFS= read -r -d '' relative; do
        case "$relative" in
            ""|/*|..|../*|*/..|*/../*)
                fail "Git returned an unsafe deleted path: $relative"
                return 1
                ;;
        esac
        destination="$snapshot/$relative"
        if [ -d "$destination" ] && [ ! -L "$destination" ]; then
            fail "deleted tracked path unexpectedly became a directory: $relative"
            return 1
        fi
        rm -f "$destination"
    done <"$deleted_list"

    rm -f "$changed_list" "$deleted_list"
)

run_locked_npm_ci() {
    local package_root="$1"
    local state_root="$2"
    local safe_path
    safe_path="$(dirname "$NODE_BIN"):$(dirname "$NPM_BIN"):/usr/bin:/bin"

    mkdir -p \
        "$state_root/home" \
        "$state_root/cache" \
        "$state_root/tmp"
    : >"$state_root/user.npmrc"
    : >"$state_root/global.npmrc"

    # `env -i` is intentional. npm lifecycle scripts must not inherit GitHub,
    # npm, or user-shell credentials/configuration from the resolver process.
    # The explicit public registry plus lockfile integrity own the fetched
    # bytes; the private HOME/cache/config keep concurrent builds independent.
    (
        cd "$package_root"
        env -i \
            PATH="$safe_path" \
            HOME="$state_root/home" \
            PWD="$package_root" \
            TMPDIR="$state_root/tmp" \
            LANG=C \
            LC_ALL=C \
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
            npm_config_cache="$state_root/cache" \
            npm_config_userconfig="$state_root/user.npmrc" \
            npm_config_globalconfig="$state_root/global.npmrc" \
            npm_config_registry="https://registry.npmjs.org/" \
            "$NPM_BIN" \
                ci \
                --no-audit \
                --no-fund \
                --prefer-offline \
                --registry="https://registry.npmjs.org/"
    )
}

install_tree() {
    local label="$1"
    local package_root="$2"
    local state_root="$3"
    local required_output="$4"
    local node_modules="$package_root/node_modules"

    validate_regular_file "$package_root/package.json" "$label package manifest" ||
        return 1
    validate_regular_file "$package_root/package-lock.json" "$label package lock" ||
        return 1
    if [ -e "$package_root/.npmrc" ] || [ -L "$package_root/.npmrc" ]; then
        fail "repository npm configuration is not an approved package input: $package_root/.npmrc"
        return 1
    fi
    if [ -e "$node_modules" ] || [ -L "$node_modules" ]; then
        fail "new source snapshot already contains a $label dependency tree: $node_modules"
        return 1
    fi

    echo "prepare-shell-build-tools: installing locked $label dependencies"
    run_locked_npm_ci "$package_root" "$state_root" || return 1

    if [ ! -d "$node_modules" ] || [ -L "$node_modules" ]; then
        fail "npm did not produce a real $label dependency tree: $node_modules"
        return 1
    fi
    if [ ! -e "$required_output" ]; then
        fail "locked $label install is missing required output: $required_output"
        return 1
    fi
}

main() {
    local snapshot="${1:-}"
    local npm_state
    if [ "$#" -ne 1 ] ||
       [ -z "$snapshot" ] ||
       [ "$snapshot" = "/" ] ||
       [[ "$snapshot" != /* ]] ||
       [ -e "$snapshot" ] ||
       [ -L "$snapshot" ]; then
        usage
        return 2
    fi

    NPM_BIN="$(type -P npm || true)"
    NODE_BIN="$(type -P node || true)"
    if [ -z "$NPM_BIN" ] || [ -z "$NODE_BIN" ]; then
        fail "node and npm are required; run the package build through scripts/dev-shell.sh"
        return 1
    fi

    mkdir "$snapshot"
    copy_checkout_inputs "$snapshot" || return 1
    npm_state="$snapshot/.kandelo-npm-state"
    if [ -e "$npm_state" ] || [ -L "$npm_state" ]; then
        fail "source snapshot contains reserved npm state: $npm_state"
        return 1
    fi

    # WHY: the package resolver may source-build shell after any unusable
    # archive, including a stale same-run overlay. The private snapshot keeps
    # local, direct, transitive, and concurrent fallbacks on the same recipe
    # path without deleting another process's checkout-owned node_modules.
    install_tree \
        "root shell-composer" \
        "$snapshot" \
        "$npm_state" \
        "$snapshot/node_modules/.bin/tsx" ||
        return 1
    install_tree \
        "mkrootfs" \
        "$snapshot/tools/mkrootfs" \
        "$npm_state" \
        "$snapshot/tools/mkrootfs/node_modules/fflate" ||
        return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
