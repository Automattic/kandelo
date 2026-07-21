#!/usr/bin/env bash
# Shared caller-owned root and verified-source contract for package build
# scripts. Source this file; do not execute it directly.

kandelo_package_require_real_dir() {
    local label="$1"
    local candidate="$2"
    local parent
    case "$candidate" in
        /*) ;;
        *)
            echo "ERROR: $label must be an absolute path: $candidate" >&2
            return 2
            ;;
    esac
    if [[ "/${candidate#/}/" == *'/../'* || "/${candidate#/}/" == *'/./'* || \
          "/${candidate#/}/" == *'//'* ]]; then
        echo "ERROR: $label must be normalized: $candidate" >&2
        return 2
    fi
    if [ -L "$candidate" ] || { [ -e "$candidate" ] && [ ! -d "$candidate" ]; }; then
        echo "ERROR: $label must be a real directory: $candidate" >&2
        return 2
    fi
    if [ -d "$candidate" ]; then
        (cd "$candidate" && pwd -P)
        return
    fi
    parent="$(dirname "$candidate")"
    if [ ! -d "$parent" ] || [ -L "$parent" ]; then
        echo "ERROR: $label parent must be a real directory: $parent" >&2
        return 2
    fi
    printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$(basename "$candidate")"
}

kandelo_package_require_existing_real_dir() {
    local label="$1"
    local candidate="$2"
    case "$candidate" in
        /*) ;;
        *)
            echo "ERROR: $label must be an absolute path: $candidate" >&2
            return 2
            ;;
    esac
    if [[ "/${candidate#/}/" == *'/../'* || "/${candidate#/}/" == *'/./'* || \
          "/${candidate#/}/" == *'//'* ]]; then
        echo "ERROR: $label must be normalized: $candidate" >&2
        return 2
    fi
    if [ ! -d "$candidate" ] || [ -L "$candidate" ]; then
        echo "ERROR: $label must be a real directory: $candidate" >&2
        return 2
    fi
    (cd "$candidate" && pwd -P)
}

kandelo_package_require_disjoint_paths() {
    local first_label="$1"
    local first_path="$2"
    local second_label="$3"
    local second_path="$4"
    case "$first_path/" in
        "$second_path/"|"$second_path/"*)
            echo "ERROR: $first_label must not overlap $second_label" >&2
            return 2
            ;;
    esac
    case "$second_path/" in
        "$first_path/"*)
            echo "ERROR: $first_label must not overlap $second_label" >&2
            return 2
            ;;
    esac
}

kandelo_package_require_source_disjoint_from_build_roots() {
    local source_root="$1"
    if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
        kandelo_package_require_disjoint_paths WASM_POSIX_DEP_SOURCE_DIR "$source_root" \
            WASM_POSIX_DEP_WORK_DIR "$KANDELO_PACKAGE_WORK_DIR" || return
    fi
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ] && [ -n "$KANDELO_PACKAGE_OUT_DIR" ]; then
        kandelo_package_require_disjoint_paths WASM_POSIX_DEP_SOURCE_DIR "$source_root" \
            WASM_POSIX_DEP_OUT_DIR "$KANDELO_PACKAGE_OUT_DIR" || return
    fi
}

kandelo_package_prepare_build_roots() {
    local direct_work_dir="$1"
    local supported_arch="$2"
    local target_arch="${WASM_POSIX_DEP_TARGET_ARCH:-$supported_arch}"
    local work_candidate="${WASM_POSIX_DEP_WORK_DIR:-$direct_work_dir}"
    local out_candidate="${WASM_POSIX_DEP_OUT_DIR:-}"

    if [ "$target_arch" != "$supported_arch" ]; then
        echo "ERROR: package is currently built for $supported_arch only, got $target_arch" >&2
        return 2
    fi

    local caller_source_root=""
    if [ -n "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
        caller_source_root="$(kandelo_package_require_existing_real_dir \
            WASM_POSIX_DEP_SOURCE_DIR "$WASM_POSIX_DEP_SOURCE_DIR")" || return
    fi

    KANDELO_PACKAGE_WORK_DIR="$(
        kandelo_package_require_real_dir WASM_POSIX_DEP_WORK_DIR "$work_candidate"
    )" || return
    if [ -n "$caller_source_root" ]; then
        kandelo_package_require_disjoint_paths WASM_POSIX_DEP_SOURCE_DIR \
            "$caller_source_root" WASM_POSIX_DEP_WORK_DIR \
            "$KANDELO_PACKAGE_WORK_DIR" || return
    fi
    mkdir -p "$KANDELO_PACKAGE_WORK_DIR"
    if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
        WASM_POSIX_DEP_WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
        export WASM_POSIX_DEP_WORK_DIR
    fi
    KANDELO_PACKAGE_OUT_DIR=""
    if [ -n "$out_candidate" ]; then
        KANDELO_PACKAGE_OUT_DIR="$(
            kandelo_package_require_real_dir WASM_POSIX_DEP_OUT_DIR "$out_candidate"
        )" || return
        if [ -n "$caller_source_root" ]; then
            kandelo_package_require_disjoint_paths WASM_POSIX_DEP_SOURCE_DIR \
                "$caller_source_root" WASM_POSIX_DEP_OUT_DIR \
                "$KANDELO_PACKAGE_OUT_DIR" || return
        fi
        # Work products must not be swept into the package output, and output
        # installation must not mutate work state. Formula callers use sibling
        # roots beneath Homebrew's buildpath.
        if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
            kandelo_package_require_disjoint_paths WASM_POSIX_DEP_WORK_DIR \
                "$KANDELO_PACKAGE_WORK_DIR" WASM_POSIX_DEP_OUT_DIR \
                "$KANDELO_PACKAGE_OUT_DIR" || return
        fi
        mkdir -p "$KANDELO_PACKAGE_OUT_DIR"
        WASM_POSIX_DEP_OUT_DIR="$KANDELO_PACKAGE_OUT_DIR"
        export WASM_POSIX_DEP_OUT_DIR
    fi
}

kandelo_package_select_source_root() {
    local direct_source_root="$1"
    local source_candidate="${WASM_POSIX_DEP_SOURCE_DIR:-$direct_source_root}"

    KANDELO_PACKAGE_SOURCE_ROOT="$(kandelo_package_require_existing_real_dir \
        WASM_POSIX_DEP_SOURCE_DIR "$source_candidate")" || return
    if [ -n "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
        kandelo_package_require_source_disjoint_from_build_roots \
            "$KANDELO_PACKAGE_SOURCE_ROOT" || return
        WASM_POSIX_DEP_SOURCE_DIR="$KANDELO_PACKAGE_SOURCE_ROOT"
        export WASM_POSIX_DEP_SOURCE_DIR
    fi
}

kandelo_package_stage_verified_source() {
    local label="$1"
    local dest="$2"
    local verified_dir="$3"
    local source_url="$4"
    local source_sha256="$5"
    local work_dir="$6"
    local download_dir tarball

    if [ -e "$dest" ] || [ -L "$dest" ]; then
        echo "ERROR: $label destination already exists: $dest" >&2
        return 2
    fi

    if [ -n "$verified_dir" ]; then
        verified_dir="$(kandelo_package_require_existing_real_dir \
            "verified $label source" "$verified_dir")" || return
        kandelo_package_require_source_disjoint_from_build_roots "$verified_dir" || return
        mkdir -p "$dest"
        cp -a "$verified_dir/." "$dest/"
        chmod -R u+rwX "$dest"
        return
    fi

    if [ -z "$source_url" ]; then
        echo "ERROR: $label source URL is empty" >&2
        return 2
    fi
    if ! printf '%s\n' "$source_sha256" | grep -Eq '^[0-9a-fA-F]{64}$'; then
        echo "ERROR: $label source sha256 is invalid" >&2
        return 2
    fi

    download_dir="$(mktemp -d "$work_dir/kandelo-${label}-source.XXXXXX")" || return
    tarball="$download_dir/source.tar.gz"
    if ! curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$source_url" -o "$tarball"; then
        rm -rf "$download_dir"
        return 1
    fi
    if ! printf '%s  %s\n' "$source_sha256" "$tarball" | shasum -a 256 -c -; then
        rm -rf "$download_dir"
        return 1
    fi
    mkdir -p "$dest"
    if ! tar xzf "$tarball" -C "$dest" --strip-components=1; then
        rm -rf "$dest" "$download_dir"
        return 1
    fi
    rm -rf "$download_dir"
}

kandelo_package_git_apply_patch() {
    local source_root="$1"
    local patch_file="$2"
    local mode="${3:-apply}"
    local ceiling
    local -a git_args=(apply)

    source_root="$(kandelo_package_require_existing_real_dir \
        "patch source root" "$source_root")" || return
    case "$patch_file" in
        /*) ;;
        *)
            echo "ERROR: patch file must be an absolute path: $patch_file" >&2
            return 2
            ;;
    esac
    if [ ! -f "$patch_file" ] || [ -L "$patch_file" ]; then
        echo "ERROR: patch file must be a regular non-symlink file: $patch_file" >&2
        return 2
    fi
    case "$mode" in
        apply) ;;
        check) git_args+=(--check) ;;
        *)
            echo "ERROR: unsupported git patch mode: $mode" >&2
            return 2
            ;;
    esac

    # A checksum-verified archive has no nested .git directory. When its
    # writable copy lives below the Kandelo checkout, an ordinary `git apply`
    # discovers the unrelated parent repository and resolves new-file paths
    # against the wrong worktree. Stop discovery at the source parent so Git
    # always applies archive patches relative to the staged source itself.
    ceiling="$(dirname "$source_root")"
    (
        cd "$source_root"
        GIT_CEILING_DIRECTORIES="$ceiling" git "${git_args[@]}" "$patch_file"
    )
}
