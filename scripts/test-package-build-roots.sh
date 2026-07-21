#!/usr/bin/env bash
# Contract tests for caller-owned package source, work, and output roots.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
cleanup() {
    chmod -R u+w "$TMP_ROOT" 2>/dev/null || true
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
    echo "test-package-build-roots.sh: $*" >&2
    exit 1
}

tree_digest() {
    local root="$1"
    tar cf - -C "$root" . | shasum -a 256 | awk '{print $1}'
}

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

direct_work="$TMP_ROOT/direct-work"
unset WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR \
    WASM_POSIX_DEP_SOURCE_DIR WASM_POSIX_DEP_TARGET_ARCH
kandelo_package_prepare_build_roots "$direct_work" wasm32
[ "$KANDELO_PACKAGE_WORK_DIR" = "$(cd "$direct_work" && pwd -P)" ] ||
    fail "direct developer work-root fallback changed"
[ -z "$KANDELO_PACKAGE_OUT_DIR" ] ||
    fail "direct developer build unexpectedly acquired an output root"
kandelo_package_select_source_root "$REPO_ROOT"
[ "$KANDELO_PACKAGE_SOURCE_ROOT" = "$(cd "$REPO_ROOT" && pwd -P)" ] ||
    fail "direct developer source-root fallback changed"

work_root="$TMP_ROOT/caller-work"
out_root="$TMP_ROOT/caller-out"
WASM_POSIX_DEP_WORK_DIR="$work_root"
WASM_POSIX_DEP_OUT_DIR="$out_root"
WASM_POSIX_DEP_TARGET_ARCH=wasm32
kandelo_package_prepare_build_roots "$direct_work" wasm32
[ "$KANDELO_PACKAGE_WORK_DIR" = "$(cd "$work_root" && pwd -P)" ] ||
    fail "caller work root was not selected"
[ "$KANDELO_PACKAGE_OUT_DIR" = "$(cd "$out_root" && pwd -P)" ] ||
    fail "caller output root was not selected"

