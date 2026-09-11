#!/bin/bash
set -euo pipefail

# Refuse a case-collapsed checkout of a git tree.
#
# WHY: git can track two paths that differ only in letter case — the Sortix
# os-test suite tracks both `include/inttypes/PRIx16.c` and
# `include/inttypes/PRIX16.c`. A case-insensitive filesystem (the macOS
# default, APFS without the case-sensitive option) cannot hold both, so the
# checkout keeps whichever file git wrote last and the other name resolves to
# the same bytes.
#
# That is not a cosmetic problem for a conformance suite. `PRIX16.c` on such a
# checkout contains `#ifndef PRIx16`, so it compiles, passes, and reports a
# conformance result for a macro it never tested. The suite keeps reporting
# passes; the passes are fictional. A measurement taken on a collapsed
# checkout is worthless, and nothing about the failure is visible in the
# result output.
#
# Detection compares git's tracked path list against the filesystem. Two
# tracked paths that differ only in case must be two distinct files. If they
# resolve to the same device and inode — or if one of them is missing — the
# filesystem collapsed them and this script fails loudly, naming every
# affected path.
#
# This checks the filesystem's behavior, not the working tree's cleanliness,
# so a genuine local edit to a tracked file never trips it.
#
# Usage:
#   scripts/check-case-sensitive-checkout.sh <git-tree-dir> [more dirs...]
#
# Exit status:
#   0  every case-colliding tracked path is a distinct file (or the tree
#      tracks no case-colliding paths at all)
#   1  the checkout is case-collapsed, or the directory is not a git tree

usage() {
    echo "Usage: $0 <git-tree-dir> [more dirs...]" >&2
    exit 2
}

[ $# -ge 1 ] || usage

# List tracked paths whose lowercased spelling is shared by more than one
# tracked path, grouped so each group's members print on one line.
collision_groups() {
    local dir="$1"
    git -C "$dir" ls-files -z \
        | tr '\0' '\n' \
        | awk '
            {
                key = tolower($0)
                if (key in seen) { seen[key] = seen[key] "\t" $0 }
                else { seen[key] = $0; order[++n] = key }
                count[key]++
            }
            END {
                for (i = 1; i <= n; i++) {
                    key = order[i]
                    if (count[key] > 1) print seen[key]
                }
            }
        '
}

overall_status=0

for dir in "$@"; do
    if [ ! -d "$dir" ]; then
        echo "check-case-sensitive-checkout: not a directory: $dir" >&2
        overall_status=1
        continue
    fi
    if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
        echo "check-case-sensitive-checkout: not a git tree: $dir" >&2
        overall_status=1
        continue
    fi

    collapsed_groups=()
    total_groups=0

    while IFS= read -r group; do
        [ -n "$group" ] || continue
        total_groups=$((total_groups + 1))

        # Split the tab-separated group into an array of tracked paths.
        IFS=$'\t' read -r -a members <<< "$group"

        collapsed=false
        for member in "${members[@]}"; do
            if [ ! -e "$dir/$member" ]; then
                collapsed=true
                break
            fi
        done
        if ! $collapsed; then
            first="${members[0]}"
            for member in "${members[@]:1}"; do
                if [ "$dir/$first" -ef "$dir/$member" ]; then
                    collapsed=true
                    break
                fi
            done
        fi

        if $collapsed; then
            collapsed_groups+=("$group")
        fi
    done < <(collision_groups "$dir")

    if [ ${#collapsed_groups[@]} -eq 0 ]; then
        if [ "$total_groups" -gt 0 ]; then
            echo "check-case-sensitive-checkout: OK — $dir holds all" \
                 "$total_groups case-colliding path group(s) as distinct files."
        else
            echo "check-case-sensitive-checkout: OK — $dir tracks no" \
                 "case-colliding paths."
        fi
        continue
    fi

    overall_status=1
    {
        echo ""
        echo "ERROR: case-collapsed checkout — $dir"
        echo ""
        echo "This filesystem is case-insensitive, so git could not check out"
        echo "both spellings of the paths below. Each group now resolves to a"
        echo "single file, and every name in the group reads the same bytes."
        echo ""
        echo "Any test built from a collapsed path tests whatever the surviving"
        echo "file contains, NOT what its own name says. Results from this"
        echo "checkout are fictional and must not be reported."
        echo ""
        echo "Collapsed path groups (${#collapsed_groups[@]}):"
        for group in "${collapsed_groups[@]}"; do
            IFS=$'\t' read -r -a members <<< "$group"
            printf '  %s\n' "${members[0]}"
            for member in "${members[@]:1}"; do
                printf '    collides with: %s\n' "$member"
            done
        done
        echo ""
        echo "Fix: check this tree out on a case-sensitive filesystem."
        echo "  scripts/ensure-case-sensitive-volume.sh --print-mount-point"
        echo "creates and mounts one, and prints where to place the checkout."
        echo ""
    } >&2
done

exit "$overall_status"
