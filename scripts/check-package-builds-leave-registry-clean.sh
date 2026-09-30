#!/usr/bin/env bash
# Fail if a package build left files inside packages/registry/<pkg>/.
#
# The resolver reruns a package's build script only when the package's cache
# key changed (an ABI bump, a toolchain or recipe change), and it hands the
# script a fresh WASM_POSIX_DEP_WORK_DIR for exactly that reason. A script
# that instead keeps its source or build tree next to itself in the registry
# finds the previous build's objects there on the next run, make treats them
# as up to date, and the "rebuilt" package ships stale code. After an ABI
# bump, bzip2 kept shipping a binary that declared the previous ABI until the
# in-tree tree was deleted by hand. CI never saw it because every CI job starts
# from a fresh checkout, so this check makes the leftover itself the failure:
# after resolver-driven builds, packages/registry must hold no untracked or
# gitignored files except the resolver's own generated state:
#
#   packages/registry/program-packages.json                  (program index)
#   packages/registry/.program-packages.json.kandelo-index.lock
#                                                            (its publish lock)
#   packages/registry/.program-packages.json.index-transaction-*/
#                                                            (its scratch)
#   packages/registry/<pkg>/package.pr.toml                  (PR overlays)
#
# Build scripts keep every source tree, build tree, intermediate file, and
# collected bin/ under $KANDELO_PACKAGE_WORK_DIR (see
# kandelo_package_prepare_build_roots in scripts/package-build-roots.sh).
# Direct developer invocations of a build script still build next to it by
# design, so run this only after resolver-driven builds (CI, ./run.sh setup).
#
#   check-package-builds-leave-registry-clean.sh [repo-root]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "check-package-builds-leave-registry-clean: not a git work tree: $ROOT" >&2
    exit 2
fi

status_file="$(mktemp)"
trap 'rm -f "$status_file"' EXIT
# --ignored=matching lists each ignored directory once (e.g.
# "!! packages/registry/bzip2/bin/") instead of every file inside it.
# Read NUL-separated records from a file so a git failure stops the check
# instead of looking like an empty, clean status.
git -C "$ROOT" status --porcelain=v1 -z --ignored=matching \
    --untracked-files=normal -- packages/registry >"$status_file"

offenders=()
expect_rename_source=0
while IFS= read -r -d '' record; do
    if [ "$expect_rename_source" = 1 ]; then
        # The second path of a staged rename/copy record; not a leftover.
        expect_rename_source=0
        continue
    fi
    code="${record:0:2}"
    path="${record:3}"
    case "$code" in
        R*|C*) expect_rename_source=1; continue ;;
        '??'|'!!') ;;
        *) continue ;;
    esac
    if [ "$path" = "packages/registry/program-packages.json" ] ||
       [ "$path" = "packages/registry/.program-packages.json.kandelo-index.lock" ] ||
       [[ "$path" =~ ^packages/registry/\.program-packages\.json\.index-transaction-[^/]+/?$ ]] ||
       [[ "$path" =~ ^packages/registry/[^/]+/package\.pr\.toml$ ]]; then
        continue
    fi
    offenders+=("$path")
done <"$status_file"

if [ "${#offenders[@]}" -gt 0 ]; then
    echo "check-package-builds-leave-registry-clean: package builds left files in packages/registry:" >&2
    printf '  %s\n' "${offenders[@]}" >&2
    echo "Build scripts must keep source trees, build trees, intermediate files, and" >&2
    echo "bin/ under \$KANDELO_PACKAGE_WORK_DIR (kandelo_package_prepare_build_roots in" >&2
    echo "scripts/package-build-roots.sh); a tree kept in the package directory" >&2
    echo "survives the rebuilds the resolver runs after an ABI or toolchain change." >&2
    exit 1
fi
echo "check-package-builds-leave-registry-clean: ok"
