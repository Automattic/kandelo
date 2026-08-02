#!/usr/bin/env bash

# Lifecycle helpers for running a patched Homebrew worktree without changing
# the prefix and Cellar selected by the caller's brew executable.

HOMEBREW_PATCHED_REPO=""
HOMEBREW_PATCHED_PREFIX=""
HOMEBREW_PATCHED_OVERLAY=""
HOMEBREW_PATCHED_LAUNCHER=""
HOMEBREW_PATCHED_BREW_BIN=""
HOMEBREW_PATCHED_PROTECTED_DIR=""
HOMEBREW_PATCHED_PROTECTED_DIR_STATE=""
HOMEBREW_PATCHED_SOURCE_ALIAS_DIR=""
HOMEBREW_PATCHED_PROTECTED_XTASK=""
HOMEBREW_PATCHED_PROTECTED_XTASK_STATE=""
HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256=""
HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR=""
HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE=""
HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256=""
HOMEBREW_PATCHED_PLATFORM_ROOT=""
HOMEBREW_PATCHED_PLATFORM_SHA256=""
HOMEBREW_PATCHED_FORMULA_TEST_ROOT=""
HOMEBREW_PATCHED_FORMULA_TEST_SHA256=""
HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE=""
HOMEBREW_PATCHED_SYSROOT_ROOT=""
HOMEBREW_PATCHED_SYSROOT_SHA256=""
HOMEBREW_PATCHED_RECIPE_RUNNER=""
HOMEBREW_PATCHED_RECIPE_RUNNER_STATE=""
HOMEBREW_PATCHED_RECIPE_RUNNER_SHA256=""
HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG=""
HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE=""
HOMEBREW_PATCHED_RECIPE_SEALED_ROOT=""
HOMEBREW_PATCHED_RECIPE_SUPERVISOR_UNIT=""
HOMEBREW_PATCHED_RECIPE_USER=""
HOMEBREW_PATCHED_RECIPE_UID=""
HOMEBREW_PATCHED_INTEGRITY_SHA256=""
HOMEBREW_PATCHED_OVERLAY_OWNER_UID=""
HOMEBREW_PATCHED_OVERLAY_SEAL_STATE=""
HOMEBREW_PATCHED_DEPENDENCY_PLAN=""
HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256=""
HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE=""
HOMEBREW_PATCHED_TIER2_ATTESTATION=""
HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256=""
HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE=""
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_PATH=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_BASENAME=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_LABEL=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_SHA256=()
declare -Ag HOMEBREW_PATCHED_CONTROL_FILE_STATE=()
HOMEBREW_PATCHED_SUDO_BIN=""
HOMEBREW_PATCHED_SYSTEMD_RUN_BIN=""
HOMEBREW_PATCHED_SYSTEMCTL_BIN=""
HOMEBREW_PATCHED_GETENT_BIN=""
HOMEBREW_PATCHED_PGREP_BIN=""
HOMEBREW_PATCHED_PKILL_BIN=""
HOMEBREW_PATCHED_BUILD_USER=""
HOMEBREW_PATCHED_BUILD_UID=""
HOMEBREW_PATCHED_SYSTEMD_SLICE=""
HOMEBREW_PATCHED_TEARDOWN_COMPLETE=0
HOMEBREW_PATCHED_NATIVE_PREFIX=""
HOMEBREW_PATCHED_NATIVE_CACHE=""
HOMEBREW_PATCHED_NATIVE_TEMP=""
HOMEBREW_PATCHED_NATIVE_CONFIG=""
HOMEBREW_PATCHED_NATIVE_HOME=""
HOMEBREW_PATCHED_NATIVE_BREW_BIN=""
HOMEBREW_PATCHED_NATIVE_RUNNER=""
HOMEBREW_PATCHED_NATIVE_SEALED=0
HOMEBREW_PATCHED_NATIVE_API_SOURCE=""
HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR=""
HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION=""
HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE=""
HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256=""
HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES=()
HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP=""
HOMEBREW_PATCHED_STAGED_INPUT_DIR=""
HOMEBREW_PATCHED_STAGED_INPUT_PATH=""

homebrew_sha256_stream() {
  local output digest
  if command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum)" || return
  else
    output="$(shasum -a 256)" || return
  fi
  digest="${output%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 2
  printf '%s\n' "$digest"
}

homebrew_patched_launcher_integrity() {
  local git_path="${HOMEBREW_GIT_PATH:-}"
  [ -n "$git_path" ] && [ -x "$git_path" ] || {
    echo "homebrew-patched-launcher: protected Git is unavailable for overlay verification" >&2
    return 2
  }
  # WHY: a missing Git checkout and a genuinely clean checkout can both feed
  # zero bytes to a hash. Preserve Git's failure status so loss of the linked
  # worktree backing metadata can never look like a valid clean overlay.
  (
    set -o pipefail
    {
      /usr/bin/env -i \
        HOME=/nonexistent PATH=/usr/bin:/bin LC_ALL=C \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 \
        "$git_path" -C "$HOMEBREW_PATCHED_OVERLAY" \
          diff --no-ext-diff --binary HEAD &&
      /usr/bin/env -i \
        HOME=/nonexistent PATH=/usr/bin:/bin LC_ALL=C \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 \
        "$git_path" -C "$HOMEBREW_PATCHED_OVERLAY" \
          status --porcelain=v1 --untracked-files=all
    } | homebrew_sha256_stream
  )
}

homebrew_patched_launcher_verify_protected_xtask() {
  if [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK" ] && \
     [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_STATE" ] && \
     [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || \
     [ "$HOMEBREW_PATCHED_PROTECTED_XTASK" != \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/xtask" ] || \
     [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_STATE" ] || \
     [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256" ]; then
    echo "homebrew-patched-launcher: protected program-index checker state is incomplete" >&2
    return 2
  fi

  local actual_sha256
  actual_sha256="$(/usr/bin/sha256sum \
    "$HOMEBREW_PATCHED_PROTECTED_XTASK" 2>/dev/null || true)"
  actual_sha256="${actual_sha256%% *}"
  if [ ! -f "$HOMEBREW_PATCHED_PROTECTED_XTASK" ] || \
     [ -L "$HOMEBREW_PATCHED_PROTECTED_XTASK" ] || \
     [ "$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' \
       "$HOMEBREW_PATCHED_PROTECTED_XTASK" 2>/dev/null || true)" != \
       "$HOMEBREW_PATCHED_PROTECTED_XTASK_STATE" ] || \
     [ "$actual_sha256" != "$HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256" ]; then
    echo "homebrew-patched-launcher: root-owned program-index checker changed after isolation" >&2
    return 1
  fi
}

homebrew_patched_launcher_verify_native_link_auditor() {
  if [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" ] && \
     [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE" ] && \
     [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || \
     [ "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" != \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/native-link-auditor" ] || \
     [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE" ] || \
     [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256" ]; then
    echo "homebrew-patched-launcher: protected native link auditor state is incomplete" >&2
    return 2
  fi

  local actual_sha256
  actual_sha256="$(
    /usr/bin/sha256sum "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" \
      2>/dev/null || true
  )"
  actual_sha256="${actual_sha256%% *}"
  if [ ! -f "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" ] || \
     [ -L "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" ] || \
     [ "$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' \
       "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" 2>/dev/null || true)" != \
       "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE" ] || \
     [ "$actual_sha256" != \
       "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256" ]; then
    echo "homebrew-patched-launcher: root-owned native link auditor changed after isolation" >&2
    return 1
  fi
}

homebrew_patched_launcher_prepare_native_link_auditor() {
  if [ "$#" -ne 3 ]; then
    echo "homebrew_patched_launcher_prepare_native_link_auditor: expected KANDELO-ROOT BUILD-USER SUDO" >&2
    return 2
  fi
  local kandelo_root="$1" build_user="$2" sudo_bin="$3"
  local source="$kandelo_root/scripts/homebrew-tap-recipe-runner.py"
  local destination source_state source_state_after source_sha source_sha_after
  local source_state_without_size source_links
  local auditor_state auditor_sha

  [ -n "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || {
    echo "homebrew-patched-launcher: protected native link auditor root is unavailable" >&2
    return 2
  }
  destination="$HOMEBREW_PATCHED_PROTECTED_DIR/native-link-auditor"
  [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" ] && \
    [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE" ] && \
    [ -z "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256" ] && \
    [ ! -e "$destination" ] && [ ! -L "$destination" ] || {
    echo "homebrew-patched-launcher: protected native link auditor state is already populated" >&2
    return 2
  }
  [ -f "$source" ] && [ ! -L "$source" ] && \
    [ "$(/usr/bin/realpath -- "$source" 2>/dev/null || true)" = "$source" ] || {
    echo "homebrew-patched-launcher: native link auditor source is unavailable" >&2
    return 2
  }
  homebrew_assert_tree_not_replaceable_by_user "$build_user" "$source" || return
  if "$sudo_bin" -n -H -u "$build_user" -- /usr/bin/test -w "$source"; then
    echo "homebrew-patched-launcher: Formula identity can change the native link auditor source" >&2
    return 2
  fi
  source_state="$(
    /usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$source"
  )" || return 2
  source_state_without_size="${source_state%:*}"
  source_links="${source_state_without_size##*:}"
  [ "$source_links" = "1" ] || {
    echo "homebrew-patched-launcher: native link auditor source is not single-linked" >&2
    return 2
  }
  source_sha="$(/usr/bin/sha256sum "$source")" || return 2
  source_sha="${source_sha%% *}"
  [[ "$source_sha" =~ ^[0-9a-f]{64}$ ]] || {
    echo "homebrew-patched-launcher: native link auditor source cannot be authenticated" >&2
    return 2
  }

  # WHY: native build tools are used by both registry-bridge and tap-native
  # Formulae. Stage their link-chain auditor independently of either recipe
  # schema so every native prefix crosses the same root-owned audit boundary.
  "$sudo_bin" /usr/bin/install -o root -g root -m 0555 -- \
    "$source" "$destination" || return
  source_state_after="$(
    /usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$source"
  )" || return 2
  source_sha_after="$(/usr/bin/sha256sum "$source")" || return 2
  source_sha_after="${source_sha_after%% *}"
  auditor_state="$(
    /usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$destination"
  )" || return 2
  auditor_sha="$(/usr/bin/sha256sum "$destination")" || return 2
  auditor_sha="${auditor_sha%% *}"
  if [ "$source_state_after" != "$source_state" ] || \
     [ "$source_sha_after" != "$source_sha" ] || \
     [ "$auditor_sha" != "$source_sha" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$destination")" != \
       "0:0:555:1" ] || \
     ! /usr/bin/cmp -s -- "$source" "$destination"; then
    echo "homebrew-patched-launcher: native link auditor changed while it was staged" >&2
    return 2
  fi

  HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR="$destination"
  HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE="$auditor_state"
  HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256="$auditor_sha"
}

homebrew_patched_launcher_sealed_directory_state() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_sealed_directory_state: expected PATH" >&2
    return 2
  fi
  local path="$1" state
  [ -d "$path" ] && [ ! -L "$path" ] || return 1
  state="$(/usr/bin/stat -c '%u:%g:%a' "$path" 2>/dev/null)" || return 1
  # WHY: a directory's link count reflects child directories on tmpfs/ext*
  # and is deliberately reported as one by some overlay filesystems. Root
  # ownership, mode, and the complete descendant manifest are the portable
  # mutation boundary; regular files remain single-link checked separately.
  [ "$state" = "0:0:555" ] || return 1
  printf '%s\n' "$state"
}

homebrew_patched_launcher_collect_sorted_find_entries() {
  if [ "$#" -lt 3 ]; then
    echo "homebrew_patched_launcher_collect_sorted_find_entries: expected ROOT ARRAY LABEL [FIND-EXPRESSION...]" >&2
    return 2
  fi
  local root="$1" array_name="$2" label="$3"
  shift 3
  local raw_file sorted_file status=0
  local -n output_entries="$array_name"
  output_entries=()
  raw_file="$(/usr/bin/mktemp /tmp/kandelo-find-raw.XXXXXX)" || return
  sorted_file="$(/usr/bin/mktemp /tmp/kandelo-find-sorted.XXXXXX)" || {
    /usr/bin/rm -f -- "$raw_file"
    return 2
  }
  # WHY: `mapfile < <(find ...)` reports only mapfile's status. Materializing
  # each phase lets a traversal or sort error reject the projection instead of
  # silently authenticating the subset produced before that error.
  if /usr/bin/find "$root" "$@" -print0 >"$raw_file"; then
    if LC_ALL=C /usr/bin/sort -z "$raw_file" >"$sorted_file"; then
      # shellcheck disable=SC2034 # writes through the caller-selected nameref
      mapfile -d '' output_entries <"$sorted_file" || status=$?
    else
      status=$?
    fi
  else
    status=$?
  fi
  if ! /usr/bin/rm -f -- "$raw_file" "$sorted_file"; then
    echo "homebrew-patched-launcher: could not remove the $label traversal inventory" >&2
    return 2
  fi
  if [ "$status" -ne 0 ]; then
    echo "homebrew-patched-launcher: could not enumerate the $label tree" >&2
    return "$status"
  fi
}

homebrew_patched_launcher_manifest_sha256() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_patched_launcher_manifest_sha256: expected MANIFEST-FUNCTION ROOT" >&2
    return 2
  fi
  local manifest_function="$1" root="$2" manifest_file digest status=0
  manifest_file="$(/usr/bin/mktemp /tmp/kandelo-manifest.XXXXXX)" || return
  if "$manifest_function" "$root" >"$manifest_file"; then
    digest="$(homebrew_sha256_stream <"$manifest_file")" || status=$?
  else
    status=$?
  fi
  if ! /usr/bin/rm -f -- "$manifest_file"; then
    echo "homebrew-patched-launcher: could not remove a projection manifest" >&2
    return 2
  fi
  [ "$status" -eq 0 ] || return "$status"
  [ -n "$digest" ] || return 2
  printf '%s\n' "$digest"
}

