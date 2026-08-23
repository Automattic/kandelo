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

# Print the verified source root for one declared source dependency. Source-only
# builds use the resolver's injective UTF-8 byte encoding; the legacy spelling
# remains available only to the default resolver policy for compatibility.
kandelo_package_source_dependency_dir() {
    local package_name="${1:-}"
    local dependency_key variable value resolved
    if [ -z "$package_name" ]; then
        echo "ERROR: source dependency package name must not be empty" >&2
        return 2
    fi

    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
        dependency_key="K_$(
            LC_ALL=C printf '%s' "$package_name" |
                od -An -v -tx1 |
                tr -d '[:space:]' |
                tr '[:lower:]' '[:upper:]'
        )"
    else
        dependency_key="${package_name//-/_}"
        dependency_key="$(
            LC_ALL=C printf '%s' "$dependency_key" |
                tr '[:lower:]' '[:upper:]'
        )"
    fi
    variable="WASM_POSIX_DEP_${dependency_key}_SRC_DIR"

    value="$(printenv "$variable" 2>/dev/null || true)"
    if [ -z "$value" ]; then
        echo "ERROR: source dependency variable $variable is empty or unset" >&2
        return 2
    fi
    resolved="$(kandelo_package_require_existing_real_dir "$variable" "$value")" ||
        return
    if [ "$resolved" != "$value" ]; then
        echo "ERROR: source dependency variable $variable must use its canonical path: $value" >&2
        return 2
    fi
    printf '%s\n' "$resolved"
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

kandelo_package_require_stable_projection_id() {
    local label="$1"
    local value="$2"
    if ! printf '%s\n' "$value" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,127}$'; then
        echo "ERROR: $label must be a stable identifier: $value" >&2
        return 2
    fi
}

kandelo_package_require_regular_input_tree() {
    local label="$1"
    local root="$2"
    local invalid
    invalid="$(find "$root" -type l -print -quit)"
    if [ -n "$invalid" ]; then
        echo "ERROR: $label contains a symlink: $invalid" >&2
        return 2
    fi
    invalid="$(find "$root" -mindepth 1 ! -type d ! -type f -print -quit)"
    if [ -n "$invalid" ]; then
        echo "ERROR: $label contains a special entry: $invalid" >&2
        return 2
    fi
}

kandelo_package_remove_private_tree() {
    local root="$1"
    if [ -d "$root" ] && [ ! -L "$root" ]; then
        find "$root" -type d -exec chmod u+rwx {} + 2>/dev/null || true
    fi
    rm -rf -- "$root"
}

kandelo_package_make_private_tree_writable() {
    local root="$1"
    kandelo_package_require_regular_input_tree "private sysroot" "$root" || return
    find "$root" -type d -exec chmod u+rwx {} + || return
    find "$root" -type f -exec chmod u+rw {} + || return
}