err="$TMP_ROOT/invalid-arch.err"
if (WASM_POSIX_DEP_TARGET_ARCH=wasm64
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "unsupported package architecture was accepted"
fi
grep -F "built for wasm32 only, got wasm64" "$err" >/dev/null ||
    fail "unsupported package architecture was not explained"

real_dir="$TMP_ROOT/real-dir"
linked_dir="$TMP_ROOT/linked-dir"
mkdir -p "$real_dir"
ln -s "$real_dir" "$linked_dir"
err="$TMP_ROOT/symlink-work.err"
if (WASM_POSIX_DEP_WORK_DIR="$linked_dir"
    WASM_POSIX_DEP_OUT_DIR=
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "symlink work root was accepted"
fi
grep -F "WASM_POSIX_DEP_WORK_DIR must be a real directory" "$err" >/dev/null ||
    fail "symlink work-root rejection was not explained"

err="$TMP_ROOT/symlink-out.err"
if (WASM_POSIX_DEP_WORK_DIR="$work_root"
    WASM_POSIX_DEP_OUT_DIR="$linked_dir"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "symlink output root was accepted"
fi
grep -F "WASM_POSIX_DEP_OUT_DIR must be a real directory" "$err" >/dev/null ||
    fail "symlink output-root rejection was not explained"

overlap_work="$TMP_ROOT/overlap"
overlap_out="$overlap_work/out"
mkdir -p "$overlap_work"
err="$TMP_ROOT/overlap.err"
if (WASM_POSIX_DEP_WORK_DIR="$overlap_work"
    WASM_POSIX_DEP_OUT_DIR="$overlap_out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "overlapping caller work/output roots were accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "overlapping caller roots were not explained"

overlap_out_parent="$TMP_ROOT/overlap-out-parent"
overlap_work_child="$overlap_out_parent/work"
mkdir -p "$overlap_work_child"
err="$TMP_ROOT/reverse-work-out-overlap.err"
if (WASM_POSIX_DEP_WORK_DIR="$overlap_work_child"
    WASM_POSIX_DEP_OUT_DIR="$overlap_out_parent"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "output root containing the work root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "reverse work/output overlap was not explained"

source_contains_work="$TMP_ROOT/source-contains-work"
mkdir -p "$source_contains_work"
err="$TMP_ROOT/source-work-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$source_contains_work"
    WASM_POSIX_DEP_WORK_DIR="$source_contains_work/work"
    WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/source-work-out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "source root containing the work root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "source/work overlap was not explained"
[ ! -e "$source_contains_work/work" ] ||
    fail "source/work overlap mutated the caller source before rejection"

work_contains_source="$TMP_ROOT/work-contains-source"
mkdir -p "$work_contains_source/source"
err="$TMP_ROOT/work-source-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$work_contains_source/source"
    WASM_POSIX_DEP_WORK_DIR="$work_contains_source"
    WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/work-source-out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "work root containing the source root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "reverse source/work overlap was not explained"

source_contains_out="$TMP_ROOT/source-contains-out"
mkdir -p "$source_contains_out"
err="$TMP_ROOT/source-out-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$source_contains_out"
    WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/source-out-work"
    WASM_POSIX_DEP_OUT_DIR="$source_contains_out/out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "source root containing the output root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "source/output overlap was not explained"
[ ! -e "$source_contains_out/out" ] ||
    fail "source/output overlap mutated the caller source before rejection"

out_contains_source="$TMP_ROOT/out-contains-source"
mkdir -p "$out_contains_source/source"
err="$TMP_ROOT/out-source-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$out_contains_source/source"
    WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/out-source-work"
    WASM_POSIX_DEP_OUT_DIR="$out_contains_source"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "output root containing the source root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "reverse source/output overlap was not explained"

source_root="$TMP_ROOT/source"
mkdir -p "$source_root/subdir"
printf 'caller-verified source\n' >"$source_root/subdir/payload.txt"
chmod -R a-w "$source_root"
source_before="$(tree_digest "$source_root")"

WASM_POSIX_DEP_SOURCE_DIR="$source_root"
kandelo_package_select_source_root "$REPO_ROOT"
[ "$KANDELO_PACKAGE_SOURCE_ROOT" = "$(cd "$source_root" && pwd -P)" ] ||
    fail "caller source root was not selected"

verified_dest="$TMP_ROOT/verified-dest"
kandelo_package_stage_verified_source fixture "$verified_dest" "$source_root" \
    "https://invalid.example/verified-dir-must-win.tar.gz" "not-a-hash" "$work_root"
cmp -s "$source_root/subdir/payload.txt" "$verified_dest/subdir/payload.txt" ||
    fail "verified source directory was not copied exactly"
[ "$(tree_digest "$source_root")" = "$source_before" ] ||
    fail "caller-verified source tree was mutated"

source_link="$TMP_ROOT/source-link"
ln -s "$source_root" "$source_link"
err="$TMP_ROOT/source-link.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$source_link"
    kandelo_package_select_source_root "$REPO_ROOT") 2>"$err"; then
    fail "symlink source root was accepted"
fi
grep -F "WASM_POSIX_DEP_SOURCE_DIR must be a real directory" "$err" >/dev/null ||
    fail "symlink source-root rejection was not explained"

archive_parent="$TMP_ROOT/archive-parent"
mkdir -p "$archive_parent/upstream-1.0"
printf 'archive-selected source\n' >"$archive_parent/upstream-1.0/archive.txt"
archive="$TMP_ROOT/source.tar.gz"
tar czf "$archive" -C "$archive_parent" upstream-1.0
archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
archive_dest="$TMP_ROOT/archive-dest"
kandelo_package_stage_verified_source fixture "$archive_dest" "" \
    "file://$archive" "$archive_sha" "$work_root"
grep -Fx "archive-selected source" "$archive_dest/archive.txt" >/dev/null ||
    fail "source URL/hash archive was not selected and extracted"

# A staged archive can live below an unrelated Git checkout during direct and
# package-staging builds. Patch paths must remain relative to that source root,
# including files introduced by a patch, rather than inheriting the parent
# repository's worktree context.
patch_parent="$TMP_ROOT/patch-parent"
patch_source="$patch_parent/nested/source"
patch_file="$TMP_ROOT/archive-source.patch"
mkdir -p "$patch_source"
git -C "$patch_parent" init -q
printf 'before\n' >"$patch_source/existing.txt"
printf '%s\n' \
    '--- a/existing.txt' \
    '+++ b/existing.txt' \
    '@@ -1 +1 @@' \
    '-before' \
    '+after' \
    '--- /dev/null' \
    '+++ b/added.txt' \
    '@@ -0,0 +1 @@' \
    '+added inside staged source' \
    >"$patch_file"
kandelo_package_git_apply_patch "$patch_source" "$patch_file" check
grep -Fx "before" "$patch_source/existing.txt" >/dev/null ||
    fail "git patch check mutated the staged source"
[ ! -e "$patch_source/added.txt" ] ||
    fail "git patch check created a staged source file"
kandelo_package_git_apply_patch "$patch_source" "$patch_file"
grep -Fx "after" "$patch_source/existing.txt" >/dev/null ||
    fail "git patch did not modify the staged source"
grep -Fx "added inside staged source" "$patch_source/added.txt" >/dev/null ||
    fail "git patch did not create a file in the staged source"
[ ! -e "$patch_parent/added.txt" ] ||
    fail "git patch escaped into the unrelated parent worktree"

bad_dest="$TMP_ROOT/bad-hash-dest"
err="$TMP_ROOT/bad-hash.err"
if kandelo_package_stage_verified_source fixture "$bad_dest" "" \
    "file://$archive" "0000000000000000000000000000000000000000000000000000000000000000" \
    "$work_root" >/dev/null 2>"$err"; then
    fail "source archive with the wrong sha256 was accepted"
fi
[ ! -e "$bad_dest" ] || fail "failed source verification left a staged source tree"

# Exercise the roots and source-selection helpers as one tiny build: immutable
# input is copied to work, and the sole published artifact lands under OUT.
integration_work="$TMP_ROOT/integration-work"
integration_out="$TMP_ROOT/integration-out"
integration_source="$TMP_ROOT/integration-source"
mkdir -p "$integration_source"
printf 'integration payload\n' >"$integration_source/input.txt"
chmod -R a-w "$integration_source"
integration_before="$(tree_digest "$integration_source")"
(
    WASM_POSIX_DEP_WORK_DIR="$integration_work"
    WASM_POSIX_DEP_OUT_DIR="$integration_out"
    WASM_POSIX_DEP_SOURCE_DIR="$integration_source"
    WASM_POSIX_DEP_TARGET_ARCH=wasm32
    export WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR
    export WASM_POSIX_DEP_SOURCE_DIR WASM_POSIX_DEP_TARGET_ARCH
    kandelo_package_prepare_build_roots "$TMP_ROOT/integration-direct" wasm32
    kandelo_package_stage_verified_source integration \
        "$KANDELO_PACKAGE_WORK_DIR/source" "$WASM_POSIX_DEP_SOURCE_DIR" \
        "https://invalid.example/source-dir-must-win.tar.gz" "not-a-hash" \
        "$KANDELO_PACKAGE_WORK_DIR"
    tr '[:lower:]' '[:upper:]' \
        <"$KANDELO_PACKAGE_WORK_DIR/source/input.txt" \
        >"$KANDELO_PACKAGE_WORK_DIR/artifact.wasm"
    cp "$KANDELO_PACKAGE_WORK_DIR/artifact.wasm" \
        "$KANDELO_PACKAGE_OUT_DIR/artifact.wasm"
)
grep -Fx "INTEGRATION PAYLOAD" "$integration_out/artifact.wasm" >/dev/null ||
    fail "declared output did not land under WASM_POSIX_DEP_OUT_DIR"
[ "$(find "$integration_out" -type f | wc -l | tr -d ' ')" = 1 ] ||
    fail "caller output root contains undeclared work products"
[ "$(tree_digest "$integration_source")" = "$integration_before" ] ||
    fail "integrated build mutated its immutable caller source"

# Caller-owned output installation is a copy-only packaging operation. It must
# not require the repo's Rust/xtask toolchain, which Homebrew intentionally
# keeps out of the isolated Formula environment after the Wasm build finishes.
output_only_root="$TMP_ROOT/output-only"
output_only_wasm="$output_only_root/input/program.wasm"
output_only_data="$output_only_root/input/runtime.dat"
output_only_out="$output_only_root/out"
rustc_probe="$output_only_root/rustc-was-called"
mkdir -p "$(dirname "$output_only_wasm")" "$output_only_out"
printf 'wasm package payload\n' >"$output_only_wasm"
printf 'runtime package payload\n' >"$output_only_data"
(
    rustc() {
        printf 'unexpected rustc probe\n' >"$rustc_probe"
        return 93
    }
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
    WASM_POSIX_DEP_OUT_DIR="$output_only_out"
    WASM_POSIX_DEP_TARGET_ARCH=wasm32
    export WASM_POSIX_INSTALL_LOCAL_MIRROR
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION
    export WASM_POSIX_DEP_OUT_DIR WASM_POSIX_DEP_TARGET_ARCH
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary output-only-test "$output_only_wasm"
    install_local_runtime_file output-only-test "$output_only_data" \
        "share/runtime.dat"
)
[ ! -e "$rustc_probe" ] ||
    fail "caller-owned output installation invoked rustc"
cmp "$output_only_wasm" "$output_only_out/program.wasm" >/dev/null ||
    fail "caller-owned Wasm output bytes changed during installation"
cmp "$output_only_data" "$output_only_out/share/runtime.dat" >/dev/null ||
    fail "caller-owned runtime-file bytes changed during installation"

err="$output_only_root/unsafe-runtime-artifact.err"
if (
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    WASM_POSIX_DEP_OUT_DIR="$output_only_out"
    export WASM_POSIX_INSTALL_LOCAL_MIRROR WASM_POSIX_DEP_OUT_DIR
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_runtime_file output-only-test "$output_only_data" "../escape.dat"
) 2>"$err"; then
    fail "caller-owned runtime installation accepted a parent path"
fi
grep -F "artifact must be a portable relative path" "$err" >/dev/null ||
    fail "unsafe caller-owned runtime artifact rejection was not explained"
[ ! -e "$output_only_root/escape.dat" ] ||
    fail "unsafe caller-owned runtime artifact escaped its output root"

bash "$REPO_ROOT/scripts/test-graphics-pkgconfig.sh"

# Every exact-shell registry recipe must enter through this tested root
# contract. Their real package builds remain separate bottle/dry-run evidence.
for package in bc posix-utils-lite lsof nethack fbdoom modeset; do
    script="$REPO_ROOT/packages/registry/$package/build-$package.sh"
    grep -F 'scripts/package-build-roots.sh' "$script" >/dev/null ||
        fail "$package build does not source the caller-root contract"
    grep -F 'kandelo_package_prepare_build_roots' "$script" >/dev/null ||
        fail "$package build does not prepare caller-owned roots"
    grep -F 'WASM_POSIX_INSTALL_LOCAL_MIRROR=0' "$script" >/dev/null ||
        fail "$package build does not suppress checkout-local installation"
    if grep -E '^(BIN_DIR|OUT_BIN|RUNTIME_DIR|SRC_DIR|HOST_BUILD_DIR|CDOOM_SRC)="\$(SCRIPT_DIR|HERE)/' \
        "$script" >/dev/null; then
        fail "$package build still assigns mutable output below its script directory"
    fi
done
for package in posix-utils-lite lsof modeset; do
    script="$REPO_ROOT/packages/registry/$package/build-$package.sh"
    grep -F 'kandelo_package_select_source_root' "$script" >/dev/null ||
        fail "$package build does not select the caller's in-tree source root"
done
for package in bc nethack fbdoom; do
    script="$REPO_ROOT/packages/registry/$package/build-$package.sh"
    grep -F 'kandelo_package_stage_verified_source' "$script" >/dev/null ||
        fail "$package build does not stage caller-verified source"
done

grep -F 'make -j1 CC=cc LD=cc -C util makedefs dgn_comp lev_comp dlb recover' \
    "$REPO_ROOT/packages/registry/nethack/build-nethack.sh" >/dev/null ||
    fail "NetHack host generators do not override ambient parallel MAKEFLAGS"

for package in lsof modeset netcat; do
    if grep -F 'scripts/run-wasm-fork-instrument.sh' \
        "$REPO_ROOT/packages/registry/$package/build-$package.sh" >/dev/null; then
        fail "$package build instruments a program that does not import fork"
    fi
done

grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    "$REPO_ROOT/packages/registry/nethack/build-nethack.sh" >/dev/null ||
    fail "NetHack build does not instrument its fork-capable artifact"

# Ruby keeps source filenames in runtime assertions and publishes its generated
# rbconfig.rb. Its recipe must therefore map caller work paths at compile time
# while giving configure stable command names and sysroot-independent flags.
ruby_script="$REPO_ROOT/packages/registry/ruby/build-ruby.sh"
ruby_cc_wrapper="$REPO_ROOT/packages/registry/ruby/kandelo-ruby-cc"
bash -n "$ruby_cc_wrapper" || fail "Ruby compiler prefix wrapper has invalid shell syntax"
ruby_wrapper_err="$TMP_ROOT/ruby-wrapper-missing-work-root.err"
if env -u KANDELO_RUBY_WORK_DIR bash "$ruby_cc_wrapper" --version \
    >/dev/null 2>"$ruby_wrapper_err"; then
    fail "Ruby compiler prefix wrapper accepted a missing work root"
fi
grep -F "must name the Ruby package work root" "$ruby_wrapper_err" >/dev/null ||
    fail "Ruby compiler prefix wrapper did not explain its missing work root"
ruby_fake_bin="$TMP_ROOT/ruby-fake-bin"
ruby_wrapper_args="$TMP_ROOT/ruby-wrapper-args"
mkdir -p "$ruby_fake_bin"
cat > "$ruby_fake_bin/wasm32posix-cc" <<'RUBY_FAKE_CC'
#!/usr/bin/env bash
printf '%s\n' "$@"
RUBY_FAKE_CC
chmod +x "$ruby_fake_bin/wasm32posix-cc"
KANDELO_RUBY_WORK_DIR="$TMP_ROOT/caller-ruby-work" \
    PATH="$ruby_fake_bin:$PATH" \
    bash "$ruby_cc_wrapper" -O2 conftest.c > "$ruby_wrapper_args"
for map_kind in ffile fdebug fmacro; do
    grep -Fx -- "-${map_kind}-prefix-map=$TMP_ROOT/caller-ruby-work=/usr/src/kandelo-packages/ruby" \
        "$ruby_wrapper_args" >/dev/null ||
        fail "Ruby compiler wrapper is missing its ${map_kind} caller-work prefix map"
done
grep -Fx -- "-O2" "$ruby_wrapper_args" >/dev/null ||
    fail "Ruby compiler wrapper did not preserve a compiler option"
grep -Fx "conftest.c" "$ruby_wrapper_args" >/dev/null ||
    fail "Ruby compiler wrapper did not preserve a source argument"
grep -F "cp \"\$SCRIPT_DIR/kandelo-ruby-cc\"" "$ruby_script" >/dev/null ||
    fail "Ruby build does not install its tested compiler prefix wrapper"
grep -F "CC=\"\$RUBY_CC_COMMAND\"" "$ruby_script" >/dev/null ||
    fail "Ruby configure does not use its stable compiler command"
grep -F -- "--with-baseruby=\"\$BASERUBY_COMMAND\"" "$ruby_script" >/dev/null ||
    fail "Ruby configure does not record its stable baseruby command"
grep -F "CPPFLAGS=\"-DRUBY_KANDELO_POSIX=1 -I\$ZLIB_PREFIX/include\"" \
    "$ruby_script" >/dev/null ||
    fail "Ruby configure CPPFLAGS reintroduced its private sysroot path"
grep -F "LDFLAGS=\"-L\$ZLIB_PREFIX/lib -Wl,-z,stack-size=1048576\"" \
    "$ruby_script" >/dev/null ||
    fail "Ruby configure LDFLAGS reintroduced its private sysroot path"

# Invalid guest paths are rejected before NetHack reaches any toolchain or
# dependency work.
nethack_work="$TMP_ROOT/nethack-invalid-work"
nethack_out="$TMP_ROOT/nethack-invalid-out"
err="$TMP_ROOT/nethack-path.err"
if WASM_POSIX_DEP_WORK_DIR="$nethack_work" \
    WASM_POSIX_DEP_OUT_DIR="$nethack_out" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    NETHACK_HACKDIR=relative/not-allowed \
    bash "$REPO_ROOT/packages/registry/nethack/build-nethack.sh" \
    >/dev/null 2>"$err"; then
    fail "NetHack accepted a relative compiled runtime path"
fi
grep -F "NETHACK_HACKDIR must be an absolute guest path" "$err" >/dev/null ||
    fail "NetHack invalid runtime-path rejection was not explained"

# Invalid architectures likewise fail before package-specific compilers run.
for package in bc posix-utils-lite lsof nethack fbdoom modeset; do
    err="$TMP_ROOT/$package-arch.err"
    if WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/$package-invalid-work" \
        WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/$package-invalid-out" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm64 \
        bash "$REPO_ROOT/packages/registry/$package/build-$package.sh" \
        >/dev/null 2>"$err"; then
        fail "$package accepted an unsupported architecture"
    fi
    grep -F "built for wasm32 only, got wasm64" "$err" >/dev/null ||
        fail "$package did not explain its unsupported architecture"
done

echo "test-package-build-roots.sh: ok"