homebrew_patched_launcher_platform_projection_manifest() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_platform_projection_manifest: expected ROOT" >&2
    return 2
  fi
  local root="$1" entry relative digest state total_bytes=0
  local -a entries=()
  [ -d "$root" ] && [ ! -L "$root" ] || {
    echo "homebrew-patched-launcher: platform projection is not one real directory" >&2
    return 2
  }
  homebrew_patched_launcher_sealed_directory_state "$root" >/dev/null || {
    echo "homebrew-patched-launcher: platform projection root is not sealed" >&2
    return 2
  }
  homebrew_patched_launcher_collect_sorted_find_entries \
    "$root" entries "platform projection" -mindepth 1 || return
  [ "${#entries[@]}" -le 512 ] || {
    echo "homebrew-patched-launcher: platform projection exceeds the entry limit" >&2
    return 2
  }
  for entry in "${entries[@]}"; do
    relative="${entry#"$root"/}"
    [ "$relative" != "$entry" ] && [ -n "$relative" ] &&
      [[ "$relative" != *$'\n'* ]] && [[ "$relative" != *$'\t'* ]] || {
      echo "homebrew-patched-launcher: platform projection has an unsafe path" >&2
      return 2
    }
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then
      state="$(
        homebrew_patched_launcher_sealed_directory_state "$entry"
      )" || {
        echo "homebrew-patched-launcher: platform projection directory is not sealed: $relative" >&2
        return 2
      }
      printf 'd\t%s\t%s\n' "$state" "$relative"
    elif [ -f "$entry" ] && [ ! -L "$entry" ]; then
      state="$(/usr/bin/stat -c '%u:%g:%a:%h:%s' "$entry")" || return 2
      case "$state" in
        0:0:444:1:*|0:0:555:1:*) ;;
        *)
          echo "homebrew-patched-launcher: platform projection file is not sealed: $relative" >&2
          return 2
          ;;
      esac
      total_bytes=$((total_bytes + ${state##*:}))
      [ "$total_bytes" -le 134217728 ] || {
        echo "homebrew-patched-launcher: platform projection exceeds the byte limit" >&2
        return 2
      }
      digest="$(/usr/bin/sha256sum "$entry")" || return 2
      digest="${digest%% *}"
      printf 'f\t%s\t%s\t%s\n' "$state" "$digest" "$relative"
    else
      echo "homebrew-patched-launcher: platform projection contains an unsupported node: $relative" >&2
      return 2
    fi
  done
}

homebrew_patched_launcher_verify_platform_projection() {
  if [ -z "$HOMEBREW_PATCHED_PLATFORM_ROOT" ] && \
     [ -z "$HOMEBREW_PATCHED_PLATFORM_SHA256" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_PLATFORM_ROOT" ] || \
     [ -z "$HOMEBREW_PATCHED_PLATFORM_SHA256" ]; then
    echo "homebrew-patched-launcher: protected platform projection state is incomplete" >&2
    return 2
  fi
  local actual_sha256
  actual_sha256="$(
    homebrew_patched_launcher_manifest_sha256 \
      homebrew_patched_launcher_platform_projection_manifest \
      "$HOMEBREW_PATCHED_PLATFORM_ROOT"
  )" || return
  [ "$actual_sha256" = "$HOMEBREW_PATCHED_PLATFORM_SHA256" ] || {
    echo "homebrew-patched-launcher: protected platform projection changed after isolation" >&2
    return 1
  }
}

homebrew_patched_launcher_formula_test_runtime_manifest() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_formula_test_runtime_manifest: expected ROOT" >&2
    return 2
  fi
  local root="$1" checker entry relative file_bytes total_bytes=0
  local -a entries=()
  local -a required_files=(
    Cargo.toml
    package.json
    examples/run-example.ts
    examples/run-example-output.ts
    examples/run-example-paths.ts
    host/src/binary-resolver.ts
    host/src/node-kernel-host.ts
    host/wasm/kandelo-kernel.wasm
    host/wasm/program-packages.json
    node_modules/tsx/package.json
    node_modules/esbuild/package.json
    node_modules/fflate/package.json
    node_modules/fzstd/package.json
    node_modules/vite/bin/vite.js
    node_modules/vite/package.json
  )
  local -a required_directories=(
    .ci-test-binary-cache/programs
    binaries
    host/src
    host/wasm
    node_modules/@esbuild
  )
  [ "$root" = "$HOMEBREW_PATCHED_PROTECTED_DIR/formula-test-runtime" ] || {
    echo "homebrew-patched-launcher: Formula test runtime left its protected root" >&2
    return 2
  }
  homebrew_patched_launcher_collect_sorted_find_entries \
    "$root" entries "Formula test runtime" -mindepth 1 || return
  [ "${#entries[@]}" -le 65536 ] || {
    echo "homebrew-patched-launcher: Formula test runtime exceeds the entry limit" >&2
    return 2
  }
  for entry in "${entries[@]}"; do
    relative="${entry#"$root"/}"
    if [[ "$relative" != */* ]]; then
      case "$relative" in
        .ci-test-binary-cache|Cargo.toml|binaries|crates|examples|host|libc|\
          node_modules|package.json|scripts|sdk|target|tools) ;;
        *)
          echo "homebrew-patched-launcher: Formula test runtime exposes an undeclared top-level input: $relative" >&2
          return 2
          ;;
      esac
    fi
    if [ -f "$entry" ] && [ ! -L "$entry" ]; then
      file_bytes="$(/usr/bin/stat -c '%s' "$entry")" || return 2
      [[ "$file_bytes" =~ ^[0-9]+$ ]] &&
        [ "$file_bytes" -le 268435456 ] || {
        echo "homebrew-patched-launcher: Formula test runtime file exceeds the byte limit" >&2
        return 2
      }
      total_bytes=$((total_bytes + file_bytes))
      [ "$total_bytes" -le 536870912 ] || {
        echo "homebrew-patched-launcher: Formula test runtime exceeds the byte limit" >&2
        return 2
      }
    fi
  done
  for checker in "${required_files[@]}"; do
    [ -f "$root/$checker" ] && [ ! -L "$root/$checker" ] || {
      echo "homebrew-patched-launcher: Formula test runtime lacks required file: $checker" >&2
      return 2
    }
  done
  for checker in "${required_directories[@]}"; do
    [ -d "$root/$checker" ] && [ ! -L "$root/$checker" ] || {
      echo "homebrew-patched-launcher: Formula test runtime lacks required directory: $checker" >&2
      return 2
    }
  done
  for checker in .git Cargo.lock package-lock.json packages local-binaries \
    target/.rustc_info.json tools/xtask scripts/dev-shell.sh \
    scripts/install-local-binary.sh; do
    if [ -e "$root/$checker" ] || [ -L "$root/$checker" ]; then
      echo "homebrew-patched-launcher: Formula test runtime exposes undeclared checkout authority: $checker" >&2
      return 2
    fi
  done
  checker="$root/$HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE"
  [ -n "$HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE" ] &&
    [[ "$HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE" =~ ^target/[A-Za-z0-9_.+-]+/release/xtask$ ]] &&
    [ -f "$checker" ] && [ ! -L "$checker" ] &&
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$checker" 2>/dev/null)" = \
      "0:0:555:1" ] || {
    echo "homebrew-patched-launcher: Formula test runtime checker is invalid" >&2
    return 2
  }
  for entry in "${entries[@]}"; do
    relative="${entry#"$root"/}"
    case "$relative" in
      target|target/"${HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE#target/}"|\
        "${HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE%/*}"|\
        "${HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE%/release/xtask}") ;;
      target/*)
        echo "homebrew-patched-launcher: Formula test runtime target tree contains undeclared state: $relative" >&2
        return 2
        ;;
    esac
  done
  # WHY: binaries/ intentionally contains relative links into the transported
  # sibling cache. Revalidate every hop as part of the authenticated manifest;
  # a digest alone would faithfully authenticate an escaping link.
  homebrew_assert_tree_symlinks_contained \
    "$root" "Formula test runtime" || return
  homebrew_patched_launcher_sysroot_projection_manifest "$root"
}

homebrew_patched_launcher_verify_formula_test_runtime() {
  if [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_ROOT" ] && \
     [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_SHA256" ] && \
     [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_ROOT" ] || \
     [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_SHA256" ] || \
     [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE" ]; then
    echo "homebrew-patched-launcher: protected Formula test runtime state is incomplete" >&2
    return 2
  fi
  local actual_sha256
  actual_sha256="$(
    homebrew_patched_launcher_manifest_sha256 \
      homebrew_patched_launcher_formula_test_runtime_manifest \
      "$HOMEBREW_PATCHED_FORMULA_TEST_ROOT"
  )" || return
  [ "$actual_sha256" = "$HOMEBREW_PATCHED_FORMULA_TEST_SHA256" ] || {
    echo "homebrew-patched-launcher: protected Formula test runtime changed after isolation" >&2
    return 1
  }
}

homebrew_patched_launcher_sysroot_projection_manifest() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_sysroot_projection_manifest: expected ROOT" >&2
    return 2
  fi
  local root="$1" entry relative digest state target file_bytes total_bytes=0
  local -a entries=()
  [ -d "$root" ] && [ ! -L "$root" ] || {
    echo "homebrew-patched-launcher: sysroot projection is not one real directory" >&2
    return 2
  }
  homebrew_patched_launcher_sealed_directory_state "$root" >/dev/null || {
    echo "homebrew-patched-launcher: sysroot projection root is not sealed" >&2
    return 2
  }
  homebrew_patched_launcher_collect_sorted_find_entries \
    "$root" entries "sysroot projection" -mindepth 1 || return
  [ "${#entries[@]}" -le 65536 ] || {
    echo "homebrew-patched-launcher: sysroot projection exceeds the entry limit" >&2
    return 2
  }
  for entry in "${entries[@]}"; do
    relative="${entry#"$root"/}"
    [ "$relative" != "$entry" ] && [ -n "$relative" ] &&
      [[ "$relative" != *$'\n'* ]] && [[ "$relative" != *$'\t'* ]] || {
      echo "homebrew-patched-launcher: sysroot projection has an unsafe path" >&2
      return 2
    }
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then
      state="$(
        homebrew_patched_launcher_sealed_directory_state "$entry"
      )" || {
        echo "homebrew-patched-launcher: sysroot projection directory is not sealed: $relative" >&2
        return 2
      }
      printf 'd\t%s\t%s\n' "$state" "$relative"
    elif [ -f "$entry" ] && [ ! -L "$entry" ]; then
      state="$(/usr/bin/stat -c '%u:%g:%a:%h:%s' "$entry")" || return 2
      case "$state" in
        0:0:444:1:*|0:0:555:1:*) ;;
        *)
          echo "homebrew-patched-launcher: sysroot projection file is not sealed: $relative" >&2
          return 2
          ;;
      esac
      file_bytes="${state##*:}"
      [[ "$file_bytes" =~ ^[0-9]+$ ]] &&
        [ "$file_bytes" -le 1073741824 ] || {
        echo "homebrew-patched-launcher: sysroot projection file exceeds the byte limit: $relative" >&2
        return 2
      }
      total_bytes=$((total_bytes + file_bytes))
      [ "$total_bytes" -le 2147483648 ] || {
        echo "homebrew-patched-launcher: sysroot projection exceeds the byte limit" >&2
        return 2
      }
      digest="$(/usr/bin/sha256sum "$entry")" || return 2
      digest="${digest%% *}"
      printf 'f\t%s\t%s\t%s\n' "$state" "$digest" "$relative"
    elif [ -L "$entry" ]; then
      state="$(/usr/bin/stat -c '%u:%g:%h' "$entry")" || return 2
      [ "$state" = "0:0:1" ] || {
        echo "homebrew-patched-launcher: sysroot projection symlink is not sealed: $relative" >&2
        return 2
      }
      target="$(/usr/bin/readlink -- "$entry")" || return 2
      [ -n "$target" ] && [[ "$target" != /* ]] &&
        [[ "$target" != *$'\n'* ]] && [[ "$target" != *$'\t'* ]] || {
        echo "homebrew-patched-launcher: sysroot projection has an unsafe symlink: $relative" >&2
        return 2
      }
      printf 'l\t%s\t%s\t%s\n' "$state" "$target" "$relative"
    else
      echo "homebrew-patched-launcher: sysroot projection contains an unsupported node: $relative" >&2
      return 2
    fi
  done
}

homebrew_patched_launcher_verify_sysroot_projection() {
  if [ -z "$HOMEBREW_PATCHED_SYSROOT_ROOT" ] && \
     [ -z "$HOMEBREW_PATCHED_SYSROOT_SHA256" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_SYSROOT_ROOT" ] || \
     [ -z "$HOMEBREW_PATCHED_SYSROOT_SHA256" ]; then
    echo "homebrew-patched-launcher: protected sysroot projection state is incomplete" >&2
    return 2
  fi
  local actual_sha256
  actual_sha256="$(
    homebrew_patched_launcher_manifest_sha256 \
      homebrew_patched_launcher_sysroot_projection_manifest \
      "$HOMEBREW_PATCHED_SYSROOT_ROOT"
  )" || return
  [ "$actual_sha256" = "$HOMEBREW_PATCHED_SYSROOT_SHA256" ] || {
    echo "homebrew-patched-launcher: protected sysroot projection changed after isolation" >&2
    return 1
  }
}

homebrew_patched_launcher_verify_recipe_runner() {
  if [ -z "$HOMEBREW_PATCHED_RECIPE_RUNNER" ] && \
     [ -z "$HOMEBREW_PATCHED_RECIPE_RUNNER_STATE" ] && \
     [ -z "$HOMEBREW_PATCHED_RECIPE_RUNNER_SHA256" ] && \
     [ -z "$HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG" ] && \
     [ -z "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE" ] && \
     [ -z "$HOMEBREW_PATCHED_RECIPE_SEALED_ROOT" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || \
     [ "$HOMEBREW_PATCHED_RECIPE_RUNNER" != \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/homebrew-tap-recipe-runner" ] || \
     [ "$HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG" != \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/runner-config.json" ] || \
     [ "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE" != \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/native-closure.json" ] || \
     [ "$HOMEBREW_PATCHED_RECIPE_SEALED_ROOT" != \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/sealed-outputs" ] || \
     [ -z "$HOMEBREW_PATCHED_RECIPE_RUNNER_STATE" ] || \
     [ -z "$HOMEBREW_PATCHED_RECIPE_RUNNER_SHA256" ]; then
    echo "homebrew-patched-launcher: protected recipe runner state is incomplete" >&2
    return 2
  fi

  local actual_sha256
  actual_sha256="$(
    /usr/bin/sha256sum "$HOMEBREW_PATCHED_RECIPE_RUNNER" 2>/dev/null || true
  )"
  actual_sha256="${actual_sha256%% *}"
  if [ "$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' \
       "$HOMEBREW_PATCHED_RECIPE_RUNNER" 2>/dev/null || true)" != \
       "$HOMEBREW_PATCHED_RECIPE_RUNNER_STATE" ] || \
     [ "$actual_sha256" != "$HOMEBREW_PATCHED_RECIPE_RUNNER_SHA256" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' \
       "$HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG" 2>/dev/null || true)" != \
       "0:0:400:1" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/recipe-passwd" 2>/dev/null || true)" != \
       "0:0:444:1" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' \
       "$HOMEBREW_PATCHED_PROTECTED_DIR/recipe-group" 2>/dev/null || true)" != \
       "0:0:444:1" ] || \
     {
       if [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ]; then
         [ "$(/usr/bin/stat -c '%u:%g:%a:%h' \
           "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE" 2>/dev/null || true)" != \
           "0:0:400:1" ]
       else
         [ -e "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE" ] || \
           [ -L "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE" ]
       fi
     } || \
     ! homebrew_patched_launcher_sealed_directory_state \
       "$HOMEBREW_PATCHED_RECIPE_SEALED_ROOT" >/dev/null 2>&1; then
    echo "homebrew-patched-launcher: protected recipe runner boundary changed" >&2
    return 1
  fi
}

homebrew_patched_launcher_admit_recipe_runner_source() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_admit_recipe_runner_source: expected PLATFORM-ROOT" >&2
    return 2
  fi
  local platform_root="$1"
  local source="$platform_root/scripts/homebrew-tap-recipe-runner.py"
  local source_sha
  # WHY: this Python program runs as root before any tap recipe is admitted.
  # Select it only from the exact root-owned platform projection whose complete
  # manifest was sealed by the launcher; a checkout path supplied separately
  # would reintroduce mutable workflow state as privileged code authority.
  if [ -z "$HOMEBREW_PATCHED_PLATFORM_ROOT" ] || \
     [ "$platform_root" != "$HOMEBREW_PATCHED_PLATFORM_ROOT" ]; then
    echo "homebrew-patched-launcher: tap recipe runner source is outside the sealed platform projection" >&2
    return 2
  fi
  homebrew_patched_launcher_verify_platform_projection || return
  if [ ! -f "$source" ] || [ -L "$source" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$source" \
       2>/dev/null || true)" != "0:0:444:1" ]; then
    echo "homebrew-patched-launcher: trusted tap recipe runner source is not sealed" >&2
    return 2
  fi
  source_sha="$(/usr/bin/sha256sum "$source" 2>/dev/null || true)"
  source_sha="${source_sha%% *}"
  if ! [[ "$source_sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "homebrew-patched-launcher: trusted tap recipe runner source cannot be authenticated" >&2
    return 2
  fi
  printf '%s\n' "$source"
}

homebrew_patched_launcher_prepare_recipe_runner() {
  if [ "$#" -ne 15 ]; then
    echo "homebrew_patched_launcher_prepare_recipe_runner: expected BUILD-USER BUILD-GROUP RECIPE-USER PRIMARY-TAP PLATFORM-HOST PLATFORM-ALIAS SYSROOT-HOST SYSROOT-ALIAS ALLOWED-REQUEST-ROOT SYSTEMD-SLICE UNIT-PREFIX SUDO SYSTEMD-RUN JQ NODE" >&2
    return 2
  fi
  local build_user="$1" build_group="$2" recipe_user="$3" primary_tap_root="$4"
  local platform_host_root="$5" platform_alias_root="$6"
  local sysroot_host_root="$7" sysroot_alias_root="$8" allowed_request_root="$9"
  local systemd_slice="${10}" unit_prefix="${11}" sudo_bin="${12}"
  local systemd_run_bin="${13}" jq_bin="${14}" node_bin="${15}"
  local runner_source
  local runner="$HOMEBREW_PATCHED_PROTECTED_DIR/homebrew-tap-recipe-runner"
  local config="$HOMEBREW_PATCHED_PROTECTED_DIR/runner-config.json"
  local passwd_file="$HOMEBREW_PATCHED_PROTECTED_DIR/recipe-passwd"
  local group_file="$HOMEBREW_PATCHED_PROTECTED_DIR/recipe-group"
  local sealed_root="$HOMEBREW_PATCHED_PROTECTED_DIR/sealed-outputs"
  local native_closure="$HOMEBREW_PATCHED_PROTECTED_DIR/native-closure.json"
  # WHY: the protected directory retains the full 64-hex build identity.
  # `/s` keeps the resulting pathname within Linux sockaddr_un.sun_path.
  local socket_path="$HOMEBREW_PATCHED_PROTECTED_DIR/s"
  local formula manifest_sha256 recipe_host_root recipe_alias_root recipe_entrypoint
  local build_uid build_gid recipe_uid recipe_gid llvm_bin supervisor_unit
  local runner_source_sha runner_source_sha_after
  local runner_source_state runner_source_state_after
  local runner_sha runner_sha_after runner_state attempt socket_state
  local supervisor_state

  runner_source="$(
    homebrew_patched_launcher_admit_recipe_runner_source "$platform_host_root"
  )" || return
  runner_source_state="$(
    /usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$runner_source"
  )" || return
  runner_source_sha="$(/usr/bin/sha256sum "$runner_source")" || return
  runner_source_sha="${runner_source_sha%% *}"
  build_uid="$(/usr/bin/id -u "$build_user")" || return
  build_gid="$(/usr/bin/id -g "$build_user")" || return
  recipe_uid="$(/usr/bin/id -u "$recipe_user")" || return
  recipe_gid="$(/usr/bin/id -g "$recipe_user")" || return
  if [ "$recipe_user" != "kandelo-homebrew-recipe" ] || \
     [ "$build_uid" = "$recipe_uid" ] || [ "$recipe_uid" = "0" ] || \
     [ "$recipe_uid" = "$(/usr/bin/id -u)" ]; then
    echo "homebrew-patched-launcher: tap recipe identity is not isolated" >&2
    return 2
  fi
  formula="$("$jq_bin" -er '.formula' "$HOMEBREW_PATCHED_TIER2_ATTESTATION")" ||
    return
  manifest_sha256="$(
    "$jq_bin" -er '.tap_recipe.manifest_sha256' \
      "$HOMEBREW_PATCHED_TIER2_ATTESTATION"
  )" || return
  recipe_alias_root="$primary_tap_root/Kandelo/recipes/$formula"
  recipe_host_root="$HOMEBREW_PATCHED_PROTECTED_DIR/selected-recipe"
  [ -d "$recipe_alias_root" ] && [ ! -L "$recipe_alias_root" ] || {
    echo "homebrew-patched-launcher: selected tap recipe root is unavailable" >&2
    return 2
  }
  recipe_entrypoint="$recipe_alias_root/$(
    "$jq_bin" -er '.tap_recipe.entrypoint' \
      "$HOMEBREW_PATCHED_TIER2_ATTESTATION"
  )" || return
  llvm_bin="${HOMEBREW_KANDELO_LLVM_BIN:-${LLVM_BIN:-${WASM_POSIX_LLVM_DIR:-}}}"
  [ -d "$llvm_bin" ] && [ ! -L "$llvm_bin" ] || {
    echo "homebrew-patched-launcher: protected LLVM directory is unavailable" >&2
    return 2
  }
  [ -f "$node_bin" ] && [ ! -L "$node_bin" ] && [ -x "$node_bin" ] || {
    echo "homebrew-patched-launcher: protected Node executable is unavailable" >&2
    return 2
  }

  [ ! -e "$runner" ] && [ ! -L "$runner" ] || {
    echo "homebrew-patched-launcher: protected tap recipe runner destination is occupied" >&2
    return 2
  }
  "$sudo_bin" /usr/bin/install -o root -g root -m 0555 -- \
    "$runner_source" "$runner" || return
  runner_source_state_after="$(
    /usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$runner_source"
  )" || return
  runner_source_sha_after="$(/usr/bin/sha256sum "$runner_source")" || return
  runner_source_sha_after="${runner_source_sha_after%% *}"
  runner_state="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$runner")" ||
    return
  runner_sha="$(/usr/bin/sha256sum "$runner")" || return
  runner_sha="${runner_sha%% *}"
  if [ "$runner_source_state_after" != "$runner_source_state" ] || \
     [ "$runner_source_sha_after" != "$runner_source_sha" ] || \
     [ "$runner_sha" != "$runner_source_sha" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$runner")" != "0:0:555:1" ] || \
     ! /usr/bin/cmp -s -- "$runner_source" "$runner"; then
    echo "homebrew-patched-launcher: trusted tap recipe runner changed while it was staged" >&2
    return 2
  fi
  homebrew_patched_launcher_prepare_sysroot_projection \
    "$sysroot_host_root" "$HOMEBREW_PATCHED_PROTECTED_DIR/sysroot" \
    "$runner" "$platform_host_root" "$sudo_bin" || return
  sysroot_host_root="$HOMEBREW_PATCHED_SYSROOT_ROOT"
  # WHY: Formula validation must see the same path it normally uses, but the
  # privileged runner must not trust or expose the mutable tap checkout. Copy
  # only the manifest-closed selected recipe, then bind that projection over
  # the original alias inside the isolated recipe service.
  "$sudo_bin" -n -- /usr/bin/env -i /usr/bin/python3 -I "$runner" \
    --stage-recipe \
    --source "$recipe_alias_root" \
    --destination "$recipe_host_root" \
    --formula "$formula" \
    --manifest-sha256 "$manifest_sha256" || return
  printf 'root:x:0:0:root:/root:/usr/sbin/nologin\n%s:x:%s:%s:Kandelo recipe:%s:/usr/sbin/nologin\n' \
    "$recipe_user" "$recipe_uid" "$recipe_gid" \
    "$HOMEBREW_PATCHED_PROTECTED_DIR/recipe-home" |
    "$sudo_bin" -n -- /usr/bin/tee "$passwd_file" >/dev/null || return
  printf 'root:x:0:\n%s:x:%s:\n' "$recipe_user" "$recipe_gid" |
    "$sudo_bin" -n -- /usr/bin/tee "$group_file" >/dev/null || return
  "$sudo_bin" -n -- /usr/bin/chown root:root "$passwd_file" "$group_file" ||
    return
  "$sudo_bin" -n -- /usr/bin/chmod 0444 "$passwd_file" "$group_file" ||
    return
  "$sudo_bin" /usr/bin/install -d -o root -g root -m 0555 "$sealed_root" ||
    return
  "$jq_bin" -cSjn \
    --arg allowed_request_root "$allowed_request_root" \
    --arg arch "${KANDELO_HOMEBREW_ARCH:-}" \
    --argjson build_gid "$build_gid" \
    --argjson build_uid "$build_uid" \
    --arg build_user "$build_user" \
    --arg group_file "$group_file" \
    --arg llvm_bin "$llvm_bin" \
    --arg native_cellar "$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar" \
    --arg native_closure_manifest "$native_closure" \
    --arg node_bin "$node_bin" \
    --arg platform_alias_root "$platform_alias_root" \
    --arg platform_host_root "$platform_host_root" \
    --arg passwd_file "$passwd_file" \
    --arg protected_root "$HOMEBREW_PATCHED_PROTECTED_DIR" \
    --arg recipe_alias_root "$recipe_alias_root" \
    --arg recipe_entrypoint "$recipe_entrypoint" \
    --argjson recipe_gid "$recipe_gid" \
    --arg recipe_host_root "$recipe_host_root" \
    --argjson recipe_uid "$recipe_uid" \
    --arg recipe_user "$recipe_user" \
    --arg sealed_root "$sealed_root" \
    --arg slice "$systemd_slice" \
    --arg sysroot_alias_root "$sysroot_alias_root" \
    --arg sysroot_host_root "$sysroot_host_root" \
    --arg target_cellar "$HOMEBREW_PATCHED_PREFIX/Cellar" \
    --arg unit_prefix "$unit_prefix" \
    --slurpfile attestation "$HOMEBREW_PATCHED_TIER2_ATTESTATION" \
    --slurpfile host_plan "$HOMEBREW_PATCHED_DEPENDENCY_PLAN" '
      ($attestation[0]) as $a |
      ($host_plan[0]) as $h |
      ($h.native_requirements | map(.formula) | sort | unique) as $requirements |
      {
        allowed_request_root: $allowed_request_root,
        arch: $arch,
        build_gid: $build_gid,
        build_uid: $build_uid,
        build_user: $build_user,
        dependencies: $a.tap_recipe.dependencies,
        formula: $a.full_name,
        group_file: $group_file,
        llvm_bin: $llvm_bin,
        manifest_sha256: $a.tap_recipe.manifest_sha256,
        native_cellar: $native_cellar,
        native_closure_manifest: $native_closure_manifest,
        native_formulae: (($h.build_and_test - $requirements) | sort | unique),
        native_requirement_formulae: $requirements,
        node_bin: $node_bin,
        platform_alias_root: $platform_alias_root,
        platform_host_root: $platform_host_root,
        passwd_file: $passwd_file,
        protected_root: $protected_root,
        recipe_alias_root: $recipe_alias_root,
        recipe_entrypoint: $recipe_entrypoint,
        recipe_gid: $recipe_gid,
        recipe_host_root: $recipe_host_root,
        recipe_uid: $recipe_uid,
        recipe_user: $recipe_user,
        resources: $a.tap_recipe.resources,
        script_env_keys: $a.tap_recipe.script_env_keys,
        sealed_root: $sealed_root,
        slice: $slice,
        source_sha256: $a.tap_recipe.source_sha256,
        source_url: $a.tap_recipe.source_url,
        sysroot_alias_root: $sysroot_alias_root,
        sysroot_host_root: $sysroot_host_root,
        target_cellar: $target_cellar,
        unit_prefix: $unit_prefix,
        version: $a.tap_recipe.version
      }
    ' |
    "$sudo_bin" -n -- /usr/bin/tee "$config" >/dev/null || return
  "$sudo_bin" /usr/bin/chown root:root "$config" || return
  "$sudo_bin" /usr/bin/chmod 0400 "$config" || return
  runner_sha_after="$(/usr/bin/sha256sum "$runner")" || return
  runner_sha_after="${runner_sha_after%% *}"
  if [ "$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$runner")" != \
       "$runner_state" ] || [ "$runner_sha_after" != "$runner_sha" ]; then
    echo "homebrew-patched-launcher: protected tap recipe runner is not sealed" >&2
    return 2
  fi

  HOMEBREW_PATCHED_RECIPE_RUNNER="$runner"
  HOMEBREW_PATCHED_RECIPE_RUNNER_STATE="$runner_state"
  HOMEBREW_PATCHED_RECIPE_RUNNER_SHA256="$runner_sha"
  HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG="$config"
  HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE="$native_closure"
  HOMEBREW_PATCHED_RECIPE_SEALED_ROOT="$sealed_root"
  HOMEBREW_PATCHED_RECIPE_USER="$recipe_user"
  HOMEBREW_PATCHED_RECIPE_UID="$recipe_uid"
  supervisor_unit="$unit_prefix-recipe-supervisor.service"
  HOMEBREW_PATCHED_RECIPE_SUPERVISOR_UNIT="$supervisor_unit"
  "$sudo_bin" /usr/bin/chmod 0555 "$HOMEBREW_PATCHED_PROTECTED_DIR" ||
    return

  # WHY: Formula execution retains NoNewPrivileges. A root-owned supervisor
  # created before that boundary accepts one peer-credential-authenticated
  # request, then closes its socket. It receives no workflow environment or
  # publisher credentials.
  # WHY: `ProtectHome=yes` makes nested bind destinations inaccessible.
  # `tmpfs` still hides every home directory by default while allowing only
  # the explicitly bound publisher roots below to reappear.
  "$sudo_bin" -n -- "$systemd_run_bin" --quiet --collect \
    "--unit=$supervisor_unit" "--slice=$systemd_slice" \
    "--property=KillMode=control-group" "--property=SendSIGKILL=yes" \
    "--property=TimeoutStopSec=10s" "--property=RuntimeMaxSec=7500s" \
    "--property=NoNewPrivileges=yes" \
    "--property=PrivateNetwork=yes" "--property=PrivateDevices=yes" \
    "--property=PrivateIPC=yes" \
    "--property=RestrictAddressFamilies=AF_UNIX" \
    "--property=ProtectSystem=strict" "--property=ProtectHome=tmpfs" \
    "--property=ProtectKernelTunables=yes" \
    "--property=ProtectKernelModules=yes" \
    "--property=ProtectControlGroups=yes" \
    "--property=ProtectKernelLogs=yes" "--property=ProtectClock=yes" \
    "--property=ProtectHostname=yes" \
    "--property=RestrictSUIDSGID=yes" "--property=RestrictRealtime=yes" \
    "--property=RestrictNamespaces=yes" "--property=LockPersonality=yes" \
    "--property=KeyringMode=private" "--property=RemoveIPC=yes" \
    "--property=SupplementaryGroups=" "--property=UMask=0022" \
    "--property=CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL" \
    "--property=AmbientCapabilities=" \
    "--property=BindPaths=$allowed_request_root" \
    "--property=ReadWritePaths=$allowed_request_root" \
    "--property=ReadWritePaths=$HOMEBREW_PATCHED_PROTECTED_DIR" \
    "--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar" \
    "--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_PREFIX/Cellar" \
    "--property=BindReadOnlyPaths=$platform_host_root" \
    "--property=BindReadOnlyPaths=$sysroot_host_root" \
    "--property=BindReadOnlyPaths=$llvm_bin" \
    "--property=BindReadOnlyPaths=${node_bin%/*}" \
    --service-type=exec --expand-environment=no -- \
    /usr/bin/env -i /usr/bin/python3 -I "$runner" --supervisor || return
  for ((attempt = 0; attempt < 600; attempt++)); do
    if [ -S "$socket_path" ]; then
      socket_state="$(/usr/bin/stat -c '%u:%g:%a' "$socket_path")" || return
      [ "$socket_state" = "$build_uid:$build_gid:600" ] || {
        echo "homebrew-patched-launcher: recipe supervisor socket has unsafe access" >&2
        return 2
      }
      return 0
    fi
    if (( attempt % 20 == 19 )); then
      supervisor_state="$(
        "$sudo_bin" -n -- "$systemctl_bin" show \
          --property=ActiveState --value "$supervisor_unit" 2>/dev/null
      )" || supervisor_state=""
      case "$supervisor_state" in
        failed|inactive) break ;;
      esac
    fi
    sleep 0.05
  done
  echo "homebrew-patched-launcher: recipe supervisor did not become ready" >&2
  # The supervisor receives an empty environment and no publisher credential,
  # so its bounded service status and journal are safe diagnostic evidence.
  "$sudo_bin" -n -- "$systemctl_bin" status --no-pager --full \
    "$supervisor_unit" >&2 || true
  "$sudo_bin" -n -- /usr/bin/journalctl --no-pager --quiet \
    --unit "$supervisor_unit" --lines 100 >&2 || true
  return 1
}

homebrew_patched_launcher_prepare_platform_projection() {
  if [ "$#" -ne 3 ]; then
    echo "homebrew_patched_launcher_prepare_platform_projection: expected KANDELO-ROOT DESTINATION SUDO" >&2
    return 2
  fi
  local kandelo_root="$1" destination="$2" sudo_bin="$3"
  local source entry relative parent source_state source_state_after mode digest
  local -a roots=(
    sdk/activate.sh
    sdk/bin
    sdk/src
    sdk/config.site
    sdk/package.json
    libc/glue
    scripts/run-wasm-fork-instrument.sh
    scripts/run-wasm-local-root-spill.sh
    scripts/wasm-artifact-guards.sh
    scripts/homebrew-tap-recipe-runner.py
    tools/bin/wasm-fork-instrument
    tools/bin/wasm-local-root-spill
    crates/shared/src/lib.rs
  )
  local -a entries=() projection_directories=()

  [ -d "$kandelo_root" ] && [ ! -L "$kandelo_root" ] || {
    echo "homebrew-patched-launcher: Kandelo platform source is not one real directory" >&2
    return 2
  }
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || {
    echo "homebrew-patched-launcher: platform projection destination is occupied" >&2
    return 2
  }
  "$sudo_bin" /usr/bin/install -d -o root -g root -m 0755 "$destination"
  for relative in "${roots[@]}"; do
    source="$kandelo_root/$relative"
    if [ -d "$source" ] && [ ! -L "$source" ]; then
      homebrew_patched_launcher_collect_sorted_find_entries \
        "$source" entries "platform input $relative" || return
    elif [ -f "$source" ] && [ ! -L "$source" ]; then
      entries=("$source")
    else
      echo "homebrew-patched-launcher: required platform input is unavailable: $relative" >&2
      return 2
    fi
    for entry in "${entries[@]}"; do
      relative="${entry#"$kandelo_root"/}"
      [ "$relative" != "$entry" ] && [ -n "$relative" ] || return 2
      if [ -d "$entry" ] && [ ! -L "$entry" ]; then
        "$sudo_bin" /usr/bin/install -d -o root -g root -m 0755 \
          "$destination/$relative"
        continue
      fi
      if [ ! -f "$entry" ] || [ -L "$entry" ]; then
        echo "homebrew-patched-launcher: platform input contains an unsupported node: $relative" >&2
        return 2
      fi
      source_state="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$entry")" ||
        return 2
      [ "${source_state#*:*:*:*:*:}" = "1:${source_state##*:}" ] || {
        echo "homebrew-patched-launcher: platform input file is not single-linked: $relative" >&2
        return 2
      }
      parent="${destination}/${relative%/*}"
      "$sudo_bin" /usr/bin/install -d -o root -g root -m 0555 "$parent"
      if [ -x "$entry" ]; then mode=0555; else mode=0444; fi
      "$sudo_bin" /usr/bin/install -o root -g root -m "$mode" -- \
        "$entry" "$destination/$relative" || return
      source_state_after="$(
        /usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$entry"
      )" || return 2
      [ "$source_state_after" = "$source_state" ] &&
        /usr/bin/cmp -s -- "$entry" "$destination/$relative" || {
        echo "homebrew-patched-launcher: platform input changed while it was staged: $relative" >&2
        return 2
      }
    done
  done
  # WHY: GNU install applies -m only to the final path component and creates
  # missing ancestors as 0755. Build the root-owned tree first, then seal every
  # directory together so path depth cannot change the projection contract.
  homebrew_patched_launcher_collect_sorted_find_entries \
    "$destination" projection_directories "platform projection directories" \
    -type d || return
  for entry in "${projection_directories[@]}"; do
    "$sudo_bin" /usr/bin/chown root:root "$entry" || return
    "$sudo_bin" /usr/bin/chmod 0555 "$entry" || return
  done
  digest="$(
    homebrew_patched_launcher_manifest_sha256 \
      homebrew_patched_launcher_platform_projection_manifest "$destination"
  )" || return
  [ -n "$digest" ] || return 2
  HOMEBREW_PATCHED_PLATFORM_ROOT="$destination"
  HOMEBREW_PATCHED_PLATFORM_SHA256="$digest"
}

homebrew_patched_launcher_prepare_formula_test_runtime() {
  if [ "$#" -ne 7 ]; then
    echo "homebrew_patched_launcher_prepare_formula_test_runtime: expected KANDELO-ROOT DESTINATION PLATFORM CHECKER CHECKER-RELATIVE PROGRAM-INDEX SUDO" >&2
    return 2
  fi
  local kandelo_root="$1" destination="$2" platform_root="$3" checker="$4"
  local checker_relative="$5" program_index="$6" sudo_bin="$7"
  local admitted_runner stager runner_sha admitted_sha digest status=0

  [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_ROOT" ] &&
    [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_SHA256" ] &&
    [ -z "$HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE" ] || {
    echo "homebrew-patched-launcher: Formula test runtime state is already populated" >&2
    return 2
  }
  [ -n "$HOMEBREW_PATCHED_PROTECTED_DIR" ] &&
    [ "$destination" = \
      "$HOMEBREW_PATCHED_PROTECTED_DIR/formula-test-runtime" ] &&
    [ "$platform_root" = "$HOMEBREW_PATCHED_PLATFORM_ROOT" ] &&
    [ "$checker" = "$HOMEBREW_PATCHED_PROTECTED_XTASK" ] || {
    echo "homebrew-patched-launcher: Formula test runtime inputs left the protected boundary" >&2
    return 2
  }
  [[ "$checker_relative" =~ ^target/[A-Za-z0-9_.+-]+/release/xtask$ ]] || {
    echo "homebrew-patched-launcher: Formula test checker path is invalid" >&2
    return 2
  }
  [ "$program_index" = \
      "$kandelo_root/${checker_relative%/xtask}/formula-test-program-packages.json" ] &&
    [ -f "$program_index" ] && [ ! -L "$program_index" ] &&
    [ "$(/usr/bin/realpath -- "$program_index")" = "$program_index" ] || {
    echo "homebrew-patched-launcher: Formula test program projection is invalid" >&2
    return 2
  }
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || {
    echo "homebrew-patched-launcher: Formula test runtime destination is occupied" >&2
    return 2
  }
  admitted_runner="$(
    homebrew_patched_launcher_admit_recipe_runner_source "$platform_root"
  )" || return
  stager="$HOMEBREW_PATCHED_PROTECTED_DIR/formula-test-runtime-stager"
  [ ! -e "$stager" ] && [ ! -L "$stager" ] || {
    echo "homebrew-patched-launcher: Formula test runtime stager destination is occupied" >&2
    return 2
  }
  "$sudo_bin" -n -- /usr/bin/install -o root -g root -m 0555 -- \
    "$admitted_runner" "$stager" || return
  runner_sha="$(/usr/bin/sha256sum "$stager" 2>/dev/null || true)"
  runner_sha="${runner_sha%% *}"
  admitted_sha="$(/usr/bin/sha256sum "$admitted_runner" 2>/dev/null || true)"
  admitted_sha="${admitted_sha%% *}"
  if [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$stager" 2>/dev/null || true)" != \
       "0:0:555:1" ] || [ "$runner_sha" != "$admitted_sha" ] || \
     ! /usr/bin/cmp -s -- "$admitted_runner" "$stager"; then
    echo "homebrew-patched-launcher: Formula test runtime stager is not the admitted protected program" >&2
    "$sudo_bin" -n -- /usr/bin/rm -f -- "$stager" || true
    return 2
  fi

  # WHY: Formula builds retain the minimal SDK projection. Node execution is a
  # different boundary: tests need the reviewed host source, loader packages,
  # exact kernel, checker, and portable package generations. The privileged
  # stager selects only that fixed closure, authenticates stable pre/post
  # source identities, and publishes it atomically without exposing source
  # recipes, build scripts, or the workflow-owned checkout. The host's bundled
  # program index is generated from only the physical package generations
  # staged for this runtime; it is inert identity, not registry execution
  # authority.
  if "$sudo_bin" -n -- /usr/bin/env -i /usr/bin/python3 -I "$stager" \
      --stage-formula-test-runtime \
      --source "$kandelo_root" \
      --platform "$platform_root" \
      --checker "$checker" \
      --checker-relative "$checker_relative" \
      --program-index "$program_index" \
      --destination "$destination"; then
    :
  else
    status=$?
  fi
  if ! "$sudo_bin" -n -- /usr/bin/rm -f -- "$stager"; then
    echo "homebrew-patched-launcher: could not remove the Formula test runtime stager" >&2
    status=2
  fi
  if [ "$status" -ne 0 ]; then
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      "$sudo_bin" -n -- /usr/bin/rm -rf -- "$destination" || return 2
    fi
    return "$status"
  fi

  HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE="$checker_relative"
  digest="$(
    homebrew_patched_launcher_manifest_sha256 \
      homebrew_patched_launcher_formula_test_runtime_manifest "$destination"
  )" || {
    status=$?
    HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE=""
    "$sudo_bin" -n -- /usr/bin/rm -rf -- "$destination" || return 2
    return "$status"
  }
  [ -n "$digest" ] || {
    HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE=""
    "$sudo_bin" -n -- /usr/bin/rm -rf -- "$destination" || return 2
    return 2
  }
  HOMEBREW_PATCHED_FORMULA_TEST_ROOT="$destination"
  HOMEBREW_PATCHED_FORMULA_TEST_SHA256="$digest"
}

homebrew_patched_launcher_prepare_sysroot_projection() {
  if [ "$#" -ne 5 ]; then
    echo "homebrew_patched_launcher_prepare_sysroot_projection: expected SYSROOT DESTINATION RUNNER PLATFORM-ROOT SUDO" >&2
    return 2
  fi
  local sysroot="$1" destination="$2" runner="$3" platform_root="$4"
  local sudo_bin="$5" admitted_runner runner_sha admitted_sha digest status

  [ -z "$HOMEBREW_PATCHED_SYSROOT_ROOT" ] &&
    [ -z "$HOMEBREW_PATCHED_SYSROOT_SHA256" ] || {
    echo "homebrew-patched-launcher: sysroot projection state is already populated" >&2
    return 2
  }
  [ -n "$HOMEBREW_PATCHED_PROTECTED_DIR" ] &&
    [ "$destination" = "$HOMEBREW_PATCHED_PROTECTED_DIR/sysroot" ] &&
    [ "$runner" = \
      "$HOMEBREW_PATCHED_PROTECTED_DIR/homebrew-tap-recipe-runner" ] || {
    echo "homebrew-patched-launcher: sysroot projection left the protected runner root" >&2
    return 2
  }
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || {
    echo "homebrew-patched-launcher: sysroot projection destination is occupied" >&2
    return 2
  }
  admitted_runner="$(
    homebrew_patched_launcher_admit_recipe_runner_source "$platform_root"
  )" || return
  runner_sha="$(/usr/bin/sha256sum "$runner" 2>/dev/null || true)"
  runner_sha="${runner_sha%% *}"
  admitted_sha="$(/usr/bin/sha256sum "$admitted_runner" 2>/dev/null || true)"
  admitted_sha="${admitted_sha%% *}"
  if [ ! -f "$runner" ] || [ -L "$runner" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$runner" 2>/dev/null || true)" != \
       "0:0:555:1" ] || [ "$runner_sha" != "$admitted_sha" ] || \
     ! /usr/bin/cmp -s -- "$admitted_runner" "$runner"; then
    echo "homebrew-patched-launcher: sysroot staging runner is not the admitted protected program" >&2
    return 2
  fi

  # WHY: ProtectHome hides the workflow checkout from the persistent recipe
  # supervisor. The already admitted root-owned runner traverses the source via
  # held descriptors, validates stable pre/post identities, and atomically
  # publishes a sealed /run projection without granting the recipe checkout
  # access. Relative contained symlinks remain symlinks so SDK path semantics
  # do not change at this security boundary.
  if "$sudo_bin" -n -- /usr/bin/env -i /usr/bin/python3 -I "$runner" \
      --stage-sysroot --source "$sysroot" --destination "$destination"; then
    :
  else
    status=$?
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      "$sudo_bin" -n -- /usr/bin/rm -rf -- "$destination" || return 2
    fi
    return "$status"
  fi
  digest="$(
    homebrew_patched_launcher_manifest_sha256 \
      homebrew_patched_launcher_sysroot_projection_manifest "$destination"
  )" || {
    status=$?
    "$sudo_bin" -n -- /usr/bin/rm -rf -- "$destination" || return 2
    return "$status"
  }
  [ -n "$digest" ] || {
    "$sudo_bin" -n -- /usr/bin/rm -rf -- "$destination" || return 2
    return 2
  }
  # Publish these as one logical state transition. Cleanup treats one populated
  # value without the other as tampering, so neither global is visible until
  # the root-owned output and its complete manifest both validate.
  HOMEBREW_PATCHED_SYSROOT_ROOT="$destination"
  HOMEBREW_PATCHED_SYSROOT_SHA256="$digest"
}

homebrew_patched_launcher_seal_target_dependencies() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_patched_launcher_seal_target_dependencies: expected BUILD-USER SUDO" >&2
    return 2
  fi
  local build_user="$1" sudo_bin="$2"
  local cellar="$HOMEBREW_PATCHED_PREFIX/Cellar"
  local opt="$HOMEBREW_PATCHED_PREFIX/opt"
  local rack link resolved

  homebrew_assert_tree_symlinks_contained "$cellar" "target Cellar" || return
  "$sudo_bin" -n -- /usr/bin/find "$cellar" -xdev -mindepth 1 \
    -exec /usr/bin/chown -h root:root {} + || return
  # WHY: dependency kegs are immutable inputs, but Cellar itself is the
  # root-owned sticky insertion point where the Formula identity creates its
  # own new rack. Sealing depth zero would protect dependencies by disabling
  # every subsequent target install.
  "$sudo_bin" -n -- /usr/bin/find "$cellar" -xdev -mindepth 1 -type d \
    -exec /usr/bin/chmod 0555 {} + || return
  "$sudo_bin" -n -- /usr/bin/find "$cellar" -xdev -type f -perm /111 \
    -exec /usr/bin/chmod 0555 {} + || return
  "$sudo_bin" -n -- /usr/bin/find "$cellar" -xdev -type f ! -perm /111 \
    -exec /usr/bin/chmod 0444 {} + || return
  for rack in "$cellar"/*; do
    [ -e "$rack" ] || [ -L "$rack" ] || continue
    [ -d "$rack" ] && [ ! -L "$rack" ] || {
      echo "homebrew-patched-launcher: target dependency rack is not one real directory: $rack" >&2
      return 2
    }
    homebrew_assert_tree_not_writable_by_user "$build_user" "$rack" || return
    homebrew_assert_tree_not_replaceable_by_user "$build_user" "$rack" || return
  done
  for link in "$opt"/*; do
    [ -e "$link" ] || [ -L "$link" ] || continue
    [ -L "$link" ] || {
      echo "homebrew-patched-launcher: target dependency opt entry is not a symlink: $link" >&2
      return 2
    }
    resolved="$(/usr/bin/realpath -- "$link" 2>/dev/null || true)"
    case "$resolved/" in
      "$cellar"/*/) ;;
      *)
        echo "homebrew-patched-launcher: target dependency opt link escapes the Cellar: $link" >&2
        return 2
        ;;
    esac
    "$sudo_bin" -n -- /usr/bin/chown -h root:root "$link" || return
    [ "$(/usr/bin/stat -c '%u:%g' "$link")" = "0:0" ] || return 2
  done
}

homebrew_patched_launcher_snapshot_target_cellar_layout() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_snapshot_target_cellar_layout: expected no arguments" >&2
    return 2
  fi
  local cellar="$HOMEBREW_PATCHED_PREFIX/Cellar" rack rack_name keg
  local -a entries=()
  if [ -z "$HOMEBREW_PATCHED_PREFIX" ] || [ ! -d "$cellar" ] || [ -L "$cellar" ]; then
    echo "homebrew-patched-launcher: target Cellar is unavailable" >&2
    return 2
  fi
  for rack in "$cellar"/*; do
    [ -e "$rack" ] || [ -L "$rack" ] || continue
    if [ ! -d "$rack" ] || [ -L "$rack" ]; then
      echo "homebrew-patched-launcher: target Cellar rack is not a real directory: $rack" >&2
      return 1
    fi
    rack_name="${rack##*/}"
    entries+=("rack:$rack_name")
    for keg in "$rack"/*; do
      [ -e "$keg" ] || [ -L "$keg" ] || continue
      if [ ! -d "$keg" ] || [ -L "$keg" ]; then
        echo "homebrew-patched-launcher: target Cellar keg is not a real directory: $keg" >&2
        return 1
      fi
      entries+=("keg:$rack_name/${keg##*/}")
    done
  done
  if [ "${#entries[@]}" -gt 0 ]; then
    printf '%s\n' "${entries[@]}" | LC_ALL=C sort
  fi
}

