#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/node-vfs-builder-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/images/vfs/scripts" \
  "$TEST_ROOT/apps/browser-demos/public" \
  "$TEST_ROOT/bin"
cp "$REPO_ROOT/images/vfs/scripts/build-node-vfs-image.sh" \
  "$TEST_ROOT/images/vfs/scripts/build-node-vfs-image.sh"
chmod +x "$TEST_ROOT/images/vfs/scripts/build-node-vfs-image.sh"
touch "$TEST_ROOT/apps/browser-demos/public/node-vfs.vfs.zst"

cat >"$TEST_ROOT/bin/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log_path="${NODE_VFS_TEST_LOG:?}"
printf '%s\n' "$TMPDIR" >"$log_path"
test -d "$TMPDIR"
case "$TMPDIR" in
  /tmp/kandelo-node-vfs.*) ;;
  *) echo "unexpected TMPDIR: $TMPDIR" >&2; exit 1 ;;
esac
printf 'npx saw short TMPDIR\n'
EOF
chmod +x "$TEST_ROOT/bin/npx"

LONG_TMPDIR="$TEST_ROOT/$(printf 'node-vfs-inherited-tmpdir-%.0s' {1..8})"
mkdir -p "$LONG_TMPDIR"
LOG_PATH="$TEST_ROOT/npx.log"
output="$({
  cd "$TEST_ROOT"
  TMPDIR="$LONG_TMPDIR" NODE_VFS_TEST_LOG="$LOG_PATH" \
    PATH="$TEST_ROOT/bin:$PATH" \
    ./images/vfs/scripts/build-node-vfs-image.sh
})"
short_tmpdir="$(<"$LOG_PATH")"
case "$short_tmpdir" in
  /tmp/kandelo-node-vfs.*) ;;
  *) echo "npx did not receive a private short TMPDIR: $short_tmpdir" >&2; exit 1 ;;
esac
test ! -e "$short_tmpdir"
grep -Fq 'npx saw short TMPDIR' <<<"$output"
grep -Fq 'node-vfs.vfs.zst' <<<"$output"
printf 'node-vfs builder short TMPDIR test passed\n'

