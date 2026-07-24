#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/validate-staging-release.sh"
COMPOSE_SCRIPT="$SCRIPT_DIR/compose-staging-release-snapshots.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin"

printf '%s\n' '{"abi_version":39,"entries":[{"package":"zlib","arch":"wasm32","git_inputs":[{"name":"tap","repository":"https://example.invalid/tap.git","commit":"1111111111111111111111111111111111111111"}]}]}' > "$TMP_ROOT/expected.json"
cat > "$TMP_ROOT/index.toml" <<'EOF'
abi_version = 39
archive_url = "https://github.com/Automattic/kandelo/releases/download/pr-946-staging/zlib.tar.zst"
EOF
printf 'archive bytes\n' > "$TMP_ROOT/zlib.tar.zst"

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
INDEX_SHA="$(sha_file "$TMP_ROOT/index.toml")"
ARCHIVE_SHA="$(sha_file "$TMP_ROOT/zlib.tar.zst")"
INDEX_SIZE="$(wc -c < "$TMP_ROOT/index.toml" | tr -d '[:space:]')"
ARCHIVE_SIZE="$(wc -c < "$TMP_ROOT/zlib.tar.zst" | tr -d '[:space:]')"

cat > "$TMP_ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = api ] && [[ "$*" == *'/releases/tags/'* ]]; then
  [ "${GH_STUB_RELEASE_PRESENT:-1}" = 1 ] || exit 1
  printf '%s\n' "${GH_STUB_RELEASE_ID:-17}"
elif [ "$1" = api ] && [[ "$*" == *'/assets?per_page=100'* ]]; then
  printf '[%s]\n' "${GH_STUB_ASSETS:?}"
elif [ "$1 $2" = 'release download' ]; then
  asset=""; dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) asset="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  case "$asset" in
    index.toml) cp "${GH_STUB_INDEX:?}" "$dir/index.toml" ;;
    zlib.tar.zst) cp "${GH_STUB_ARCHIVE:?}" "$dir/zlib.tar.zst" ;;
    *) exit 1 ;;
  esac
else
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi
EOF
chmod +x "$TMP_ROOT/bin/gh"

cat > "$TMP_ROOT/bin/xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for credential_name in \
  GH_TOKEN GITHUB_TOKEN \
  HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN \
  HOMEBREW_DOCKER_REGISTRY_TOKEN; do
  [ -z "${!credential_name:-}" ] || {
    echo "xtask inherited $credential_name" >&2
    exit 97
  }
done
action="$1 $2"
shift 2
mode=""; output=""; localized=""; index=""; assets=""; archives=""; snapshot=""; scope=""
base=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) mode="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --localized-index) localized="$2"; shift 2 ;;
    --index) index="$2"; shift 2 ;;
    --assets) assets="$2"; shift 2 ;;
    --archives-dir) archives="$2"; shift 2 ;;
    --snapshot) snapshot="$2"; shift 2 ;;
    --scope) scope="$2"; shift 2 ;;
    --base-index) base="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$action" = 'staging-reuse compose' ]; then
  cp "$base" "$output"
  exit 0
fi
if [ "$action" = 'staging-reuse validate-archives' ]; then
  [ -s "$snapshot" ]
  if [ "${XTASK_EXPECT_ARCHIVE:-1}" = 1 ]; then
    [ -s "$archives/zlib.tar.zst" ]
  else
    [ ! -e "$archives/zlib.tar.zst" ]
  fi
  [[ "$scope" == all || "$scope" == current-declared-git-inputs ]]
  [ "${XTASK_ARCHIVE_STUB_FAIL:-0}" = 0 ] || exit 1
  exit 0
fi
[ "$action" = 'staging-reuse validate' ]
[ -s "$index" ] && [ -s "$assets" ]
[ "${XTASK_STUB_FAIL:-0}" = 0 ] || exit 1
sed 's#https://github.com/Automattic/kandelo/releases/download/pr-946-staging/##' \
  "$index" > "$localized"