homebrew_patched_launcher_stage_control_file() {
  if [ "$#" -ne 5 ]; then
    echo "homebrew_patched_launcher_stage_control_file: expected KEY SOURCE BASENAME MAX_BYTES LABEL" >&2
    return 2
  fi
  local key="$1" source="$2" basename="$3" max_bytes="$4" label="$5"
  local destination source_state source_uid source_mode source_links bytes digest
  if [ -z "$HOMEBREW_PATCHED_PREFIX" ] || [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: stage the $label after preparation and before isolation" >&2
    return 2
  fi
  if ! [[ "$key" =~ ^[a-z][a-z0-9_]*$ ]] ||
     ! [[ "$basename" =~ ^\.[a-z0-9][a-z0-9._-]*\.json$ ]] ||
     ! [[ "$max_bytes" =~ ^[1-9][0-9]*$ ]]; then
    echo "homebrew-patched-launcher: invalid protected control-file declaration for $label" >&2
    return 2
  fi
  if [ -n "${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]:-}" ]; then
    echo "homebrew-patched-launcher: $label is already staged" >&2
    return 2
  fi
  if [ ! -f "$source" ] || [ -L "$source" ]; then
    echo "homebrew-patched-launcher: $label is not a private regular file" >&2
    return 2
  fi
  if source_state="$(stat -c '%u:%a:%h:%s' "$source" 2>/dev/null)"; then
    IFS=: read -r source_uid source_mode source_links bytes <<<"$source_state"
  else
    source_state="$(stat -f '%u:%Lp:%l:%z' "$source")" || return 2
    IFS=: read -r source_uid source_mode source_links bytes <<<"$source_state"
  fi
  if [ "$source_uid" != "$(id -u)" ] || [ "$source_links" != "1" ] ||
     ! [[ "$source_mode" =~ ^[0-7]{3,4}$ ]] ||
     [ $((8#$source_mode & 0077)) -ne 0 ]; then
    echo "homebrew-patched-launcher: $label is not a private regular file" >&2
    return 2
  fi
  if ! [[ "$bytes" =~ ^[1-9][0-9]*$ ]] || [ "$bytes" -gt "$max_bytes" ]; then
    echo "homebrew-patched-launcher: $label exceeds the size limit" >&2
    return 2
  fi
  destination="$HOMEBREW_PATCHED_PREFIX/$basename"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "homebrew-patched-launcher: $label destination already exists" >&2
    return 1
  fi
  HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]="$destination"
  HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]="$basename"
  HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]="$label"
  HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES[$key]="$max_bytes"
  HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]=""
  HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]="staging"
  if ! cp "$source" "$destination" || ! chmod 0444 "$destination" ||
     ! digest="$(homebrew_sha256_stream <"$destination")"; then
    echo "homebrew-patched-launcher: could not stage the $label" >&2
    homebrew_patched_launcher_remove_control_file "$key" || true
    return 1
  fi
  HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]="$digest"
  HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]="ready"
  if ! homebrew_patched_launcher_verify_control_file "$key"; then
    HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]="staging"
    homebrew_patched_launcher_remove_control_file "$key" || true
    return 1
  fi
}

homebrew_patched_launcher_verify_control_file() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_verify_control_file: expected KEY" >&2
    return 2
  fi
  local key="$1" path
  path="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]:-}"
  [ -n "$path" ] || return 0
  local label="${HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]}"
  local expected="$HOMEBREW_PATCHED_PREFIX/${HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]}"
  local max_bytes="${HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES[$key]}"
  local state prefix_uid actual_sha size
  if [ "${HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]:-}" != "ready" ] ||
     [ "$path" != "$expected" ] ||
     [ ! -f "$expected" ] || [ -L "$expected" ]; then
    echo "homebrew-patched-launcher: protected $label changed" >&2
    return 1
  fi
  if state="$(stat -c '%u:%a:%h:%s' "$expected" 2>/dev/null)"; then
    prefix_uid="$(stat -c '%u' "$HOMEBREW_PATCHED_PREFIX")"
  else
    state="$(stat -f '%u:%Lp:%l:%z' "$expected")"
    prefix_uid="$(stat -f '%u' "$HOMEBREW_PATCHED_PREFIX")"
  fi
  case "$state" in
    "$prefix_uid":444:1:*) ;;
    *)
      echo "homebrew-patched-launcher: protected $label ownership or mode is unsafe" >&2
      return 1
      ;;
  esac
  size="${state##*:}"
  if ! [[ "$size" =~ ^[1-9][0-9]*$ ]] || [ "$size" -gt "$max_bytes" ]; then
    echo "homebrew-patched-launcher: protected $label size changed" >&2
    return 1
  fi
  actual_sha="$(homebrew_sha256_stream <"$expected")"
  if [ -z "${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]:-}" ] ||
     [ "$actual_sha" != "${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]}" ]; then
    echo "homebrew-patched-launcher: protected $label content changed" >&2
    return 1
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
      /usr/bin/test -r "$expected" &&
      ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
        /usr/bin/test -w "$expected" || {
        echo "homebrew-patched-launcher: Formula identity has unsafe $label access" >&2
        return 1
      }
  fi
}

homebrew_patched_launcher_remove_control_file() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_remove_control_file: expected KEY" >&2
    return 2
  fi
  local key="$1" path
  path="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]:-}"
  [ -n "$path" ] || return 0
  local label="${HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]}"
  local expected="$HOMEBREW_PATCHED_PREFIX/${HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]}"
  if [ "${HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]:-}" = "staging" ]; then
    local destination_uid prefix_uid destination_links
    if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] || \
       [ "$path" != "$expected" ]; then
      echo "homebrew-patched-launcher: refusing to remove an unsafe partial $label" >&2
      return 1
    fi
    if [ -e "$expected" ] || [ -L "$expected" ]; then
      if [ ! -f "$expected" ] || [ -L "$expected" ]; then
        echo "homebrew-patched-launcher: partial $label is not a regular file" >&2
        return 1
      fi
      if destination_uid="$(stat -c '%u' "$expected" 2>/dev/null)"; then
        prefix_uid="$(stat -c '%u' "$HOMEBREW_PATCHED_PREFIX")"
        destination_links="$(stat -c '%h' "$expected")"
      else
        destination_uid="$(stat -f '%u' "$expected")"
        prefix_uid="$(stat -f '%u' "$HOMEBREW_PATCHED_PREFIX")"
        destination_links="$(stat -f '%l' "$expected")"
      fi
      if [ "$destination_uid" != "$prefix_uid" ] || [ "$destination_links" != "1" ]; then
        echo "homebrew-patched-launcher: partial $label ownership is unsafe" >&2
        return 1
      fi
      rm -f -- "$expected" || return
    fi
  else
    homebrew_patched_launcher_verify_control_file "$key" || return
    if [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -f -- "$path" || return
    else
      rm -f -- "$path" || return
    fi
  fi
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_BASENAME[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_SHA256[$key]'
  unset 'HOMEBREW_PATCHED_CONTROL_FILE_STATE[$key]'
}

homebrew_patched_launcher_seal_control_files() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_seal_control_files: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" key path label
  for key in "${!HOMEBREW_PATCHED_CONTROL_FILE_PATH[@]}"; do
    path="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[$key]}"
    label="${HOMEBREW_PATCHED_CONTROL_FILE_LABEL[$key]}"
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown root:root "$path" || return
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chmod 0444 "$path" || return
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$path")" = "0:0:444:1" ] &&
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- /usr/bin/test -r "$path" &&
      ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- /usr/bin/test -w "$path" || {
      echo "homebrew-patched-launcher: could not protect the $label" >&2
      return 1
    }
    homebrew_patched_launcher_verify_control_file "$key" || return
  done
}

homebrew_patched_launcher_stage_dependency_plan() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_stage_dependency_plan: expected PLAN" >&2
    return 2
  fi
  homebrew_patched_launcher_stage_control_file dependency_plan "$1" \
    .kandelo-publisher-build-dependencies.json 65536 "dependency plan" || return
  HOMEBREW_PATCHED_DEPENDENCY_PLAN="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[dependency_plan]}"
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256="${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[dependency_plan]}"
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE="${HOMEBREW_PATCHED_CONTROL_FILE_STATE[dependency_plan]}"
}

homebrew_patched_launcher_verify_dependency_plan() {
  homebrew_patched_launcher_verify_control_file dependency_plan
}

homebrew_patched_launcher_remove_dependency_plan() {
  homebrew_patched_launcher_remove_control_file dependency_plan || return
  HOMEBREW_PATCHED_DEPENDENCY_PLAN=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE=""
}

homebrew_patched_launcher_stage_tier2_attestation() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_stage_tier2_attestation: expected ATTESTATION" >&2
    return 2
  fi
  homebrew_patched_launcher_stage_control_file tier2_attestation "$1" \
    .kandelo-publisher-tier2-attestation.json 65536 "Tier-2 attestation" || return
  HOMEBREW_PATCHED_TIER2_ATTESTATION="${HOMEBREW_PATCHED_CONTROL_FILE_PATH[tier2_attestation]}"
  HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256="${HOMEBREW_PATCHED_CONTROL_FILE_SHA256[tier2_attestation]}"
  HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE="${HOMEBREW_PATCHED_CONTROL_FILE_STATE[tier2_attestation]}"
}

homebrew_patched_launcher_verify_tier2_attestation() {
  homebrew_patched_launcher_verify_control_file tier2_attestation
}

homebrew_patched_launcher_remove_tier2_attestation() {
  homebrew_patched_launcher_remove_control_file tier2_attestation || return
  HOMEBREW_PATCHED_TIER2_ATTESTATION=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE=""
}

homebrew_assert_tree_not_writable_by_user() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_assert_tree_not_writable_by_user: expected USER TREE" >&2
    return 2
  fi
  local user="$1" tree="$2" writable
  [ -d "$tree" ] && [ ! -L "$tree" ] || {
    echo "homebrew-patched-launcher: protected source is not a real directory: $tree" >&2
    return 1
  }
  [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ] || {
    echo "homebrew-patched-launcher: privileged host boundary is not initialized" >&2
    return 2
  }
  if ! writable="$("$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- \
    /usr/bin/find "$tree" -xdev \
      \( -writable -print -quit \) -o \
      \( -type d \( ! -readable -o ! -executable \) -prune \))"; then
    echo "homebrew-patched-launcher: could not inspect protected source as $user: $tree" >&2
    return 2
  fi
  if [ -n "$writable" ]; then
    echo "homebrew-patched-launcher: build user can write protected source: $writable" >&2
    return 1
  fi
}

homebrew_assert_tree_not_replaceable_by_user() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_assert_tree_not_replaceable_by_user: expected USER TREE" >&2
    return 2
  fi
  local user="$1" current="$2" parent mode current_uid parent_uid user_uid
  user_uid="$(id -u "$user")"
  current="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- \
    /usr/bin/realpath -- "$current")" || {
    echo "homebrew-patched-launcher: could not resolve protected source: $current" >&2
    return 2
  }
  while [ "$current" != "/" ]; do
    parent="$(dirname "$current")"
    current_uid="$(
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/stat -c '%u' "$current"
    )" || return 2
    parent_uid="$(
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/stat -c '%u' "$parent"
    )" || return 2
    # WHY: an owner may chmod a currently read-only inode or ancestor and then
    # replace it. Effective writability alone is therefore not an ownership
    # boundary for code that will be copied into a privileged execution path.
    if [ "$current_uid" = "$user_uid" ] || [ "$parent_uid" = "$user_uid" ]; then
      echo "homebrew-patched-launcher: build user can replace protected source: $current" >&2
      return 1
    fi
    if "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$parent"; then
      mode="$(/usr/bin/stat -c '%a' "$parent")"
      if [ $((8#$mode & 01000)) -eq 0 ]; then
        echo "homebrew-patched-launcher: build user can replace protected source: $current" >&2
        return 1
      fi
    fi
    current="$parent"
  done
}

homebrew_assert_tree_symlinks_contained() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_assert_tree_symlinks_contained: expected TREE LABEL" >&2
    return 2
  fi
  local tree="$1" label="$2" physical_tree unsafe_entry
  physical_tree="$(cd "$tree" && pwd -P)" || {
    echo "homebrew-patched-launcher: could not resolve protected $label tree" >&2
    return 2
  }
  unsafe_entry="$(/usr/bin/find "$physical_tree" -xdev \
    ! \( -type d -o -type f -o -type l \) -print -quit)" || return 2
  [ -z "$unsafe_entry" ] || {
    echo "homebrew-patched-launcher: protected $label contains a special entry: $unsafe_entry" >&2
    return 1
  }
  if ! /usr/bin/find "$physical_tree" -xdev -type l \
       -exec /usr/bin/bash -c '
         set -euo pipefail
         root="$1"
         label="$2"
         shift 2
         for link in "$@"; do
           raw_target="$(/usr/bin/readlink -- "$link")" || exit 1
           case "$raw_target" in
             /*) lexical_input="$raw_target" ;;
             *) lexical_input="${link%/*}/$raw_target" ;;
           esac
           lexical_target="$(/usr/bin/realpath -m -s -- "$lexical_input")" || exit 1
           case "$lexical_target" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: protected %s symlink crosses its tree: %s\n" \
                 "$label" "$link" >&2
               exit 1
               ;;
           esac
           resolved="$(/usr/bin/realpath -- "$link")" || {
             printf "homebrew-patched-launcher: protected %s symlink is unresolved: %s\n" \
               "$label" "$link" >&2
             exit 1
           }
           case "$resolved" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: protected %s symlink escapes its tree: %s\n" \
                 "$label" "$link" >&2
               exit 1
               ;;
           esac
         done
       ' kandelo-protected-tree "$physical_tree" "$label" {} +; then
    echo "homebrew-patched-launcher: protected $label symlink validation failed" >&2
    return 1
  fi
}

homebrew_patched_launcher_emit_sysroot_access_audit() {
  cat <<'EOF'
if ! sysroot_access_violation="$(/usr/bin/find "$expected_sysroot" -xdev \( -writable -o ! -readable -o \( -type d ! -executable \) \) -print -quit)"; then
  echo "homebrew-patched-launcher: could not inspect the protected sysroot alias" >&2
  exit 2
fi
if [ -n "$sysroot_access_violation" ]; then
  echo "homebrew-patched-launcher: protected sysroot alias has unsafe access: $sysroot_access_violation" >&2
  exit 1
fi
EOF
}

homebrew_patched_launcher_verify_overlay_seal() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_verify_overlay_seal: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" unsafe_entry
  if [ "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" != "sealed" ] || \
     [ -z "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" ] || \
     [ ! -d "$HOMEBREW_PATCHED_OVERLAY" ] || \
     [ -L "$HOMEBREW_PATCHED_OVERLAY" ]; then
    echo "homebrew-patched-launcher: patched Homebrew overlay is not sealed" >&2
    return 1
  fi
  unsafe_entry="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
    "$HOMEBREW_PATCHED_OVERLAY" -xdev \
    \( ! -uid "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" -o \
       ! \( -type d -o -type f -o -type l \) -o \
       \( -type f -links +1 \) -o \
       \( -type d ! -perm 0555 \) -o \
       \( -type f \( ! -perm -0444 -o -perm /0222 -o -perm /07000 \) \) \
    \) -print -quit)" || {
    echo "homebrew-patched-launcher: could not inspect the sealed Homebrew overlay" >&2
    return 2
  }
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-patched-launcher: sealed Homebrew overlay entry is unsafe: $unsafe_entry" >&2
    return 1
  fi
  homebrew_patched_launcher_assert_overlay_symlinks_contained || return
  homebrew_assert_tree_not_writable_by_user \
    "$build_user" "$HOMEBREW_PATCHED_OVERLAY" || return
  homebrew_assert_tree_not_replaceable_by_user \
    "$build_user" "$HOMEBREW_PATCHED_OVERLAY" || return
}

homebrew_patched_launcher_assert_overlay_symlinks_contained() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_assert_overlay_symlinks_contained: expected no arguments" >&2
    return 2
  fi
  local physical_overlay
  physical_overlay="$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" || {
    echo "homebrew-patched-launcher: could not resolve the Homebrew overlay" >&2
    return 2
  }
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type l \
       -exec /usr/bin/bash -c '
         root="$1"
         shift
         for link in "$@"; do
           raw_target="$(/usr/bin/readlink -- "$link")" || {
             printf "homebrew-patched-launcher: overlay symlink cannot be read: %s\\n" "$link" >&2
             exit 1
           }
           case "$raw_target" in
             /*) lexical_input="$raw_target" ;;
             *) lexical_input="${link%/*}/$raw_target" ;;
           esac
           lexical_target="$(/usr/bin/realpath -m -s -- "$lexical_input")" || {
             printf "homebrew-patched-launcher: overlay symlink target cannot be normalized: %s\\n" "$link" >&2
             exit 1
           }
           case "$lexical_target" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: overlay symlink crosses its worktree: %s\\n" "$link" >&2
               exit 1
               ;;
           esac
           resolved="$(/usr/bin/realpath -- "$link")" || {
             printf "homebrew-patched-launcher: overlay symlink is unresolved: %s\\n" "$link" >&2
             exit 1
           }
           case "$resolved" in
             "$root"|"$root"/*) ;;
             *)
               printf "homebrew-patched-launcher: overlay symlink escapes its worktree: %s\\n" "$link" >&2
               exit 1
               ;;
           esac
         done
       ' bash "$physical_overlay" {} +; then
    echo "homebrew-patched-launcher: Homebrew overlay symlink validation failed" >&2
    return 1
  fi
}

homebrew_patched_launcher_seal_overlay() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_seal_overlay: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" unsafe_entry
  if [ -n "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" ] || \
     [ -z "$HOMEBREW_PATCHED_SUDO_BIN" ] || \
     [ ! -d "$HOMEBREW_PATCHED_OVERLAY" ] || \
     [ -L "$HOMEBREW_PATCHED_OVERLAY" ]; then
    echo "homebrew-patched-launcher: patched Homebrew overlay cannot be sealed" >&2
    return 2
  fi
  HOMEBREW_PATCHED_OVERLAY_OWNER_UID="$(/usr/bin/id -u)"
  if [ "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" = \
       "$(/usr/bin/id -u "$build_user")" ]; then
    echo "homebrew-patched-launcher: overlay owner must differ from the build user" >&2
    return 2
  fi
  unsafe_entry="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
    "$HOMEBREW_PATCHED_OVERLAY" -xdev \
    \( ! -uid "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" -o \
       ! \( -type d -o -type f -o -type l \) -o \
       \( -type f -links +1 \) \) -print -quit)" || {
    echo "homebrew-patched-launcher: could not inspect the Homebrew overlay before sealing" >&2
    return 2
  }
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-patched-launcher: Homebrew overlay entry cannot be sealed: $unsafe_entry" >&2
    return 1
  fi
  homebrew_patched_launcher_assert_overlay_symlinks_contained || return

  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealing"
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type d \
       -exec /usr/bin/chmod 0555 {} + || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type f -perm /0111 \
       -exec /usr/bin/chmod 0555 {} + || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type f ! -perm /0111 \
       -exec /usr/bin/chmod 0444 {} +; then
    echo "homebrew-patched-launcher: could not seal the Homebrew overlay" >&2
    return 1
  fi
  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealed"
  homebrew_patched_launcher_verify_overlay_seal "$build_user"
}

homebrew_patched_launcher_restore_overlay_for_cleanup() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_restore_overlay_for_cleanup: expected no arguments" >&2
    return 2
  fi
  case "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" in
    "") return 0 ;;
    cleanup-ready) return 0 ;;
    sealing|sealed) ;;
    *)
      echo "homebrew-patched-launcher: Homebrew overlay seal state is invalid" >&2
      return 2
      ;;
  esac
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] && \
     [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" != "1" ]; then
    echo "homebrew-patched-launcher: refusing to restore the overlay before Formula process teardown" >&2
    return 1
  fi
  if [ ! -d "$HOMEBREW_PATCHED_OVERLAY" ] || [ -L "$HOMEBREW_PATCHED_OVERLAY" ] || \
     [ "$(/usr/bin/stat -c '%u' "$HOMEBREW_PATCHED_OVERLAY")" != \
       "$HOMEBREW_PATCHED_OVERLAY_OWNER_UID" ]; then
    echo "homebrew-patched-launcher: refusing to restore a changed Homebrew overlay" >&2
    return 1
  fi
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type d \
       -exec /usr/bin/chmod u+rwx {} + || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
       "$HOMEBREW_PATCHED_OVERLAY" -xdev -type f \
       -exec /usr/bin/chmod u+rw {} +; then
    echo "homebrew-patched-launcher: could not restore the Homebrew overlay for cleanup" >&2
    return 1
  fi
  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="cleanup-ready"
}

homebrew_patched_launcher_worktree_registration_status() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_patched_launcher_worktree_registration_status: expected REPO WORKTREE" >&2
    return 2
  fi
  local repo="$1" worktree="$2" listing line
  listing="$(git -C "$repo" worktree list --porcelain)" || {
    echo "homebrew-patched-launcher: could not inspect Homebrew worktree registrations" >&2
    return 2
  }
  while IFS= read -r line; do
    [ "$line" = "worktree $worktree" ] && return 0
  done <<<"$listing"
  return 1
}

homebrew_patched_launcher_git_version_is_supported() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_git_version_is_supported: expected VERSION" >&2
    return 2
  fi
  local version="$1" major minor
  if ! [[ "$version" =~ ^git\ version\ ([0-9]+)\.([0-9]+)(\.[0-9]+)*([.+-][^[:space:]]+)?$ ]]; then
    return 1
  fi
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 7 ]; }
}

# Keep Homebrew's host-side repository and trust operations on the declared
# dev-shell Git even after a target Formula installs a Wasm `git` into the
# selected Homebrew prefix. Homebrew preserves HOMEBREW_* variables when its
# launcher resets PATH and gives this documented absolute override precedence
# over the brewed Git shim.
homebrew_patched_launcher_select_host_git() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_select_host_git: expected no arguments" >&2
    return 2
  fi
  local git_path git_version git_root
  unset HOMEBREW_GIT_PATH
  git_path="$(command -v git || true)"
  git_root="${git_path%/bin/git}"
  git_version="$("$git_path" --version 2>/dev/null || true)"
  git_version="${git_version%%$'\n'*}"
  if ! [[ "$git_path" =~ ^/nix/store/[0-9a-z]{32}-git-[^/]+/bin/git$ ]] ||
     [ ! -f "$git_path" ] || [ -L "$git_path" ] || [ ! -x "$git_path" ] ||
     [ -w "$git_path" ] || [ -w "${git_path%/*}" ] || [ -w "$git_root" ] ||
     ! homebrew_patched_launcher_git_version_is_supported "$git_version"; then
    echo "homebrew-patched-launcher: dev shell does not provide protected Nix Git 2.7.0 or newer" >&2
    return 2
  fi
  HOMEBREW_GIT_PATH="$git_path"
  export HOMEBREW_GIT_PATH
}

homebrew_assert_protected_host_executable() {
  if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "homebrew_assert_protected_host_executable: expected USER PATH EXPECTED LABEL [SYMLINK_TARGET]" >&2
    return 2
  fi
  local user="$1" path="$2" expected="$3" label="$4"
  local symlink_target="${5:-}" mode resolved parent parent_mode
  if [ "$path" != "$expected" ] || [ ! -f "$path" ] || [ ! -x "$path" ]; then
    echo "homebrew-patched-launcher: $label must be the protected $expected" >&2
    return 2
  fi
  resolved="$(/usr/bin/readlink -f -- "$path" 2>/dev/null || true)"
  if [ -L "$path" ]; then
    parent="${path%/*}"
    parent_mode="$(/usr/bin/stat -c '%a' "$parent" 2>/dev/null || true)"
    if [ -z "$symlink_target" ] || [ "$resolved" != "$symlink_target" ] || \
       [ "$(/usr/bin/stat -c '%u' "$path" 2>/dev/null || true)" != "0" ] || \
       [ "$(/usr/bin/stat -c '%u' "$parent" 2>/dev/null || true)" != "0" ] || \
       ! [[ "$parent_mode" =~ ^[0-7]{3,4}$ ]] || \
       [ $((8#$parent_mode & 0022)) -ne 0 ] || \
       "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$parent"; then
      echo "homebrew-patched-launcher: $label symlink is not protected" >&2
      return 2
    fi
  elif [ -n "$symlink_target" ] && [ "$resolved" != "$path" ]; then
    echo "homebrew-patched-launcher: $label resolves outside $expected" >&2
    return 2
  fi
  mode="$(/usr/bin/stat -Lc '%a' "$resolved" 2>/dev/null || true)"
  if [ ! -f "$resolved" ] || [ ! -x "$resolved" ] || \
     [ "$(/usr/bin/stat -Lc '%u' "$resolved" 2>/dev/null || true)" != "0" ] || \
     ! [[ "$mode" =~ ^[0-7]{3,4}$ ]] || [ $((8#$mode & 0022)) -ne 0 ]; then
    echo "homebrew-patched-launcher: $label must be the protected $expected" >&2
    return 2
  fi
  if "$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$path"; then
    echo "homebrew-patched-launcher: build user can replace $label" >&2
    return 2
  fi
}

homebrew_assert_protected_host_versioned_executable() {
  if [ "$#" -ne 5 ]; then
    echo "homebrew_assert_protected_host_versioned_executable: expected USER PATH EXPECTED LABEL SELECTOR_NAME" >&2
    return 2
  fi
  local user="$1" path="$2" expected="$3" label="$4" selector_name="$5"
  local expected_parent resolved resolved_parent resolved_basename
  if [ "$path" != "$expected" ] || [ "${expected##*/}" != "$selector_name" ] || \
     ! [[ "$selector_name" =~ ^[A-Za-z0-9_+-]+$ ]]; then
    echo "homebrew-patched-launcher: $label must be the protected $expected" >&2
    return 2
  fi
  if [ ! -L "$path" ]; then
    homebrew_assert_protected_host_executable \
      "$user" "$path" "$expected" "$label"
    return
  fi

  resolved="$(/usr/bin/readlink -f -- "$path" 2>/dev/null || true)"
  expected_parent="${expected%/*}"
  resolved_parent="${resolved%/*}"
  resolved_basename="${resolved##*/}"
  # WHY: distributions may expose a stable interpreter name through a
  # root-owned version selector. Keep that useful indirection without granting
  # an admitted host tool permission to redirect outside its protected system
  # directory or to an arbitrary helper with different behavior.
  if [ "$resolved_parent" != "$expected_parent" ] || \
     ! [[ "$resolved_basename" =~ ^${selector_name}\.[0-9]+$ ]]; then
    echo "homebrew-patched-launcher: $label version selector is not protected" >&2
    return 2
  fi
  homebrew_assert_protected_host_executable \
    "$user" "$path" "$expected" "$label" "$resolved"
}

