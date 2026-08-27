#!/usr/bin/env bash

# Shared "is this build step's output still current?" primitive for
# `scripts/build-rootfs.sh` and `scripts/build-host.sh`.
#
# Mirrors `scripts/fork-instrument-tool-input-hash.sh`'s content-identity
# approach (fold each input file's `git hash-object` blob hash into one
# digest, independent of mtimes: a checkout, rebase, or restored cache
# directory can otherwise make stale sources look newer than a fresh build)
# but generalizes it to a caller-supplied list of files AND directories, so
# each build step can declare its own exact input set without copy-pasting
# the folding logic.
#
# A stamp file (`<output>.input-hash`) records the digest a build was last
# produced from. A step re-runs its expensive work only when the *computed*
# digest fails to match the *recorded* one (or the stamp/output is missing),
# so a real input change is always rebuilt — the recorded digest is never
# treated as authoritative on its own, only as a fast-path skip when it
# already agrees with the current tree.

# repo_input_hash <repo_root> <relative_path>...
# Each argument is a path relative to `repo_root`: a file is hashed
# directly; a directory is expanded to every regular file beneath it
# (recursively). Missing paths are silently skipped, so a step's input list
# can name a not-yet-created path (e.g. a projection file from a step that
# has not run yet) without failing — the resulting digest simply will not
# match any stamp recorded after that path started existing, which is the
# correct "rebuild" behavior.
repo_input_hash() {
    local repo_root="$1"
    shift
    (
        cd "$repo_root"
        local path
        for path in "$@"; do
            if [ -d "$path" ]; then
                find "$path" -type f -print
            elif [ -f "$path" ]; then
                printf '%s\n' "$path"
            fi
        done | LC_ALL=C sort -u | while IFS= read -r relative_path; do
            printf '%s\0' "$relative_path"
            git hash-object -- "$relative_path"
        done | git hash-object --stdin
    )
}

# build_step_is_current <output_path> <stamp_path> <computed_hash>
# True only when the output exists, a stamp exists, and the stamp's
# recorded digest matches the digest just computed for the current tree.
build_step_is_current() {
    local output_path="$1" stamp_path="$2" computed_hash="$3"
    [ -e "$output_path" ] || return 1
    [ -f "$stamp_path" ] || return 1
    [ "$(cat "$stamp_path")" = "$computed_hash" ]
}

# write_build_stamp <stamp_path> <computed_hash>
# Writes the stamp atomically (write-then-rename) so a killed/interrupted
# write can never leave a corrupt stamp that falsely compares equal to a
# future digest.
write_build_stamp() {
    local stamp_path="$1" computed_hash="$2"
    local stamp_stage
    stamp_stage="$(mktemp "${stamp_path}.XXXXXX")"
    printf '%s\n' "$computed_hash" > "$stamp_stage"
    mv -f "$stamp_stage" "$stamp_path"
}