jq -n --arg mode "$mode" --arg sha "${GH_STUB_ARCHIVE_SHA:?}" \
  --argjson size "${GH_STUB_ARCHIVE_SIZE:?}" \
  '{mode:$mode,entries:[{package:"zlib",arch:"wasm32",current:true,asset:"zlib.tar.zst",archive_sha256:$sha,size:$size}]}' > "$output"
EOF
chmod +x "$TMP_ROOT/bin/xtask"

ASSETS="$(jq -nc \
  --arg isha "$INDEX_SHA" --arg asha "$ARCHIVE_SHA" \
  --argjson isize "$INDEX_SIZE" --argjson asize "$ARCHIVE_SIZE" \
  '[{name:"index.toml",state:"uploaded",size:$isize,digest:("sha256:"+$isha)},
    {name:"zlib.tar.zst",state:"uploaded",size:$asize,digest:("sha256:"+$asha)}]')"

run_helper() {
  env PATH="$TMP_ROOT/bin:$PATH" \
    GH_TOKEN=test-release-token \
    GITHUB_TOKEN=test-fallback-token \
    HOMEBREW_GITHUB_API_TOKEN=test-api-token \
    HOMEBREW_GITHUB_PACKAGES_TOKEN=test-packages-token \
    HOMEBREW_DOCKER_REGISTRY_TOKEN=test-registry-token \
    GITHUB_REPOSITORY=Automattic/kandelo \
    GH_STUB_ASSETS="${GH_STUB_ASSETS_OVERRIDE:-$ASSETS}" \
    GH_STUB_RELEASE_PRESENT="${GH_STUB_RELEASE_PRESENT:-1}" \
    GH_STUB_INDEX="$TMP_ROOT/index.toml" \
    GH_STUB_ARCHIVE="$TMP_ROOT/zlib.tar.zst" \
    GH_STUB_ARCHIVE_SHA="$ARCHIVE_SHA" \
    GH_STUB_ARCHIVE_SIZE="$ARCHIVE_SIZE" \
    XTASK_STUB_FAIL="${XTASK_STUB_FAIL:-0}" \
    XTASK_ARCHIVE_STUB_FAIL="${XTASK_ARCHIVE_STUB_FAIL:-0}" \
    XTASK_EXPECT_ARCHIVE="${XTASK_EXPECT_ARCHIVE:-1}" \
    bash "$SCRIPT" "$@"
}

run_helper --tag pr-946-staging --expected-ledger "$TMP_ROOT/expected.json" \
  --mode structural --output-dir "$TMP_ROOT/structural" --xtask "$TMP_ROOT/bin/xtask"
[ -s "$TMP_ROOT/structural/source-index.toml" ]
[ -s "$TMP_ROOT/structural/index.toml" ]
[ -s "$TMP_ROOT/structural/assets.json" ]
[ -s "$TMP_ROOT/structural/snapshot.json" ]
[ ! -e "$TMP_ROOT/structural/archives" ]

printf '%s\n' \
  '{"abi_version":39,"entries":[{"package":"zlib","arch":"wasm32","git_inputs":[]}]}' \
  > "$TMP_ROOT/expected-no-git.json"
XTASK_EXPECT_ARCHIVE=0 run_helper --tag pr-946-staging \
  --expected-ledger "$TMP_ROOT/expected-no-git.json" --mode structural \
  --output-dir "$TMP_ROOT/structural-no-git" --xtask "$TMP_ROOT/bin/xtask"
[ ! -e "$TMP_ROOT/structural-no-git/archives" ]

run_helper --tag pr-946-staging --expected-ledger "$TMP_ROOT/expected.json" \
  --mode current --materialize --output-dir "$TMP_ROOT/current" --xtask "$TMP_ROOT/bin/xtask"
cmp "$TMP_ROOT/zlib.tar.zst" "$TMP_ROOT/current/archives/zlib.tar.zst"
grep -Fxq "file://$TMP_ROOT/current/archives/index.toml" "$TMP_ROOT/current/index-url.txt"
grep -Fq 'archive_url = "zlib.tar.zst"' "$TMP_ROOT/current/archives/index.toml"
if grep -Fq 'https://' "$TMP_ROOT/current/archives/index.toml"; then
  echo "materialized index retained a remote archive URL" >&2
  exit 1
