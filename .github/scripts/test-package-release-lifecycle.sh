#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIFECYCLE="$SCRIPT_DIR/package-release-lifecycle.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin"

cat >"$TMP_ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

store="${GH_STATE:?}"
log="$store/writes.log"
mkdir -p "$store/assets"

release_json() {
  jq -S --slurpfile assets "$store/assets.json" \
    '.assets = $assets[0]' "$store/release.json"
}

http_json() {
  local path="$1"
  printf 'HTTP/1.1 200 OK\r\n\r\n'
  cat "$path"
}

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ "$1" = release ] && [ "$2" = upload ]; then
  tag="$3"
  path="${@: -1}"
  name="$(basename "$path")"
  [ "$(jq -r .tag_name "$store/release.json")" = "$tag" ]
  id="$(jq '[.[].id] | max // 100' "$store/assets.json")"
  id=$((id + 1))
  size="$(wc -c <"$path" | tr -d '[:space:]')"
  sha="$(sha_file "$path")"
  cp "$path" "$store/assets/$id"
  jq --argjson id "$id" --arg name "$name" --argjson size "$size" \
    --arg digest "sha256:$sha" \
    '. + [{id:$id,name:$name,state:"uploaded",size:$size,digest:$digest}]' \
    "$store/assets.json" >"$store/assets.next"
  mv "$store/assets.next" "$store/assets.json"
  printf 'upload %s\n' "$name" >>"$log"
  if [ -f "$store/fail-upload-response-once" ]; then
    rm "$store/fail-upload-response-once"
    exit 1
  fi
  exit 0
fi

[ "$1" = api ] || { echo "unexpected gh command: $*" >&2; exit 2; }
shift
include=false
method=GET
endpoint=""
fields=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --include) include=true; shift ;;
    -H) shift 2 ;;
    --method|-X) method="$2"; shift 2 ;;
    -f|-F) fields+=("$2"); shift 2 ;;
    --jq) jq_filter="$2"; shift 2 ;;
    --paginate|--slurp) shift ;;
    /*) endpoint="$1"; shift ;;
    *) echo "unexpected gh api argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$method" = GET ]; then
  case "$endpoint" in
    */releases\?per_page=100\&page=1)
      if [ -f "$store/release.json" ]; then
        release_json | jq -s .
      else
        printf '[]\n'
      fi
      ;;
    */releases\?per_page=100\&page=*) printf '[]\n' ;;
    */releases/7)
      [ -f "$store/release.json" ] || {
        printf 'HTTP/1.1 404 Not Found\r\n\r\n'
        exit 1
      }
      if [ "$include" = true ]; then
        tmp="$(mktemp)"
        release_json >"$tmp"
        http_json "$tmp"
        rm "$tmp"
      else
        release_json
      fi
      ;;
    */releases/7/assets\?per_page=100\&page=1) cat "$store/assets.json" ;;
    */releases/7/assets\?per_page=100\&page=*) printf '[]\n' ;;
    */releases/assets/*)
      id="${endpoint##*/}"
      cat "$store/assets/$id"
      ;;
    */git/ref/tags/*)
      if [ ! -f "$store/tag.json" ]; then
        printf 'HTTP/1.1 404 Not Found\r\n\r\n'
        exit 1
      fi
      if [ "$include" = true ]; then http_json "$store/tag.json"
      else cat "$store/tag.json"; fi
      ;;
    *) echo "unexpected GET endpoint: $endpoint" >&2; exit 2 ;;
  esac
  exit 0
fi

field() {
  local key="$1" item
  for item in "${fields[@]}"; do
    case "$item" in "$key="*) printf '%s' "${item#*=}"; return 0 ;; esac
  done
  return 1
}

case "$method:$endpoint" in
  POST:*/releases)
    if [ -f "$store/fail-create-hard" ]; then
      printf 'create-failed\n' >>"$log"
      exit 1
    fi
    tag="$(field tag_name)"
    target="$(field target_commitish)"
    name="$(field name)"
    body="$(field body)"
    prerelease="$(field prerelease)"
    jq -nS --arg tag "$tag" --arg target "$target" --arg name "$name" \
      --arg body "$body" --argjson prerelease "$prerelease" '{
        id:7,tag_name:$tag,target_commitish:$target,name:$name,body:$body,
        draft:true,immutable:false,prerelease:$prerelease,assets:[]
      }' >"$store/release.json"
    printf '[]\n' >"$store/assets.json"
    printf 'create\n' >>"$log"
    if [ -f "$store/fail-create-response-once" ]; then
      rm "$store/fail-create-response-once"
      exit 1
    fi
    release_json
    ;;
  POST:*/git/refs)
    ref="$(field ref)"
    sha="$(field sha)"
    jq -nS --arg ref "$ref" --arg sha "$sha" \
      '{ref:$ref,object:{type:"commit",sha:$sha}}' >"$store/tag.json"
    printf 'tag\n' >>"$log"
    ;;
  PATCH:*/releases/7)
    printf 'publish\n' >>"$log"
    if [ -f "$store/fail-publish" ]; then exit 1; fi
    jq '.draft=false | .immutable=true' "$store/release.json" \
      >"$store/release.next"
    mv "$store/release.next" "$store/release.json"
    if [ -f "$store/fail-publish-response-once" ]; then
      rm "$store/fail-publish-response-once"
      exit 1
    fi
    release_json
    ;;
  *) echo "unexpected write: $method $endpoint" >&2; exit 2 ;;