homebrew_patched_launcher_remove_native_bridges() {
  local formula target_cellar target_opt native_rack native_opt native_opt_target
  local native_version target_rack target_keg target_opt_link expected_opt_target
  local rack_present opt_present rack_state formula_status status=0
  local -a remaining_bridges=()
  [ -n "$HOMEBREW_PATCHED_PREFIX" ] || return 0
  target_cellar="$HOMEBREW_PATCHED_PREFIX/Cellar"
  target_opt="$HOMEBREW_PATCHED_PREFIX/opt"
  for formula in "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}"; do
    formula_status=0
    rack_present=0
    opt_present=0
    native_rack="$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar/$formula"
    native_opt="$HOMEBREW_PATCHED_NATIVE_PREFIX/opt/$formula"
    native_opt_target="$(cd "$native_opt" && pwd -P)" || formula_status=1
    if [ "$formula_status" -eq 0 ] && \
       [ "${native_opt_target%/*}" != "$native_rack" ]; then
      echo "homebrew-patched-launcher: native Formula opt link changed before bridge cleanup: $formula" >&2
      formula_status=1
    fi
    native_version="${native_opt_target##*/}"
    target_rack="$target_cellar/$formula"
    target_keg="$target_rack/$native_version"
    target_opt_link="$target_opt/$formula"
    expected_opt_target="../Cellar/$formula/$native_version"

    if [ -e "$target_rack" ] || [ -L "$target_rack" ]; then
      if [ -d "$target_rack" ] && [ ! -L "$target_rack" ]; then
        rack_present=1
      else
        echo "homebrew-patched-launcher: refusing to remove changed native Formula rack: $target_rack" >&2
        formula_status=1
      fi
    fi
    if [ -e "$target_opt_link" ] || [ -L "$target_opt_link" ]; then
      if [ -L "$target_opt_link" ] && \
         [ "$(/usr/bin/readlink "$target_opt_link")" = "$expected_opt_target" ]; then
        opt_present=1
      else
        echo "homebrew-patched-launcher: refusing to remove changed native Formula opt bridge: $target_opt_link" >&2
        formula_status=1
      fi
    fi
    if [ "$rack_present" -eq 1 ] && [ "$opt_present" -eq 1 ] && \
       { [ ! -d "$target_keg" ] || [ -L "$target_keg" ] || \
         [ "$(cd "$target_keg" && pwd -P)" != "$target_keg" ]; }; then
      echo "homebrew-patched-launcher: refusing to remove changed native Formula keg: $target_keg" >&2
      formula_status=1
    fi
    if [ "$rack_present" -eq 1 ] && [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
      rack_state="$(/usr/bin/stat -c '%u:%g:%a' "$target_rack")"
      case "$rack_state:$opt_present" in
        0:0:700:0)
          if "$HOMEBREW_PATCHED_SUDO_BIN" -n -H \
               -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
               /usr/bin/test -r "$target_rack" || \
             "$HOMEBREW_PATCHED_SUDO_BIN" -n -H \
               -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
               /usr/bin/test -w "$target_rack" || \
             "$HOMEBREW_PATCHED_SUDO_BIN" -n -H \
               -u "$HOMEBREW_PATCHED_BUILD_USER" -- \
               /usr/bin/test -x "$target_rack"; then
            echo "homebrew-patched-launcher: build user can access partial native Formula proxy: $target_rack" >&2
            formula_status=1
          fi
          ;;
        0:0:555:0|0:0:555:1) ;;
        *)
          echo "homebrew-patched-launcher: refusing to remove changed native Formula proxy: $target_rack" >&2
          formula_status=1
          ;;
      esac
      if [ "$formula_status" -eq 0 ]; then
        if [ "$rack_state" != "0:0:700" ]; then
          homebrew_assert_tree_not_writable_by_user \
            "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" || formula_status=1
        fi
        if [ "$formula_status" -eq 0 ]; then
          homebrew_assert_tree_not_replaceable_by_user \
            "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" || formula_status=1
        fi
      fi
    fi

    if [ "$formula_status" -eq 0 ] && [ "$opt_present" -eq 1 ]; then
      if [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
        "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -f -- \
          "$target_opt_link" || formula_status=1
      else
        rm -f -- "$target_opt_link" || formula_status=1
      fi
    fi
    if [ "$formula_status" -eq 0 ] && [ "$rack_present" -eq 1 ]; then
      if [ -n "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
        "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -rf -- \
          "$target_rack" || formula_status=1
      else
        find "$target_rack" -type d -exec chmod u+w {} + && \
          rm -rf -- "$target_rack" || formula_status=1
      fi
    fi
    if [ "$formula_status" -ne 0 ]; then
      remaining_bridges+=("$formula")
      status=1
    fi
  done
  HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES=("${remaining_bridges[@]}")
  return "$status"
}

homebrew_patched_launcher_cleanup() {
  local teardown_status worktree_registration_status
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] && \
     [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" != "1" ]; then
    if homebrew_patched_launcher_teardown "$HOMEBREW_PATCHED_BUILD_USER" \
      >/dev/null; then
      :
    else
      teardown_status="$?"
      echo "homebrew-patched-launcher: Formula process teardown failed; preserving launcher state for retry" >&2
      return "$teardown_status"
    fi
  fi
  if ! homebrew_patched_launcher_verify_protected_xtask; then
    echo "homebrew-patched-launcher: protected checker changed; preserving launcher state for inspection" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_verify_native_link_auditor; then
    echo "homebrew-patched-launcher: protected native link auditor changed; preserving launcher state for inspection" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_verify_platform_projection; then
    echo "homebrew-patched-launcher: protected platform projection changed; preserving launcher state for inspection" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_verify_formula_test_runtime; then
    echo "homebrew-patched-launcher: protected Formula test runtime changed; preserving launcher state for inspection" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_verify_sysroot_projection; then
    echo "homebrew-patched-launcher: protected sysroot projection changed; preserving launcher state for inspection" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_verify_recipe_runner; then
    echo "homebrew-patched-launcher: protected recipe runner changed; preserving launcher state for inspection" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_verify_native_overlay_attestation; then
    echo "homebrew-patched-launcher: sealed Homebrew identity changed; preserving launcher state for inspection" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_remove_staged_input; then
    echo "homebrew-patched-launcher: protected input remains; preserving launcher state for retry" >&2
    return 1
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] && \
     [ "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" = "sealed" ]; then
    if ! homebrew_patched_launcher_verify_overlay_seal \
         "$HOMEBREW_PATCHED_BUILD_USER" || \
       [ -z "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ] || \
       [ "$(homebrew_patched_launcher_integrity)" != \
         "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ]; then
      echo "homebrew-patched-launcher: patched Homebrew overlay changed; preserving launcher state for inspection" >&2
      return 1
    fi
  fi
  if ! homebrew_patched_launcher_remove_native_bridges; then
    echo "homebrew-patched-launcher: native Formula bridges remain; preserving launcher state for retry" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_remove_dependency_plan; then
    echo "homebrew-patched-launcher: protected dependency plan changed; preserving launcher state for retry" >&2
    return 1
  fi
  if ! homebrew_patched_launcher_remove_tier2_attestation; then
    echo "homebrew-patched-launcher: protected Tier-2 attestation changed; preserving launcher state for retry" >&2
    return 1
  fi
  if [ -n "$HOMEBREW_PATCHED_PROTECTED_DIR" ]; then
    local protected_basename protected_parent protected_state
    protected_basename="${HOMEBREW_PATCHED_PROTECTED_DIR##*/}"
    protected_parent="${HOMEBREW_PATCHED_PROTECTED_DIR%/*}"
    protected_state="$(
      /usr/bin/stat -c '%d:%i:%u:%g' "$HOMEBREW_PATCHED_PROTECTED_DIR" \
        2>/dev/null || true
    )"
    if [ "$protected_parent" != "/run/kandelo-homebrew-publisher" ] || \
       ! [[ "$protected_basename" =~ ^build-[0-9a-f]{64}$ ]] || \
       [ "$(/usr/bin/realpath -- "$HOMEBREW_PATCHED_PROTECTED_DIR" 2>/dev/null || true)" != \
         "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || \
       [ "$protected_state" != "$HOMEBREW_PATCHED_PROTECTED_DIR_STATE" ] || \
       [ "$(/usr/bin/stat -c '%u:%g:%a' "$protected_parent" 2>/dev/null || true)" != \
         "0:0:711" ] || \
       [ "$(/usr/bin/realpath -- "$protected_parent" 2>/dev/null || true)" != \
         "$protected_parent" ]; then
      echo "homebrew-patched-launcher: protected launcher state changed before cleanup" >&2
      return 1
    fi
    if ! "$HOMEBREW_PATCHED_SUDO_BIN" rm -rf -- \
         "$HOMEBREW_PATCHED_PROTECTED_DIR" \
         >/dev/null 2>&1 || [ -e "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || \
         [ -L "$HOMEBREW_PATCHED_PROTECTED_DIR" ]; then
      echo "homebrew-patched-launcher: protected launcher state could not be removed; preserving cleanup state for retry" >&2
      return 1
    fi
    HOMEBREW_PATCHED_PROTECTED_DIR=""
    HOMEBREW_PATCHED_PROTECTED_DIR_STATE=""
    HOMEBREW_PATCHED_PROTECTED_XTASK=""
    HOMEBREW_PATCHED_PROTECTED_XTASK_STATE=""
    HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256=""
    HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR=""
    HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE=""
    HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256=""
    HOMEBREW_PATCHED_PLATFORM_ROOT=""
    HOMEBREW_PATCHED_PLATFORM_SHA256=""
    HOMEBREW_PATCHED_FORMULA_TEST_ROOT=""
    HOMEBREW_PATCHED_FORMULA_TEST_SHA256=""
    HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE=""
    HOMEBREW_PATCHED_SYSROOT_ROOT=""
    HOMEBREW_PATCHED_SYSROOT_SHA256=""
    HOMEBREW_PATCHED_RECIPE_RUNNER=""
    HOMEBREW_PATCHED_RECIPE_RUNNER_STATE=""
    HOMEBREW_PATCHED_RECIPE_RUNNER_SHA256=""
    HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG=""
    HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE=""
    HOMEBREW_PATCHED_RECIPE_SEALED_ROOT=""
    HOMEBREW_PATCHED_RECIPE_SUPERVISOR_UNIT=""
    HOMEBREW_PATCHED_RECIPE_USER=""
    HOMEBREW_PATCHED_RECIPE_UID=""
    HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION=""
    HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE=""
    HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256=""
  fi
  if [ -n "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR" ]; then
    if ! "$HOMEBREW_PATCHED_SUDO_BIN" rm -rf "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR" \
         >/dev/null 2>&1 || [ -e "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR" ] || \
         [ -L "$HOMEBREW_PATCHED_SOURCE_ALIAS_DIR" ]; then
      echo "homebrew-patched-launcher: source aliases could not be removed; preserving cleanup state for retry" >&2
      return 1
    fi
    HOMEBREW_PATCHED_SOURCE_ALIAS_DIR=""
  fi
  if [ -n "$HOMEBREW_PATCHED_LAUNCHER" ] && [ -L "$HOMEBREW_PATCHED_LAUNCHER" ]; then
    rm -f "$HOMEBREW_PATCHED_LAUNCHER" 2>/dev/null || \
      "$HOMEBREW_PATCHED_SUDO_BIN" rm -f "$HOMEBREW_PATCHED_LAUNCHER" \
        >/dev/null 2>&1 || true
  fi
  if ! homebrew_patched_launcher_restore_overlay_for_cleanup; then
    echo "homebrew-patched-launcher: sealed Homebrew overlay could not be restored; preserving launcher state for retry" >&2
    return 1
  fi
  if [ -n "$HOMEBREW_PATCHED_REPO" ] && \
     [ -n "$HOMEBREW_PATCHED_OVERLAY" ]; then
    if homebrew_patched_launcher_worktree_registration_status \
         "$HOMEBREW_PATCHED_REPO" "$HOMEBREW_PATCHED_OVERLAY"; then
      worktree_registration_status=0
    else
      worktree_registration_status="$?"
    fi
    if [ "$worktree_registration_status" -eq 2 ]; then
      echo "homebrew-patched-launcher: Homebrew overlay registration could not be verified; preserving launcher state for retry" >&2
      return 1
    fi
    if [ -d "$HOMEBREW_PATCHED_OVERLAY" ] || \
       [ "$worktree_registration_status" -eq 0 ]; then
      if ! git -C "$HOMEBREW_PATCHED_REPO" worktree remove --force \
           "$HOMEBREW_PATCHED_OVERLAY" >/dev/null 2>&1; then
        echo "homebrew-patched-launcher: Homebrew overlay removal failed; preserving launcher state for retry" >&2
        return 1
      fi
    fi
  fi
  HOMEBREW_PATCHED_SUDO_BIN=""
  HOMEBREW_PATCHED_SYSTEMD_RUN_BIN=""
  HOMEBREW_PATCHED_SYSTEMCTL_BIN=""
  HOMEBREW_PATCHED_GETENT_BIN=""
  HOMEBREW_PATCHED_PGREP_BIN=""
  HOMEBREW_PATCHED_PKILL_BIN=""
  HOMEBREW_PATCHED_BUILD_USER=""
  HOMEBREW_PATCHED_BUILD_UID=""
  HOMEBREW_PATCHED_SYSTEMD_SLICE=""
  HOMEBREW_PATCHED_TEARDOWN_COMPLETE=0
  HOMEBREW_PATCHED_INTEGRITY_SHA256=""
  HOMEBREW_PATCHED_OVERLAY_OWNER_UID=""
  HOMEBREW_PATCHED_OVERLAY_SEAL_STATE=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_SHA256=""
  HOMEBREW_PATCHED_DEPENDENCY_PLAN_STATE=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_SHA256=""
  HOMEBREW_PATCHED_TIER2_ATTESTATION_STATE=""
  HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR=""
  HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE=""
  HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256=""
  HOMEBREW_PATCHED_PLATFORM_ROOT=""
  HOMEBREW_PATCHED_PLATFORM_SHA256=""
  HOMEBREW_PATCHED_FORMULA_TEST_ROOT=""
  HOMEBREW_PATCHED_FORMULA_TEST_SHA256=""
  HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE=""
  HOMEBREW_PATCHED_SYSROOT_ROOT=""
  HOMEBREW_PATCHED_SYSROOT_SHA256=""
  HOMEBREW_PATCHED_RECIPE_RUNNER=""
  HOMEBREW_PATCHED_RECIPE_RUNNER_STATE=""
  HOMEBREW_PATCHED_RECIPE_RUNNER_SHA256=""
  HOMEBREW_PATCHED_RECIPE_RUNNER_CONFIG=""
  HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE=""
  HOMEBREW_PATCHED_RECIPE_SEALED_ROOT=""
  HOMEBREW_PATCHED_RECIPE_SUPERVISOR_UNIT=""
  HOMEBREW_PATCHED_RECIPE_USER=""
  HOMEBREW_PATCHED_RECIPE_UID=""
  HOMEBREW_PATCHED_CONTROL_FILE_PATH=()
  HOMEBREW_PATCHED_CONTROL_FILE_BASENAME=()
  HOMEBREW_PATCHED_CONTROL_FILE_LABEL=()
  HOMEBREW_PATCHED_CONTROL_FILE_MAX_BYTES=()
  HOMEBREW_PATCHED_CONTROL_FILE_SHA256=()
  HOMEBREW_PATCHED_CONTROL_FILE_STATE=()
  HOMEBREW_PATCHED_NATIVE_PREFIX=""
  HOMEBREW_PATCHED_NATIVE_CACHE=""
  HOMEBREW_PATCHED_NATIVE_TEMP=""
  HOMEBREW_PATCHED_NATIVE_CONFIG=""
  HOMEBREW_PATCHED_NATIVE_HOME=""
  HOMEBREW_PATCHED_NATIVE_BREW_BIN=""
  HOMEBREW_PATCHED_NATIVE_RUNNER=""
  HOMEBREW_PATCHED_NATIVE_SEALED=0
  HOMEBREW_PATCHED_NATIVE_API_SOURCE=""
  HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR=""
  HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION=""
  HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE=""
  HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256=""
  HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES=()
  HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP=""
  HOMEBREW_PATCHED_STAGED_INPUT_DIR=""
  HOMEBREW_PATCHED_STAGED_INPUT_PATH=""
  HOMEBREW_PATCHED_REPO=""
  HOMEBREW_PATCHED_PREFIX=""
  HOMEBREW_PATCHED_BREW_BIN=""
  HOMEBREW_PATCHED_OVERLAY=""
  HOMEBREW_PATCHED_LAUNCHER=""
}

# Return a child of BASE whose byte length exactly matches Linuxbrew's bottle
# prefix. Homebrew's fixed-prefix binary relocation pads shorter replacements
# with NUL bytes; some runtimes (notably Perl) expose those bytes through their
# compiled search paths instead of treating them as harmless string padding.
homebrew_patched_launcher_native_prefix_path() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_native_prefix_path: expected BASE" >&2
    return 2
  fi
  local base realpath_bin bottle_prefix=/home/linuxbrew/.linuxbrew
  local base_bytes bottle_prefix_bytes suffix_bytes suffix
  realpath_bin="$(command -v realpath || true)"
  [ -n "$realpath_bin" ] && [ -x "$realpath_bin" ] || {
    echo "homebrew-patched-launcher: realpath is required to select the native prefix" >&2
    return 2
  }
  base="$("$realpath_bin" -m -- "$1")" || return 2
  base_bytes="$(LC_ALL=C printf '%s' "$base" | wc -c | tr -d '[:space:]')"
  bottle_prefix_bytes="$(LC_ALL=C printf '%s' "$bottle_prefix" | wc -c | tr -d '[:space:]')"
  suffix_bytes=$((bottle_prefix_bytes - base_bytes - 1))
  if [ "$suffix_bytes" -lt 1 ]; then
    echo "homebrew-patched-launcher: native prefix base leaves no room for an exact Linuxbrew relocation path: $base" >&2
    return 2
  fi
  printf -v suffix '%*s' "$suffix_bytes" ''
  suffix="${suffix// /p}"
  printf '%s/%s\n' "$base" "$suffix"
}

