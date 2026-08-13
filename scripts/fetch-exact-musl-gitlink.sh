#!/usr/bin/env bash
# Materialize the exact candidate-owned musl gitlink from one protected public
# mirror without consulting candidate-controlled .gitmodules configuration.
set -euo pipefail

source_root=""
expected_commit=""
test_remote=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-root)
      source_root="${2:-}"
      shift 2
      ;;
    --commit)
      expected_commit="${2:-}"
      shift 2
      ;;
    --test-remote)
      test_remote="${2:-}"
      shift 2
      ;;
    *)
      echo "fetch-exact-musl-gitlink: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$source_root" ] || [ -z "$expected_commit" ]; then
  echo "fetch-exact-musl-gitlink: --source-root and --commit are required" >&2
  exit 2
fi
if [[ "$source_root" != /* ]] || [ ! -d "$source_root" ] ||
   [ -L "$source_root" ]; then
  echo "fetch-exact-musl-gitlink: source root must be an absolute real directory" >&2
  exit 2
fi
if ! [[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "fetch-exact-musl-gitlink: commit is not a lowercase 40-hex SHA" >&2
  exit 2
fi
if [ -n "$test_remote" ] && [ "${KANDELO_ABI_STAGING_TESTING:-0}" != 1 ]; then
  echo "fetch-exact-musl-gitlink: --test-remote is a test-only remote" >&2
  exit 2
fi

source_root="$(cd "$source_root" && pwd -P)"
actual_commit="$(git -C "$source_root" rev-parse HEAD)"
if [ "$actual_commit" != "$expected_commit" ]; then
  echo "fetch-exact-musl-gitlink: source root differs from the exact source commit" >&2
  exit 1
fi
if [ -n "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "fetch-exact-musl-gitlink: exact source root is dirty before materialization" >&2
  exit 1
fi

gitlink_line="$(git -C "$source_root" ls-tree "$expected_commit" -- libc/musl)"
if ! [[ "$gitlink_line" =~ ^160000[[:space:]]commit[[:space:]]([0-9a-f]{40})$'\tlibc/musl'$ ]]; then
  echo "fetch-exact-musl-gitlink: exact source does not contain one valid musl gitlink" >&2
  exit 1
fi
musl_commit="${BASH_REMATCH[1]}"

libc_root="$source_root/libc"
musl_root="$libc_root/musl"
if [ ! -d "$libc_root" ] || [ -L "$libc_root" ]; then
  echo "fetch-exact-musl-gitlink: libc parent is unavailable or a symbolic link" >&2
  exit 1
fi
if [ -L "$musl_root" ]; then
  echo "fetch-exact-musl-gitlink: musl path is a symbolic link" >&2
  exit 1
fi
if [ -e "$musl_root" ]; then
  if [ ! -d "$musl_root" ]; then
    echo "fetch-exact-musl-gitlink: musl path is not a directory" >&2
    exit 1
  fi
  musl_real="$(cd "$musl_root" && pwd -P)"
  musl_toplevel="$(git -C "$musl_root" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$musl_toplevel" = "$musl_real" ]; then
    if [ "$(git -C "$musl_root" rev-parse HEAD)" != "$musl_commit" ] ||
       [ -n "$(git -C "$musl_root" status --porcelain=v1 --untracked-files=all)" ]; then
      echo "fetch-exact-musl-gitlink: existing musl checkout differs from the exact gitlink" >&2
      exit 1
    fi
    if [ -n "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" ]; then
      echo "fetch-exact-musl-gitlink: exact source root is dirty after materialization" >&2
      exit 1
    fi
    echo "fetch-exact-musl-gitlink: exact musl gitlink already present"
    exit 0
  fi
  if [ -n "$(find "$musl_root" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "fetch-exact-musl-gitlink: uninitialized musl path is not empty" >&2
    exit 1
  fi
fi

remote="https://github.com/ifduyue/musl.git"
if [ -n "$test_remote" ]; then
  remote="$test_remote"
fi

temporary="$(mktemp -d "$libc_root/.kandelo-musl.XXXXXX")"
cleanup() {
  case "${temporary:-}" in
    "$libc_root"/.kandelo-musl.*)
      rm -rf -- "$temporary"
      ;;
  esac
}
trap cleanup EXIT

git_env=(
  env
  -u GH_TOKEN
  -u GITHUB_TOKEN
  -u ACTIONS_RUNTIME_TOKEN
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN
  -u ACTIONS_ID_TOKEN_REQUEST_URL
  GIT_CONFIG_NOSYSTEM=1
  GIT_CONFIG_GLOBAL=/dev/null
  GIT_TERMINAL_PROMPT=0
)
"${git_env[@]}" git -C "$temporary" init -q
if ! "${git_env[@]}" git -C "$temporary" \
    -c credential.helper= \
    -c http.extraHeader= \
    fetch --no-tags --depth 1 "$remote" "$musl_commit"
then
  echo "fetch-exact-musl-gitlink: exact musl gitlink is unavailable from the protected mirror" >&2
  exit 1
fi
"${git_env[@]}" git -C "$temporary" checkout -q --detach FETCH_HEAD
if [ "$(git -C "$temporary" rev-parse HEAD)" != "$musl_commit" ] ||
   [ -n "$(git -C "$temporary" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "fetch-exact-musl-gitlink: fetched musl checkout differs from the exact gitlink" >&2
  exit 1
fi

if [ -d "$musl_root" ]; then
  rmdir "$musl_root"
fi
mv "$temporary" "$musl_root"
temporary=""
trap - EXIT

if [ "$(git -C "$musl_root" rev-parse HEAD)" != "$musl_commit" ] ||
   [ -n "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "fetch-exact-musl-gitlink: exact source root is dirty after materialization" >&2
  exit 1
fi
echo "fetch-exact-musl-gitlink: materialized exact musl gitlink"
