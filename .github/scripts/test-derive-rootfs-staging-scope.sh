#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DERIVE="$SCRIPT_DIR/derive-rootfs-staging-scope.sh"
TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/repo/packages/registry" "$TMP_ROOT/bin" "$TMP_ROOT/out"
hex_a="$(printf 'a%.0s' {1..64})"
hex_b="$(printf 'b%.0s' {1..64})"
hex_c="$(printf 'c%.0s' {1..64})"

write_valid_index() {
  jq -nS --arg a "$hex_a" --arg b "$hex_b" --arg c "$hex_c" '{
    format: "kandelo-program-packages-v2",
    identities: {
      dep: {manifestSha256:$a, cacheKeys:{wasm32:$a, wasm64:$c}},
      rootfs: {manifestSha256:$b, cacheKeys:{wasm32:$b, wasm64:$c}},
      unrelated: {manifestSha256:$c, cacheKeys:{wasm64:$c}}
    },
    packages: {
      dep: {
        manifestSha256:$a,
        arches:["wasm32"],
        cacheKeys:{wasm32:$a},
        dependencyClosures:{wasm32:[]},
        members:[]
      },
      rootfs: {
        manifestSha256:$b,
        arches:["wasm32"],
        cacheKeys:{wasm32:$b},
        dependencyClosures:{wasm32:[{
          packageName:"dep",
          manifestSha256:$a,
          cacheKey:$a
        }]},
        members:[]
      },
      unrelated: {
        manifestSha256:$c,
        arches:["wasm64"],
        cacheKeys:{wasm64:$c},
        dependencyClosures:{wasm64:[]},
        members:[]
      }
    }
  }' >"$TMP_ROOT/repo/packages/registry/program-packages.json"
}

cat >"$TMP_ROOT/bin/xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"${XTASK_LOG:?}"
[ "$1 $2" = "build-deps program-index-context-check" ]
[ "$3" = "--source-repo-root" ]
[ "$4" = "${EXPECTED_REPO_ROOT:?}" ]
[ "${WASM_POSIX_DEPS_REGISTRY:?}" = "$EXPECTED_REPO_ROOT/packages/registry" ]
if [ "${XTASK_MUTATE_INDEX:-0}" = 1 ]; then
  printf '\n' >>"$WASM_POSIX_DEPS_REGISTRY/program-packages.json"
fi
[ "${XTASK_FAIL:-0}" != 1 ]
EOF
chmod +x "$TMP_ROOT/bin/xtask"

run_derive() {
  local output="$1"
  env \
    XTASK_LOG="$TMP_ROOT/xtask.log" \
    EXPECTED_REPO_ROOT="$TMP_ROOT/repo" \
    "$DERIVE" \
      --repo-root "$TMP_ROOT/repo" \
      --xtask "$TMP_ROOT/bin/xtask" \
      --output "$output"
}

expect_failure() {
  local description="$1"
  shift
  if "$@"; then
    echo "derive rootfs staging scope test: accepted $description" >&2
    exit 1
  fi
}

write_valid_index
run_derive "$TMP_ROOT/out/scope.json"
[ "$(jq -r '.format' "$TMP_ROOT/out/scope.json")" = \
  kandelo-rootfs-staging-scope-v1 ]
[ "$(jq -r '.entries | length' "$TMP_ROOT/out/scope.json")" = 2 ]
[ "$(jq -r '[.entries[].package] | join(",")' "$TMP_ROOT/out/scope.json")" = \
  dep,rootfs ]
[ "$(jq -r '[.entries[].arch] | unique | join(",")' "$TMP_ROOT/out/scope.json")" = \
  wasm32 ]
[ "$(jq -r '.entries[] | select(.package == "dep") | .cache_key_sha' \
  "$TMP_ROOT/out/scope.json")" = "$hex_a" ]
grep -Fxq \
  "build-deps program-index-context-check --source-repo-root $TMP_ROOT/repo" \
  "$TMP_ROOT/xtask.log"

