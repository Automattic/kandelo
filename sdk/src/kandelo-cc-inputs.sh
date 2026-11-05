# shellcheck shell=bash
# Content identity of the build machine's SDK driver (crates/kandelo-cc).
#
# Sourced by sdk/src/kandelo-cc.sh, which checks it on every SDK tool run,
# and by scripts/build-kandelo-cc.sh, which records it beside the driver it
# installs. One cksum process over the driver's sources: cheap enough to run
# per compile, and independent of mtimes, so a checkout, rebase or restored
# cache can never make an old driver look current. The driver crate keeps a
# flat src/ directory so this list stays a glob.
kandelo_cc_inputs_stamp() {
    local repo_root="$1"
    cksum \
        "$repo_root/Cargo.toml" \
        "$repo_root/Cargo.lock" \
        "$repo_root/rust-toolchain.toml" \
        "$repo_root/crates/kandelo-cc/Cargo.toml" \
        "$repo_root/crates/kandelo-cc/src/"*.rs \
        "$repo_root/sdk/src/kandelo-cc-inputs.sh" \
        "$repo_root/scripts/build-kandelo-cc.sh"
}
