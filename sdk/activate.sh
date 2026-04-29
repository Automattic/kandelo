# Source me from a consumer build script:
#
#   source "$REPO_ROOT/sdk/activate.sh"
#
# This puts <worktree>/sdk/bin on PATH so any wasm{32,64}posix-* tool
# the build script invokes resolves to THIS worktree's SDK source —
# no global npm-link required, and no risk of a sibling worktree's
# linked binary masking ours.
#
# Idempotent: re-sourcing does not duplicate PATH entries.

__sdk_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case ":$PATH:" in
    *:"$__sdk_dir/bin":*) ;;
    *) export PATH="$__sdk_dir/bin:$PATH" ;;
esac
unset __sdk_dir