# Give native Homebrew its own prefix while reusing the exact reviewed source
# overlay. Host Formulae and their recursive closure never occupy the target
# Cellar, so a native dependency may share a short name with the Kandelo target.
homebrew_patched_launcher_prepare_native_prefix() {
  if [ "$#" -ne 5 ]; then
    echo "homebrew_patched_launcher_prepare_native_prefix: expected PREFIX CACHE TEMP CONFIG HOME" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_OVERLAY" ] || [ -z "$HOMEBREW_PATCHED_PREFIX" ]; then
    echo "homebrew-patched-launcher: prepare the reviewed Homebrew overlay first" >&2
    return 2
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: cannot prepare the native prefix after isolation" >&2
    return 2
  fi

  local native_prefix="$1" native_cache="$2" native_temp="$3" native_config="$4"
  local native_home="$5"
  local path other native_brew reported_prefix reported_repo realpath_bin i j
  local native_prefix_bytes native_cellar_bytes
  local bottle_prefix_bytes bottle_cellar_bytes
  local -a native_inputs native_roots target_inputs target_roots
  realpath_bin="$(command -v realpath || true)"
  [ -n "$realpath_bin" ] && [ -x "$realpath_bin" ] || {
    echo "homebrew-patched-launcher: realpath is required to validate native roots" >&2
    return 2
  }
  native_inputs=("$native_prefix" "$native_cache" "$native_temp" "$native_config" "$native_home")
  for path in "${native_inputs[@]}"; do
    if [ -e "$path" ] && { [ ! -d "$path" ] || [ -L "$path" ]; }; then
      echo "homebrew-patched-launcher: native Homebrew root is not a real directory: $path" >&2
      return 2
    fi
    case "$path" in
      *:*)
        echo "homebrew-patched-launcher: native Homebrew root cannot contain ':' for a systemd bind: $path" >&2
        return 2
        ;;
    esac
    path="$("$realpath_bin" -m -- "$path")" || return 2
    [ "$path" != / ] || {
      echo "homebrew-patched-launcher: native Homebrew root cannot be /" >&2
      return 2
    }
    native_roots+=("$path")
  done

  target_inputs=(
    "$HOMEBREW_PATCHED_PREFIX"
    "$HOMEBREW_CACHE"
    "$HOMEBREW_TEMP"
    "$XDG_CONFIG_HOME"
  )
  for other in "${target_inputs[@]}"; do
    [ -n "$other" ] || continue
    target_roots+=("$("$realpath_bin" -m -- "$other")") || return 2
  done
  for ((i = 0; i < ${#native_roots[@]}; i++)); do
    path="${native_roots[$i]}"
    for ((j = i + 1; j < ${#native_roots[@]}; j++)); do
      other="${native_roots[$j]}"
      if [ "$path" = "$other" ]; then
        echo "homebrew-patched-launcher: native Homebrew roots must differ: $path" >&2
        return 2
      fi
      case "$path/" in
        "$other/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $other -> $path" >&2
          return 2
          ;;
      esac
      case "$other/" in
        "$path/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $path -> $other" >&2
          return 2
          ;;
      esac
    done
    for other in "${target_roots[@]}"; do
      [ -n "$other" ] || continue
      if [ "$path" = "$other" ]; then
        echo "homebrew-patched-launcher: native and target Homebrew roots must differ: $path" >&2
        return 2
      fi
      case "$path/" in
        "$other/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $other -> $path" >&2
          return 2
          ;;
      esac
      case "$other/" in
        "$path/"*)
          echo "homebrew-patched-launcher: Homebrew state roots must not contain one another: $path -> $other" >&2
          return 2
          ;;
      esac
    done
  done
  # A shorter binary replacement is NUL-padded by Homebrew. That is acceptable
  # for many native tools but corrupts compiled path arrays in runtimes such as
  # Perl, which then surface the padding as part of @INC. Use the exact build
  # prefix length so native bottles need neither padding nor truncation.
  native_prefix_bytes="$(LC_ALL=C printf '%s' "${native_roots[0]}" | wc -c | tr -d '[:space:]')"
  native_cellar_bytes="$(LC_ALL=C printf '%s' "${native_roots[0]}/Cellar" | wc -c | tr -d '[:space:]')"
  bottle_prefix_bytes="$(LC_ALL=C printf '%s' /home/linuxbrew/.linuxbrew | wc -c | tr -d '[:space:]')"
  bottle_cellar_bytes="$(LC_ALL=C printf '%s' /home/linuxbrew/.linuxbrew/Cellar | wc -c | tr -d '[:space:]')"
  if [ "$native_prefix_bytes" -ne "$bottle_prefix_bytes" ] ||
     [ "$native_cellar_bytes" -ne "$bottle_cellar_bytes" ]; then
    echo "homebrew-patched-launcher: native prefix must exactly match fixed-prefix Linuxbrew bottle path lengths: ${native_roots[0]}" >&2
    return 2
  fi
  for path in "${native_roots[@]}"; do
    mkdir -p "$path"
    [ -d "$path" ] && [ ! -L "$path" ] || {
      echo "homebrew-patched-launcher: native Homebrew root changed during preparation: $path" >&2
      return 2
    }
    chmod 0700 "$path"
  done
  HOMEBREW_PATCHED_NATIVE_PREFIX="${native_roots[0]}"
  HOMEBREW_PATCHED_NATIVE_CACHE="${native_roots[1]}"
  HOMEBREW_PATCHED_NATIVE_TEMP="${native_roots[2]}"
  HOMEBREW_PATCHED_NATIVE_CONFIG="${native_roots[3]}"
  HOMEBREW_PATCHED_NATIVE_HOME="${native_roots[4]}"
  mkdir -p "$HOMEBREW_PATCHED_NATIVE_PREFIX/bin"
  native_brew="$HOMEBREW_PATCHED_NATIVE_PREFIX/bin/brew"
  [ ! -e "$native_brew" ] && [ ! -L "$native_brew" ] || {
    echo "homebrew-patched-launcher: native Homebrew launcher already exists" >&2
    return 2
  }
  ln -s "$HOMEBREW_PATCHED_OVERLAY/bin/brew" "$native_brew"
  HOMEBREW_PATCHED_NATIVE_BREW_BIN="$native_brew"

  reported_prefix="$(
    unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG \
      HOMEBREW_KANDELO_PRIMARY_TAP_ROOT
    HOME="$HOMEBREW_PATCHED_NATIVE_HOME" \
      XDG_CONFIG_HOME="$HOMEBREW_PATCHED_NATIVE_CONFIG" \
      HOMEBREW_CACHE="$HOMEBREW_PATCHED_NATIVE_CACHE" \
      HOMEBREW_TEMP="$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$native_brew" --prefix
  )" || return
  reported_repo="$(
    unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG
    HOME="$HOMEBREW_PATCHED_NATIVE_HOME" \
      XDG_CONFIG_HOME="$HOMEBREW_PATCHED_NATIVE_CONFIG" \
      HOMEBREW_CACHE="$HOMEBREW_PATCHED_NATIVE_CACHE" \
      HOMEBREW_TEMP="$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$native_brew" --repository
  )" || return
  if [ "$reported_prefix" != "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    echo "homebrew-patched-launcher: native Homebrew reported the wrong prefix" >&2
    return 1
  fi
  if [ "$(cd "$reported_repo" && pwd -P)" != "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ]; then
    echo "homebrew-patched-launcher: native Homebrew did not use the reviewed overlay" >&2
    return 1
  fi
}

homebrew_patched_launcher_set_native_api_source() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_set_native_api_source: expected API-ROOT" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_NATIVE_CACHE" ] || \
     [ -n "$HOMEBREW_PATCHED_BUILD_USER" ] || \
     [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ]; then
    echo "homebrew-patched-launcher: native API source must be selected once before isolation" >&2
    return 2
  fi
  local source unsafe
  source="$(/usr/bin/realpath -- "$1")" || return
  case "$source" in
    /*) ;;
    *)
      echo "homebrew-patched-launcher: native API source must be absolute" >&2
      return 2
      ;;
  esac
  [ -d "$source" ] && [ ! -L "$source" ] &&
    [ "$(/usr/bin/stat -c '%u:%g:%a' "$source")" = "0:0:555" ] || {
    echo "homebrew-patched-launcher: native API source root is not sealed" >&2
    return 2
  }
  unsafe="$(
    /usr/bin/find "$source" -xdev -mindepth 1 \
      ! \( \( -type d -user root -group root -perm 0555 \) -o \
           \( -type f -user root -group root -perm 0444 \) \) \
      -print -quit
  )" || return
  [ -z "$unsafe" ] || {
    echo "homebrew-patched-launcher: native API source contains an unsafe entry: $unsafe" >&2
    return 2
  }
  for required in formula.jws.json formula_aliases.txt formula_names.txt \
    internal/executables.txt internal/packages.x86_64_linux.jws.json; do
    [ -f "$source/$required" ] && [ ! -L "$source/$required" ] || {
      echo "homebrew-patched-launcher: native API source lacks $required" >&2
      return 2
    }
  done
  HOMEBREW_PATCHED_NATIVE_API_SOURCE="$source"
}

homebrew_patched_launcher_stage_native_contract_file() {
  if [ "$#" -ne 3 ]; then
    echo "homebrew_patched_launcher_stage_native_contract_file: expected SOURCE BASENAME MAX-BYTES" >&2
    return 2
  fi
  local source="$1" basename="$2" max_bytes="$3"
  local destination before after destination_digest bytes
  if [ -z "$HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR" ] || \
     [ -z "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: native contract directory is unavailable" >&2
    return 2
  fi
  [[ "$basename" =~ ^[a-z][a-z0-9._-]*\.(json|rb|txt)$ ]] &&
    [[ "$max_bytes" =~ ^[1-9][0-9]*$ ]] || {
    echo "homebrew-patched-launcher: invalid native contract file declaration" >&2
    return 2
  }
  [ -f "$source" ] && [ ! -L "$source" ] || {
    echo "homebrew-patched-launcher: native contract source is not regular" >&2
    return 2
  }
  bytes="$(/usr/bin/stat -c '%s' "$source")" || return
  [ "$bytes" -gt 0 ] && [ "$bytes" -le "$max_bytes" ] || {
    echo "homebrew-patched-launcher: native contract source exceeds its size limit" >&2
    return 2
  }
  before="$(/usr/bin/sha256sum "$source")" || return
  before="${before%% *}"
  destination="$HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR/$basename"
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || {
    echo "homebrew-patched-launcher: native contract destination already exists" >&2
    return 2
  }
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/install \
    -o root -g root -m 0444 "$source" "$destination" || return
  after="$(/usr/bin/sha256sum "$source")" || return
  after="${after%% *}"
  destination_digest="$(/usr/bin/sha256sum "$destination")" || return
  destination_digest="${destination_digest%% *}"
  [ "$before" = "$after" ] &&
    [ "$(/usr/bin/stat -c '%u:%g:%a:%h:%s' "$destination")" = \
      "0:0:444:1:$bytes" ] &&
    [ "$destination_digest" = "$before" ] || {
    echo "homebrew-patched-launcher: staged native contract file changed" >&2
    return 1
  }
  printf '%s\n' "$destination"
}

homebrew_patched_launcher_verify_native_overlay_attestation() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_verify_native_overlay_attestation: expected no arguments" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION" ] && \
     [ -z "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE" ] && \
     [ -z "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256" ]; then
    return 0
  fi

  local expected actual_state actual_sha actual_integrity
  expected="$HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR/native-overlay-attestation.json"
  actual_state="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' \
    "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION" 2>/dev/null || true)"
  actual_sha="$(/usr/bin/sha256sum \
    "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION" 2>/dev/null || true)"
  actual_sha="${actual_sha%% *}"
  if ! actual_integrity="$(
    homebrew_patched_launcher_integrity 2>/dev/null
  )"; then
    actual_integrity=""
  fi
  if [ "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION" != "$expected" ] || \
     [ ! -f "$expected" ] || [ -L "$expected" ] || \
     [ "$actual_state" != \
       "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE" ] || \
     [ "$actual_sha" != \
       "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256" ] || \
     [ "$actual_integrity" != "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ]; then
    echo "homebrew-patched-launcher: sealed Homebrew identity attestation changed" >&2
    return 1
  fi
}

homebrew_patched_launcher_stage_native_overlay_attestation() {
  if [ "$#" -ne 5 ]; then
    echo "homebrew_patched_launcher_stage_native_overlay_attestation: expected WORK-DIR JQ BUILD-USER COMMIT TREE" >&2
    return 2
  fi
  local work_dir="$1" jq_bin="$2" build_user="$3"
  local commit="$4" tree="$5"
  local repository integrity source destination destination_sha
  if [ ! -d "$work_dir" ] || [ -L "$work_dir" ] || \
     [ "$HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" != "sealed" ] || \
     [ -z "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ] || \
     [ -n "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION" ] || \
     [ -n "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE" ] || \
     [ -n "$HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256" ]; then
    echo "homebrew-patched-launcher: sealed Homebrew identity cannot be attested" >&2
    return 2
  fi
  repository="$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" || return
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || {
    echo "homebrew-patched-launcher: sealed Homebrew base commit is invalid" >&2
    return 2
  }
  [[ "$tree" =~ ^[0-9a-f]{40}$ ]] || {
    echo "homebrew-patched-launcher: sealed Homebrew base tree is invalid" >&2
    return 2
  }
  integrity="$HOMEBREW_PATCHED_INTEGRITY_SHA256"
  [[ "$integrity" =~ ^[0-9a-f]{64}$ ]] || {
    echo "homebrew-patched-launcher: sealed Homebrew integrity is invalid" >&2
    return 2
  }

  # WHY: the isolated native process can read the sealed overlay but cannot
  # traverse the workflow-owned Git directory referenced by its `.git` file.
  # Record the commit and frozen overlay digest while that metadata is still
  # available, then copy the record into the root-owned native contract.
  # `/tmp` is sticky and this private 0600 file is owned by the trusted
  # launcher. The Formula user owns WORK-DIR and could otherwise replace a
  # pathname between JSON creation and the root-owned install below.
  source="$(/usr/bin/mktemp \
    /tmp/kandelo-native-overlay-attestation.XXXXXX)" || return
  if ! "$jq_bin" -S -n \
      --arg commit "$commit" \
      --arg integrity "$integrity" \
      --arg repository "$repository" \
      --arg tree "$tree" \
      '{
        schema: 1,
        kind: "kandelo-homebrew-native-overlay-attestation",
        homebrew_commit: $commit,
        homebrew_tree: $tree,
        repository: $repository,
        overlay_state_sha256: $integrity
      }' >"$source" || \
     ! /usr/bin/chmod 0600 "$source"; then
    /usr/bin/rm -f -- "$source"
    return 1
  fi
  destination="$HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR/native-overlay-attestation.json"
  if [ -e "$destination" ] || [ -L "$destination" ] || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/install \
       -o root -g root -m 0444 "$source" "$destination"; then
    /usr/bin/rm -f -- "$source"
    echo "homebrew-patched-launcher: could not protect the sealed Homebrew identity" >&2
    return 1
  fi
  /usr/bin/rm -f -- "$source" || return
  destination_sha="$(/usr/bin/sha256sum "$destination")" || return
  destination_sha="${destination_sha%% *}"
  [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$destination")" = \
      "0:0:444:1" ] && \
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
      /usr/bin/test -r "$destination" && \
    ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
      /usr/bin/test -w "$destination" || {
    echo "homebrew-patched-launcher: sealed Homebrew identity has unsafe access" >&2
    return 1
  }
  HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION="$destination"
  HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE="$(
    /usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$destination"
  )" || return
  HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256="$destination_sha"
  homebrew_patched_launcher_verify_native_overlay_attestation
}

homebrew_patched_launcher_run_native() {
  if [ "$#" -eq 0 ]; then
    echo "homebrew_patched_launcher_run_native: expected a Homebrew command" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ]; then
    echo "homebrew-patched-launcher: native Homebrew is not prepared" >&2
    return 2
  fi
  homebrew_patched_launcher_verify_native_overlay_attestation || return
  if [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ]; then
    echo "homebrew-patched-launcher: native Homebrew is sealed" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    [ "${GITHUB_ACTIONS:-}" != "true" ] || {
      echo "homebrew-patched-launcher: CI native Formula execution requires isolation" >&2
      return 2
    }
    (
      unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG \
        HOMEBREW_KANDELO_PRIMARY_TAP_ROOT
      HOME="$HOMEBREW_PATCHED_NATIVE_HOME" \
        XDG_CONFIG_HOME="$HOMEBREW_PATCHED_NATIVE_CONFIG" \
        HOMEBREW_CACHE="$HOMEBREW_PATCHED_NATIVE_CACHE" \
        HOMEBREW_TEMP="$HOMEBREW_PATCHED_NATIVE_TEMP" \
        HOMEBREW_RELOCATE_BUILD_PREFIX=1 \
        "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" "$@"
    )
    return
  fi
  [ -n "$HOMEBREW_PATCHED_NATIVE_RUNNER" ] || {
    echo "homebrew-patched-launcher: isolated native Homebrew runner is unavailable" >&2
    return 2
  }
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_NATIVE_RUNNER" "$@"
}

homebrew_patched_launcher_verify_isolated_native_identity() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_verify_isolated_native_identity: expected no arguments" >&2
    return 2
  fi
  [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] || return 0
  local native_reported_prefix native_reported_repo status
  if native_reported_prefix="$(
    homebrew_patched_launcher_run_native --prefix
  )"; then
    :
  else
    status="$?"
    echo "homebrew-patched-launcher: isolated native prefix probe failed with status $status" >&2
    return "$status"
  fi
  if native_reported_repo="$(
    homebrew_patched_launcher_run_native --repository
  )"; then
    :
  else
    status="$?"
    echo "homebrew-patched-launcher: isolated native repository probe failed with status $status" >&2
    return "$status"
  fi
  [ "$native_reported_prefix" = "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] || {
    echo "homebrew-patched-launcher: isolated native Homebrew changed its prefix" >&2
    return 1
  }
  [ "$(cd "$native_reported_repo" && pwd -P)" = \
    "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ] || {
    echo "homebrew-patched-launcher: isolated native Homebrew changed its repository" >&2
    return 1
  }
}

homebrew_patched_launcher_audit_native_projection_links() {
  local runner python
  local -a audit_args
  if [ -z "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    echo "homebrew-patched-launcher: native Homebrew is unavailable" >&2
    return 2
  fi
  audit_args=(
    --audit-native-links
    --source "$HOMEBREW_PATCHED_NATIVE_PREFIX"
  )
  if [ "${1:-}" = "--only-additional-trees" ]; then
    audit_args+=(--only-additional-trees)
    shift
  fi
  while [ "$#" -gt 0 ]; do
    audit_args+=(--tree "$1")
    shift
  done
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    runner="$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR"
    python=/usr/bin/python3
    [ -n "$runner" ] || {
      echo "homebrew-patched-launcher: native link-chain auditor is unavailable" >&2
      return 2
    }
    homebrew_patched_launcher_verify_native_link_auditor || return
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/env -i \
      "$python" -I "$runner" "${audit_args[@]}"
    return
  fi
  runner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/homebrew-tap-recipe-runner.py"
  python="$(command -v python3)" || {
    echo "homebrew-patched-launcher: python3 is required for native link auditing" >&2
    return 2
  }
  [ -f "$runner" ] && [ ! -L "$runner" ] || {
    echo "homebrew-patched-launcher: native link-chain auditor is unavailable" >&2
    return 2
  }
  "$python" -I "$runner" "${audit_args[@]}"
}

homebrew_patched_launcher_seal_native_prefix() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_seal_native_prefix: expected no arguments" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_NATIVE_PREFIX" ] || [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ]; then
    echo "homebrew-patched-launcher: native Homebrew is unavailable or already sealed" >&2
    return 2
  fi
  local unsafe_entry status
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    if homebrew_patched_launcher_uid_has_processes; then
      echo "homebrew-patched-launcher: native Formula process survived before sealing" >&2
      return 1
    else
      status="$?"
      [ "$status" -eq 1 ] || return "$status"
    fi
    unsafe_entry="$("$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev \
      ! \( -type d -o -type f -o -type l \) -print -quit)" || return 2
    [ -z "$unsafe_entry" ] || {
      echo "homebrew-patched-launcher: native Homebrew contains a special entry: $unsafe_entry" >&2
      return 1
    }
    # WHY: a final realpath can leave the future mount namespace through a
    # writable link and re-enter a keg. Audit every component using the same
    # Cellar/opt/prefix-lib/host projection model as the recipe runner. Other
    # prefix paths (including the overlay brew link) are never mounted.
    homebrew_patched_launcher_audit_native_projection_links || return
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown -hR root:root \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX"
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev -type d -exec /usr/bin/chmod 0555 {} +
    # WHY: Homebrew bottles may preserve owner-only or group-only read modes.
    # Merely removing write bits can leave a root-owned 0400 file unreadable
    # to the recipe identity. Preserve only executable meaning and publish one
    # canonical readable mode for every regular file in the sealed closure.
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev -type f -perm /0111 \
      -exec /usr/bin/chmod 0555 {} +
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" -xdev -type f ! -perm /0111 \
      -exec /usr/bin/chmod 0444 {} +
    homebrew_assert_tree_not_writable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"
    homebrew_assert_tree_not_replaceable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"
    if [ -n "$HOMEBREW_PATCHED_RECIPE_RUNNER" ]; then
      [ "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE" = \
        "$HOMEBREW_PATCHED_PROTECTED_DIR/native-closure.json" ] || {
        echo "homebrew-patched-launcher: native closure handoff path is incomplete" >&2
        return 2
      }
      # WHY: the supervisor was deliberately started while this path was
      # absent. Publish the inventory only after every native install has
      # finished and the entire prefix is root-owned/read-only. The target
      # Formula therefore cannot add a sealed-looking rack to the closure it
      # later receives.
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/env -i \
        /usr/bin/python3 -I "$HOMEBREW_PATCHED_RECIPE_RUNNER" \
        --stage-native-closure \
        --source "$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar" \
        --destination "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE" || return
    fi
  else
    # The developer path has no privileged staging handoff, so run the same
    # component-safe projection audit before changing launcher state.
    homebrew_patched_launcher_audit_native_projection_links || return
  fi
  HOMEBREW_PATCHED_NATIVE_SEALED=1
}

# Preserve relative links from a direct native Formula into its recursive
# closure without copying that closure into the target Cellar. The component
# audit has already admitted every hop and the source prefix is root-owned and
# read-only in the privileged path. `realpath` below therefore selects the
# canonical destination of an already-proved chain; it is not the confinement
# check. The copied tree is component-audited again before it is exposed.
homebrew_patched_launcher_rewrite_native_bridge_links() {
  if [ "$#" -ne 2 ]; then
    echo "homebrew_patched_launcher_rewrite_native_bridge_links: expected NATIVE_KEG TARGET_KEG" >&2
    return 2
  fi
  local native_keg="$1" target_keg="$2"
  local rewrite_bash rewrite_find rewrite_ln rewrite_readlink rewrite_realpath rewrite_rm
  local rewrite_script
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    rewrite_bash=/usr/bin/bash
    rewrite_find=/usr/bin/find
    rewrite_ln=/usr/bin/ln
    rewrite_readlink=/usr/bin/readlink
    rewrite_realpath=/usr/bin/realpath
    rewrite_rm=/usr/bin/rm
  else
    rewrite_bash="$(command -v bash)"
    rewrite_find="$(command -v find)"
    rewrite_ln="$(command -v ln)"
    rewrite_readlink="$(command -v readlink)"
    rewrite_realpath="$(command -v realpath)"
    rewrite_rm="$(command -v rm)"
  fi
  rewrite_script='
    set -euo pipefail
    native_keg="$1"
    target_keg="$2"
    native_prefix="$3"
    find_bin="$4"
    ln_bin="$5"
    readlink_bin="$6"
    realpath_bin="$7"
    rm_bin="$8"
    while IFS= read -r -d "" link; do
      target="$("$readlink_bin" "$link")"
      [[ "$target" != /* ]] || continue
      resolved="$("$realpath_bin" -m -- "${link%/*}/$target")"
      case "$resolved" in
        "$native_keg"|"$native_keg"/*) continue ;;
        "$native_prefix"|"$native_prefix"/*)
          [ -e "$resolved" ] || {
            echo "homebrew-patched-launcher: native Formula cross-keg link is unresolved: $link -> $target" >&2
            exit 1
          }
          ;;
        *)
          echo "homebrew-patched-launcher: native Formula cross-keg link escaped after validation: $link -> $target" >&2
          exit 1
          ;;
      esac
      case "$link" in
        "$native_keg"/*) relative="${link#"$native_keg"/}" ;;
        *)
          echo "homebrew-patched-launcher: native Formula link left its selected keg: $link" >&2
          exit 1
          ;;
      esac
      target_link="$target_keg/$relative"
      [ -L "$target_link" ] && [ "$("$readlink_bin" "$target_link")" = "$target" ] || {
        echo "homebrew-patched-launcher: copied native Formula link differs from its sealed source: $relative" >&2
        exit 1
      }
      "$rm_bin" -f -- "$target_link"
      "$ln_bin" -s -- "$resolved" "$target_link"
    done < <("$find_bin" "$native_keg" -xdev -type l -print0)
  '
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$rewrite_bash" -c "$rewrite_script" \
      kandelo-native-bridge-link-rewrite \
      "$native_keg" "$target_keg" "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$rewrite_find" "$rewrite_ln" "$rewrite_readlink" "$rewrite_realpath" \
      "$rewrite_rm"
  else
    "$rewrite_bash" -c "$rewrite_script" kandelo-native-bridge-link-rewrite \
      "$native_keg" "$target_keg" "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$rewrite_find" "$rewrite_ln" "$rewrite_readlink" "$rewrite_realpath" \
      "$rewrite_rm"
  fi
}

# Surface only a direct native dependency to target Homebrew. Its selected keg
# is copied into a canonical target rack; its recursive native closure remains
# in the separate prefix for embedded absolute paths and cannot collide with a
# target rack of the same short name.
homebrew_patched_launcher_bridge_native_formula() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_bridge_native_formula: expected FORMULA" >&2
    return 2
  fi
  local formula="$1" native_rack native_opt native_opt_target native_version
  local target_cellar target_opt target_rack target_keg target_opt_target
  local build_gid="" target_state_root bridge_status=0
  if ! [[ "$formula" =~ ^[a-z0-9][a-z0-9@+_.-]*$ ]]; then
    echo "homebrew-patched-launcher: invalid native Formula name: $formula" >&2
    return 2
  fi
  [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ] || {
    echo "homebrew-patched-launcher: seal native Homebrew before bridging Formulae" >&2
    return 2
  }
  if [[ " ${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[*]} " == *" $formula "* ]]; then
    echo "homebrew-patched-launcher: duplicate native Formula bridge: $formula" >&2
    return 2
  fi
  native_rack="$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar/$formula"
  native_opt="$HOMEBREW_PATCHED_NATIVE_PREFIX/opt/$formula"
  target_cellar="$HOMEBREW_PATCHED_PREFIX/Cellar"
  target_opt="$HOMEBREW_PATCHED_PREFIX/opt"
  [ -d "$native_rack" ] && [ ! -L "$native_rack" ] && \
    [ -e "$native_opt" ] && [ -L "$native_opt" ] || {
    echo "homebrew-patched-launcher: native Formula is not completely installed: $formula" >&2
    return 1
  }
  native_opt_target="$(cd "$native_opt" && pwd -P)" || {
    echo "homebrew-patched-launcher: native Formula opt link is unresolved: $formula" >&2
    return 1
  }
  [ "${native_opt_target%/*}" = "$native_rack" ] || {
    echo "homebrew-patched-launcher: native Formula opt link leaves its rack: $formula" >&2
    return 1
  }
  native_version="${native_opt_target##*/}"
  target_rack="$target_cellar/$formula"
  target_keg="$target_rack/$native_version"
  target_opt_target="../Cellar/$formula/$native_version"
  [ ! -e "$target_rack" ] && [ ! -L "$target_rack" ] && \
    [ ! -e "$target_opt/$formula" ] && [ ! -L "$target_opt/$formula" ] || {
      echo "homebrew-patched-launcher: target prefix already contains native Formula name: $formula" >&2
    return 1
  }

  # Re-audit here as well as at seal time. This is redundant for the immutable
  # privileged prefix, but keeps the non-privileged developer path honest and
  # makes bridge creation depend on the same component-safe closure contract.
  if ! homebrew_patched_launcher_audit_native_projection_links \
    --only-additional-trees "$native_opt_target"; then
    echo "homebrew-patched-launcher: native Formula has a symlink that cannot be safely relocated: $formula" >&2
    return 1
  fi

  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    build_gid="$(/usr/bin/id -g "$HOMEBREW_PATCHED_BUILD_USER")"
    for target_state_root in "$target_cellar" "$target_opt"; do
      [ -d "$target_state_root" ] && [ ! -L "$target_state_root" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_state_root")" = "0:$build_gid:1775" ] || {
          echo "homebrew-patched-launcher: protected target Homebrew root changed: $target_state_root" >&2
          return 1
        }
    done
  else
    for target_state_root in "$target_cellar" "$target_opt"; do
      if [ -e "$target_state_root" ] || [ -L "$target_state_root" ]; then
        [ -d "$target_state_root" ] && [ ! -L "$target_state_root" ] || {
          echo "homebrew-patched-launcher: target Homebrew root is not a real directory: $target_state_root" >&2
          return 1
        }
      else
        mkdir -p "$target_state_root"
      fi
    done
  fi

  # Register the transaction before its first filesystem change. Cleanup then
  # knows about a partially copied rack even if the opt link or verification
  # fails.
  HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES+=("$formula")
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/install -d \
      -o root -g root -m 0700 "$target_rack" "$target_keg" || bridge_status=1
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/cp -R -p \
        "$native_opt_target/." "$target_keg/" || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      homebrew_patched_launcher_rewrite_native_bridge_links \
        "$native_opt_target" "$target_keg" || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown -hR root:root \
        "$target_rack" || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
        "$target_rack" -xdev -type d -exec /usr/bin/chmod 0555 {} + || \
        bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/find \
        "$target_rack" -xdev -type f \
        -exec /usr/bin/chmod a-w,u-s,g-s {} + || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      homebrew_patched_launcher_audit_native_projection_links \
        --only-additional-trees "$target_keg" || bridge_status=1
    fi
    if [ "$bridge_status" -eq 0 ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/ln -s \
        "$target_opt_target" "$target_opt/$formula" || bridge_status=1
    fi
  else
    if ! install -d -m 0755 "$target_rack" "$target_keg"; then
      bridge_status=1
    elif ! cp -R -p "$native_opt_target/." "$target_keg/"; then
      bridge_status=1
    elif ! homebrew_patched_launcher_rewrite_native_bridge_links \
      "$native_opt_target" "$target_keg"; then
      bridge_status=1
    elif ! find "$target_rack" -type d -exec chmod a-w {} +; then
      bridge_status=1
    elif ! find "$target_rack" -type f -exec chmod a-w,u-s,g-s {} +; then
      bridge_status=1
    elif ! homebrew_patched_launcher_audit_native_projection_links \
      --only-additional-trees "$target_keg"; then
      bridge_status=1
    elif ! ln -s "$target_opt_target" "$target_opt/$formula"; then
      bridge_status=1
    fi
  fi
  if [ "$bridge_status" -eq 0 ] && \
     { [ ! -d "$target_rack" ] || [ -L "$target_rack" ] || \
       [ ! -d "$target_keg" ] || [ -L "$target_keg" ] || \
       [ "$(cd "$target_keg" && pwd -P)" != "$target_keg" ] || \
       [ "$(/usr/bin/readlink "$target_opt/$formula")" != "$target_opt_target" ] || \
       [ "$(cd "$target_opt/$formula" && pwd -P)" != "$target_keg" ]; }; then
    echo "homebrew-patched-launcher: native Formula proxy is not a canonical target keg" >&2
    bridge_status=1
  fi
  if [ "$bridge_status" -eq 0 ] && [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_rack")" = "0:0:555" ] && \
      [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_keg")" = "0:0:555" ] && \
      homebrew_assert_tree_not_writable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" && \
      homebrew_assert_tree_not_replaceable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack" || bridge_status=1
  fi
  if [ "$bridge_status" -ne 0 ]; then
    echo "homebrew-patched-launcher: native Formula bridge creation failed; rolling back" >&2
    if ! homebrew_patched_launcher_remove_native_bridges; then
      echo "homebrew-patched-launcher: native Formula bridge rollback failed; preserving launcher state for retry" >&2
    fi
    return 1
  fi
}

# Materialize the exact Homebrew developer-command gem groups while the
# workflow identity still owns the temporary overlay. Formula execution sees
# the resulting gem code and state only after the whole overlay is sealed.
homebrew_patched_launcher_seed_bundler_groups() {
  if [ "$#" -eq 0 ]; then
    echo "homebrew_patched_launcher_seed_bundler_groups: expected at least one group" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_OVERLAY" ]; then
    return 0
  fi
  if [ -n "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: cannot seed Bundler groups after isolation" >&2
    return 2
  fi

  local group groups groups_csv group_count
  local vendor_root groups_file expected_groups actual_groups unsafe_entry
  local unsafe_marker marker_count marker_path marker_value
  for group in "$@"; do
    if ! [[ "$group" =~ ^[a-z][a-z0-9_]*$ ]]; then
      echo "homebrew-patched-launcher: invalid Bundler group: $group" >&2
      return 2
    fi
  done
  groups="$(printf '%s\n' "$@" | LC_ALL=C sort -u)"
  group_count="$(printf '%s\n' "$groups" | awk 'NF { count++ } END { print count + 0 }')"
  if [ "$group_count" -ne "$#" ]; then
    echo "homebrew-patched-launcher: Bundler groups must be unique" >&2
    return 2
  fi
  if [ "$group_count" -gt 32 ]; then
    echo "homebrew-patched-launcher: too many Bundler groups" >&2
    return 2
  fi
  groups_csv="$(printf '%s\n' "$groups" | paste -sd, -)"

  "$HOMEBREW_PATCHED_BREW_BIN" install-bundler-gems --groups="$groups_csv"

  vendor_root="$HOMEBREW_PATCHED_OVERLAY/Library/Homebrew/vendor/bundle/ruby"
  if [ ! -d "$vendor_root" ] || [ -L "$vendor_root" ]; then
    echo "homebrew-patched-launcher: Bundler vendor root is not a real directory" >&2
    return 1
  fi
  unsafe_entry="$(find "$vendor_root" -mindepth 1 ! \( -type d -o -type f \) -print -quit)"
  if [ -n "$unsafe_entry" ]; then
    echo "homebrew-patched-launcher: Bundler vendor tree contains a non-regular entry" >&2
    return 1
  fi
  groups_file="$vendor_root/.homebrew_gem_groups"
  if [ ! -f "$groups_file" ] || [ -L "$groups_file" ]; then
    echo "homebrew-patched-launcher: Bundler group state is not a regular file" >&2
    return 1
  fi
  expected_groups="$groups"
  actual_groups="$(LC_ALL=C sort "$groups_file")"
  if [ "$actual_groups" != "$expected_groups" ]; then
    echo "homebrew-patched-launcher: Bundler group state differs from the requested groups" >&2
    return 1
  fi

  unsafe_marker="$(find "$vendor_root" -mindepth 2 -maxdepth 2 \
    -name .homebrew_vendor_version ! -type f -print -quit)"
  if [ -n "$unsafe_marker" ]; then
    echo "homebrew-patched-launcher: Bundler vendor version is not a regular file" >&2
    return 1
  fi
  marker_count="$(find "$vendor_root" -mindepth 2 -maxdepth 2 \
    -type f -name .homebrew_vendor_version -print | awk 'END { print NR + 0 }')"
  if [ "$marker_count" -ne 1 ]; then
    echo "homebrew-patched-launcher: expected one Bundler vendor version, found $marker_count" >&2
    return 1
  fi
  marker_path="$(find "$vendor_root" -mindepth 2 -maxdepth 2 \
    -type f -name .homebrew_vendor_version -print)"
  marker_value="$(cat "$marker_path")"
  if ! [[ "$marker_value" =~ ^[0-9]+$ ]]; then
    echo "homebrew-patched-launcher: invalid Bundler vendor version" >&2
    return 1
  fi
}

# Move all Formula-evaluating Brew calls behind a fixed wrapper that switches
# to a dedicated user inside a transient systemd service. KillMode=control-group
# makes double-forked or session-detached descendants part of the call lifecycle.
homebrew_patched_launcher_tier2_schema() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_tier2_schema: expected ATTESTATION" >&2
    return 2
  fi
  local -a lines
  mapfile -t lines <"$1" || {
    echo "homebrew-patched-launcher: could not read the protected Tier-2 attestation" >&2
    return 2
  }
  if [ "${#lines[@]}" -ne 1 ]; then
    echo "homebrew-patched-launcher: protected Tier-2 attestation must use one JSON line" >&2
    return 2
  fi
  case "${lines[0]}" in
    *'"schema":2,'*) printf '2\n' ;;
    *'"schema":3,'*) printf '3\n' ;;
    *)
      echo "homebrew-patched-launcher: protected Tier-2 attestation has an unsupported schema" >&2
      return 2
      ;;
  esac
}