test_resolver_scoped_vfs_outputs() (
  set -euo pipefail

  fixture="$TEST_ROOT/scoped-output"
  mkdir -p \
    "$fixture/packages/registry/node-vfs" \
    "$fixture/packages/registry/npm/dist/bin" \
    "$fixture/packages/registry/wordpress" \
    "$fixture/packages/registry/lamp" \
    "$fixture/images/vfs/scripts" \
    "$fixture/apps/browser-demos/public" \
    "$fixture/scripts" \
    "$fixture/local-binaries" \
    "$fixture/fake-bin" \
    "$fixture/kernel" \
    "$fixture/mariadb/share/mysql" \
    "$fixture/wordpress-source" \
    "$fixture/wordpress-plugin-source" \
    "$fixture/work" \
    "$fixture/out"
  fixture="$(cd "$fixture" && pwd -P)"
  : >"$fixture/kernel/kandelo-kernel.wasm"
  : >"$fixture/packages/registry/npm/dist/bin/npm-cli.js"

  cp "$REPO_ROOT/packages/registry/node-vfs/build-node-vfs.sh" \
    "$fixture/packages/registry/node-vfs/build-node-vfs.sh"
  cp "$REPO_ROOT/packages/registry/wordpress/build-wordpress.sh" \
    "$fixture/packages/registry/wordpress/build-wordpress.sh"
  cp "$REPO_ROOT/packages/registry/lamp/build-lamp.sh" \
    "$fixture/packages/registry/lamp/build-lamp.sh"
  cp "$REPO_ROOT/images/vfs/scripts/build-nginx-vfs-image.sh" \
    "$fixture/images/vfs/scripts/build-nginx-vfs-image.sh"
  cp "$REPO_ROOT/images/vfs/scripts/build-nginx-php-vfs-image.sh" \
    "$fixture/images/vfs/scripts/build-nginx-php-vfs-image.sh"
  chmod +x \
    "$fixture/packages/registry/node-vfs/build-node-vfs.sh" \
    "$fixture/packages/registry/wordpress/build-wordpress.sh" \
    "$fixture/packages/registry/lamp/build-lamp.sh" \
    "$fixture/images/vfs/scripts/build-nginx-vfs-image.sh" \
    "$fixture/images/vfs/scripts/build-nginx-php-vfs-image.sh"
  ln -s "$REPO_ROOT/scripts/package-build-roots.sh" \
    "$fixture/scripts/package-build-roots.sh"

  cat >"$fixture/images/vfs/scripts/fake-vfs-builder.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output="${1:?wrapper must pass one explicit VFS output path}"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ] &&
   [ "$(basename "$output")" = wordpress.vfs.zst ]; then
  [ "${WORDPRESS_SQLITE_SOURCE_DIR:-}" = \
    "${KANDELO_EXPECTED_WORDPRESS_SQLITE_SOURCE:?}" ] || {
    echo "WordPress wrapper did not export its friendly plugin source root" >&2
    exit 70
  }
fi
case "$output/" in
  "${WASM_POSIX_DEP_WORK_DIR:-/not-resolver}/"*) ;;
  */apps/browser-demos/public/*/) ;;
  *) echo "unexpected VFS output path: $output" >&2; exit 71 ;;
esac
printf '%s\n' "$output" >>"${KANDELO_VFS_OUTPUT_LOG:?}"
mkdir -p "$(dirname "$output")"
printf 'generated %s\n' "$(basename "$output")" >"$output"
SH
  chmod +x "$fixture/images/vfs/scripts/fake-vfs-builder.sh"
  for name in node wp lamp; do
    cp "$fixture/images/vfs/scripts/fake-vfs-builder.sh" \
      "$fixture/images/vfs/scripts/build-$name-vfs-image.sh"
  done

  cat >"$fixture/fake-bin/npx" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output="${@: -1}"
exec "${KANDELO_FAKE_VFS_BUILDER:?}" "$output"
SH
  chmod +x "$fixture/fake-bin/npx"

  cat >"$fixture/scripts/install-local-binary.sh" <<'SH'
#!/usr/bin/env bash
install_local_binary() {
  local package="$1" source="$2" artifact
  case "$package" in
    node-vfs) artifact=node-vfs.vfs.zst ;;
    nginx-vfs) artifact=nginx-vfs.vfs.zst ;;
    nginx-php-vfs) artifact=nginx-php-vfs.vfs.zst ;;
    wordpress) artifact=wordpress.vfs.zst ;;
    lamp) artifact=lamp.vfs.zst ;;
    *) return 72 ;;
  esac
  if [ "${WASM_POSIX_INSTALL_LOCAL_MIRROR:-1}" = 0 ]; then
    [ "${WASM_POSIX_INSTALL_FORK_INSTRUMENTATION:-}" = disabled ] || return 73
    cp "$source" "${WASM_POSIX_DEP_OUT_DIR:?}/$artifact"
  else
    mkdir -p "${KANDELO_FAKE_LOCAL_MIRROR:?}"
    cp "$source" "$KANDELO_FAKE_LOCAL_MIRROR/$artifact"
  fi
}
SH

  wrappers=(
    packages/registry/node-vfs/build-node-vfs.sh
    images/vfs/scripts/build-nginx-vfs-image.sh
    images/vfs/scripts/build-nginx-php-vfs-image.sh
    packages/registry/wordpress/build-wordpress.sh
    packages/registry/lamp/build-lamp.sh
  )
  public_names=(
    node-vfs.vfs.zst
    nginx-vfs.vfs.zst
    nginx-php-vfs.vfs.zst
    wordpress.vfs.zst
    lamp.vfs.zst
  )
  out_names=(
    node-vfs.vfs.zst
    nginx-vfs.vfs.zst
    nginx-php-vfs.vfs.zst
    wordpress.vfs.zst
    lamp.vfs.zst
  )

  for index in "${!wrappers[@]}"; do
    wrapper="${wrappers[$index]}"
    public_name="${public_names[$index]}"
    out_name="${out_names[$index]}"
    public_path="$fixture/apps/browser-demos/public/$public_name"
    printf 'poisoned public %s\n' "$public_name" >"$public_path"
    public_before="$(shasum -a 256 "$public_path" | awk '{print $1}')"
    rm -rf "$fixture/work" "$fixture/out" "$fixture/local-binaries"
    mkdir "$fixture/work" "$fixture/out" "$fixture/local-binaries"
    : >"$fixture/output.log"

    env \
      PATH="$fixture/fake-bin:$PATH" \
      KANDELO_FAKE_VFS_BUILDER="$fixture/images/vfs/scripts/fake-vfs-builder.sh" \
      KANDELO_VFS_OUTPUT_LOG="$fixture/output.log" \
      KANDELO_FAKE_LOCAL_MIRROR="$fixture/local-binaries" \
      KANDELO_EXPECTED_WORDPRESS_SQLITE_SOURCE="$fixture/wordpress-plugin-source" \
      WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
      WASM_POSIX_DEP_WORK_DIR="$fixture/work" \
      WASM_POSIX_DEP_OUT_DIR="$fixture/out" \
      WASM_POSIX_DEP_SOURCE_DIR="$fixture/wordpress-source" \
      WASM_POSIX_DEP_KERNEL_DIR="$fixture/kernel" \
      WASM_POSIX_DEP_MARIADB_DIR="$fixture/mariadb" \
      WASM_POSIX_DEP_K_776F726470726573732D73716C6974652D696E746567726174696F6E2D736F75726365_SRC_DIR="$fixture/wordpress-plugin-source" \
      bash "$fixture/$wrapper" >/dev/null

    [ "$(shasum -a 256 "$public_path" | awk '{print $1}')" = "$public_before" ] || {
      echo "$wrapper changed its pre-existing public bytes" >&2
      exit 74
    }
    [ "$(cat "$fixture/out/$out_name")" = "generated $public_name" ] || {
      echo "$wrapper did not publish only its declared resolver OUT member" >&2
      exit 75
    }
    [ -z "$(find "$fixture/local-binaries" -mindepth 1 -print -quit)" ] || {
      echo "$wrapper wrote a resolver-mode local mirror" >&2
      exit 76
    }
    [ "$(cat "$fixture/output.log")" = "$fixture/work/$public_name" ] || {
      echo "$wrapper did not keep generated payload bytes below WORK" >&2
      exit 77
    }

    rm -f "$public_path"
    rm -rf "$fixture/local-binaries"
    mkdir "$fixture/local-binaries"
    : >"$fixture/output.log"
    env -u WASM_POSIX_RESOLUTION_POLICY \
      -u WASM_POSIX_DEP_WORK_DIR \
      -u WASM_POSIX_DEP_OUT_DIR \
      -u WASM_POSIX_DEP_SOURCE_DIR \
      PATH="$fixture/fake-bin:$PATH" \
      KANDELO_FAKE_VFS_BUILDER="$fixture/images/vfs/scripts/fake-vfs-builder.sh" \
      KANDELO_VFS_OUTPUT_LOG="$fixture/output.log" \
      KANDELO_FAKE_LOCAL_MIRROR="$fixture/local-binaries" \
      WASM_POSIX_DEP_KERNEL_DIR="$fixture/kernel" \
      bash "$fixture/$wrapper" >/dev/null
    [ "$(cat "$public_path")" = "generated $public_name" ] || {
      echo "$wrapper lost its direct-mode public output fallback" >&2
      exit 78
    }
  done
)

test_resolver_scoped_vfs_outputs
printf 'VFS wrapper scoped-output tests passed\n'
