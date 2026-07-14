#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/release-index-state.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

asset_id_by_name() {
  local name="$1" meta
  for meta in "$GH_STATE"/meta/*.json; do
    [ -f "$meta" ] || continue
    if [ "$(jq -r .name "$meta")" = "$name" ]; then basename "$meta" .json; return 0; fi
  done
  return 1
}

write_asset() {
  local path="$1" name="$2" id size sha
  if asset_id_by_name "$name" >/dev/null 2>&1; then exit 1; fi
  id=$(cat "$GH_STATE/next-id")
  printf '%s\n' $((id + 1)) > "$GH_STATE/next-id"
  cp "$path" "$GH_STATE/content/$id"
  size=$(wc -c < "$path" | tr -d '[:space:]')
  sha=$(sha_file "$path")
  jq -n --argjson id "$id" --arg name "$name" --argjson size "$size" \
    --arg digest "sha256:$sha" \
    '{id:$id,name:$name,label:null,state:"uploaded",size:$size,digest:$digest}' \
    > "$GH_STATE/meta/$id.json"
}

maybe_apply_error() {
  local kind="$1"
  if [ -f "$GH_STATE/apply-error" ] && [ "$(cat "$GH_STATE/apply-error")" = "$kind" ]; then
    rm "$GH_STATE/apply-error"
    exit 1
  fi
}

command_name="${1:-}"
shift || true
case "$command_name" in
  api)
    method=GET
    include=false
    endpoint=""
    field=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --include) include=true; shift ;;
        --method|-X) method="$2"; shift 2 ;;
        -f) field="$2"; shift 2 ;;
        -H) shift 2 ;;
        /repos/*) endpoint="$1"; shift ;;
        *) shift ;;
      esac
    done
    printf '%s %s\n' "$method" "$endpoint" >> "$GH_STATE/api.log"
    if [[ "$endpoint" == */releases/tags/* ]]; then
      if [ ! -f "$GH_STATE/release.json" ]; then
        if [ "$include" = true ]; then printf 'HTTP/2.0 404 Not Found\n\n{}\n'; fi
        exit 1
      fi
      if [ "$include" = true ]; then printf 'HTTP/2.0 200 OK\n\n'; fi
      cat "$GH_STATE/release.json"
      exit 0
    fi
    if [[ "$endpoint" =~ /releases/([0-9]+)/assets\?per_page=([0-9]+)\&page=([0-9]+)$ ]]; then
      per="${BASH_REMATCH[2]}"; page="${BASH_REMATCH[3]}"
      all="$GH_STATE/all-assets.json"
      shopt -s nullglob
      metas=("$GH_STATE"/meta/*.json)
      if [ "${#metas[@]}" -eq 0 ]; then printf '[]\n' > "$all"
      else jq -s 'sort_by(.id)' "${metas[@]}" > "$all"; fi
      jq --argjson start "$(((page - 1) * per))" --argjson per "$per" '.[$start:($start+$per)]' "$all"
      exit 0
    fi
    if [[ "$endpoint" =~ /releases/assets/([0-9]+)$ ]]; then
      id="${BASH_REMATCH[1]}"
      case "$method" in
        GET)
          [ -f "$GH_STATE/content/$id" ] || exit 1
          cat "$GH_STATE/content/$id"
          ;;
        PATCH)
          [ -f "$GH_STATE/meta/$id.json" ] || exit 1
          key="${field%%=*}"; value="${field#*=}"
          if [ "$key" = name ] && other=$(asset_id_by_name "$value") && [ "$other" != "$id" ]; then exit 1; fi
          jq --arg key "$key" --arg value "$value" '.[$key]=$value' \
            "$GH_STATE/meta/$id.json" > "$GH_STATE/meta/$id.tmp"
          mv "$GH_STATE/meta/$id.tmp" "$GH_STATE/meta/$id.json"
          maybe_apply_error PATCH
          cat "$GH_STATE/meta/$id.json"
          ;;
        DELETE)
          rm -f "$GH_STATE/meta/$id.json" "$GH_STATE/content/$id"
          maybe_apply_error DELETE
          ;;
        *) exit 99 ;;
      esac
      exit 0
    fi
    exit 99
    ;;
  release)
    sub="${1:-}"; shift || true
    case "$sub" in
      upload)
        shift || true
        for arg in "$@"; do
          if [ -f "$arg" ]; then write_asset "$arg" "$(basename "$arg")"; maybe_apply_error UPLOAD; fi
        done
        ;;
      download)
        shift || true
        pattern=""; dir=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --pattern) pattern="$2"; shift 2 ;;
            --dir) dir="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        id=$(asset_id_by_name "$pattern")
        cp "$GH_STATE/content/$id" "$dir/$pattern"
        ;;
      *) exit 99 ;;
    esac
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$BIN/gh"

new_store() {
  local store="$1" body="$2"
  rm -rf "$store"
  mkdir -p "$store/meta" "$store/content"
  printf '100\n' > "$store/next-id"
  : > "$store/api.log"
  jq -n --arg body "$body" \
    '{id:7,tag_name:"binaries-abi-v39",body:$body}' > "$store/release.json"
}

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

run_state() {
  local store="$1"; shift
  GH_STATE="$store" GITHUB_REPOSITORY=example/repo INDEX_STATE_RETRY_DELAY_SECONDS=0 \
    PATH="$BIN:$PATH" bash "$SCRIPT" "$@"
}

read_state() {
  local store="$1" output="$2" head="$3"
  run_state "$store" read --target-tag binaries-abi-v39 --expected-abi 39 \
    --output "$output" --head-file "$head"
}

snapshot_state() {
  local store="$1" output="$2" head="$3"
  run_state "$store" snapshot --target-tag binaries-abi-v39 --expected-abi 39 \
    --output "$output" --head-file "$head"
}

publish_state() {
  local store="$1" index="$2" expected="$3"
  run_state "$store" publish --target-tag binaries-abi-v39 --expected-abi 39 \
    --index-path "$index" --expected-head "$expected"
}

assert_quiescent() {
  local store="$1" expected_sha="$2" names
  names=$(jq -r .name "$store"/meta/*.json | LC_ALL=C sort)
  printf '%s\n' "$names" | grep -Fxq index.toml
  printf '%s\n' "$names" | grep -Fxq kandelo-index-state-v1.json
  printf '%s\n' "$names" | grep -Fxq "kandelo-index-generation-v1-${expected_sha}.toml"
  [ "$(printf '%s\n' "$names" | wc -l | tr -d '[:space:]')" = 3 ]
  marker=$(grep -l 'kandelo-index-state-v1.json' "$store"/meta/*.json)
  [ "$(jq -r .label "$marker")" = "index-head-v1:sha256:${expected_sha}" ]
}

store_fingerprint() {
  local store="$1"
  find "$store/meta" "$store/content" -type f -exec shasum -a 256 {} + | LC_ALL=C sort
}

OLD="$TMP_ROOT/old.toml"
NEW="$TMP_ROOT/new.toml"
printf 'abi_version = 39\nvalue = "old"\n' > "$OLD"
printf 'abi_version = 39\nvalue = "new"\n' > "$NEW"
OLD_SHA=$(sha_file "$OLD")
NEW_SHA=$(sha_file "$NEW")
SENTINEL=$(bash "$SCRIPT" sentinel)

# Bootstrap is allowed only when release creation carried the exact sentinel.
STORE="$TMP_ROOT/bootstrap"
new_store "$STORE" "$SENTINEL"
read_state "$STORE" "$TMP_ROOT/empty.toml" "$TMP_ROOT/empty.head"
[ "$(cat "$TMP_ROOT/empty.head")" = empty ]
cp -R "$STORE" "$TMP_ROOT/empty-baseline"
before=$(store_fingerprint "$STORE")
snapshot_state "$STORE" "$TMP_ROOT/empty-snapshot.toml" "$TMP_ROOT/empty-snapshot.head"
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
[ "$(cat "$TMP_ROOT/empty-snapshot.head")" = empty ]
publish_state "$STORE" "$OLD" empty
assert_quiescent "$STORE" "$OLD_SHA"
cp -R "$STORE" "$TMP_ROOT/baseline"

# A quiescent managed snapshot validates the committed triple without changing
# release bytes or metadata.
before=$(store_fingerprint "$STORE")
snapshot_state "$STORE" "$TMP_ROOT/managed-snapshot.toml" "$TMP_ROOT/managed-snapshot.head"
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
[ "$(cat "$TMP_ROOT/managed-snapshot.head")" = "$OLD_SHA" ]
cmp "$OLD" "$TMP_ROOT/managed-snapshot.toml"

# Every process-death boundary converges on retry. Before the WAL, the old
# head remains authoritative; at and after the WAL, recovery rolls forward.
for point in \
  after-generation-upload after-pending-upload after-wal-upload \
  after-live-retire after-live-promote after-marker-commit during-cleanup after-cleanup
do
  case_store="$TMP_ROOT/case-$point"
  cp -R "$TMP_ROOT/baseline" "$case_store"
  if INDEX_STATE_FAILPOINT="$point" publish_state "$case_store" "$NEW" "$OLD_SHA" \
      >"$TMP_ROOT/$point.out" 2>"$TMP_ROOT/$point.err"
  then
    echo "failpoint $point did not interrupt publication" >&2
    exit 1
  fi
  before=$(store_fingerprint "$case_store")
  case "$point" in
    after-generation-upload|after-pending-upload|after-wal-upload)
      snapshot_state "$case_store" "$TMP_ROOT/$point.snapshot.toml" \
        "$TMP_ROOT/$point.snapshot.head"
      [ "$(cat "$TMP_ROOT/$point.snapshot.head")" = "$OLD_SHA" ]
      cmp "$OLD" "$TMP_ROOT/$point.snapshot.toml"
      ;;
    after-marker-commit|during-cleanup|after-cleanup)
      # Transaction and cleanup leftovers do not invalidate an agreeing
      # committed marker/generation/live triple.
      snapshot_state "$case_store" "$TMP_ROOT/$point.snapshot.toml" \
        "$TMP_ROOT/$point.snapshot.head"
      [ "$(cat "$TMP_ROOT/$point.snapshot.head")" = "$NEW_SHA" ]
      cmp "$NEW" "$TMP_ROOT/$point.snapshot.toml"
      ;;
    *)
      if snapshot_state "$case_store" "$TMP_ROOT/$point.snapshot.toml" \
          "$TMP_ROOT/$point.snapshot.head" >"$TMP_ROOT/$point.snapshot.out" \
          2>"$TMP_ROOT/$point.snapshot.err"
      then
        echo "snapshot accepted an incomplete committed view at $point" >&2
        exit 1
      fi
      grep -q 'post-merge recovery is required' "$TMP_ROOT/$point.snapshot.err"
      ;;
  esac
  after=$(store_fingerprint "$case_store")
  [ "$before" = "$after" ]
  read_state "$case_store" "$TMP_ROOT/recovered.toml" "$TMP_ROOT/recovered.head"
  recovered=$(cat "$TMP_ROOT/recovered.head")
  if [ "$recovered" = "$OLD_SHA" ]; then publish_state "$case_store" "$NEW" "$OLD_SHA"; fi
  read_state "$case_store" "$TMP_ROOT/final.toml" "$TMP_ROOT/final.head"
  [ "$(cat "$TMP_ROOT/final.head")" = "$NEW_SHA" ]
  cmp "$NEW" "$TMP_ROOT/final.toml"
  assert_quiescent "$case_store" "$NEW_SHA"
  # A third read is mutation-free and preserves the exact committed bytes.
  before=$(find "$case_store/meta" -type f -exec shasum -a 256 {} + | sort)
  read_state "$case_store" "$TMP_ROOT/third.toml" "$TMP_ROOT/third.head"
  after=$(find "$case_store/meta" -type f -exec shasum -a 256 {} + | sort)
  [ "$before" = "$after" ]
done

# A mutating API response may be lost. Reconciliation by stable ID must accept
# the applied rename instead of issuing a destructive blind retry.
STORE="$TMP_ROOT/lost-response"
cp -R "$TMP_ROOT/baseline" "$STORE"
printf 'PATCH\n' > "$STORE/apply-error"
publish_state "$STORE" "$NEW" "$OLD_SHA"
assert_quiescent "$STORE" "$NEW_SHA"

# Existing live releases migrate without touching the live asset. A death
# after generation staging resumes the migration on the next read.
STORE="$TMP_ROOT/migration"
new_store "$STORE" 'legacy release'
GH_STATE="$STORE" PATH="$BIN:$PATH" gh release upload binaries-abi-v39 --repo example/repo "$OLD"
id=$(jq -r 'select(.name=="old.toml") | .id' "$STORE"/meta/*.json)
jq '.name="index.toml"' "$STORE/meta/$id.json" > "$STORE/meta/$id.tmp"
mv "$STORE/meta/$id.tmp" "$STORE/meta/$id.json"
before=$(store_fingerprint "$STORE")
snapshot_state "$STORE" "$TMP_ROOT/legacy.toml" "$TMP_ROOT/legacy.head"
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
[ "$(cat "$TMP_ROOT/legacy.head")" = "$OLD_SHA" ]
cmp "$OLD" "$TMP_ROOT/legacy.toml"
if INDEX_STATE_FAILPOINT=after-migration-generation read_state "$STORE" \
    "$TMP_ROOT/migration.toml" "$TMP_ROOT/migration.head" >/dev/null 2>&1
then
  echo "migration failpoint did not interrupt" >&2; exit 1
fi
before=$(store_fingerprint "$STORE")
snapshot_state "$STORE" "$TMP_ROOT/interrupted-migration.toml" \
  "$TMP_ROOT/interrupted-migration.head"
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
[ "$(cat "$TMP_ROOT/interrupted-migration.head")" = "$OLD_SHA" ]
cmp "$OLD" "$TMP_ROOT/interrupted-migration.toml"
read_state "$STORE" "$TMP_ROOT/migration.toml" "$TMP_ROOT/migration.head"
[ "$(cat "$TMP_ROOT/migration.head")" = "$OLD_SHA" ]
cmp "$OLD" "$TMP_ROOT/migration.toml"
assert_quiescent "$STORE" "$OLD_SHA"

# The committed immutable generation repairs a missing stable asset. Wrong
# live bytes are treated as foreign mutation and fail closed.
STORE="$TMP_ROOT/repair"
cp -R "$TMP_ROOT/baseline" "$STORE"
live_meta=$(grep -l '"name": "index.toml"\|"name":"index.toml"' "$STORE"/meta/*.json)
live_id=$(jq -r .id "$live_meta")
rm "$live_meta" "$STORE/content/$live_id"
before=$(store_fingerprint "$STORE")
if snapshot_state "$STORE" "$TMP_ROOT/missing-live.toml" "$TMP_ROOT/missing-live.head" \
    >/dev/null 2>"$TMP_ROOT/missing-live.err"
then
  echo "snapshot repaired a missing stable asset" >&2; exit 1
fi
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
grep -q 'post-merge recovery is required' "$TMP_ROOT/missing-live.err"
read_state "$STORE" "$TMP_ROOT/repaired.toml" "$TMP_ROOT/repaired.head"
cmp "$OLD" "$TMP_ROOT/repaired.toml"
assert_quiescent "$STORE" "$OLD_SHA"

STORE="$TMP_ROOT/wrong-live"
cp -R "$TMP_ROOT/baseline" "$STORE"
live_meta=$(grep -l '"name": "index.toml"\|"name":"index.toml"' "$STORE"/meta/*.json)
live_id=$(jq -r .id "$live_meta")
printf 'wrong\n' > "$STORE/content/$live_id"
before=$(store_fingerprint "$STORE")
if snapshot_state "$STORE" "$TMP_ROOT/wrong.toml" "$TMP_ROOT/wrong.head" >/dev/null 2>&1; then
  echo "foreign live index mutation was accepted" >&2; exit 1
fi
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
if read_state "$STORE" "$TMP_ROOT/wrong-read.toml" "$TMP_ROOT/wrong-read.head" \
    >/dev/null 2>&1
then
  echo "foreign live index mutation was accepted by recovery" >&2; exit 1
fi

# Recovery validates the WAL's pending asset name before retiring the stable
# live index. Matching bytes under a different reserved name are not enough.
STORE="$TMP_ROOT/wrong-pending-name"
cp -R "$TMP_ROOT/baseline" "$STORE"
if INDEX_STATE_FAILPOINT=after-wal-upload publish_state "$STORE" "$NEW" "$OLD_SHA" \
    >/dev/null 2>"$TMP_ROOT/wrong-pending-setup.err"
then
  echo "WAL setup failpoint did not interrupt publication" >&2; exit 1
fi
wal_meta=$(for meta in "$STORE"/meta/*.json; do
  case "$(jq -r .name "$meta")" in kandelo-index-transaction-v1-*.json) printf '%s\n' "$meta";; esac
done; true)
wal_id=$(jq -r .id "$wal_meta")
new_id=$(jq -r .new_asset_id "$STORE/content/$wal_id")
new_meta="$STORE/meta/$new_id.json"
jq '.name="kandelo-index-pending-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.toml"' \
  "$new_meta" > "$new_meta.tmp"
mv "$new_meta.tmp" "$new_meta"
old_live_meta=$(for meta in "$STORE"/meta/*.json; do
  [ "$(jq -r .name "$meta")" = index.toml ] && printf '%s\n' "$meta"
done; true)
old_live_id=$(jq -r .id "$old_live_meta")
before=$(store_fingerprint "$STORE")
if read_state "$STORE" "$TMP_ROOT/wrong-pending.toml" "$TMP_ROOT/wrong-pending.head" \
    >"$TMP_ROOT/wrong-pending.out" 2>"$TMP_ROOT/wrong-pending.err"
then
  echo "recovery accepted a wrong-name pending asset" >&2; exit 1
fi
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
grep -q 'pending asset has an unexpected name' "$TMP_ROOT/wrong-pending.err"
[ "$(jq -r .name "$STORE/meta/$old_live_id.json")" = index.toml ]
cmp "$OLD" "$STORE/content/$old_live_id"

# An empty marker is valid only while no stable live index exists.
STORE="$TMP_ROOT/empty-with-live"
cp -R "$TMP_ROOT/empty-baseline" "$STORE"
GH_STATE="$STORE" PATH="$BIN:$PATH" gh release upload binaries-abi-v39 --repo example/repo "$OLD"
id=$(jq -r 'select(.name=="old.toml") | .id' "$STORE"/meta/*.json)
jq '.name="index.toml"' "$STORE/meta/$id.json" > "$STORE/meta/$id.tmp"
mv "$STORE/meta/$id.tmp" "$STORE/meta/$id.json"
before=$(store_fingerprint "$STORE")
if snapshot_state "$STORE" "$TMP_ROOT/empty-live.toml" "$TMP_ROOT/empty-live.head" \
    >/dev/null 2>"$TMP_ROOT/empty-live.err"
then
  echo "snapshot accepted an empty marker with a live index" >&2; exit 1
fi
after=$(store_fingerprint "$STORE")
[ "$before" = "$after" ]
grep -q 'post-merge recovery is required' "$TMP_ROOT/empty-live.err"

# An old empty release without the creation sentinel is not a virgin store.
STORE="$TMP_ROOT/unmanaged-empty"
new_store "$STORE" 'ordinary release'
if read_state "$STORE" "$TMP_ROOT/unmanaged.toml" "$TMP_ROOT/unmanaged.head" >/dev/null 2>&1; then
  echo "unmanaged empty release was bootstrapped" >&2; exit 1
fi

# Asset inventory is explicitly paginated, including the page after 100.
STORE="$TMP_ROOT/paginated"
cp -R "$TMP_ROOT/baseline" "$STORE"
for n in $(seq 1 101); do
  printf 'dummy %s\n' "$n" > "$TMP_ROOT/dummy-$n"
  GH_STATE="$STORE" PATH="$BIN:$PATH" gh release upload binaries-abi-v39 --repo example/repo "$TMP_ROOT/dummy-$n"
done
if GH_STATE="$STORE" GITHUB_REPOSITORY=example/repo INDEX_STATE_RETRY_DELAY_SECONDS=0 \
    INDEX_STATE_MAX_ASSET_PAGES=1 PATH="$BIN:$PATH" bash "$SCRIPT" read \
      --target-tag binaries-abi-v39 --expected-abi 39 \
      --output "$TMP_ROOT/bounded.toml" --head-file "$TMP_ROOT/bounded.head" \
      >"$TMP_ROOT/bounded.out" 2>"$TMP_ROOT/bounded.err"
then
  echo "bounded asset scan accepted a truncated inventory" >&2; exit 1
fi
grep -q 'asset scan reached its safety bound' "$TMP_ROOT/bounded.err"
read_state "$STORE" "$TMP_ROOT/page.toml" "$TMP_ROOT/page.head"
grep -Fq 'page=2' "$STORE/api.log"

echo "release index state tests passed"