homebrew_patched_launcher_emit_xtask_access_audit() {
  if [ "$#" -ne 6 ]; then
    echo "homebrew_patched_launcher_emit_xtask_access_audit: expected SCHEMA-3-ISOLATION XTASK-ALIAS PROTECTED-XTASK XTASK-STATE XTASK-SHA256 FINDMNT" >&2
    return 2
  fi
  local tap_recipe_isolation="$1" xtask_alias="$2" protected_xtask="$3"
  local xtask_state="$4" xtask_sha256="$5" findmnt_bin="$6"

  printf 'expected_xtask=%q\n' "$xtask_alias"
  printf 'expected_protected_xtask=%q\n' "$protected_xtask"
  printf 'expected_xtask_state=%q\n' "$xtask_state"
  printf 'expected_xtask_sha256=%q\n' "$xtask_sha256"
  printf 'expected_tap_recipe_isolation=%q\n' "$tap_recipe_isolation"
  printf 'expected_findmnt=%q\n' "$findmnt_bin"
  printf 'if [ "$expected_tap_recipe_isolation" = 1 ]; then\n'
  # WHY: schema 3 deliberately removes resolver authority. Its startup audit
  # must prove that neither checker path is usable, not require that both names
  # fail `test -e`: systemd implements InaccessiblePaths= for a file by mounting
  # a mode-000 placeholder at that name. Checking the root-staged path matters
  # because the protected directory itself remains traversable for the Brew and
  # audit launchers.
  printf '  if [ -n "${WASM_POSIX_XTASK_BIN+x}" ] || '
  printf '[ -n "${HOMEBREW_KANDELO_XTASK_BIN+x}" ]; then\n'
  printf '    echo "homebrew-patched-launcher: tap recipe retained program-index checker authority" >&2\n'
  printf '    exit 2\n  fi\n'
  printf '  for forbidden_xtask in "$expected_xtask" "$expected_protected_xtask"; do\n'
  printf '    if [ -L "$forbidden_xtask" ] || [ -r "$forbidden_xtask" ] || '
  printf '[ -w "$forbidden_xtask" ] || [ -x "$forbidden_xtask" ]; then\n'
  printf '      echo "homebrew-patched-launcher: tap recipe retained usable program-index checker authority: $forbidden_xtask" >&2\n'
  printf '      exit 2\n    fi\n'
  printf '  done\n'
  printf 'else\n'
  printf '  actual_xtask_sha256="$(/usr/bin/sha256sum "$expected_xtask" 2>/dev/null || true)"\n'
  printf '  actual_xtask_sha256="${actual_xtask_sha256%%%% *}"\n'
  printf '  if [ "${WASM_POSIX_XTASK_BIN:-}" != "$expected_xtask" ] || '
  printf '[ "${HOMEBREW_KANDELO_XTASK_BIN:-}" != "$expected_xtask" ] || '
  printf '[ ! -f "$expected_xtask" ] || [ -L "$expected_xtask" ] || '
  printf '[ ! -r "$expected_xtask" ] || [ ! -x "$expected_xtask" ] || '
  printf '[ -w "$expected_xtask" ] || '
  printf '[ "$(/usr/bin/realpath -- "$expected_xtask")" != "$expected_xtask" ] || '
  printf '[ "$(/usr/bin/stat -c '\''%%d:%%i:%%u:%%g:%%a:%%h:%%s'\'' "$expected_xtask")" != "$expected_xtask_state" ] || '
  printf '[ "$actual_xtask_sha256" != "$expected_xtask_sha256" ]; then\n'
  printf '    echo "homebrew-patched-launcher: protected program-index checker changed or is inaccessible" >&2\n'
  printf '    exit 2\n  fi\n'
  printf '  xtask_mount_options="$("$expected_findmnt" --noheadings --output VFS-OPTIONS --target "$expected_xtask")" || {\n'
  printf '    echo "homebrew-patched-launcher: could not inspect protected checker mount" >&2; exit 2;\n  }\n'
  printf '  case ",${xtask_mount_options// /}," in\n'
  printf '    *,ro,*) ;;\n'
  printf '    *) echo "homebrew-patched-launcher: protected checker mount is writable" >&2; exit 1 ;;\n'
  printf '  esac\n'
  printf 'fi\n'
}