esac
EOF
chmod +x "$TMP_ROOT/bin/gh"

sha40="$(printf 'a%.0s' {1..40})"
body="$TMP_ROOT/body"
printf 'Test package release' >"$body"

reset_store() {
  store="$TMP_ROOT/$1"
  rm -rf "$store"
  mkdir -p "$store/assets"
  : >"$store/writes.log"
  printf '[]\n' >"$store/assets.json"
}

run_lifecycle() {
  GH_STATE="$store" \
    GITHUB_REPOSITORY="${TEST_REPOSITORY:-example/repo}" \
    PACKAGE_RELEASE_RETRY_DELAY_SECONDS=0 \
    PATH="$TMP_ROOT/bin:$PATH" \
    bash "$LIFECYCLE" "$@" \
      --tag test-release \
      --target-commit "$sha40" \
      --title 'Test release' \
      --body-file "$body" \
      --prerelease true
}

add_payload() {
  local name="$1" bytes="$2" id="${3:-101}" sha
  printf '%s' "$bytes" >"$store/assets/$id"
  sha="$(sha_file "$store/assets/$id")"
  jq --argjson id "$id" --arg name "$name" \
    --argjson size "${#bytes}" --arg digest "sha256:$sha" \
    '. + [{id:$id,name:$name,state:"uploaded",size:$size,digest:$digest}]' \
    "$store/assets.json" >"$store/assets.next"
  mv "$store/assets.next" "$store/assets.json"
}

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

reset_store create
[ "$(run_lifecycle ensure-draft)" = draft ]
jq -e '.draft == true and .immutable == false' "$store/release.json" >/dev/null
grep -Fxq create "$store/writes.log"

reset_store lost-create
touch "$store/fail-create-response-once"
[ "$(run_lifecycle ensure-draft)" = draft ]
[ "$(grep -c '^create$' "$store/writes.log")" = 1 ]

reset_store hard-create-failure
touch "$store/fail-create-hard"
if run_lifecycle ensure-draft \
    >"$store/hard-create.out" 2>"$store/hard-create.err"
then
  echo "test-package-release-lifecycle: hard create failure succeeded" >&2
  exit 1
fi
[ "$(grep -c '^create-failed$' "$store/writes.log")" = 4 ]
grep -Fq 'draft creation remained uncertain' "$store/hard-create.err"