fi

# Target-only finalization must rewrite the helper's provisional file URL to
# the final directory after moving it.
cp -R "$TMP_ROOT/current" "$TMP_ROOT/target-to-place"
bash "$COMPOSE_SCRIPT" \
  --target-dir "$TMP_ROOT/target-to-place" \
  --output-dir "$TMP_ROOT/final-target"
[ ! -e "$TMP_ROOT/target-to-place" ]
[ -f "$TMP_ROOT/final-target/archives/index.toml" ]
grep -Fxq "file://$TMP_ROOT/final-target/archives/index.toml" \
  "$TMP_ROOT/final-target/index-url.txt"

# Union finalization includes both verified source directories and rejects a
# same-basename collision unless the bytes are identical.
cp -R "$TMP_ROOT/current" "$TMP_ROOT/union-target"
cp -R "$TMP_ROOT/current" "$TMP_ROOT/union-canonical"
mv "$TMP_ROOT/union-canonical/archives/zlib.tar.zst" \
  "$TMP_ROOT/union-canonical/archives/canonical.tar.zst"
bash "$COMPOSE_SCRIPT" \
  --target-dir "$TMP_ROOT/union-target" \
  --canonical-dir "$TMP_ROOT/union-canonical" \
  --overlay-expected-ledger "$TMP_ROOT/expected.json" \
  --output-dir "$TMP_ROOT/final-union" \
  --xtask "$TMP_ROOT/bin/xtask"
[ -f "$TMP_ROOT/final-union/archives/zlib.tar.zst" ]
[ -f "$TMP_ROOT/final-union/archives/canonical.tar.zst" ]
[ -f "$TMP_ROOT/final-union/archives/index.toml" ]

cp -R "$TMP_ROOT/current" "$TMP_ROOT/collision-target"
cp -R "$TMP_ROOT/current" "$TMP_ROOT/collision-canonical"
printf 'different bytes\n' > "$TMP_ROOT/collision-canonical/archives/zlib.tar.zst"
if bash "$COMPOSE_SCRIPT" \
    --target-dir "$TMP_ROOT/collision-target" \
    --canonical-dir "$TMP_ROOT/collision-canonical" \
    --overlay-expected-ledger "$TMP_ROOT/expected.json" \
    --output-dir "$TMP_ROOT/collision-output" \
    --xtask "$TMP_ROOT/bin/xtask"; then
  echo "conflicting union archive basename was accepted" >&2
  exit 1
fi

if GH_STUB_RELEASE_PRESENT=0 run_helper --tag pr-946-staging \
  --expected-ledger "$TMP_ROOT/expected.json" --mode structural \
  --output-dir "$TMP_ROOT/absent" --xtask "$TMP_ROOT/bin/xtask"; then
  echo "absent release was accepted" >&2
  exit 1
fi

if XTASK_STUB_FAIL=1 run_helper --tag pr-946-staging \
  --expected-ledger "$TMP_ROOT/expected.json" --mode structural \
  --output-dir "$TMP_ROOT/invalid" --xtask "$TMP_ROOT/bin/xtask"; then
  echo "validator failure was accepted" >&2
  exit 1
fi

if XTASK_ARCHIVE_STUB_FAIL=1 run_helper --tag pr-946-staging \
  --expected-ledger "$TMP_ROOT/expected.json" --mode structural \
  --output-dir "$TMP_ROOT/archive-invalid" --xtask "$TMP_ROOT/bin/xtask"; then
  echo "archive provenance validator failure was accepted" >&2
  exit 1
fi

BAD_ASSETS="$(printf '%s\n' "$ASSETS" | jq -c 'map(select(.name != "index.toml"))')"
if GH_STUB_ASSETS_OVERRIDE="$BAD_ASSETS" run_helper --tag pr-946-staging \
  --expected-ledger "$TMP_ROOT/expected.json" --mode structural \
  --output-dir "$TMP_ROOT/no-index" --xtask "$TMP_ROOT/bin/xtask"; then
  echo "missing index metadata was accepted" >&2
  exit 1
fi

echo "staging release validation helper tests passed"