homebrew_patched_launcher_isolate() {
  if [ "$#" -lt 6 ]; then
    echo "homebrew_patched_launcher_isolate: expected BUILD_USER WORK_DIR KANDELO_ROOT TAP_ROOT OUTPUT_ROOT SYSROOT_BUILD_ROOT [ADDITIONAL_PROTECTED_ROOT ...]" >&2
    return 2
  fi
  local build_user="$1" work_dir="$2" kandelo_root="$3" tap_root="$4" output_root="$5"
  local sysroot_build_root="$6" sysroot
  shift 6
  local build_group build_home protected_audit protected_xtask
  local wrapper_source wrapper_path audit_source native_runner_source native_runner_path
  local mutable_root protected_root target_state_root
  local physical_repo physical_prefix
  local sudo_bin sudo_mode env_bin variable value protected_bin patched_prefix patched_repo
  local systemd_run_bin systemctl_bin getent_bin pgrep_bin pkill_bin
  local build_uid build_gid systemd_slice unit_prefix source_alias_dir platform_source_root
  local config_root config_file unsafe_config_entry trust_file trust_lock
  local primary_tap_root primary_tap_owner_root taps_root
  local recipe_user recipe_uid jq_bin node_bin protected_anchor protected_nonce
  local recipe_runner_path recipe_sealed_root
  local overlay_repository overlay_commit overlay_tree
  local xtask_bin xtask_relative xtask_alias xtask_mode xtask_links
  local formula_test_program_index
  local xtask_uid xtask_state xtask_sha256 xtask_state_after xtask_sha256_after
  local xtask_alias_state xtask_alias_sha256 tap_recipe_isolation tier2_schema
  local tap_recipe_path tap_recipe_relative
  local -a preserved_variables native_preserved_variables mutable_roots
  local -a xtask_path_parts
  local -a tap_recipe_inaccessible_paths
  local -a additional_protected_roots=("$@")

  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    physical_repo="$(cd "$HOMEBREW_PATCHED_REPO" && pwd -P)" || return 2
    physical_prefix="$(cd "$HOMEBREW_PATCHED_PREFIX" && pwd -P)" || return 2
    case "$physical_repo/" in
      "$physical_prefix/"*)
        echo "homebrew-patched-launcher: Homebrew backing repository cannot be inside the hidden target prefix" >&2
        return 2
        ;;
    esac
    for mutable_root in "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$HOMEBREW_PATCHED_NATIVE_CACHE" "$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$HOMEBREW_PATCHED_NATIVE_CONFIG" "$HOMEBREW_PATCHED_NATIVE_HOME"; do
      if [ ! -d "$mutable_root" ] || [ -L "$mutable_root" ]; then
        echo "homebrew-patched-launcher: native Homebrew root is not a real directory: $mutable_root" >&2
        return 2
      fi
    done
    [ -L "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ] && \
      [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_NATIVE_BREW_BIN")" = \
        "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] || {
        echo "homebrew-patched-launcher: native Homebrew launcher changed before isolation" >&2
        return 2
      }
    if [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ]; then
      [ -d "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ] &&
        [ ! -L "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ] &&
        [ "$(/usr/bin/stat -c '%u:%g:%a' \
          "$HOMEBREW_PATCHED_NATIVE_API_SOURCE")" = "0:0:555" ] || {
        echo "homebrew-patched-launcher: native API source changed before isolation" >&2
        return 2
      }
    fi
  elif [ -n "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_CACHE" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_TEMP" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_CONFIG" ] || \
       [ -n "$HOMEBREW_PATCHED_NATIVE_HOME" ]; then
    echo "homebrew-patched-launcher: native Homebrew state is incomplete" >&2
    return 2
  fi

  [ "$(uname -s)" = "Linux" ] || {
    echo "homebrew-patched-launcher: isolated Formula execution requires Linux" >&2
    return 2
  }
  id "$build_user" >/dev/null 2>&1 || {
    echo "homebrew-patched-launcher: build user does not exist: $build_user" >&2
    return 2
  }
  [ "$(id -u "$build_user")" != "$(id -u)" ] || {
    echo "homebrew-patched-launcher: build user must differ from the workflow user" >&2
    return 2
  }
  sudo_bin="${KANDELO_HOMEBREW_SUDO_BIN:-}"
  sudo_mode="$(stat -c '%a' "$sudo_bin" 2>/dev/null || true)"
  if [ "$sudo_bin" != "/usr/bin/sudo" ] || [ ! -f "$sudo_bin" ] || \
     [ -L "$sudo_bin" ] || [ ! -x "$sudo_bin" ] || \
     [ "$(stat -c '%u' "$sudo_bin" 2>/dev/null || true)" != "0" ] || \
     ! [[ "$sudo_mode" =~ ^[0-7]{3,4}$ ]] || \
     [ $((8#$sudo_mode & 0022)) -ne 0 ]; then
    echo "homebrew-patched-launcher: KANDELO_HOMEBREW_SUDO_BIN must be the protected /usr/bin/sudo" >&2
    return 2
  fi
  HOMEBREW_PATCHED_SUDO_BIN="$sudo_bin"
  if "$sudo_bin" -H -u "$build_user" -- test -w "$sudo_bin"; then
    echo "homebrew-patched-launcher: build user can replace the privileged host boundary" >&2
    return 2
  fi
  systemd_run_bin="${KANDELO_HOMEBREW_SYSTEMD_RUN_BIN:-}"
  systemctl_bin="${KANDELO_HOMEBREW_SYSTEMCTL_BIN:-}"
  getent_bin="${KANDELO_HOMEBREW_GETENT_BIN:-}"
  pgrep_bin="${KANDELO_HOMEBREW_PGREP_BIN:-}"
  pkill_bin="${KANDELO_HOMEBREW_PKILL_BIN:-}"
  homebrew_assert_protected_host_executable \
    "$build_user" "$systemd_run_bin" /usr/bin/systemd-run systemd-run
  homebrew_assert_protected_host_executable \
    "$build_user" "$systemctl_bin" /usr/bin/systemctl systemctl
  homebrew_assert_protected_host_executable \
    "$build_user" "$getent_bin" /usr/bin/getent getent
  homebrew_assert_protected_host_executable \
    "$build_user" "$pgrep_bin" /usr/bin/pgrep pgrep
  homebrew_assert_protected_host_executable \
    "$build_user" "$pkill_bin" /usr/bin/pkill pkill /usr/bin/pgrep
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/findmnt /usr/bin/findmnt findmnt
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/find /usr/bin/find find
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/realpath /usr/bin/realpath realpath
  homebrew_assert_protected_host_executable \
    "$build_user" /usr/bin/bash /usr/bin/bash bash
  for protected_bin in chmod chown cmp cp id install ln ls mktemp mv readlink rm \
    od sha256sum stat test tr; do
    homebrew_assert_protected_host_executable \
      "$build_user" "/usr/bin/$protected_bin" "/usr/bin/$protected_bin" "$protected_bin"
  done
  homebrew_assert_protected_host_versioned_executable \
    "$build_user" /usr/bin/python3 /usr/bin/python3 python3 python3
  if [ -z "${HOMEBREW_GIT_PATH:-}" ]; then
    echo "homebrew-patched-launcher: protected host Git was not selected before isolation" >&2
    return 2
  fi
  homebrew_assert_protected_host_executable \
    "$build_user" "$HOMEBREW_GIT_PATH" "$HOMEBREW_GIT_PATH" \
    "Nix Git" || return
  homebrew_assert_tree_not_replaceable_by_user \
    "$build_user" "$HOMEBREW_GIT_PATH" || return
  if [ -n "${HOMEBREW_KANDELO_GNU_TAR:-}" ]; then
    homebrew_assert_protected_host_executable \
      "$build_user" "$HOMEBREW_KANDELO_GNU_TAR" \
      "$HOMEBREW_KANDELO_GNU_TAR" "Nix GNU tar" || return
    homebrew_assert_tree_not_replaceable_by_user \
      "$build_user" "$HOMEBREW_KANDELO_GNU_TAR" || return
  fi
  [ -d /run/systemd/system ] || {
    echo "homebrew-patched-launcher: systemd is not the active service manager" >&2
    return 2
  }
  "$sudo_bin" -n -- "$systemctl_bin" show --property=Version --value >/dev/null || {
    echo "homebrew-patched-launcher: systemd manager is unavailable" >&2
    return 2
  }
  env_bin="$(command -v env)"
  build_group="$(/usr/bin/id -gn "$build_user")"
  build_uid="$(id -u "$build_user")"
  build_gid="$(id -g "$build_user")"
  systemd_slice="kandelo-homebrew-build-${build_uid}.slice"
  unit_prefix="kandelo-homebrew-build-${build_uid}"
  build_home="$("$getent_bin" passwd "$build_user" | awk -F: '{print $6}')"
  [ -n "$build_home" ] || {
    echo "homebrew-patched-launcher: build user has no home directory" >&2
    return 2
  }

  primary_tap_root="${HOMEBREW_KANDELO_PRIMARY_TAP_ROOT:-}"
  if [ -z "$primary_tap_root" ] || [ ! -d "$primary_tap_root" ] || \
     [ -L "$primary_tap_root" ]; then
    echo "homebrew-patched-launcher: selected primary tap root must be a real directory" >&2
    return 2
  fi
  primary_tap_root="$(cd "$primary_tap_root" && pwd -P)" || return 2
  # Taps belong to HOMEBREW_REPOSITORY, not HOMEBREW_PREFIX. The reviewed
  # launcher intentionally keeps the canonical Linuxbrew prefix while running
  # from a patched repository worktree, so only the active repository can own
  # the tapped checkouts that Formula resolution actually loads.
  taps_root="$HOMEBREW_PATCHED_OVERLAY/Library/Taps"
  if [ ! -d "$taps_root" ] || [ -L "$taps_root" ]; then
    echo "homebrew-patched-launcher: active Homebrew repository tap storage must be a real directory" >&2
    return 2
  fi
  taps_root="$(cd "$taps_root" && pwd -P)" || return 2
  primary_tap_owner_root="${primary_tap_root%/*}"
  if [ "${primary_tap_owner_root%/*}" != "$taps_root" ] || \
     [ "$primary_tap_root" != "$HOMEBREW_KANDELO_PRIMARY_TAP_ROOT" ]; then
    echo "homebrew-patched-launcher: selected primary tap root is not one canonical tapped checkout" >&2
    return 2
  fi
  case "$primary_tap_root" in
    *:*)
      echo "homebrew-patched-launcher: selected primary tap root cannot contain ':'" >&2
      return 2
      ;;
  esac

  if [ ! -d "$sysroot_build_root" ] || [ -L "$sysroot_build_root" ]; then
    echo "homebrew-patched-launcher: sysroot build root must be a real directory" >&2
    return 2
  fi
  sysroot_build_root="$(cd "$sysroot_build_root" && pwd -P)" || return 2
  case "${KANDELO_HOMEBREW_ARCH:-}" in
    wasm32) sysroot="$sysroot_build_root/sysroot" ;;
    wasm64) sysroot="$sysroot_build_root/sysroot64" ;;
    *)
      echo "homebrew-patched-launcher: KANDELO_HOMEBREW_ARCH must select wasm32 or wasm64" >&2
      return 2
      ;;
  esac
  if [ ! -d "$sysroot" ] || [ -L "$sysroot" ] || \
     [ ! -f "$sysroot/lib/libc.a" ] || [ -L "$sysroot/lib/libc.a" ]; then
    echo "homebrew-patched-launcher: sysroot must be a real directory containing a regular libc archive" >&2
    return 2
  fi
  sysroot="$(cd "$sysroot" && pwd -P)" || return 2
  [ "$sysroot_build_root" != "/" ] || {
    echo "homebrew-patched-launcher: sysroot build root cannot be the filesystem root" >&2
    return 2
  }
  case "$sysroot" in
    *:*)
      echo "homebrew-patched-launcher: sysroot cannot contain ':' for a systemd bind" >&2
      return 2
      ;;
  esac
  homebrew_assert_tree_symlinks_contained "$sysroot" sysroot || return

  for protected_root in "$kandelo_root" "$tap_root" "$output_root" \
    "$sysroot_build_root" "${additional_protected_roots[@]}"; do
    if [ ! -d "$protected_root" ] || [ -L "$protected_root" ]; then
      echo "homebrew-patched-launcher: protected root is not a real directory: $protected_root" >&2
      return 2
    fi
    protected_root="$(cd "$protected_root" && pwd -P)" || return 2
    [ "$protected_root" != "/" ] || {
      echo "homebrew-patched-launcher: protected root cannot be the filesystem root" >&2
      return 2
    }
    case "$protected_root" in
      *:*)
        echo "homebrew-patched-launcher: protected root cannot contain ':' for a systemd bind: $protected_root" >&2
        return 2
        ;;
    esac
  done
  [ "$(cd "$kandelo_root" && pwd -P)" = "$kandelo_root" ] || {
    echo "homebrew-patched-launcher: Kandelo root must be one exact canonical checkout" >&2
    return 2
  }

  # WHY: WASM_POSIX_XTASK_BIN is caller-controlled until this boundary. Only
  # Cargo's exact release output below the reviewed checkout may become the
  # source-projection authority; accepting a cache, symlink, or adjacent tool
  # would let Formula evaluation select different package policy code.
  xtask_bin="${WASM_POSIX_XTASK_BIN:-}"
  if [ -z "$xtask_bin" ] || [ "${xtask_bin#/}" = "$xtask_bin" ] || \
     [ ! -f "$xtask_bin" ] || [ -L "$xtask_bin" ] || [ ! -x "$xtask_bin" ] || \
     [ "$(/usr/bin/realpath -- "$xtask_bin" 2>/dev/null || true)" != "$xtask_bin" ]; then
    echo "homebrew-patched-launcher: prepared program-index checker must be one exact regular executable" >&2
    return 2
  fi
  case "$xtask_bin" in
    "$kandelo_root"/*) xtask_relative="${xtask_bin#"$kandelo_root"/}" ;;
    *)
      echo "homebrew-patched-launcher: prepared program-index checker is outside the exact Kandelo root" >&2
      return 2
      ;;
  esac
  IFS=/ read -r -a xtask_path_parts <<<"$xtask_relative"
  if [ "${#xtask_path_parts[@]}" -ne 4 ] || \
     [ "${xtask_path_parts[0]}" != "target" ] || \
     ! [[ "${xtask_path_parts[1]}" =~ ^[A-Za-z0-9_.+-]+$ ]] || \
     [ "${xtask_path_parts[2]}" != "release" ] || \
     [ "${xtask_path_parts[3]}" != "xtask" ]; then
    echo "homebrew-patched-launcher: program-index checker is not the prepared release xtask" >&2
    return 2
  fi
  xtask_mode="$(/usr/bin/stat -c '%a' "$xtask_bin" 2>/dev/null || true)"
  xtask_links="$(/usr/bin/stat -c '%h' "$xtask_bin" 2>/dev/null || true)"
  xtask_uid="$(/usr/bin/stat -c '%u' "$xtask_bin" 2>/dev/null || true)"
  if [ "$xtask_mode" != "555" ]; then
    echo "homebrew-patched-launcher: prepared program-index checker has an unsafe mode" >&2
    return 2
  fi
  if [ "$xtask_links" != "1" ]; then
    echo "homebrew-patched-launcher: prepared program-index checker is not single-linked" >&2
    return 2
  fi
  if [ "$xtask_uid" = "$build_uid" ]; then
    echo "homebrew-patched-launcher: prepared program-index checker is owned by the Formula user" >&2
    return 2
  fi
  if "$sudo_bin" -H -u "$build_user" -- /usr/bin/test -w "$xtask_bin"; then
    echo "homebrew-patched-launcher: prepared program-index checker is writable by the Formula user" >&2
    return 2
  fi
  # WHY: GitHub places the reviewed checkout below the workflow user's private
  # home. Formula execution never reads that original path: systemd exposes the
  # exact inode through the root-created read-only alias audited below, then
  # makes the original Kandelo root inaccessible. Requiring direct Formula-user
  # read access here rejects that secure runner layout without protecting the
  # actual execution boundary.
  homebrew_assert_tree_not_replaceable_by_user "$build_user" "$xtask_bin" || return
  xtask_state="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$xtask_bin")" || return 2
  xtask_sha256="$(/usr/bin/sha256sum "$xtask_bin")" || return 2
  xtask_sha256="${xtask_sha256%% *}"
  [[ "$xtask_sha256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "homebrew-patched-launcher: could not seal the prepared program-index checker" >&2
    return 2
  }

  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    for mutable_root in "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
      "$HOMEBREW_PATCHED_NATIVE_CACHE" "$HOMEBREW_PATCHED_NATIVE_TEMP" \
      "$HOMEBREW_PATCHED_NATIVE_CONFIG" "$HOMEBREW_PATCHED_NATIVE_HOME"; do
      for protected_root in "$work_dir" "$kandelo_root" "$tap_root" "$output_root" \
        "$sysroot_build_root" "$build_home" "${additional_protected_roots[@]}"; do
        if [ "$mutable_root" = "$protected_root" ]; then
          echo "homebrew-patched-launcher: native and target execution roots must differ: $mutable_root" >&2
          return 2
        fi
        case "$mutable_root/" in
          "$protected_root/"*)
            echo "homebrew-patched-launcher: native state cannot be inside a target execution root: $mutable_root" >&2
            return 2
            ;;
        esac
        case "$protected_root/" in
          "$mutable_root/"*)
            echo "homebrew-patched-launcher: target execution root cannot be inside native state: $protected_root" >&2
            return 2
            ;;
        esac
      done
    done
    if [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ]; then
      for mutable_root in "$HOMEBREW_PATCHED_NATIVE_PREFIX" \
        "$HOMEBREW_PATCHED_NATIVE_CACHE" "$HOMEBREW_PATCHED_NATIVE_TEMP" \
        "$HOMEBREW_PATCHED_NATIVE_CONFIG" "$HOMEBREW_PATCHED_NATIVE_HOME"; do
        case "$HOMEBREW_PATCHED_NATIVE_API_SOURCE/" in
          "$mutable_root/"*)
            echo "homebrew-patched-launcher: native API source is inside mutable native state" >&2
            return 2
            ;;
        esac
        case "$mutable_root/" in
          "$HOMEBREW_PATCHED_NATIVE_API_SOURCE/"*)
            echo "homebrew-patched-launcher: mutable native state is inside the API source" >&2
            return 2
            ;;
        esac
      done
      homebrew_assert_tree_not_replaceable_by_user \
        "$build_user" "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" || return
      homebrew_assert_tree_not_writable_by_user \
        "$build_user" "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" || return
    fi
  fi

  mutable_roots=(
    "$work_dir"
    "$HOMEBREW_PATCHED_PREFIX"
    "$HOMEBREW_CACHE"
    "$HOMEBREW_TEMP"
    "$XDG_CONFIG_HOME"
    "$build_home"
  )
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    mutable_roots+=(
      "$HOMEBREW_PATCHED_NATIVE_PREFIX"
      "$HOMEBREW_PATCHED_NATIVE_CACHE"
      "$HOMEBREW_PATCHED_NATIVE_TEMP"
      "$HOMEBREW_PATCHED_NATIVE_CONFIG"
      "$HOMEBREW_PATCHED_NATIVE_HOME"
    )
  fi
  for mutable_root in "${mutable_roots[@]}"; do
    if [ ! -d "$mutable_root" ] || [ -L "$mutable_root" ]; then
      echo "homebrew-patched-launcher: mutable build root is not a real directory: $mutable_root" >&2
      return 2
    fi
    case "$sysroot_build_root/" in
      "$mutable_root/"*)
        echo "homebrew-patched-launcher: sysroot build root cannot be inside mutable Formula state" >&2
        return 2
        ;;
    esac
    case "$mutable_root/" in
      "$sysroot_build_root/"*)
        echo "homebrew-patched-launcher: mutable Formula state cannot be inside the sysroot build root" >&2
        return 2
        ;;
    esac
  done
  for protected_root in "${additional_protected_roots[@]}"; do
    homebrew_assert_tree_not_replaceable_by_user "$build_user" "$protected_root" || return
  done
  for target_state_root in "$HOMEBREW_PATCHED_PREFIX/Cellar" \
    "$HOMEBREW_PATCHED_PREFIX/opt"; do
    if [ -e "$target_state_root" ] || [ -L "$target_state_root" ]; then
      [ -d "$target_state_root" ] && [ ! -L "$target_state_root" ] || {
        echo "homebrew-patched-launcher: target Homebrew root is not a real directory: $target_state_root" >&2
        return 2
      }
    fi
  done
  if [ ! -d "$HOMEBREW_PATCHED_PREFIX/bin" ] || \
     [ -L "$HOMEBREW_PATCHED_PREFIX/bin" ] || \
     [ ! -L "$HOMEBREW_PATCHED_LAUNCHER" ] || \
     [ "${HOMEBREW_PATCHED_LAUNCHER%/*}" != "$HOMEBREW_PATCHED_PREFIX/bin" ] || \
     [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_LAUNCHER")" != \
       "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ]; then
    echo "homebrew-patched-launcher: target Brew launcher changed before isolation" >&2
    return 2
  fi
  chmod 1777 "$work_dir"
  "$sudo_bin" chown -R "$build_user:$build_group" \
    "$HOMEBREW_PATCHED_PREFIX" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP"
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    "$sudo_bin" /usr/bin/chown -R "$build_user:$build_group" \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" "$HOMEBREW_PATCHED_NATIVE_CACHE" \
      "$HOMEBREW_PATCHED_NATIVE_TEMP" "$HOMEBREW_PATCHED_NATIVE_CONFIG" \
      "$HOMEBREW_PATCHED_NATIVE_HOME"
    "$sudo_bin" /usr/bin/install -d -o root -g "$build_group" -m 1775 \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX" "$HOMEBREW_PATCHED_NATIVE_PREFIX/bin"
    "$sudo_bin" /usr/bin/install -d -o "$build_user" -g "$build_group" -m 0755 \
      "$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar"
    "$sudo_bin" /usr/bin/chown -h root:root "$HOMEBREW_PATCHED_NATIVE_BREW_BIN"
    "$sudo_bin" /usr/bin/install -d -o "$build_user" -g "$build_group" -m 0755 \
      "$HOMEBREW_PATCHED_NATIVE_CONFIG/homebrew"
    if [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ]; then
      if [ -e "$HOMEBREW_PATCHED_NATIVE_CACHE/api" ] || \
         [ -L "$HOMEBREW_PATCHED_NATIVE_CACHE/api" ]; then
        [ -d "$HOMEBREW_PATCHED_NATIVE_CACHE/api" ] &&
          [ ! -L "$HOMEBREW_PATCHED_NATIVE_CACHE/api" ] &&
          [ -z "$(find "$HOMEBREW_PATCHED_NATIVE_CACHE/api" \
            -mindepth 1 -print -quit)" ] || {
          echo "homebrew-patched-launcher: native API mountpoint is not empty" >&2
          return 2
        }
      fi
      # WHY: the cache remains writable for bottle downloads, but its sticky
      # root prevents the build identity from replacing this root-owned API
      # mountpoint between isolated Brew commands.
      "$sudo_bin" /usr/bin/install -d -o root -g "$build_group" -m 1775 \
        "$HOMEBREW_PATCHED_NATIVE_CACHE"
      "$sudo_bin" /usr/bin/install -d -o root -g root -m 0555 \
        "$HOMEBREW_PATCHED_NATIVE_CACHE/api"
      [ "$(/usr/bin/stat -c '%u:%g:%a' \
        "$HOMEBREW_PATCHED_NATIVE_CACHE")" = "0:$build_gid:1775" ] &&
        [ "$(/usr/bin/stat -c '%u:%g:%a' \
          "$HOMEBREW_PATCHED_NATIVE_CACHE/api")" = "0:0:555" ] &&
        ! "$sudo_bin" -n -H -u "$build_user" -- /usr/bin/mv \
          "$HOMEBREW_PATCHED_NATIVE_CACHE/api" \
          "$HOMEBREW_PATCHED_NATIVE_CACHE/api.replace-probe" \
          >/dev/null 2>&1 || {
        echo "homebrew-patched-launcher: native API mountpoint is replaceable" >&2
        return 2
      }
    fi
  fi
  # WHY: Homebrew derives its target prefix from the path used to invoke
  # bin/brew. Keep that canonical path, but make both its parent and the exact
  # symlink sticky/root-owned before the less-trusted Formula identity starts.
  # The build user can still add normal keg links below bin, but cannot replace
  # the launcher whose $0 selects the target prefix.
  "$sudo_bin" /usr/bin/install -d -o root -g "$build_group" -m 1775 \
    "$HOMEBREW_PATCHED_PREFIX" "$HOMEBREW_PATCHED_PREFIX/bin" \
    "$HOMEBREW_PATCHED_PREFIX/Cellar" "$HOMEBREW_PATCHED_PREFIX/opt"
  "$sudo_bin" /usr/bin/chown -h root:root "$HOMEBREW_PATCHED_LAUNCHER"
  [ "$(/usr/bin/stat -c '%u:%g' "$HOMEBREW_PATCHED_LAUNCHER")" = "0:0" ] && \
    [ "$(/usr/bin/stat -c '%u:%g:%a' "$HOMEBREW_PATCHED_PREFIX/bin")" = \
      "0:$build_gid:1775" ] && \
    [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_LAUNCHER")" = \
      "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] || {
      echo "homebrew-patched-launcher: could not protect the canonical target Brew launcher" >&2
      return 2
    }
  homebrew_patched_launcher_seal_target_dependencies \
    "$build_user" "$sudo_bin" || return
  homebrew_patched_launcher_seal_control_files "$build_user" || return
  tap_recipe_isolation=0
  if [ -n "$HOMEBREW_PATCHED_TIER2_ATTESTATION" ]; then
    homebrew_patched_launcher_verify_tier2_attestation || return
    tier2_schema="$(
      homebrew_patched_launcher_tier2_schema "$HOMEBREW_PATCHED_TIER2_ATTESTATION"
    )" || return
    if [ "$tier2_schema" = "3" ]; then
      tap_recipe_isolation=1
    fi
  fi
  if [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ] || \
     [ "$tap_recipe_isolation" = "1" ]; then
    # The native overlay attestation exists for both build and verifier jobs.
    # Verifiers do not create a schema-3 recipe realm, so resolve its JSON
    # writer independently from that narrower isolation path.
    jq_bin="$(command -v jq)"
    homebrew_assert_protected_host_executable \
      "$build_user" "$jq_bin" "$jq_bin" jq || return
  fi
  if [ "$tap_recipe_isolation" = "1" ]; then
    recipe_user="${KANDELO_HOMEBREW_RECIPE_USER:-}"
    id "$recipe_user" >/dev/null 2>&1 || {
      echo "homebrew-patched-launcher: tap recipe user does not exist: $recipe_user" >&2
      return 2
    }
    recipe_uid="$(id -u "$recipe_user")"
    if [ "$recipe_user" != "kandelo-homebrew-recipe" ] || \
       [ "$recipe_uid" = "$build_uid" ] || [ "$recipe_uid" = "$(id -u)" ] || \
       [ "$recipe_uid" = "0" ]; then
      echo "homebrew-patched-launcher: tap recipe user is not an isolated identity" >&2
      return 2
    fi
    if "$sudo_bin" -n -H -u "$recipe_user" -- \
      "$sudo_bin" -n true >/dev/null 2>&1; then
      echo "homebrew-patched-launcher: tap recipe identity unexpectedly has sudo access" >&2
      return 2
    fi
    node_bin="${HOMEBREW_KANDELO_NODE:-}"
    homebrew_assert_protected_host_executable \
      "$build_user" "$node_bin" "$node_bin" node || return
  fi
  "$sudo_bin" install -d -o root -g root -m 0755 \
    "$HOMEBREW_PATCHED_PREFIX/etc/homebrew" "$XDG_CONFIG_HOME/homebrew"
  for config_root in "$HOMEBREW_PATCHED_PREFIX/etc/homebrew" "$XDG_CONFIG_HOME"; do
    if ! unsafe_config_entry="$("$sudo_bin" -n -- /usr/bin/find "$config_root" \
      -xdev ! \( -type d -o -type f \) -print -quit)"; then
      echo "homebrew-patched-launcher: could not inspect isolated config: $config_root" >&2
      return 2
    fi
    [ -z "$unsafe_config_entry" ] || {
      echo "homebrew-patched-launcher: isolated config contains a non-regular entry: $unsafe_config_entry" >&2
      return 2
    }
    "$sudo_bin" chown -R root:root "$config_root"
    "$sudo_bin" -n -- /usr/bin/find "$config_root" -xdev -type d \
      -exec chmod 0555 {} +
    "$sudo_bin" -n -- /usr/bin/find "$config_root" -xdev -type f \
      -exec chmod 0444 {} +
  done

  # The publisher overlay does not persist redundant item trust for an already
  # trusted tap. Keep both the trust data and any existing lock inode readable
  # but immutable; explicit trust mutations must still fail in this identity.
  trust_file="$XDG_CONFIG_HOME/homebrew/trust.json"
  trust_lock="${trust_file}.lock"
  for config_file in "$trust_file" "$trust_lock"; do
    [ -f "$config_file" ] && [ ! -L "$config_file" ] || {
      echo "homebrew-patched-launcher: required trust-store file is not regular: $config_file" >&2
      return 2
    }
  done
  [ ! "$trust_file" -ef "$trust_lock" ] &&
    [ "$(stat -c '%h' "$trust_file")" = "1" ] &&
    [ "$(stat -c '%h' "$trust_lock")" = "1" ] || {
      echo "homebrew-patched-launcher: trust-store files must use distinct private inodes" >&2
      return 2
    }
  [ "$(stat -c '%u:%g:%a:%h' "$trust_file")" = "0:0:444:1" ] &&
    [ "$(stat -c '%u:%g:%a:%h' "$trust_lock")" = "0:0:444:1" ] &&
    [ "$(stat -c '%u:%g:%a' "$XDG_CONFIG_HOME")" = "0:0:555" ] &&
    [ "$(stat -c '%u:%g:%a' "$XDG_CONFIG_HOME/homebrew")" = "0:0:555" ] || {
      echo "homebrew-patched-launcher: isolated trust-store ownership or mode is unsafe" >&2
      return 2
    }
  for config_file in "$trust_file" "$trust_lock"; do
    "$sudo_bin" -H -u "$build_user" -- test -r "$config_file" &&
      ! "$sudo_bin" -H -u "$build_user" -- test -w "$config_file" || {
        echo "homebrew-patched-launcher: isolated trust-store access is unsafe: $config_file" >&2
        return 2
      }
  done
  mutable_roots=("$work_dir" "$HOMEBREW_CACHE" "$HOMEBREW_TEMP" "$build_home")
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    mutable_roots+=(
      "$HOMEBREW_PATCHED_NATIVE_PREFIX"
      "$HOMEBREW_PATCHED_NATIVE_CACHE"
      "$HOMEBREW_PATCHED_NATIVE_TEMP"
      "$HOMEBREW_PATCHED_NATIVE_CONFIG"
      "$HOMEBREW_PATCHED_NATIVE_HOME"
    )
  fi
  for mutable_root in "${mutable_roots[@]}"; do
    if ! "$sudo_bin" -H -u "$build_user" -- test -r "$mutable_root" -a \
      -x "$mutable_root" -a -w "$mutable_root"; then
      echo "homebrew-patched-launcher: build user cannot access mutable build root: $mutable_root" >&2
      return 2
    fi
  done
  homebrew_assert_tree_not_replaceable_by_user "$build_user" "$sysroot" || return

  protected_anchor="/run/kandelo-homebrew-publisher"
  [ "$(/usr/bin/stat -c '%u:%g:%a' /run)" = "0:0:755" ] || {
    echo "homebrew-patched-launcher: /run does not provide a protected publisher anchor" >&2
    return 2
  }
  "$sudo_bin" /usr/bin/install -d -o root -g root -m 0711 \
    "$protected_anchor" || return
  [ "$(/usr/bin/stat -c '%u:%g:%a' "$protected_anchor")" = "0:0:711" ] || {
    echo "homebrew-patched-launcher: protected publisher anchor has unsafe access" >&2
    return 2
  }
  protected_nonce="$(
    /usr/bin/od -An -N32 -tx1 /dev/urandom | /usr/bin/tr -d ' \n'
  )" || return
  [[ "$protected_nonce" =~ ^[0-9a-f]{64}$ ]] || {
    echo "homebrew-patched-launcher: could not create a protected build identity" >&2
    return 2
  }
  HOMEBREW_PATCHED_PROTECTED_DIR="$protected_anchor/build-$protected_nonce"
  "$sudo_bin" install -d -o root -g root -m 0755 "$HOMEBREW_PATCHED_PROTECTED_DIR"
  HOMEBREW_PATCHED_PROTECTED_DIR_STATE="$(
    /usr/bin/stat -c '%d:%i:%u:%g' "$HOMEBREW_PATCHED_PROTECTED_DIR"
  )" || return
  if [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ]; then
    HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR="$HOMEBREW_PATCHED_PROTECTED_DIR/native-api"
    "$sudo_bin" /usr/bin/install -d -o root -g root -m 0555 \
      "$HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR" || return
  fi
  # WHY: the wrapper source is frozen before privileged recipe-runner staging.
  # Derive its two fixed paths from the already-selected protected build root
  # instead of serializing lifecycle globals that are intentionally populated
  # only after the runner and sealed-output directory have been authenticated.
  recipe_runner_path="$HOMEBREW_PATCHED_PROTECTED_DIR/homebrew-tap-recipe-runner"
  recipe_sealed_root="$HOMEBREW_PATCHED_PROTECTED_DIR/sealed-outputs"
  protected_xtask="$HOMEBREW_PATCHED_PROTECTED_DIR/xtask"
  # WHY: a read-only bind preserves the source inode's uid. Stage the already
  # validated bytes as one root-owned inode before Formula code runs so tap
  # support can authenticate the checker without trusting a workflow-user uid.
  "$sudo_bin" /usr/bin/install -o root -g root -m 0555 -- \
    "$xtask_bin" "$protected_xtask"
  xtask_state_after="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$xtask_bin")" ||
    return 2
  xtask_sha256_after="$(/usr/bin/sha256sum "$xtask_bin")" || return 2
  xtask_sha256_after="${xtask_sha256_after%% *}"
  xtask_alias_state="$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' "$protected_xtask")" ||
    return 2
  xtask_alias_sha256="$(/usr/bin/sha256sum "$protected_xtask")" || return 2
  xtask_alias_sha256="${xtask_alias_sha256%% *}"
  if [ "$xtask_state_after" != "$xtask_state" ] || \
     [ "$xtask_sha256_after" != "$xtask_sha256" ] || \
     [ "$xtask_alias_sha256" != "$xtask_sha256" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$protected_xtask")" != "0:0:555:1" ] || \
     ! /usr/bin/cmp -s -- "$xtask_bin" "$protected_xtask"; then
    echo "homebrew-patched-launcher: could not stage the root-owned program-index checker" >&2
    return 2
  fi
  HOMEBREW_PATCHED_PROTECTED_XTASK="$protected_xtask"
  HOMEBREW_PATCHED_PROTECTED_XTASK_STATE="$xtask_alias_state"
  HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256="$xtask_alias_sha256"
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    homebrew_patched_launcher_prepare_native_link_auditor \
      "$kandelo_root" "$build_user" "$sudo_bin" || return
  fi
  platform_source_root="$kandelo_root"
  if [ "$tap_recipe_isolation" = "1" ]; then
    homebrew_patched_launcher_prepare_platform_projection \
      "$kandelo_root" "$HOMEBREW_PATCHED_PROTECTED_DIR/platform" \
      "$sudo_bin" || return
    platform_source_root="$HOMEBREW_PATCHED_PLATFORM_ROOT"
    formula_test_program_index="$(
      /usr/bin/realpath -- \
        "${xtask_bin%/*}/formula-test-program-packages.json" 2>/dev/null ||
        true
    )"
    homebrew_patched_launcher_prepare_formula_test_runtime \
      "$kandelo_root" \
      "$HOMEBREW_PATCHED_PROTECTED_DIR/formula-test-runtime" \
      "$platform_source_root" "$protected_xtask" "$xtask_relative" \
      "$formula_test_program_index" "$sudo_bin" || return
  fi
  source_alias_dir="$work_dir/source-aliases"
  "$sudo_bin" install -d -o root -g root -m 0555 \
    "$source_alias_dir" "$source_alias_dir/kandelo" "$source_alias_dir/tap" \
    "$source_alias_dir/sysroot"
  HOMEBREW_PATCHED_SOURCE_ALIAS_DIR="$source_alias_dir"
  xtask_alias="$source_alias_dir/kandelo/$xtask_relative"
  tap_recipe_inaccessible_paths=("-$xtask_alias")
  for tap_recipe_relative in \
    packages/registry local-binaries .ci-test-binary-cache \
    scripts/install-local-binary.sh; do
    tap_recipe_path="$kandelo_root/$tap_recipe_relative"
    if [ -e "$tap_recipe_path" ] || [ -L "$tap_recipe_path" ]; then
      # WHY: schema 3 deliberately excludes these legacy resolver paths from
      # the closed platform projection. systemd treats an absent, unprefixed
      # InaccessiblePaths= target as a namespace setup error; `-` keeps the
      # mask effective if a path appears while allowing the intended absence.
      tap_recipe_inaccessible_paths+=(
        "-$source_alias_dir/kandelo/$tap_recipe_relative"
      )
    fi
  done
  audit_source="$work_dir/audit-source-aliases"
  protected_audit="$HOMEBREW_PATCHED_PROTECTED_DIR/audit-source-aliases"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    # WHY: explicit audit branches already explain expected rejections, but an
    # unforeseen `set -e` failure otherwise becomes only a transient unit exit
    # code. Keep the unexpected command and line observable without allowing
    # the audit to continue after a failed invariant.
    printf 'source_audit_failed() {\n'
    printf '  local status="$1" line="$2" command="$3"\n'
    printf '  trap - ERR\n'
    printf '  printf '\''homebrew-patched-launcher: protected source audit failed at line %%s (status %%s): %%s\\n'\'' "$line" "$status" "$command" >&2\n'
    printf '  exit "$status"\n}\n'
    printf 'trap '\''source_audit_failed "$?" "$LINENO" "$BASH_COMMAND"'\'' ERR\n'
    printf 'expected_kandelo=%q\n' "$source_alias_dir/kandelo"
    printf 'expected_tap=%q\n' "$source_alias_dir/tap"
    printf 'expected_sysroot=%q\n' "$source_alias_dir/sysroot"
    printf 'expected_primary_tap=%q\n' "$primary_tap_root"
    homebrew_patched_launcher_emit_xtask_access_audit \
      "$tap_recipe_isolation" "$xtask_alias" "$protected_xtask" \
      "$xtask_alias_state" "$xtask_alias_sha256" /usr/bin/findmnt
    printf 'if [ "${HOMEBREW_KANDELO_ROOT:-}" != "$expected_kandelo" ] || '
    printf '[ "${KANDELO_HOMEBREW_KANDELO_ROOT:-}" != "$expected_kandelo" ]; then\n'
    printf '  echo "homebrew-patched-launcher: isolated Kandelo root does not use the protected alias" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'if [ "${HOMEBREW_KANDELO_SYSROOT:-}" != "$expected_sysroot" ] || '
    printf '[ "${WASM_POSIX_SYSROOT:-}" != "$expected_sysroot" ]; then\n'
    printf '  echo "homebrew-patched-launcher: isolated sysroot does not use the protected alias" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'if [ "${HOMEBREW_KANDELO_PRIMARY_TAP_ROOT:-}" != "$expected_primary_tap" ]; then\n'
    printf '  echo "homebrew-patched-launcher: isolated primary tap root changed" >&2\n'
    printf '  exit 2\nfi\n'
    if [ "$tap_recipe_isolation" = "1" ]; then
      printf 'required_platform_inputs=('
      for tap_recipe_path in \
        sdk/bin/wasm32posix-cc sdk/bin/wasm64posix-cc \
        sdk/src/bin/cc.ts sdk/src/lib/toolchain.ts sdk/config.site \
        libc/glue/abi_constants.h scripts/run-wasm-fork-instrument.sh \
        scripts/run-wasm-local-root-spill.sh scripts/wasm-artifact-guards.sh \
        tools/bin/wasm-fork-instrument tools/bin/wasm-local-root-spill \
        crates/shared/src/lib.rs; do
        printf ' %q' "$tap_recipe_path"
      done
      printf ')\n'
      printf 'for platform_input in "${required_platform_inputs[@]}"; do\n'
      printf '  if [ ! -f "$expected_kandelo/$platform_input" ] || [ -L "$expected_kandelo/$platform_input" ] || [ ! -r "$expected_kandelo/$platform_input" ]; then\n'
      printf '    echo "homebrew-patched-launcher: required platform projection input is unavailable: $platform_input" >&2\n'
      printf '    exit 2\n  fi\ndone\n'
      printf 'for forbidden_platform_input in .git Cargo.toml Cargo.lock packages local-binaries .ci-test-binary-cache target tools/xtask scripts/dev-shell.sh scripts/install-local-binary.sh; do\n'
      printf '  forbidden_path="$expected_kandelo/$forbidden_platform_input"\n'
      printf '  if [ -e "$forbidden_path" ] || [ -L "$forbidden_path" ] || [ -r "$forbidden_path" ] || [ -w "$forbidden_path" ] || [ -x "$forbidden_path" ]; then\n'
      printf '    echo "homebrew-patched-launcher: closed platform projection exposes undeclared authority: $forbidden_platform_input" >&2\n'
      printf '    exit 2\n  fi\ndone\n'
    fi
    printf 'if [ ! -f "$expected_sysroot/lib/libc.a" ] || [ -L "$expected_sysroot/lib/libc.a" ]; then\n'
    printf '  echo "homebrew-patched-launcher: protected sysroot libc archive is invalid" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'for source_alias in "$expected_kandelo" "$expected_tap" "$expected_sysroot"; do\n'
    printf '  if [ ! -d "$source_alias" ] || [ ! -r "$source_alias" ] || [ ! -x "$source_alias" ]; then\n'
    printf '    echo "homebrew-patched-launcher: protected source alias is inaccessible: $source_alias" >&2\n'
    printf '    exit 2\n  fi\n'
    printf '  mount_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$source_alias")" || {\n'
    printf '    echo "homebrew-patched-launcher: could not inspect protected source mount: $source_alias" >&2\n'
    printf '    exit 2\n  }\n'
    printf '  case ",${mount_options// /}," in\n'
    printf '    *,ro,*) ;;\n'
    printf '    *) echo "homebrew-patched-launcher: protected source mount is writable: $source_alias" >&2; exit 1 ;;\n'
    printf '  esac\ndone\n'
    printf 'primary_tap_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$expected_primary_tap")" || {\n'
    printf '  echo "homebrew-patched-launcher: could not inspect selected primary tap mount" >&2; exit 2;\n}\n'
    printf 'case ",${primary_tap_options// /}," in *,ro,*) ;; *) echo "homebrew-patched-launcher: selected primary tap is writable" >&2; exit 1 ;; esac\n'
    printf 'if (: >"$expected_primary_tap/.kandelo-write-probe") 2>/dev/null; then\n'
    printf '  echo "homebrew-patched-launcher: target Formula can modify the selected primary tap" >&2; exit 1\nfi\n'
    homebrew_patched_launcher_emit_sysroot_access_audit
    printf 'hidden_roots=('
    for protected_root in "$kandelo_root" "$tap_root" "$output_root" \
      "$sysroot_build_root" "${additional_protected_roots[@]}"; do
      printf ' %q' "$protected_root"
    done
    if [ "$tap_recipe_isolation" = "1" ]; then
      printf ' %q %q' "$platform_source_root" \
        "$HOMEBREW_PATCHED_FORMULA_TEST_ROOT"
    fi
    printf ')\nfor hidden_root in "${hidden_roots[@]}"; do\n'
    printf '  if [ -r "$hidden_root" ] || [ -w "$hidden_root" ] || [ -x "$hidden_root" ]; then\n'
    printf '    echo "homebrew-patched-launcher: original protected root is usable by Formula execution: $hidden_root" >&2\n'
    printf '    exit 1\n  fi\n'
    printf '  if /usr/bin/ls "$hidden_root" >/dev/null 2>&1; then\n'
    printf '    echo "homebrew-patched-launcher: Formula execution can list an original protected root: $hidden_root" >&2\n'
    printf '    exit 1\n  fi\n'
    printf '  if (: >"$hidden_root/.kandelo-write-probe") 2>/dev/null; then\n'
    printf '    echo "homebrew-patched-launcher: Formula execution can modify an original protected root: $hidden_root" >&2\n'
    printf '    exit 1\n  fi\ndone\n'
    if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
      printf 'native_prefix=%q\n' "$HOMEBREW_PATCHED_NATIVE_PREFIX"
      printf 'native_mount_options="$(/usr/bin/findmnt --noheadings --output VFS-OPTIONS --target "$native_prefix")" || {\n'
      printf '  echo "homebrew-patched-launcher: could not inspect native Homebrew mount" >&2; exit 2;\n}\n'
      printf 'case ",${native_mount_options// /}," in *,ro,*) ;; *) echo "homebrew-patched-launcher: native Homebrew prefix is writable" >&2; exit 1 ;; esac\n'
      printf 'if (: >"$native_prefix/.kandelo-write-probe") 2>/dev/null; then\n'
      printf '  echo "homebrew-patched-launcher: target Formula can modify native Homebrew" >&2; exit 1\nfi\n'
    fi
  } >"$audit_source"
  "$sudo_bin" install -o root -g root -m 0555 "$audit_source" "$protected_audit"
  rm -f "$audit_source"

  wrapper_source="$work_dir/run-isolated-brew"
  wrapper_path="$HOMEBREW_PATCHED_PROTECTED_DIR/run-brew"
  preserved_variables=(
    CI GITHUB_ACTIONS RUNNER_OS LANG LC_ALL TZ SOURCE_DATE_EPOCH
    PATH XDG_CONFIG_HOME
    HOMEBREW_CACHE HOMEBREW_TEMP HOMEBREW_NO_AUTO_UPDATE
    HOMEBREW_NO_INSTALL_CLEANUP HOMEBREW_NO_ANALYTICS HOMEBREW_DEVELOPER
    KANDELO_HOMEBREW_ARCH
    HOMEBREW_KANDELO_ARCH HOMEBREW_KANDELO_NODE
    HOMEBREW_KANDELO_PRIMARY_TAP_ROOT
    HOMEBREW_GIT_PATH
    HOMEBREW_KANDELO_GNU_TAR HOMEBREW_KANDELO_LLVM_BIN HOMEBREW_KANDELO_ABI
    HOMEBREW_KANDELO_NODE_RECEIPT_PATH
    LLVM_BIN WASM_POSIX_LLVM_DIR
    NIX_SSL_CERT_FILE SSL_CERT_FILE PLAYWRIGHT_BROWSERS_PATH
  )
  native_preserved_variables=(
    CI GITHUB_ACTIONS RUNNER_OS LANG LC_ALL TZ SOURCE_DATE_EPOCH PATH
    HOMEBREW_NO_AUTO_UPDATE HOMEBREW_NO_INSTALL_CLEANUP
    HOMEBREW_NO_ANALYTICS HOMEBREW_DEVELOPER HOMEBREW_GIT_PATH
    NIX_SSL_CERT_FILE SSL_CERT_FILE
  )
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'xtask_path=%q\n' "$xtask_bin"
    printf 'xtask_state=%q\n' "$xtask_state"
    printf 'xtask_sha256=%q\n' "$xtask_sha256"
    printf 'protected_xtask_path=%q\n' "$protected_xtask"
    printf 'protected_xtask_state=%q\n' "$xtask_alias_state"
    printf 'protected_xtask_sha256=%q\n' "$xtask_alias_sha256"
    printf 'actual_xtask_sha256="$(/usr/bin/sha256sum "$xtask_path" 2>/dev/null || true)"\n'
    printf 'actual_xtask_sha256="${actual_xtask_sha256%%%% *}"\n'
    printf 'actual_protected_xtask_sha256="$(/usr/bin/sha256sum "$protected_xtask_path" 2>/dev/null || true)"\n'
    printf 'actual_protected_xtask_sha256="${actual_protected_xtask_sha256%%%% *}"\n'
    # WHY: the source checkout is trusted but workflow-owned. Rechecking its
    # inode and bytes for every Formula entry prevents a later workflow step
    # from silently turning the already-reviewed checker path into new code.
    printf 'if [ ! -f "$xtask_path" ] || [ -L "$xtask_path" ] || [ ! -x "$xtask_path" ] || '
    printf '[ "$(/usr/bin/realpath -- "$xtask_path")" != "$xtask_path" ] || '
    printf '[ "$(/usr/bin/stat -c '\''%%d:%%i:%%u:%%g:%%a:%%h:%%s'\'' "$xtask_path")" != "$xtask_state" ] || '
    printf '[ "$actual_xtask_sha256" != "$xtask_sha256" ]; then\n'
    printf '  echo "homebrew-patched-launcher: prepared program-index checker changed after isolation" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'if [ ! -f "$protected_xtask_path" ] || [ -L "$protected_xtask_path" ] || '
    printf '[ "$(/usr/bin/stat -c '\''%%d:%%i:%%u:%%g:%%a:%%h:%%s'\'' "$protected_xtask_path")" != "$protected_xtask_state" ] || '
    printf '[ "$actual_protected_xtask_sha256" != "$protected_xtask_sha256" ]; then\n'
    printf '  echo "homebrew-patched-launcher: root-owned program-index checker changed after isolation" >&2\n'
    printf '  exit 2\nfi\n'
    printf 'bottle_tag_env=()\n'
    for variable in KANDELO_HOMEBREW_BOTTLE_TAG HOMEBREW_KANDELO_BOTTLE_TAG; do
      printf 'if [ -n "${%s+x}" ]; then bottle_tag_env+=("%s=${%s}"); fi\n' \
        "$variable" "$variable" "$variable"
    done
    printf 'command_path=%q\n' "$HOMEBREW_PATCHED_LAUNCHER"
    printf 'platform_projection=%q\n' "$platform_source_root"
    printf 'formula_test_projection=%q\n' \
      "$HOMEBREW_PATCHED_FORMULA_TEST_ROOT"
    printf 'kandelo_alias=%q\n' "$source_alias_dir/kandelo"
    printf 'source_audit=0\n'
    printf 'formula_test=0\n'
    printf 'kandelo_projection="$platform_projection"\n'
    printf 'formula_test_env=()\n'
    printf 'if [ "${1:-}" = __kandelo_verify_source_aliases ]; then\n'
    printf '  [ "$#" -eq 1 ] || { echo "homebrew-patched-launcher: source audit accepts no arguments" >&2; exit 2; }\n'
    printf '  command_path=%q\n' "$protected_audit"
    printf '  source_audit=1\n'
    printf '  shift\nfi\n'
    if [ "$tap_recipe_isolation" = "1" ]; then
      printf 'if [ "$source_audit" = 0 ] && [ "${1:-}" = test ]; then\n'
      printf '  [ -n "$formula_test_projection" ] || { echo "homebrew-patched-launcher: Formula test runtime is unavailable" >&2; exit 2; }\n'
      printf '  formula_test=1\n'
      printf '  kandelo_projection="$formula_test_projection"\n'
      printf '  formula_test_env+=('
      printf ' %q' \
        "HOMEBREW_KANDELO_XTASK_BIN=$xtask_alias" \
        "WASM_POSIX_XTASK_BIN=$xtask_alias"
      printf ' )\n'
      printf 'fi\n'
    fi
    printf 'formula_inaccessible_args=()\n'
    if [ "$tap_recipe_isolation" = "1" ]; then
      printf 'if [ "$formula_test" != 1 ]; then\n'
      for tap_recipe_path in "${tap_recipe_inaccessible_paths[@]}"; do
        printf '  formula_inaccessible_args+=(%q)\n' \
          "--property=InaccessiblePaths=$tap_recipe_path"
      done
      printf 'fi\n'
    fi
    printf 'working_directory=%q\n' "$work_dir"
    printf 'unit=%q-$$-${RANDOM}.service\n' "$unit_prefix"
    printf 'collect_args=(--collect)\n'
    printf 'if [ "$source_audit" = 1 ]; then collect_args=(); fi\n'
    printf 'systemd_command=(%q -n -- %q --quiet --wait "${collect_args[@]}" --pipe' \
      "$sudo_bin" "$systemd_run_bin"
    printf ' --unit="$unit"'
    printf ' %q' "--slice=$systemd_slice" \
      "--uid=$build_user" "--gid=$build_group" \
      "--property=KillMode=control-group" "--property=SendSIGKILL=yes" \
      "--property=TimeoutStopSec=10s" "--property=NoNewPrivileges=yes" \
      "--property=BindReadOnlyPaths=$tap_root:$source_alias_dir/tap" \
      "--property=BindReadOnlyPaths=$sysroot:$source_alias_dir/sysroot" \
      "--property=BindReadOnlyPaths=$taps_root" \
      "--property=InaccessiblePaths=$kandelo_root" \
      "--property=InaccessiblePaths=$tap_root" \
      "--property=InaccessiblePaths=$output_root" \
      "--service-type=exec" \
      "--expand-environment=no"
    printf ' "--property=BindReadOnlyPaths=$kandelo_projection:$kandelo_alias"'
    if [ "$tap_recipe_isolation" != "1" ]; then
      printf ' %q' "--property=BindReadOnlyPaths=$protected_xtask:$xtask_alias"
    fi
    if [ "$sysroot_build_root" != "$kandelo_root" ] && \
       [ "$sysroot_build_root" != "$tap_root" ] && \
       [ "$sysroot_build_root" != "$output_root" ]; then
      printf ' %q' "--property=InaccessiblePaths=$sysroot_build_root"
    fi
    for protected_root in "${additional_protected_roots[@]}"; do
      printf ' %q' "--property=InaccessiblePaths=$protected_root"
    done
    if [ "$tap_recipe_isolation" = "1" ]; then
      # WHY: a tap-owned recipe receives the SDK, sysroot, and instrumenter as
      # platform tooling, but never the old package-registry resolver surface.
      # Masking these paths in the service makes an accidental absolute-path
      # fallback fail even after Formula code reconstructs the source alias.
      printf ' %q %q %q' \
        "--property=InaccessiblePaths=$protected_xtask" \
        "--property=InaccessiblePaths=$platform_source_root" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_FORMULA_TEST_ROOT"
    fi
    if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
      printf ' %q' \
        "--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_NATIVE_PREFIX" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_CACHE" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_TEMP" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_CONFIG" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_HOME"
    fi
    printf ' "${formula_inaccessible_args[@]}"'
    printf ' --working-directory="$working_directory" -- %q -i' "$env_bin"
    printf ' %q' "HOME=$build_home" "USER=$build_user" "LOGNAME=$build_user" \
      "TMPDIR=$HOMEBREW_TEMP"
    for variable in "${preserved_variables[@]}"; do
      if [ -n "${!variable+x}" ]; then
        value="${!variable}"
        printf ' %q' "$variable=$value"
      fi
    done
    # WHY: Homebrew preserves HOMEBREW_* variables across its Formula-test
    # re-exec but rebuilds the ordinary environment. Give tap support a
    # protected alias it can freeze, while direct resolver callers still get
    # the conventional WASM_POSIX_XTASK_BIN name.
    printf ' %q %q %q %q' "HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo" \
      "KANDELO_HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo" \
      "HOMEBREW_KANDELO_SYSROOT=$source_alias_dir/sysroot" \
      "WASM_POSIX_SYSROOT=$source_alias_dir/sysroot"
    if [ "$tap_recipe_isolation" != "1" ]; then
      printf ' %q %q' "HOMEBREW_KANDELO_XTASK_BIN=$xtask_alias" \
        "WASM_POSIX_XTASK_BIN=$xtask_alias"
    else
      printf ' %q %q %q %q' \
        "HOMEBREW_KANDELO_FORK_INSTRUMENT=$source_alias_dir/kandelo/tools/bin/wasm-fork-instrument" \
        "HOMEBREW_KANDELO_LOCAL_ROOT_SPILL=$source_alias_dir/kandelo/tools/bin/wasm-local-root-spill" \
        "HOMEBREW_KANDELO_TAP_RECIPE_RUNNER=$recipe_runner_path" \
        "HOMEBREW_KANDELO_TAP_RECIPE_SEALED_ROOT=$recipe_sealed_root"
    fi
    printf ' "${bottle_tag_env[@]}" "${formula_test_env[@]}" "$command_path" "$@")\n'
    printf 'if [ "$source_audit" != 1 ]; then exec "${systemd_command[@]}"; fi\n'
    # WHY: --collect erases a failed transient unit before its namespace error
    # can be inspected. The startup audit carries no credentials, so preserve
    # only that unit long enough to print bounded systemctl status, then reset
    # it immediately. Formula commands retain the ordinary collect-and-exec
    # path and cannot use diagnostics to continue after a failed boundary.
    printf 'set +e\n'
    printf '"${systemd_command[@]}"\n'
    printf 'source_audit_status="$?"\n'
    printf 'set -e\n'
    printf 'if [ "$source_audit_status" -ne 0 ]; then\n'
    printf '  %q -n -- %q status "$unit" --no-pager --lines=20 >&2 || true\n' \
      "$sudo_bin" "$systemctl_bin"
    printf 'fi\n'
    printf '%q -n -- %q reset-failed "$unit" >/dev/null 2>&1 || true\n' \
      "$sudo_bin" "$systemctl_bin"
    printf 'exit "$source_audit_status"\n'
  } >"$wrapper_source"
  "$sudo_bin" install -o root -g root -m 0555 "$wrapper_source" "$wrapper_path"
  rm -f "$wrapper_source"

  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    native_runner_source="$work_dir/run-isolated-native-brew"
    native_runner_path="$HOMEBREW_PATCHED_PROTECTED_DIR/run-native-brew"
    {
      printf '#!/usr/bin/env bash\nset -euo pipefail\n'
      printf '[ "$#" -gt 0 ] || { echo "homebrew-patched-launcher: native Homebrew command is required" >&2; exit 2; }\n'
      printf 'working_directory=%q\n' "$HOMEBREW_PATCHED_NATIVE_TEMP"
      printf 'unit=%q-native-$$-${RANDOM}.service\n' "$unit_prefix"
      printf 'exec %q --quiet --wait --collect --pipe' "$systemd_run_bin"
      printf ' --unit="$unit"'
      printf ' %q' "--slice=$systemd_slice" \
        "--uid=$build_user" "--gid=$build_group" \
        "--property=KillMode=control-group" "--property=SendSIGKILL=yes" \
        "--property=TimeoutStopSec=10s" "--property=NoNewPrivileges=yes" \
        "--property=BindReadOnlyPaths=$work_dir" \
        "--property=InaccessiblePaths=$kandelo_root" \
        "--property=InaccessiblePaths=$tap_root" \
        "--property=InaccessiblePaths=$output_root" \
        "--property=InaccessiblePaths=$HOMEBREW_PATCHED_PREFIX" \
        "--property=InaccessiblePaths=$HOMEBREW_CACHE" \
        "--property=InaccessiblePaths=$HOMEBREW_TEMP" \
        "--property=InaccessiblePaths=$XDG_CONFIG_HOME" \
        "--property=InaccessiblePaths=$build_home" \
        "--service-type=exec" \
        "--expand-environment=no"
      if [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ]; then
        printf ' %q' \
          "--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_NATIVE_API_SOURCE:$HOMEBREW_PATCHED_NATIVE_CACHE/api"
      fi
      if [ "$sysroot_build_root" != "$kandelo_root" ] && \
         [ "$sysroot_build_root" != "$tap_root" ] && \
         [ "$sysroot_build_root" != "$output_root" ]; then
        printf ' %q' "--property=InaccessiblePaths=$sysroot_build_root"
      fi
      for protected_root in "${additional_protected_roots[@]}"; do
        printf ' %q' "--property=InaccessiblePaths=$protected_root"
      done
      printf ' --working-directory="$working_directory" -- %q -i' "$env_bin"
      printf ' %q' "HOME=$HOMEBREW_PATCHED_NATIVE_HOME" \
        "USER=$build_user" "LOGNAME=$build_user" \
        "TMPDIR=$HOMEBREW_PATCHED_NATIVE_TEMP" \
        "XDG_CONFIG_HOME=$HOMEBREW_PATCHED_NATIVE_CONFIG" \
        "HOMEBREW_CACHE=$HOMEBREW_PATCHED_NATIVE_CACHE" \
        "HOMEBREW_TEMP=$HOMEBREW_PATCHED_NATIVE_TEMP"
      for variable in "${native_preserved_variables[@]}"; do
        if [ -n "${!variable+x}" ]; then
          value="${!variable}"
          printf ' %q' "$variable=$value"
        fi
      done
      printf ' %q' "HOMEBREW_RELOCATE_BUILD_PREFIX=1"
      printf ' %q "$@"\n' "$HOMEBREW_PATCHED_NATIVE_BREW_BIN"
    } >"$native_runner_source"
    "$sudo_bin" /usr/bin/install -o root -g root -m 0500 \
      "$native_runner_source" "$native_runner_path"
    rm -f "$native_runner_source"
    HOMEBREW_PATCHED_NATIVE_RUNNER="$native_runner_path"
  fi
  if [ "$tap_recipe_isolation" = "1" ]; then
    homebrew_patched_launcher_prepare_recipe_runner \
      "$build_user" "$build_group" "$recipe_user" "$primary_tap_root" \
      "$platform_source_root" \
      "$source_alias_dir/kandelo" \
      "$sysroot" "$source_alias_dir/sysroot" \
      "$HOMEBREW_TEMP" "$systemd_slice" "$unit_prefix" "$sudo_bin" \
      "$systemd_run_bin" "$jq_bin" "$node_bin" || return
    if [ "$HOMEBREW_PATCHED_RECIPE_RUNNER" != "$recipe_runner_path" ] || \
       [ "$HOMEBREW_PATCHED_RECIPE_SEALED_ROOT" != "$recipe_sealed_root" ]; then
      echo "homebrew-patched-launcher: staged recipe boundary differs from the frozen wrapper paths" >&2
      return 2
    fi
  else
    "$sudo_bin" chmod 0555 "$HOMEBREW_PATCHED_PROTECTED_DIR"
  fi

  # Capture Git identity while the trusted workflow user still owns the
  # overlay and can traverse its linked-worktree backing metadata. After the
  # next step seals the workflow-owned overlay against mutation, isolated
  # admission uses only the immutable attestation built from these values.
  overlay_repository="$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" || return
  overlay_commit="$(
    /usr/bin/env -i \
      HOME=/nonexistent PATH=/usr/bin:/bin LC_ALL=C \
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 \
      "$HOMEBREW_GIT_PATH" -C "$overlay_repository" \
        rev-parse --verify 'HEAD^{commit}'
  )" || return
  overlay_tree="$(
    /usr/bin/env -i \
      HOME=/nonexistent PATH=/usr/bin:/bin LC_ALL=C \
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 \
      "$HOMEBREW_GIT_PATH" -C "$overlay_repository" \
        rev-parse --verify 'HEAD^{tree}'
  )" || return
  [[ "$overlay_commit" =~ ^[0-9a-f]{40}$ ]] &&
    [[ "$overlay_tree" =~ ^[0-9a-f]{40}$ ]] || {
    echo "homebrew-patched-launcher: trusted Homebrew Git identity is invalid" >&2
    return 2
  }

  # Git still needs the workflow-owned backing repository. Normalize every
  # trusted file materialized in the temporary worktree, including Bundler
  # output whose archive modes are not part of the publisher boundary.
  homebrew_patched_launcher_seal_overlay "$build_user" || return
  homebrew_assert_tree_not_writable_by_user \
    "$build_user" "$source_alias_dir" || return
  homebrew_assert_tree_not_replaceable_by_user \
    "$build_user" "$source_alias_dir" || return
  HOMEBREW_PATCHED_INTEGRITY_SHA256="$(
    homebrew_patched_launcher_integrity
  )" || return
  if [ -n "$HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR" ]; then
    homebrew_patched_launcher_stage_native_overlay_attestation \
      "$work_dir" "$jq_bin" "$build_user" \
      "$overlay_commit" "$overlay_tree" || return
  fi
  HOMEBREW_PATCHED_SYSTEMD_RUN_BIN="$systemd_run_bin"
  HOMEBREW_PATCHED_SYSTEMCTL_BIN="$systemctl_bin"
  HOMEBREW_PATCHED_GETENT_BIN="$getent_bin"
  HOMEBREW_PATCHED_PGREP_BIN="$pgrep_bin"
  HOMEBREW_PATCHED_PKILL_BIN="$pkill_bin"
  HOMEBREW_PATCHED_BUILD_USER="$build_user"
  HOMEBREW_PATCHED_BUILD_UID="$build_uid"
  HOMEBREW_PATCHED_SYSTEMD_SLICE="$systemd_slice"
  HOMEBREW_PATCHED_TEARDOWN_COMPLETE=0

  HOMEBREW_PATCHED_BREW_BIN="$wrapper_path"
  "$HOMEBREW_PATCHED_BREW_BIN" __kandelo_verify_source_aliases || {
    echo "homebrew-patched-launcher: isolated source aliases failed verification" >&2
    return 1
  }
  if ! patched_prefix="$("$HOMEBREW_PATCHED_BREW_BIN" --prefix)"; then
    echo "homebrew-patched-launcher: isolated wrapper could not report the Homebrew prefix" >&2
    return 1
  fi
  if ! patched_repo="$("$HOMEBREW_PATCHED_BREW_BIN" --repository)"; then
    echo "homebrew-patched-launcher: isolated wrapper could not report the Homebrew repository" >&2
    return 1
  fi
  [ "$patched_prefix" = "$HOMEBREW_PATCHED_PREFIX" ] || {
    echo "homebrew-patched-launcher: isolated wrapper changed Homebrew prefix" >&2
    return 1
  }
  [ "$(cd "$patched_repo" && pwd -P)" = "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ] || {
    echo "homebrew-patched-launcher: isolated wrapper changed Homebrew repository" >&2
    return 1
  }
  homebrew_patched_launcher_verify_isolated_native_identity || return
}

# Remove the one registered protected input without discarding retry state on
# failure. Formula processes must already be stopped before normal cleanup
# calls this helper.
homebrew_patched_launcher_remove_staged_input() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_remove_staged_input: expected no arguments" >&2
    return 2
  fi
  if [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] && \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] && \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ]; then
    return 0
  fi
  if [ -z "$HOMEBREW_PATCHED_SUDO_BIN" ] || \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] || \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] || \
     [ -z "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ] || \
     [ "${HOMEBREW_PATCHED_STAGED_INPUT_PATH%/*}" != \
       "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ]; then
    echo "homebrew-patched-launcher: protected input cleanup state is incomplete" >&2
    return 1
  fi
  case "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" in
    "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP"/homebrew-bottle-input.??????) ;;
    *)
      echo "homebrew-patched-launcher: protected input cleanup path left its shared root" >&2
      return 1
      ;;
  esac
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/rm -rf -- \
       "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" || \
     [ -e "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] || \
     [ -L "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ]; then
    echo "homebrew-patched-launcher: could not remove protected input; preserving cleanup state for retry" >&2
    return 1
  fi
  HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP=""
  HOMEBREW_PATCHED_STAGED_INPUT_DIR=""
  HOMEBREW_PATCHED_STAGED_INPUT_PATH=""
}

# Copy one workflow-owned input into a root-owned directory that the isolated
# Formula identity can read but cannot modify or replace.
homebrew_patched_launcher_stage_protected_input() {
  if [ "$#" -ne 4 ]; then
    echo "homebrew_patched_launcher_stage_protected_input: expected BUILD_USER SHARED_TEMP SOURCE BASENAME" >&2
    return 2
  fi
  local build_user="$1" shared_temp="$2" source="$3" basename="$4"
  local protected_dir="" protected_path=""

  if [ -z "$HOMEBREW_PATCHED_BUILD_USER" ] || \
     [ "$build_user" != "$HOMEBREW_PATCHED_BUILD_USER" ] || \
     [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" = "1" ] || \
     [ -z "$HOMEBREW_PATCHED_SUDO_BIN" ]; then
    echo "homebrew-patched-launcher: protected input requires the initialized Formula identity" >&2
    return 2
  fi
  if [ -n "$HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP" ] || \
     [ -n "$HOMEBREW_PATCHED_STAGED_INPUT_DIR" ] || \
     [ -n "$HOMEBREW_PATCHED_STAGED_INPUT_PATH" ]; then
    echo "homebrew-patched-launcher: a protected input is already registered" >&2
    return 2
  fi
  if [ ! -f "$source" ] || [ -L "$source" ]; then
    echo "homebrew-patched-launcher: protected input source is not a regular file: $source" >&2
    return 2
  fi
  if [ "${#basename}" -gt 512 ] || \
     ! [[ "$basename" =~ ^[A-Za-z0-9][A-Za-z0-9@._+,\-]*$ ]]; then
    echo "homebrew-patched-launcher: invalid protected input basename: $basename" >&2
    return 2
  fi
  if [ ! -d "$shared_temp" ] || [ -L "$shared_temp" ]; then
    echo "homebrew-patched-launcher: protected input shared temp is not a real directory" >&2
    return 2
  fi
  shared_temp="$(cd "$shared_temp" && pwd -P)" || return 2
  if [ "$(/usr/bin/stat -c '%u:%g:%a' "$shared_temp")" != "0:0:1777" ]; then
    echo "homebrew-patched-launcher: protected input shared temp must be root-owned mode 1777" >&2
    return 2
  fi

  protected_dir="$(/usr/bin/mktemp -d "$shared_temp/homebrew-bottle-input.XXXXXX")" || return 1
  protected_path="$protected_dir/$basename"
  HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP="$shared_temp"
  HOMEBREW_PATCHED_STAGED_INPUT_DIR="$protected_dir"
  HOMEBREW_PATCHED_STAGED_INPUT_PATH="$protected_path"
  if ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/install \
       -o root -g root -m 0444 -- "$source" "$protected_path" || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown root:root \
       "$protected_dir" || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chmod 0555 \
       "$protected_dir"; then
    echo "homebrew-patched-launcher: could not stage protected input" >&2
    homebrew_patched_launcher_remove_staged_input || true
    return 1
  fi

  if [ "$(/usr/bin/stat -c '%u:%g:%a' "$protected_dir")" != "0:0:555" ] || \
     [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$protected_path")" != "0:0:444:1" ] || \
     [ "$source" -ef "$protected_path" ] || \
     ! /usr/bin/cmp -s -- "$source" "$protected_path" || \
     ! "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
       /usr/bin/test -r "$protected_path" || \
     "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
       /usr/bin/test -w "$protected_path" || \
     "$HOMEBREW_PATCHED_SUDO_BIN" -n -H -u "$build_user" -- \
       /usr/bin/test -w "$protected_dir" || \
     ! homebrew_assert_tree_not_writable_by_user "$build_user" "$protected_dir" || \
     ! homebrew_assert_tree_not_replaceable_by_user "$build_user" "$protected_dir"; then
    echo "homebrew-patched-launcher: protected input is not root-owned, exact, readable, and immutable" >&2
    homebrew_patched_launcher_remove_staged_input || true
    return 1
  fi

}

homebrew_patched_launcher_uid_has_processes() {
  if [ "$#" -ne 0 ]; then
    echo "homebrew_patched_launcher_uid_has_processes: expected no arguments" >&2
    return 2
  fi
  local status uid
  local -a uids=("$HOMEBREW_PATCHED_BUILD_UID")
  if [ -n "$HOMEBREW_PATCHED_RECIPE_UID" ]; then
    uids+=("$HOMEBREW_PATCHED_RECIPE_UID")
  fi
  for uid in "${uids[@]}"; do
    if "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PGREP_BIN" \
      -u "$uid" >/dev/null 2>&1; then
      return 0
    else
      status="$?"
    fi
    if [ "$status" -ne 1 ]; then
      echo "homebrew-patched-launcher: could not inspect isolated build processes" >&2
      return 2
    fi
  done
  return 1
}

homebrew_patched_launcher_stop_and_verify_unit() {
  if [ "$#" -ne 3 ]; then
    echo "homebrew_patched_launcher_stop_and_verify_unit: expected UNIT LABEL REQUIRE-REMOVED" >&2
    return 2
  fi
  local unit="$1" label="$2" require_removed="$3"
  local active_state load_state control_group cgroup_path
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
    kill --kill-whom=all --signal=KILL "$unit" >/dev/null 2>&1 || true
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
    stop "$unit" >/dev/null 2>&1 || true
  control_group="$(
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
      show --property=ControlGroup --value "$unit" 2>/dev/null || true
  )"
  active_state="$(
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
      show --property=ActiveState --value "$unit" 2>/dev/null || true
  )"
  case "$active_state" in
    ""|inactive|failed) ;;
    *)
      echo "homebrew-patched-launcher: $label remained $active_state after teardown" >&2
      return 1
      ;;
  esac
  if [ -n "$control_group" ]; then
    if [[ "$control_group" != /* ]] || [[ "$control_group" == *..* ]] || \
       [[ "$control_group" == *:* ]] || [[ "$control_group" == *$'\n'* ]]; then
      echo "homebrew-patched-launcher: $label reported an unsafe cgroup" >&2
      return 1
    fi
    cgroup_path="/sys/fs/cgroup${control_group}"
    if [ -s "$cgroup_path/cgroup.procs" ]; then
      echo "homebrew-patched-launcher: $label cgroup still contains processes" >&2
      return 1
    fi
  fi
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
    reset-failed "$unit" >/dev/null 2>&1 || true
  if [ "$require_removed" = "1" ]; then
    load_state="$(
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_SYSTEMCTL_BIN" \
        show --property=LoadState --value "$unit" 2>/dev/null || true
    )"
    case "$load_state" in
      ""|not-found) ;;
      *)
        echo "homebrew-patched-launcher: $label unit survived cleanup" >&2
        return 1
        ;;
    esac
  elif [ "$require_removed" != "0" ]; then
    echo "homebrew-patched-launcher: invalid unit removal policy" >&2
    return 2
  fi
}

homebrew_patched_launcher_teardown() {
  if [ "$#" -ne 1 ]; then
    echo "homebrew_patched_launcher_teardown: expected BUILD_USER" >&2
    return 2
  fi
  local build_user="$1" attempt process_status
  if [ -z "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    return 0
  fi
  if [ "$build_user" != "$HOMEBREW_PATCHED_BUILD_USER" ]; then
    echo "homebrew-patched-launcher: teardown user differs from isolated build user" >&2
    return 2
  fi
  if [ "$HOMEBREW_PATCHED_TEARDOWN_COMPLETE" = "1" ]; then
    return 0
  fi

  if [ -n "$HOMEBREW_PATCHED_RECIPE_SUPERVISOR_UNIT" ]; then
    homebrew_patched_launcher_stop_and_verify_unit \
      "$HOMEBREW_PATCHED_RECIPE_SUPERVISOR_UNIT" \
      "tap recipe supervisor" 1 || return
  fi
  homebrew_patched_launcher_stop_and_verify_unit \
    "$HOMEBREW_PATCHED_SYSTEMD_SLICE" "Formula build slice" 0 || return
  "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PKILL_BIN" \
    -TERM -u "$HOMEBREW_PATCHED_BUILD_UID" >/dev/null 2>&1 || true
  if [ -n "$HOMEBREW_PATCHED_RECIPE_UID" ]; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PKILL_BIN" \
      -TERM -u "$HOMEBREW_PATCHED_RECIPE_UID" >/dev/null 2>&1 || true
  fi
  for ((attempt = 0; attempt < 50; attempt++)); do
    if homebrew_patched_launcher_uid_has_processes; then
      sleep 0.1
      continue
    else
      process_status="$?"
    fi
    if [ "$process_status" -eq 1 ]; then
      break
    fi
    return "$process_status"
  done
  if homebrew_patched_launcher_uid_has_processes; then
    "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PKILL_BIN" \
      -KILL -u "$HOMEBREW_PATCHED_BUILD_UID" >/dev/null 2>&1 || true
    if [ -n "$HOMEBREW_PATCHED_RECIPE_UID" ]; then
      "$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PKILL_BIN" \
        -KILL -u "$HOMEBREW_PATCHED_RECIPE_UID" >/dev/null 2>&1 || true
    fi
    sleep 1
  else
    process_status="$?"
    [ "$process_status" -eq 1 ] || return "$process_status"
  fi
  if homebrew_patched_launcher_uid_has_processes; then
    echo "homebrew-patched-launcher: Formula build identity still owns live processes" >&2
    return 1
  else
    process_status="$?"
    [ "$process_status" -eq 1 ] || return "$process_status"
  fi
  HOMEBREW_PATCHED_TEARDOWN_COMPLETE=1
}

homebrew_patched_launcher_verify_isolation() {
  if [ -z "$HOMEBREW_PATCHED_PROTECTED_DIR" ] || \
     [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK" ] || \
     [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_STATE" ] || \
     [ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_SHA256" ] || \
     [ -z "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ]; then
    echo "homebrew-patched-launcher: isolated execution was not initialized" >&2
    return 2
  fi
  homebrew_patched_launcher_verify_overlay_seal \
    "$HOMEBREW_PATCHED_BUILD_USER" || return
  homebrew_patched_launcher_verify_protected_xtask || return
  homebrew_patched_launcher_verify_native_link_auditor || return
  homebrew_patched_launcher_verify_platform_projection || return
  homebrew_patched_launcher_verify_formula_test_runtime || return
  homebrew_patched_launcher_verify_sysroot_projection || return
  homebrew_patched_launcher_verify_recipe_runner || return
  homebrew_patched_launcher_verify_native_overlay_attestation || return
  [ "$(homebrew_patched_launcher_integrity)" = "$HOMEBREW_PATCHED_INTEGRITY_SHA256" ] || {
    echo "homebrew-patched-launcher: patched Homebrew source changed during Formula execution" >&2
    return 1
  }
  homebrew_patched_launcher_verify_dependency_plan || return
  [ -L "$HOMEBREW_PATCHED_LAUNCHER" ] && \
    [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_LAUNCHER")" = "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] || {
    echo "homebrew-patched-launcher: protected Brew launcher changed during Formula execution" >&2
    return 1
  }
  if [ -n "$HOMEBREW_PATCHED_NATIVE_PREFIX" ]; then
    [ -n "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR" ] && \
      [ -n "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_STATE" ] && \
      [ -n "$HOMEBREW_PATCHED_NATIVE_LINK_AUDITOR_SHA256" ] || {
      echo "homebrew-patched-launcher: protected native link auditor was not initialized" >&2
      return 2
    }
    [ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ] || {
      echo "homebrew-patched-launcher: native Homebrew was not sealed" >&2
      return 1
    }
    [ -f "$HOMEBREW_PATCHED_NATIVE_RUNNER" ] && \
      [ ! -L "$HOMEBREW_PATCHED_NATIVE_RUNNER" ] && \
      [ "$(/usr/bin/stat -c '%u:%g:%a' "$HOMEBREW_PATCHED_NATIVE_RUNNER")" = "0:0:500" ] || {
      echo "homebrew-patched-launcher: protected native Homebrew runner changed" >&2
      return 1
    }
    [ -L "$HOMEBREW_PATCHED_NATIVE_BREW_BIN" ] && \
      [ "$(/usr/bin/readlink "$HOMEBREW_PATCHED_NATIVE_BREW_BIN")" = \
        "$HOMEBREW_PATCHED_OVERLAY/bin/brew" ] && \
      [ "$(/usr/bin/stat -c '%u:%g' "$HOMEBREW_PATCHED_NATIVE_BREW_BIN")" = "0:0" ] || {
      echo "homebrew-patched-launcher: protected native Brew launcher changed" >&2
      return 1
    }
    homebrew_assert_tree_not_writable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"
    homebrew_assert_tree_not_replaceable_by_user \
      "$HOMEBREW_PATCHED_BUILD_USER" "$HOMEBREW_PATCHED_NATIVE_PREFIX"

    local formula native_rack native_opt native_opt_target native_version
    local target_cellar target_opt target_rack target_keg target_opt_link
    local expected_opt_target build_gid
    build_gid="$(/usr/bin/id -g "$HOMEBREW_PATCHED_BUILD_USER")"
    target_cellar="$HOMEBREW_PATCHED_PREFIX/Cellar"
    target_opt="$HOMEBREW_PATCHED_PREFIX/opt"
    for formula in "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}"; do
      native_rack="$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar/$formula"
      native_opt="$HOMEBREW_PATCHED_NATIVE_PREFIX/opt/$formula"
      [ -d "$native_rack" ] && [ -L "$native_opt" ] || {
        echo "homebrew-patched-launcher: sealed native Formula changed: $formula" >&2
        return 1
      }
      native_opt_target="$(cd "$native_opt" && pwd -P)" || {
        echo "homebrew-patched-launcher: sealed native Formula opt link is unresolved: $formula" >&2
        return 1
      }
      [ "${native_opt_target%/*}" = "$native_rack" ] || {
        echo "homebrew-patched-launcher: sealed native Formula opt link leaves its rack: $formula" >&2
        return 1
      }
      native_version="${native_opt_target##*/}"
      target_rack="$target_cellar/$formula"
      target_keg="$target_rack/$native_version"
      target_opt_link="$target_opt/$formula"
      expected_opt_target="../Cellar/$formula/$native_version"
      [ -d "$target_rack" ] && [ ! -L "$target_rack" ] && \
        [ -d "$target_keg" ] && [ ! -L "$target_keg" ] && \
        [ "$(cd "$target_keg" && pwd -P)" = "$target_keg" ] && \
        [ -L "$target_opt_link" ] && \
        [ "$(/usr/bin/readlink "$target_opt_link")" = "$expected_opt_target" ] && \
        [ "$(cd "$target_opt_link" && pwd -P)" = "$target_keg" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_rack")" = "0:0:555" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_keg")" = "0:0:555" ] && \
        [ "$(/usr/bin/stat -c '%u:%g' "$target_opt_link")" = "0:0" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_cellar")" = \
          "0:$build_gid:1775" ] && \
        [ "$(/usr/bin/stat -c '%u:%g:%a' "$target_opt")" = \
          "0:$build_gid:1775" ] || {
        echo "homebrew-patched-launcher: native Formula proxy changed: $formula" >&2
        return 1
      }
      homebrew_assert_tree_not_writable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack"
      homebrew_assert_tree_not_replaceable_by_user \
        "$HOMEBREW_PATCHED_BUILD_USER" "$target_rack"
    done
  fi
}

