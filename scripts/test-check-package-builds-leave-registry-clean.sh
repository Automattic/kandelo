#!/usr/bin/env bash
# Tests for scripts/check-package-builds-leave-registry-clean.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/check-package-builds-leave-registry-clean.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# A fixture checkout with one tracked package and the registry's real ignore
# shape: in-tree products are gitignored, so plain `git status` hides them.
new_repo() {
    local repo="$1"
    mkdir -p "$repo/packages/registry/pkg"
    git -C "$repo" init -q
    # Isolate the fixture from the caller's global excludes (e.g. .DS_Store).
    git -C "$repo" config core.excludesFile /dev/null
    printf 'kind = "program"\n' >"$repo/packages/registry/pkg/package.toml"
    printf 'echo build\n' >"$repo/packages/registry/pkg/build-pkg.sh"
    cat >"$repo/.gitignore" <<'EOF'
/packages/registry/program-packages.json
packages/registry/*/*-src/
packages/registry/*/bin/
packages/registry/*/package.pr.toml
EOF
    git -C "$repo" add -A
    git -C "$repo" -c user.name=t -c user.email=t@example.invalid \
        commit -q -m fixture
}

# Clean checkout passes.
new_repo "$T/clean"
bash "$GUARD" "$T/clean" >/dev/null || fail "clean: a fresh checkout must pass"

# The resolver's own generated state passes.
new_repo "$T/generated"
printf '{}\n' >"$T/generated/packages/registry/program-packages.json"
: >"$T/generated/packages/registry/.program-packages.json.kandelo-index.lock"
mkdir -p "$T/generated/packages/registry/.program-packages.json.index-transaction-123-0"
printf 'x\n' >"$T/generated/packages/registry/.program-packages.json.index-transaction-123-0/f"
printf '[overlay]\n' >"$T/generated/packages/registry/pkg/package.pr.toml"
bash "$GUARD" "$T/generated" >/dev/null ||
    fail "generated: program index, its lock, its scratch dirs, and PR overlays must pass"

# A gitignored in-tree source tree and bin/ fail, and are named.
new_repo "$T/ignored"
mkdir -p "$T/ignored/packages/registry/pkg/pkg-src" "$T/ignored/packages/registry/pkg/bin"
printf 'obj\n' >"$T/ignored/packages/registry/pkg/pkg-src/main.o"
printf 'wasm\n' >"$T/ignored/packages/registry/pkg/bin/pkg.wasm"
if out="$(bash "$GUARD" "$T/ignored" 2>&1)"; then fail "ignored: expected failure"; fi
grep -q 'packages/registry/pkg/pkg-src/' <<<"$out" || fail "ignored: did not name pkg-src/: $out"
grep -q 'packages/registry/pkg/bin/' <<<"$out" || fail "ignored: did not name bin/: $out"

# An untracked, non-ignored leftover (e.g. a downloaded tarball) fails.
new_repo "$T/untracked"
printf 'tar\n' >"$T/untracked/packages/registry/pkg/pkg-1.0.tar.gz"
if out="$(bash "$GUARD" "$T/untracked" 2>&1)"; then fail "untracked: expected failure"; fi
grep -q 'packages/registry/pkg/pkg-1.0.tar.gz' <<<"$out" ||
    fail "untracked: did not name the tarball: $out"

# A lookalike of the generated-state exemptions is still a leftover.
new_repo "$T/lookalike"
mkdir -p "$T/lookalike/packages/registry/pkg/sub"
printf '[overlay]\n' >"$T/lookalike/packages/registry/pkg/sub/package.pr.toml"
if out="$(bash "$GUARD" "$T/lookalike" 2>&1)"; then fail "lookalike: expected failure"; fi
grep -q 'packages/registry/pkg/sub/' <<<"$out" || fail "lookalike: did not name pkg/sub/: $out"

# Files outside packages/registry are not this guard's concern.
new_repo "$T/outside"
mkdir -p "$T/outside/local-binaries"
printf 'wasm\n' >"$T/outside/local-binaries/pkg.wasm"
bash "$GUARD" "$T/outside" >/dev/null || fail "outside: files outside the registry must pass"

# A directory that is not a git work tree is an error, not a pass.
mkdir -p "$T/not-a-repo"
if bash "$GUARD" "$T/not-a-repo" >/dev/null 2>&1; then fail "not-a-repo: expected failure"; fi

echo "check-package-builds-leave-registry-clean: all tests passed"