# Create an isolated mutable sysroot beneath the resolver-owned work root. The
# remaining arguments are declared compiled-package dependency names; their
# resolver-provided output roots are overlaid in order after the SDK seed.
kandelo_package_prepare_private_sysroot() {
    local label="${1:-}"
    local sdk_candidate="${2:-}"
    shift 2 2>/dev/null || {
        echo "ERROR: private sysroot requires a label and SDK seed" >&2
        return 2
    }

    local work_candidate work_root sdk_root source_root output_root dependency_name
    local dependency_key dependency_variable dependency_root previous_root
    local private_root
    local -a dependency_roots=()
    local -a dependency_names=()

    kandelo_package_require_stable_projection_id \
        "private sysroot label" "$label" || return
    work_candidate="${WASM_POSIX_DEP_WORK_DIR:-}"
    work_root="$(kandelo_package_require_existing_real_dir \
        WASM_POSIX_DEP_WORK_DIR "$work_candidate")" || return
    if [ "$work_root" != "$work_candidate" ]; then
        echo "ERROR: WASM_POSIX_DEP_WORK_DIR must use its canonical path: $work_candidate" >&2
        return 2
    fi
    sdk_root="$(kandelo_package_require_existing_real_dir \
        "private sysroot SDK seed" "$sdk_candidate")" || return
    if [ "$sdk_root" != "$sdk_candidate" ]; then
        echo "ERROR: private sysroot SDK seed must use its canonical path: $sdk_candidate" >&2
        return 2
    fi
    kandelo_package_require_regular_input_tree \
        "private sysroot SDK seed" "$sdk_root" || return
    kandelo_package_require_disjoint_paths \
        "private sysroot SDK seed" "$sdk_root" \
        WASM_POSIX_DEP_WORK_DIR "$work_root" || return

    source_root=""
    if [ -n "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
        source_root="$(kandelo_package_require_existing_real_dir \
            WASM_POSIX_DEP_SOURCE_DIR "$WASM_POSIX_DEP_SOURCE_DIR")" || return
        if [ "$source_root" != "$WASM_POSIX_DEP_SOURCE_DIR" ]; then
            echo "ERROR: WASM_POSIX_DEP_SOURCE_DIR must use its canonical path: $WASM_POSIX_DEP_SOURCE_DIR" >&2
            return 2
        fi
        kandelo_package_require_disjoint_paths \
            WASM_POSIX_DEP_WORK_DIR "$work_root" \
            WASM_POSIX_DEP_SOURCE_DIR "$source_root" || return
        kandelo_package_require_disjoint_paths \
            "private sysroot SDK seed" "$sdk_root" \
            WASM_POSIX_DEP_SOURCE_DIR "$source_root" || return
    fi
    output_root=""
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        output_root="$(kandelo_package_require_existing_real_dir \
            WASM_POSIX_DEP_OUT_DIR "$WASM_POSIX_DEP_OUT_DIR")" || return
        if [ "$output_root" != "$WASM_POSIX_DEP_OUT_DIR" ]; then
            echo "ERROR: WASM_POSIX_DEP_OUT_DIR must use its canonical path: $WASM_POSIX_DEP_OUT_DIR" >&2
            return 2
        fi
        kandelo_package_require_disjoint_paths \
            WASM_POSIX_DEP_WORK_DIR "$work_root" \
            WASM_POSIX_DEP_OUT_DIR "$output_root" || return
        if [ -n "$source_root" ]; then
            kandelo_package_require_disjoint_paths \
                WASM_POSIX_DEP_SOURCE_DIR "$source_root" \
                WASM_POSIX_DEP_OUT_DIR "$output_root" || return
        fi
        kandelo_package_require_disjoint_paths \
            "private sysroot SDK seed" "$sdk_root" \
            WASM_POSIX_DEP_OUT_DIR "$output_root" || return
    fi

    for dependency_name in "$@"; do
        kandelo_package_require_stable_projection_id \
            "private sysroot dependency" "$dependency_name" || return
        if printf '%s\n' "${dependency_names[@]}" | grep -Fx "$dependency_name" >/dev/null; then
            echo "ERROR: private sysroot dependency is duplicated: $dependency_name" >&2
            return 2
        fi
        dependency_names+=("$dependency_name")
        dependency_key="${dependency_name//-/_}"
        dependency_key="$(
            LC_ALL=C printf '%s' "$dependency_key" |
                tr '[:lower:]' '[:upper:]'
        )"
        dependency_variable="WASM_POSIX_DEP_${dependency_key}_DIR"
        dependency_root="$(printenv "$dependency_variable" 2>/dev/null || true)"
        if [ -z "$dependency_root" ]; then
            echo "ERROR: private sysroot dependency variable $dependency_variable is empty or unset" >&2
            return 2
        fi
        dependency_root="$(kandelo_package_require_existing_real_dir \
            "$dependency_variable" "$dependency_root")" || return
        if [ "$dependency_root" != "$(printenv "$dependency_variable")" ]; then
            echo "ERROR: private sysroot dependency variable $dependency_variable must use its canonical path" >&2
            return 2
        fi
        kandelo_package_require_regular_input_tree \
            "private sysroot dependency $dependency_name" "$dependency_root" || return
        kandelo_package_require_disjoint_paths \
            "private sysroot dependency $dependency_name" "$dependency_root" \
            WASM_POSIX_DEP_WORK_DIR "$work_root" || return
        kandelo_package_require_disjoint_paths \
            "private sysroot dependency $dependency_name" "$dependency_root" \
            "private sysroot SDK seed" "$sdk_root" || return
        if [ -n "$source_root" ]; then
            kandelo_package_require_disjoint_paths \
                "private sysroot dependency $dependency_name" "$dependency_root" \
                WASM_POSIX_DEP_SOURCE_DIR "$source_root" || return
        fi
        if [ -n "$output_root" ]; then
            kandelo_package_require_disjoint_paths \
                "private sysroot dependency $dependency_name" "$dependency_root" \
                WASM_POSIX_DEP_OUT_DIR "$output_root" || return
        fi
        for previous_root in "${dependency_roots[@]}"; do
            kandelo_package_require_disjoint_paths \
                "private sysroot dependency $dependency_name" "$dependency_root" \
                "another private sysroot dependency" "$previous_root" || return
        done
        dependency_roots+=("$dependency_root")
    done

    private_root="$(mktemp -d "$work_root/.kandelo-${label}-sysroot.XXXXXX")" || {
        echo "ERROR: could not reserve a private sysroot beneath $work_root" >&2
        return 2
    }
    if ! cp -a "$sdk_root/." "$private_root/"; then
        kandelo_package_remove_private_tree "$private_root"
        echo "ERROR: could not seed private sysroot from $sdk_root" >&2
        return 2
    fi
    if ! kandelo_package_make_private_tree_writable "$private_root"; then
        kandelo_package_remove_private_tree "$private_root"
        return 2
    fi
    for dependency_root in "${dependency_roots[@]}"; do
        if ! cp -a "$dependency_root/." "$private_root/"; then
            kandelo_package_remove_private_tree "$private_root"
            echo "ERROR: could not overlay private sysroot dependency $dependency_root" >&2
            return 2
        fi
        if ! kandelo_package_make_private_tree_writable "$private_root"; then
            kandelo_package_remove_private_tree "$private_root"
            return 2
        fi
    done
    kandelo_package_require_regular_input_tree "private sysroot" "$private_root" || {
        kandelo_package_remove_private_tree "$private_root"
        return 2
    }
    printf '%s\n' "$private_root"
}