homebrew_patched_launcher_prepare() {
  if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "homebrew_patched_launcher_prepare: expected BREW_BIN PATCH_FILE WORK_DIR [EXTRA_PATCH_FILE]" >&2
    return 2
  fi

  local brew_bin="$1"
  local patch_file="$2"
  local work_dir="$3"
  local extra_patch_file="${4:-}"
  local attempt candidate canonical_overlay patched_prefix patched_repo

  if [ -n "$extra_patch_file" ] && [ ! -f "$extra_patch_file" ]; then
    echo "homebrew-patched-launcher: extra patch is unavailable: $extra_patch_file" >&2
    return 2
  fi

  HOMEBREW_PATCHED_REPO="$("$brew_bin" --repository)" || return
  HOMEBREW_PATCHED_PREFIX="$("$brew_bin" --prefix)" || return
  HOMEBREW_PATCHED_BREW_BIN="$brew_bin"

  if [ ! -f "$patch_file" ] ||
     ! git -C "$HOMEBREW_PATCHED_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  git -C "$HOMEBREW_PATCHED_REPO" apply --check "$patch_file" || return
  HOMEBREW_PATCHED_OVERLAY="$work_dir/homebrew-overlay"
  git -C "$HOMEBREW_PATCHED_REPO" worktree add --detach "$HOMEBREW_PATCHED_OVERLAY" HEAD >/dev/null || return
  canonical_overlay="$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" || return
  HOMEBREW_PATCHED_OVERLAY="$canonical_overlay"
  git -C "$HOMEBREW_PATCHED_OVERLAY" apply --whitespace=nowarn "$patch_file" || return
  if [ -n "$extra_patch_file" ]; then
    git -C "$HOMEBREW_PATCHED_OVERLAY" apply --check "$extra_patch_file" || return
    git -C "$HOMEBREW_PATCHED_OVERLAY" apply --whitespace=nowarn "$extra_patch_file" || return
  fi

  # Homebrew derives HOMEBREW_PREFIX from the path used to invoke bin/brew and
  # HOMEBREW_REPOSITORY from that symlink's target. Invoking the worktree's
  # launcher directly would move the prefix into work_dir, making ordinary
  # host build-dependency bottles non-relocatable.
  attempt=0
  while [ "$attempt" -lt 100 ]; do
    attempt=$((attempt + 1))
    candidate="$HOMEBREW_PATCHED_PREFIX/bin/.kandelo-brew-$$-${RANDOM}-${attempt}"
    if ln -s "$HOMEBREW_PATCHED_OVERLAY/bin/brew" "$candidate" 2>/dev/null; then
      HOMEBREW_PATCHED_LAUNCHER="$candidate"
      break
    fi
  done
  if [ -z "$HOMEBREW_PATCHED_LAUNCHER" ]; then
    echo "homebrew-patched-launcher: could not create a launcher under $HOMEBREW_PATCHED_PREFIX/bin" >&2
    return 1
  fi

  HOMEBREW_PATCHED_BREW_BIN="$HOMEBREW_PATCHED_LAUNCHER"
  patched_prefix="$("$HOMEBREW_PATCHED_BREW_BIN" --prefix)" || return
  patched_repo="$("$HOMEBREW_PATCHED_BREW_BIN" --repository)" || return
  if [ "$patched_prefix" != "$HOMEBREW_PATCHED_PREFIX" ]; then
    echo "homebrew-patched-launcher: changed Homebrew prefix: $HOMEBREW_PATCHED_PREFIX -> $patched_prefix" >&2
    return 1
  fi
  if [ "$(cd "$patched_repo" && pwd -P)" != "$(cd "$HOMEBREW_PATCHED_OVERLAY" && pwd -P)" ]; then
    echo "homebrew-patched-launcher: did not select its temporary repository" >&2
    return 1
  fi
}
