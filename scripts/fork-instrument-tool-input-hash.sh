#!/usr/bin/env bash

# Content identity for the repository-built wasm-fork-instrument executable.
# Keep this independent of mtimes: a checkout, rebase, or restored tools/bin
# cache can otherwise make an old binary look newer than its current sources.

# The crate directories of the tool's workspace closure. The drift test in
# tools/xtask/src/build_deps.rs reads this line and compares it with the
# cargo-derived closure the package cache key uses.
FORK_INSTRUMENT_TOOL_CRATE_ROOTS="crates/fork-instrument crates/shared"

# fork_instrument_tool_crate_files
# Print the regular files below the crate roots that are source, one per line,
# from the repository root. Inside a directory the repository tracks, a file
# git ignores is generated output (a fuzz run's target/ and corpus/, say) and
# is left out -- the same rule, from the same committed .gitignore files only,
# as the package cache key (tools/xtask/src/input_scope.rs). Untracked files no
# rule ignores are source. Deleted-but-indexed paths and symlinks are skipped,
# as the `find -type f` this replaced skipped them. Without a .git entry
# nothing marks a file as generated, so every file is listed; with one, a git
# failure fails the hash rather than silently hashing a different file set.
fork_instrument_tool_crate_files() {
    local listing relative_path
    # shellcheck disable=SC2086 # the roots are a fixed, space-free word list
    if [ -e .git ]; then
        listing="$(git -c "safe.directory=$PWD" -c core.quotePath=false \
            ls-files --cached --others --exclude-per-directory=.gitignore \
            -- $FORK_INSTRUMENT_TOOL_CRATE_ROOTS)" || {
            echo "fork-instrument-tool-input-hash: git ls-files failed in $PWD" >&2
            return 1
        }
        while IFS= read -r relative_path; do
            if [ -n "$relative_path" ] && [ -f "$relative_path" ] && [ ! -L "$relative_path" ]; then
                printf '%s\n' "$relative_path"
            fi
        done <<<"$listing"
    else
        find $FORK_INSTRUMENT_TOOL_CRATE_ROOTS -type f -print
    fi
}

fork_instrument_tool_input_hash() {
    local repo_root="$1"
    local relative_path crate_files

    (
        cd "$repo_root" || exit 1
        crate_files="$(fork_instrument_tool_crate_files)" || exit 1
        {
            for relative_path in Cargo.toml Cargo.lock rust-toolchain.toml \
                .cargo/config.toml \
                scripts/build-fork-instrument-tool.sh \
                scripts/run-wasm-fork-instrument.sh \
                scripts/fork-instrument-tool-input-hash.sh; do
                if [ -f "$relative_path" ]; then
                    printf '%s\n' "$relative_path"
                fi
            done
            printf '%s\n' "$crate_files"
        } | LC_ALL=C sort -u | while IFS= read -r relative_path; do
            [ -n "$relative_path" ] || continue
            printf '%s\0' "$relative_path"
            git hash-object -- "$relative_path"
        done | git hash-object --stdin
    )
}