kandelo_package_vfs_projection_requested() {
    local label="$1"
    local selected="$2"
    local requested="$3"
    local previous=""
    local item
    kandelo_package_require_stable_projection_id "$label" "$requested" || return
    [ -n "$selected" ] || return 1
    kandelo_package_require_stable_projection_id \
        "VFS product package" "${KANDELO_VFS_PRODUCT_PACKAGE:-}" || return
    kandelo_package_require_stable_projection_id \
        "resolver package" "${WASM_POSIX_DEP_NAME:-}" || return
    if [ "$KANDELO_VFS_PRODUCT_PACKAGE" != "$WASM_POSIX_DEP_NAME" ]; then
        return 1
    fi
    if [ "${#selected}" -gt 8192 ] || \
       ! printf '%s\n' "$selected" | grep -Eq \
           '^[a-z0-9][a-z0-9._-]{0,127}(,[a-z0-9][a-z0-9._-]{0,127})*$'; then
        echo "ERROR: $label selection is not a canonical comma-separated identifier list" >&2
        return 2
    fi
    while IFS= read -r item; do
        if [ -n "$previous" ] && [[ "$item" < "$previous" || "$item" == "$previous" ]]; then
            echo "ERROR: $label selection is not a canonical comma-separated identifier list" >&2
            return 2
        fi
        [ "$item" = "$requested" ] && return 0
        previous="$item"
    done < <(printf '%s\n' "$selected" | tr ',' '\n')
    return 1
}

kandelo_package_vfs_output_requested() {
    kandelo_package_vfs_projection_requested \
        "VFS product output" "${KANDELO_VFS_PRODUCT_OUTPUTS:-}" "$1"
}

kandelo_package_vfs_source_role_requested() {
    kandelo_package_vfs_projection_requested \
        "VFS product source role" "${KANDELO_VFS_PRODUCT_SOURCE_ROLES:-}" "$1"
}

kandelo_package_projection_root() {
    local relative="$1"
    local output_root projection_root
    output_root="$(kandelo_package_require_existing_real_dir \
        KANDELO_PACKAGE_OUT_DIR "${KANDELO_PACKAGE_OUT_DIR:-}")" || return
    projection_root="$output_root/$relative"
    if [ -L "$projection_root" ] || \
       { [ -e "$projection_root" ] && [ ! -d "$projection_root" ]; }; then
        echo "ERROR: package projection root must be a real directory: $projection_root" >&2
        return 2
    fi
    mkdir -p "$projection_root"
    kandelo_package_require_existing_real_dir \
        "package projection root" "$projection_root"
}

