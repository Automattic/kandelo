#!/usr/bin/env bash

# Content identity for the repository-built wasm-fork-instrument executable.
# Keep this independent of mtimes: a checkout, rebase, or restored tools/bin
# cache can otherwise make an old binary look newer than its current sources.

fork_instrument_tool_input_hash() {
    local repo_root="$1"
    local relative_path

    (
        cd "$repo_root"
        {
            for relative_path in Cargo.toml Cargo.lock rust-toolchain.toml \
                scripts/build-fork-instrument-tool.sh \
                scripts/fork-instrument-tool-input-hash.sh; do
                if [ -f "$relative_path" ]; then
                    printf '%s\n' "$relative_path"
                fi
            done
            find crates/fork-instrument crates/shared -type f -print
        } | LC_ALL=C sort -u | while IFS= read -r relative_path; do
            printf '%s\0' "$relative_path"
            git hash-object -- "$relative_path"
        done | git hash-object --stdin
    )
}