reset_store publish
run_lifecycle ensure-draft >/dev/null
add_payload index.toml 'index bytes'
[ "$(run_lifecycle seal-publish)" = immutable ]
jq -e '.draft == false and .immutable == true' "$store/release.json" >/dev/null
grep -Fxq 'upload kandelo-package-release-seal-v1.json' "$store/writes.log"
grep -Fxq tag "$store/writes.log"
grep -Fxq publish "$store/writes.log"
writes_before="$(wc -l <"$store/writes.log")"
[ "$(run_lifecycle seal-publish)" = immutable ]
[ "$(wc -l <"$store/writes.log")" = "$writes_before" ]

seal_id="$(jq -r '.[] | select(.name ==
  "kandelo-package-release-seal-v1.json") | .id' "$store/assets.json")"
cp "$store/assets/$seal_id" "$store/seal.good"
printf 'tampered seal\n' >"$store/assets/$seal_id"
if run_lifecycle seal-publish >/dev/null 2>"$store/seal-drift.err"; then
  echo "test-package-release-lifecycle: immutable seal drift was accepted" >&2
  exit 1
fi
grep -Fq 'inventory seal differs' "$store/seal-drift.err"
mv "$store/seal.good" "$store/assets/$seal_id"

reset_store lost-publish
run_lifecycle ensure-draft >/dev/null
add_payload index.toml 'lost response bytes'
touch "$store/fail-publish-response-once"
[ "$(run_lifecycle seal-publish)" = immutable ]
[ "$(grep -c '^publish$' "$store/writes.log")" = 1 ]

reset_store publish-failure
run_lifecycle ensure-draft >/dev/null
add_payload index.toml 'retry bytes'
touch "$store/fail-publish"
if run_lifecycle seal-publish >"$store/failure.out" 2>"$store/failure.err"; then
  echo "test-package-release-lifecycle: publish failure unexpectedly succeeded" >&2
  exit 1
fi
jq -e '.draft == true and .immutable == false' "$store/release.json" >/dev/null
rm "$store/fail-publish"
[ "$(run_lifecycle seal-publish)" = immutable ]

reset_store mismatch
run_lifecycle ensure-draft >/dev/null
jq '.name="Different release"' "$store/release.json" >"$store/release.next"
mv "$store/release.next" "$store/release.json"
if run_lifecycle ensure-draft >/dev/null 2>"$store/mismatch.err"; then
  echo "test-package-release-lifecycle: mismatched identity was accepted" >&2
  exit 1
fi
grep -Fq 'release identity is malformed or differs' "$store/mismatch.err"

reset_store mutable
run_lifecycle ensure-draft >/dev/null
jq '.draft=false | .immutable=false' "$store/release.json" \
  >"$store/release.next"
mv "$store/release.next" "$store/release.json"
if run_lifecycle state >/dev/null 2>"$store/mutable.err"; then
  echo "test-package-release-lifecycle: arbitrary mutable release was accepted" >&2
  exit 1
fi
grep -Fq 'public release is mutable' "$store/mutable.err"

reset_store grandfathered
TEST_REPOSITORY=Automattic/kandelo
GITHUB_REPOSITORY="$TEST_REPOSITORY" GH_STATE="$store" \
  PACKAGE_RELEASE_RETRY_DELAY_SECONDS=0 PATH="$TMP_ROOT/bin:$PATH" \
  bash "$LIFECYCLE" ensure-draft \
    --tag binaries-abi-v42 \
    --target-commit "$sha40" \
    --title binaries-abi-v42 \
    --body-file "$body" \
    --prerelease false >/dev/null
jq '.draft=false | .immutable=false' "$store/release.json" \
  >"$store/release.next"
mv "$store/release.next" "$store/release.json"
state="$(GITHUB_REPOSITORY="$TEST_REPOSITORY" GH_STATE="$store" \
  PACKAGE_RELEASE_RETRY_DELAY_SECONDS=0 PATH="$TMP_ROOT/bin:$PATH" \
  bash "$LIFECYCLE" state \
    --tag binaries-abi-v42 \
    --target-commit "$sha40" \
    --title binaries-abi-v42 \
    --body-file "$body" \
    --prerelease false \
    --allow-grandfathered-abi42)"
[ "$state" = grandfathered-mutable ]

echo "test-package-release-lifecycle: ok"