# Transitional package adapters publish only physical bytes. VFS product
# manifests remain the sole authority that selects package names, logical
# outputs, source roles, materialization, and product membership.
kandelo_package_project_vfs_output() {
    local selector="$1"
    local source="$2"
    local projection_root target
    kandelo_package_require_stable_projection_id \
        "VFS product output selector" "$selector" || return
    if [ ! -f "$source" ] || [ -L "$source" ] || [ ! -s "$source" ]; then
        echo "ERROR: VFS product output source must be one regular non-symlink file: $source" >&2
        return 2
    fi
    projection_root="$(kandelo_package_projection_root \
        .kandelo-vfs-product-outputs)" || return
    target="$projection_root/$selector"
    if [ -e "$target" ] || [ -L "$target" ]; then
        echo "ERROR: VFS product output already exists: $target" >&2
        return 2
    fi
    cp "$source" "$target"
}

kandelo_package_project_vfs_source_role() {
    local role="$1"
    local source="$2"
    local projection_root target invalid
    kandelo_package_require_stable_projection_id \
        "VFS product source role" "$role" || return
    source="$(kandelo_package_require_existing_real_dir \
        "VFS product source role source" "$source")" || return
    if [ -z "$(find "$source" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: VFS product source role source is empty: $source" >&2
        return 2
    fi
    invalid="$(find "$source" -type l -print -quit)"
    if [ -n "$invalid" ]; then
        echo "ERROR: VFS product source role contains a symlink: $invalid" >&2
        return 2
    fi
    invalid="$(find "$source" -mindepth 1 ! -type d ! -type f -print -quit)"
    if [ -n "$invalid" ]; then
        echo "ERROR: VFS product source role contains a special entry: $invalid" >&2
        return 2
    fi
    projection_root="$(kandelo_package_projection_root \
        .kandelo-vfs-source-roles)" || return
    target="$projection_root/$role"
    if [ -e "$target" ] || [ -L "$target" ]; then
        echo "ERROR: VFS product source role already exists: $target" >&2
        return 2
    fi
    mkdir "$target"
    cp -a "$source/." "$target/"
}

kandelo_package_project_requested_vfs_output() {
    local selector="$1"
    local source="$2"
    local status
    status=0
    kandelo_package_vfs_output_requested "$selector" || status=$?
    case "$status" in
        0) kandelo_package_project_vfs_output "$selector" "$source" ;;
        1) return 0 ;;
        *) return "$status" ;;
    esac
}

kandelo_package_project_requested_vfs_directory_output() {
    local selector="$1"
    local source="$2"
    local status projection_root target invalid
    status=0
    kandelo_package_vfs_output_requested "$selector" || status=$?
    case "$status" in
        0) ;;
        1) return 0 ;;
        *) return "$status" ;;
    esac
    source="$(kandelo_package_require_existing_real_dir \
        "VFS product directory output source" "$source")" || return
    if [ -z "$(find "$source" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: VFS product directory output source is empty: $source" >&2
        return 2
    fi
    invalid="$(find "$source" -type l -print -quit)"
    if [ -n "$invalid" ]; then
        echo "ERROR: VFS product directory output contains a symlink: $invalid" >&2
        return 2
    fi
    invalid="$(find "$source" -mindepth 1 ! -type d ! -type f -print -quit)"
    if [ -n "$invalid" ]; then
        echo "ERROR: VFS product directory output contains a special entry: $invalid" >&2
        return 2
    fi
    projection_root="$(kandelo_package_projection_root \
        .kandelo-vfs-product-outputs)" || return
    target="$projection_root/$selector"
    if [ -e "$target" ] || [ -L "$target" ]; then
        echo "ERROR: VFS product output already exists: $target" >&2
        return 2
    fi
    mkdir "$target"
    cp -a "$source/." "$target/"
}

