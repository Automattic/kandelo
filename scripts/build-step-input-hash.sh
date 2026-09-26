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

# repo_input_hash <repo_root> <relative_path-or-literal>...
# Each argument is either a path relative to `repo_root`, or a literal
# value to fold in as-is, written `literal:<value>` (e.g.
# `literal:ABI_VERSION=43`) — for a resolved config value (an env-var
# override, a value read out of a file at a different location than the
# file itself, ...) that a build step's digest must track even though the
# value has no repo-relative path of its own. A `literal:` argument is
# never looked up on disk; everything after the first `:` is folded
# directly.
#
# A path argument that is a regular file is hashed directly; one that is a
# symlink is hashed by its literal target string, NOT the content it
# resolves to (see below); one that is a directory is expanded to every
# regular file and symlink beneath it (recursively). A missing path is
# silently skipped, so a step's input list can name a not-yet-created path
# (e.g. a projection file from a step that has not run yet) without
# failing — the resulting digest simply will not match any stamp recorded
# after that path started existing, which is the correct "rebuild"
# behavior.
#
# Symlinks are enumerated (not skipped by a bare `-type f` find, which
# would otherwise make a symlink invisible to the digest) and hashed by
# folding in `"<path> -> <readlink target>"` rather than running
# `git hash-object` directly on the symlink path: `git hash-object`
# follows a symlink and hashes whatever it points to, which is both the
# wrong signal (retargeting a symlink without touching the pointed-to file
# would go undetected) and unsafe (fails outright on a dangling symlink or
# one that points at a directory).
#
# A directory argument follows the package cache key's rule
# (tools/xtask/src/input_scope.rs): inside a directory the repository
# tracks, a file git ignores is generated output and is left out; a
# directory that is itself ignored is a generated artifact and is listed
# whole. See repo_input_dir_files below.

# git with the repository chosen by path alone: an inherited GIT_DIR /
# GIT_WORK_TREE / GIT_INDEX_FILE must not redirect the question.
_repo_input_git() {
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
        git -c "safe.directory=$(pwd -P)" -c core.quotePath=false --literal-pathspecs "$@"
}

# _repo_input_owner <dir>
# The nearest ancestor of the relative path <dir> (itself included) holding a
# .git entry, or `.` when none below the current directory does.
_repo_input_owner() {
    local candidate="$1"
    while :; do
        if [ -e "$candidate/.git" ]; then
            printf '%s' "$candidate"
            return
        fi
        case "$candidate" in
            */*) candidate="${candidate%/*}" ;;
            *) break ;;
        esac
    done
    printf '.'
}

# repo_input_dir_files <owner> <dir>
# Print every regular file and symlink below <dir> that is source, one path
# per line, relative to the current directory. <owner> is the repository
# that owns <dir> (`.` for the current directory). Only the committed
# .gitignore files decide what is ignored -- not .git/info/exclude or a
# personal core.excludesFile, which would make two machines with identical
# trees disagree. Tracked files are never ignored; untracked files no rule
# ignores are source; deleted-but-indexed paths are skipped (the digest is of
# the working tree). A directory git lists as one entry (a submodule or a
# nested checkout) is walked with its own repository's rules. Without a .git
# entry nothing marks a file as generated, so everything is listed; with one,
# a git failure fails the hash instead of silently hashing a different set.
repo_input_dir_files() {
    local owner="$1" dir="$2" rel listing entry path
    if [ "$owner" = . ]; then
        rel="$dir"
    elif [ "$dir" = "$owner" ]; then
        rel=.
    else
        rel="${dir#"$owner"/}"
    fi
    if [ ! -e "$owner/.git" ]; then
        find "$dir" \( -type f -o -type l \) -print
        return
    fi
    listing="$(cd "$owner" && _repo_input_git ls-files --others --ignored \
        --exclude-per-directory=.gitignore --directory -- "$rel")" || {
        echo "build-step-input-hash: git ls-files failed in $owner" >&2
        return 1
    }
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        entry="${entry%/}"
        case "$rel/" in
            "$entry"/*)
                # The input itself (or an ancestor) is ignored: it is a
                # generated artifact, and all of it is the input.
                find "$dir" \( -type f -o -type l \) -print
                return
                ;;
        esac
    done <<<"$listing"
    listing="$(cd "$owner" && _repo_input_git ls-files --cached --others \
        --exclude-per-directory=.gitignore -- "$rel")" || {
        echo "build-step-input-hash: git ls-files failed in $owner" >&2
        return 1
    }
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        entry="${entry%/}"
        if [ "$owner" = . ]; then path="$entry"; else path="$owner/$entry"; fi
        if [ -L "$path" ] || [ -f "$path" ]; then
            printf '%s\n' "$path"
        elif [ -d "$path" ]; then
            repo_input_dir_files "$path" "$path" || return 1
        fi
    done <<<"$listing"
}

repo_input_hash() {
    local repo_root="$1"
    shift
    (
        cd "$repo_root" || exit 1
        local path listed="" files
        for path in "$@"; do
            case "$path" in
                literal:*)
                    listed+="$path"$'\n'
                    continue
                    ;;
            esac
            if [ -L "$path" ]; then
                listed+="$path"$'\n'
            elif [ -d "$path" ]; then
                # Collected before the pipeline so a git failure fails the
                # hash instead of silently hashing a shorter list.
                files="$(repo_input_dir_files "$(_repo_input_owner "$path")" "$path")" || exit 1
                [ -z "$files" ] || listed+="$files"$'\n'
            elif [ -f "$path" ]; then
                listed+="$path"$'\n'
            fi
        done
        printf '%s' "$listed" | LC_ALL=C sort -u | while IFS= read -r relative_path; do
            printf '%s\0' "$relative_path"
            case "$relative_path" in
                literal:*)
                    printf '%s' "${relative_path#literal:}" | git hash-object --stdin
                    ;;
                *)
                    if [ -L "$relative_path" ]; then
                        printf '%s -> %s' "$relative_path" "$(readlink "$relative_path")" |
                            git hash-object --stdin
                    else
                        git hash-object -- "$relative_path"
                    fi
                    ;;
            esac
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