write_valid_index
XTASK_FAIL=1 expect_failure "a stale projection" \
  run_derive "$TMP_ROOT/out/stale.json"
[ ! -e "$TMP_ROOT/out/stale.json" ]

write_valid_index
XTASK_MUTATE_INDEX=1 expect_failure "an index mutated during validation" \
  run_derive "$TMP_ROOT/out/mutated.json"
[ ! -e "$TMP_ROOT/out/mutated.json" ]

write_valid_index
jq '.format = "unknown"' \
  "$TMP_ROOT/repo/packages/registry/program-packages.json" \
  >"$TMP_ROOT/bad.json"
mv "$TMP_ROOT/bad.json" \
  "$TMP_ROOT/repo/packages/registry/program-packages.json"
expect_failure "a malformed projection" \
  run_derive "$TMP_ROOT/out/malformed.json"

write_valid_index
jq 'del(.packages.rootfs)' \
  "$TMP_ROOT/repo/packages/registry/program-packages.json" \
  >"$TMP_ROOT/bad.json"
mv "$TMP_ROOT/bad.json" \
  "$TMP_ROOT/repo/packages/registry/program-packages.json"
expect_failure "a missing rootfs projection" \
  run_derive "$TMP_ROOT/out/missing-rootfs.json"

write_valid_index
jq '.packages.rootfs.arches += ["wasm64"] |
    .packages.rootfs.cacheKeys.wasm64 = .identities.rootfs.cacheKeys.wasm64 |
    .packages.rootfs.dependencyClosures.wasm64 = []' \
  "$TMP_ROOT/repo/packages/registry/program-packages.json" \
  >"$TMP_ROOT/bad.json"
mv "$TMP_ROOT/bad.json" \
  "$TMP_ROOT/repo/packages/registry/program-packages.json"
expect_failure "a rootfs projection expanded to wasm64" \
  run_derive "$TMP_ROOT/out/wasm64.json"

write_valid_index
jq '.packages.rootfs.dependencyClosures.wasm32 +=
      [.packages.rootfs.dependencyClosures.wasm32[0]]' \
  "$TMP_ROOT/repo/packages/registry/program-packages.json" \
  >"$TMP_ROOT/bad.json"
mv "$TMP_ROOT/bad.json" \
  "$TMP_ROOT/repo/packages/registry/program-packages.json"
expect_failure "duplicate rootfs dependencies" \
  run_derive "$TMP_ROOT/out/duplicate.json"

write_valid_index
jq --arg c "$hex_c" \
  '.packages.rootfs.dependencyClosures.wasm32[0].cacheKey = $c' \
  "$TMP_ROOT/repo/packages/registry/program-packages.json" \
  >"$TMP_ROOT/bad.json"
mv "$TMP_ROOT/bad.json" \
  "$TMP_ROOT/repo/packages/registry/program-packages.json"
expect_failure "a dependency identity mismatch" \
  run_derive "$TMP_ROOT/out/identity.json"

write_valid_index
mv "$TMP_ROOT/repo/packages/registry/program-packages.json" \
  "$TMP_ROOT/repo/packages/registry/program-packages.real.json"
ln -s program-packages.real.json \
  "$TMP_ROOT/repo/packages/registry/program-packages.json"
expect_failure "a symlinked projection" \
  run_derive "$TMP_ROOT/out/symlink.json"

rm "$TMP_ROOT/repo/packages/registry/program-packages.json"
mv "$TMP_ROOT/repo/packages/registry/program-packages.real.json" \
  "$TMP_ROOT/repo/packages/registry/program-packages.json"
write_valid_index
printf 'occupied\n' >"$TMP_ROOT/out/occupied.json"
expect_failure "an existing output target" \
  run_derive "$TMP_ROOT/out/occupied.json"

echo "derive rootfs staging scope tests passed"