kandelo_package_project_requested_vfs_source_role() {
    local role="$1"
    local source="$2"
    local status
    status=0
    kandelo_package_vfs_source_role_requested "$role" || status=$?
    case "$status" in
        0) kandelo_package_project_vfs_source_role "$role" "$source" ;;
        1) return 0 ;;
        *) return "$status" ;;
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

kandelo_package_require_existing_regular_file() {
    local label="$1"
    local candidate="$2"
    local parent parent_real canonical
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
    if [ ! -f "$candidate" ] || [ -L "$candidate" ]; then
        echo "ERROR: $label must be a regular non-symlink file: $candidate" >&2
        return 2
    fi
    parent="$(dirname "$candidate")"
    parent_real="$(kandelo_package_require_existing_real_dir \
        "$label parent" "$parent")" || return
    canonical="$parent_real/$(basename "$candidate")"
    if [ "$candidate" != "$canonical" ]; then
        echo "ERROR: $label must use its canonical path: $candidate" >&2
        return 2
    fi
    printf '%s\n' "$canonical"
}

kandelo_package_stage_verified_source() {
    local label="$1"
    local dest="$2"
    local verified_dir="$3"
    local source_url="$4"
    local source_sha256="$5"
    local work_dir="$6"
    local archive_magic download_dir entry invalid tarball zip_listing
    local zip_listing_long zip_root zip_top zip_top_name
    local resolver_archive resolver_source work_root output_root positional_source dest_path
    local -a zip_entries

    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = "source-only-v1" ]; then
        if [ -z "${WASM_POSIX_DEP_SOURCE_ARCHIVE:-}" ]; then
            echo "ERROR: $label source-only resolver archive is empty" >&2
            return 2
        fi
        if [ -z "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
            echo "ERROR: $label source-only resolver source directory is empty" >&2
            return 2
        fi
        resolver_archive="$(kandelo_package_require_existing_regular_file \
            "source-only $label archive" "$WASM_POSIX_DEP_SOURCE_ARCHIVE")" || return
        resolver_source="$(kandelo_package_require_existing_real_dir \
            "source-only $label source" "$WASM_POSIX_DEP_SOURCE_DIR")" || return
        if [ "$resolver_source" != "$WASM_POSIX_DEP_SOURCE_DIR" ]; then
            echo "ERROR: source-only $label source must use its canonical path" >&2
            return 2
        fi
        work_root="$(kandelo_package_require_existing_real_dir \
            "source-only $label work root" "$work_dir")" || return
        if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
            local environment_work_root
            environment_work_root="$(kandelo_package_require_existing_real_dir \
                WASM_POSIX_DEP_WORK_DIR "$WASM_POSIX_DEP_WORK_DIR")" || return
            if [ "$environment_work_root" != "$work_root" ]; then
                echo "ERROR: source-only $label work root does not match WASM_POSIX_DEP_WORK_DIR" >&2
                return 2
            fi
        fi
        kandelo_package_require_disjoint_paths "source-only $label source" \
            "$resolver_source" "source-only $label work root" "$work_root" || return
        output_root=""
        if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
            output_root="$(kandelo_package_require_existing_real_dir \
                WASM_POSIX_DEP_OUT_DIR "$WASM_POSIX_DEP_OUT_DIR")" || return
            kandelo_package_require_disjoint_paths "source-only $label source" \
                "$resolver_source" WASM_POSIX_DEP_OUT_DIR "$output_root" || return
            kandelo_package_require_disjoint_paths "source-only $label work root" \
                "$work_root" WASM_POSIX_DEP_OUT_DIR "$output_root" || return
        fi
        positional_source="$resolver_source"
        if [ -n "$verified_dir" ]; then
            positional_source="$(kandelo_package_require_existing_real_dir \
                "verified $label source" "$verified_dir")" || return
            if [ "$positional_source" != "$resolver_source" ]; then
                echo "ERROR: verified $label source does not match the source-only resolver source" >&2
                return 2
            fi
        fi

        if [ -e "$dest" ] || [ -L "$dest" ]; then
            echo "ERROR: $label destination already exists: $dest" >&2
            return 2
        fi
        dest_path="$(kandelo_package_require_real_dir \
            "source-only $label destination" "$dest")" || return
        case "$dest_path/" in
            "$work_root/"*) ;;
            *)
                echo "ERROR: source-only $label destination must be below the caller work root" >&2
                return 2
                ;;
        esac
        mkdir "$dest_path" || return
        if ! cp -a "$positional_source/." "$dest_path/"; then
            rm -rf "$dest_path"
            return 1
        fi
        if ! find "$dest_path" ! -type l -exec chmod u+rwX,go-w {} +; then
            rm -rf "$dest_path"
            return 1
        fi
        return 0
    fi

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
    # WHY keep the staged name compression-neutral: package manifests include
    # both gzip and xz archives, and tar should select the decompressor from
    # the verified bytes rather than a recipe-specific filename convention.
    tarball="$download_dir/source.archive"
    if ! curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$source_url" -o "$tarball"; then
        rm -rf "$download_dir"
        return 1
    fi
    if ! printf '%s  %s\n' "$source_sha256" "$tarball" | shasum -a 256 -c -; then
        rm -rf "$download_dir"
        return 1
    fi

    archive_magic="$(od -An -N4 -tx1 "$tarball" | tr -d '[:space:]')"
    case "$archive_magic" in
        504b0304|504b0506|504b0708)
            zip_listing="$download_dir/entries.txt"
            zip_listing_long="$download_dir/entries.long.txt"
            zip_root="$download_dir/unpacked"
            if ! unzip -Z1 "$tarball" >"$zip_listing" ||
               ! unzip -Z -l "$tarball" >"$zip_listing_long"; then
                rm -rf "$download_dir"
                return 1
            fi
            # Reject links/devices before extraction so an archive entry cannot
            # redirect a later write outside the private unpacking root.
            if ! awk '
                NR <= 2 { next }
                /^[0-9]+ files?,/ { next }
                {
                    kind = substr($0, 1, 1)
                    if (kind != "-" && kind != "d") exit 1
                    seen = 1
                }
                END { if (!seen) exit 1 }
            ' "$zip_listing_long"; then
                rm -rf "$download_dir"
                return 1
            fi
            zip_top_name=""
            while IFS= read -r entry; do
                case "$entry" in
                    ""|/*|*\\*)
                        rm -rf "$download_dir"
                        return 1
                        ;;
                esac
                entry="${entry%/}"
                [ -n "$entry" ] || {
                    rm -rf "$download_dir"
                    return 1
                }
                case "/$entry/" in
                    *'/../'*|*'/./'*|*'//'*)
                        rm -rf "$download_dir"
                        return 1
                        ;;
                esac
                if [ -z "$zip_top_name" ]; then
                    zip_top_name="${entry%%/*}"
                elif [ "${entry%%/*}" != "$zip_top_name" ]; then
                    rm -rf "$download_dir"
                    return 1
                fi
            done <"$zip_listing"
            [ -n "$zip_top_name" ] || {
                rm -rf "$download_dir"
                return 1
            }
            mkdir -p "$zip_root"
            if ! unzip -oq "$tarball" -d "$zip_root"; then
                rm -rf "$download_dir"
                return 1
            fi
            mapfile -d '' -t zip_entries < <(
                find "$zip_root" -mindepth 1 -maxdepth 1 -print0
            )
            if [ "${#zip_entries[@]}" -ne 1 ] ||
               [ "$(basename "${zip_entries[0]}")" != "$zip_top_name" ] ||
               [ ! -d "${zip_entries[0]}" ] || [ -L "${zip_entries[0]}" ]; then
                rm -rf "$download_dir"
                return 1
            fi
            zip_top="${zip_entries[0]}"
            invalid="$(find "$zip_top" -type l -print -quit)"
            [ -z "$invalid" ] || {
                rm -rf "$download_dir"
                return 1
            }
            invalid="$(
                find "$zip_top" -mindepth 1 ! -type d ! -type f -print -quit
            )"
            [ -z "$invalid" ] || {
                rm -rf "$download_dir"
                return 1
            }
            mkdir -p "$dest"
            if ! cp -a "$zip_top/." "$dest/"; then
                rm -rf "$dest" "$download_dir"
                return 1
            fi
            rm -rf "$download_dir"
            return 0
            ;;
    esac

    mkdir -p "$dest"
    if ! tar xf "$tarball" -C "$dest" --strip-components=1; then
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
