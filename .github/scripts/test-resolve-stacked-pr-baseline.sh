#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESOLVER="$REPO_ROOT/.github/scripts/resolve-stacked-pr-baseline.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export MOCK_STATE="$TMP/state"
export MOCK_CASE="success"
export MOCK_LOG="$TMP/mock.log"
export MOCK_REQUIREMENTS="$TMP/requirements.json"
export H="1111111111111111111111111111111111111111"
export B="2222222222222222222222222222222222222222"
export A="3333333333333333333333333333333333333333"
export M="4444444444444444444444444444444444444444"
export ADVANCED="5555555555555555555555555555555555555555"
mkdir -p "$MOCK_STATE" "$TMP/bin"

cat > "$MOCK_REQUIREMENTS" <<'JSON'
[
  {
    "package": "alpha",
    "version": "1",
    "revision": 1,
    "arch": "wasm32",
    "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "kind": "library"
  },
  {
    "package": "beta",
    "version": "2",
    "revision": 3,
    "arch": "wasm32",
    "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "kind": "program"
  }
]
JSON

cat > "$TMP/bin/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$MOCK_LOG"
printf '\n' >> "$MOCK_LOG"

count_call() {
  local name="$1"
  local file="$MOCK_STATE/$name"
  local count=0
  [ ! -f "$file" ] || count="$(cat "$file")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$file"
  printf '%s\n' "$count"
}

pr_json() {
  local number="$1" head_ref="$2" head_sha="$3" base_ref="$4" base_sha="$5"
  local head_repo="Automattic/kandelo"
  if [ "$MOCK_CASE" = "fork_base" ] && [ "$number" != "30" ]; then
    head_repo="Elsewhere/kandelo"
  fi
  jq -nc \
    --argjson number "$number" \
    --arg head_ref "$head_ref" --arg head_sha "$head_sha" \
    --arg base_ref "$base_ref" --arg base_sha "$base_sha" \
    --arg head_repo "$head_repo" \
    '{
      number:$number,
      state:"open",
      head:{ref:$head_ref,sha:$head_sha,repo:{full_name:$head_repo}},
      base:{ref:$base_ref,sha:$base_sha,repo:{full_name:"Automattic/kandelo"}}
    }'
}

release_json() {
  local pr="$1"
  local count
  count="$(count_call "release-$pr")"
  if [ "$MOCK_CASE" = "release_deleted" ] && [ "$pr" = "20" ] && [ "$count" -gt 1 ]; then
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1
  fi
  local archive_id archive_name archive_size index_id index_size run_id digest index_digest
  if [ "$pr" = "20" ]; then
    index_id=2000
    index_size=10
    archive_id=2001
    archive_name='alpha-1-rev1-abi18-wasm32-aaaaaaaa.tar.zst'
    archive_size=13
    run_id=200
    digest='sha256:34a4e35e4026908b98df5c3d9e71df3ad40fe400ecf98d8d2374015e1271db57'
    index_digest='sha256:817a0bb4b4a50da37ac00fead2187a434dcd3913e487bdc38857ee8b48a34b5e'
  else
    index_id=1000
    index_size=10
    archive_id=1001
    archive_name='beta-2-rev3-abi18-wasm32-bbbbbbbb.tar.zst'
    archive_size=12
    run_id=100
    digest='sha256:f4384866f772aa707fa4af638be88161e3aaf20d08de503c1f409fbd8cab7182'
    index_digest='sha256:0d9e62cf7cab5902aa05f466f0ae6f73a6a6ef460ea9a06491b0e38780d8b780'
  fi
  if [ "$MOCK_CASE" = "release_mutated" ] && [ "$pr" = "20" ] && [ "$count" -gt 1 ]; then
    archive_id=2999
  fi
  if [ "$MOCK_CASE" = "bad_digest" ] && [ "$pr" = "20" ]; then
    digest='sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  fi
  if [ "$MOCK_CASE" = "missing_archive" ] && [ "$pr" = "20" ]; then
    jq -nc --argjson id "$((3000 + pr))" --arg tag "pr-${pr}-staging" \
      --argjson index_id "$index_id" --argjson index_size "$index_size" \
      --arg index_digest "$index_digest" '
      {id:$id,tag_name:$tag,prerelease:true,draft:false,assets:[
        {id:$index_id,name:"index.toml",size:$index_size,digest:$index_digest,updated_at:"now"}
      ]}'
    return
  fi
  jq -nc --argjson id "$((3000 + pr))" --arg tag "pr-${pr}-staging" \
    --argjson index_id "$index_id" --argjson index_size "$index_size" \
    --argjson archive_id "$archive_id" --arg archive_name "$archive_name" \
    --argjson archive_size "$archive_size" --arg digest "$digest" --arg index_digest "$index_digest" '
    {id:$id,tag_name:$tag,prerelease:true,draft:false,assets:[
      {id:$index_id,name:"index.toml",size:$index_size,digest:$index_digest,updated_at:"now"},
      {id:$archive_id,name:$archive_name,size:$archive_size,digest:$digest,updated_at:"now"}
    ]}'
}

endpoint="${*: -1}"
case "$endpoint" in
  /repos/Automattic/kandelo/pulls/30)
    count="$(count_call current-pr)"
    base_sha="$B"
    if [ "$MOCK_CASE" = "head_advanced" ] && [ "$count" -gt 1 ]; then
      base_sha="$ADVANCED"
    fi
    pr_json 30 'feature/b' "$H" 'feature/b' "$base_sha"
    ;;
  *'/pulls?state=open&head=Automattic%3Afeature%2Fb&per_page=100')
    if [ "$MOCK_CASE" = "ambiguous_base" ]; then
      printf '[[%s,%s]]\n' \
        "$(pr_json 20 'feature/b' "$B" 'feature/a' "$A")" \
        "$(pr_json 21 'feature/b' "$B" 'main' "$M")"
    else
      printf '[[%s]]\n' "$(pr_json 20 'feature/b' "$B" 'feature/a' "$A")"
    fi
    ;;
  *'/pulls?state=open&head=Automattic%3Afeature%2Fa&per_page=100')
    printf '[[%s]]\n' "$(pr_json 10 'feature/a' "$A" 'main' "$M")"
    ;;
  /repos/Automattic/kandelo/compare/*)
    if [ "$MOCK_CASE" = "non_ancestor" ] && [[ "$endpoint" == *"${B}...${H}" ]]; then
      printf '{"status":"diverged"}\n'
    else
      printf '{"status":"ahead"}\n'
    fi
    ;;
  /repos/Automattic/kandelo/releases/tags/pr-20-staging)
    if [ "$MOCK_CASE" = "missing_release" ]; then
      echo 'gh: Not Found (HTTP 404)' >&2
      exit 1
    fi
    release_json 20
    ;;
  /repos/Automattic/kandelo/releases/tags/pr-10-staging)
    release_json 10
    ;;
  /repos/Automattic/kandelo/releases/assets/2000)
    printf 'index-pr20'
    ;;
  /repos/Automattic/kandelo/releases/assets/1000)
    printf 'index-pr10'
    ;;
  /repos/Automattic/kandelo/releases/assets/2001)
    printf 'alpha-archive'
    ;;
  /repos/Automattic/kandelo/releases/assets/1001)
    printf 'beta-archive'
    ;;
  /repos/Automattic/kandelo/actions/runs/200)
    path='.github/workflows/staging-build.yml'
    [ "$MOCK_CASE" != "wrong_run" ] || path='.github/workflows/other.yml'
    jq -nc --arg sha "$B" --arg path "$path" '{
      id:200,event:"pull_request",path:$path,
      repository:{full_name:"Automattic/kandelo"},
      head_repository:{full_name:"Automattic/kandelo"},
      head_branch:"feature/b",head_sha:$sha,pull_requests:[{number:20}]
    }'
    ;;
  /repos/Automattic/kandelo/actions/runs/100)
    jq -nc --arg sha "$A" '{
      id:100,event:"pull_request",path:".github/workflows/staging-build.yml",
      repository:{full_name:"Automattic/kandelo"},
      head_repository:{full_name:"Automattic/kandelo"},
      head_branch:"feature/a",head_sha:$sha,pull_requests:[{number:10}]
    }'
    ;;
  *)
    echo "unexpected mock gh endpoint: $endpoint" >&2
    exit 1
    ;;
esac
MOCK_GH
chmod +x "$TMP/bin/gh"

cat > "$TMP/bin/selector" <<'MOCK_SELECTOR'
#!/usr/bin/env bash
set -euo pipefail
printf 'selector ' >> "$MOCK_LOG"
printf '%q ' "$@" >> "$MOCK_LOG"
printf '\n' >> "$MOCK_LOG"
[ "$1" = "select" ] || exit 2
shift
index=''
requirements=''
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --index) index="$2"; shift 2 ;;
    --requirements) requirements="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --expected-abi) shift 2 ;;
    *) exit 2 ;;
  esac
done
marker="$(cat "$index")"
case "$marker" in
  index-pr20)
    jq '[.[] | select(.package == "alpha") | . + {
      archive_name:"alpha-1-rev1-abi18-wasm32-aaaaaaaa.tar.zst",
      archive_sha256:"34a4e35e4026908b98df5c3d9e71df3ad40fe400ecf98d8d2374015e1271db57",
      built_by:"https://github.com/Automattic/kandelo/actions/runs/200"
    }]' "$requirements" > "$output"
    ;;
  index-pr10)
    jq '[.[] | select(.package == "beta") | . + {
      archive_name:"beta-2-rev3-abi18-wasm32-bbbbbbbb.tar.zst",
      archive_sha256:"f4384866f772aa707fa4af638be88161e3aaf20d08de503c1f409fbd8cab7182",
      built_by:"https://github.com/Automattic/kandelo/actions/runs/100"
    }]' "$requirements" > "$output"
    ;;
  *) exit 1 ;;
esac
MOCK_SELECTOR
chmod +x "$TMP/bin/selector"

cat > "$TMP/bin/xtask" <<'MOCK_XTASK'
#!/usr/bin/env bash
set -euo pipefail
printf 'xtask ' >> "$MOCK_LOG"
printf '%q ' "$@" >> "$MOCK_LOG"
printf '\n' >> "$MOCK_LOG"
[ "$1" = "index-update" ] || exit 2
[ "$MOCK_CASE" != "archive_invalid" ] || exit 1
MOCK_XTASK
chmod +x "$TMP/bin/xtask"

reset_case() {
  export MOCK_CASE="$1"
  rm -rf "$MOCK_STATE"
  mkdir -p "$MOCK_STATE"
  : > "$MOCK_LOG"
}

run_resolver() {
  local output="$1"
  rm -rf "$output"
  GH_BIN="$TMP/bin/gh" GITHUB_SERVER_URL='https://github.com' \
    STACKED_BASELINE_PYTHON=bash STACKED_BASELINE_SELECTOR="$TMP/bin/selector" \
    STACKED_BASELINE_API_ATTEMPTS=1 STACKED_BASELINE_RETRY_SECONDS=0 \
    bash "$RESOLVER" \
      --repo Automattic/kandelo \
      --current-pr 30 \
      --head-sha "$H" \
      --base-ref feature/b \
      --base-sha "$B" \
      --default-branch main \
      --abi 18 \
      --requirements "$MOCK_REQUIREMENTS" \
      --output "$output" \
      --xtask "$TMP/bin/xtask"
}

expect_failure() {
  local name="$1"
  local expected="$2"
  local output="$TMP/output-$name"
  if run_resolver "$output" > "$TMP/$name.stdout" 2> "$TMP/$name.stderr"; then
    echo "FAIL: $name unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$TMP/$name.stderr"; then
    echo "FAIL: $name did not report $expected" >&2
    cat "$TMP/$name.stderr" >&2
    exit 1
  fi
  [ ! -e "$output" ] || { echo "FAIL: $name published a partial output" >&2; exit 1; }
  echo "PASS: $name"
}

reset_case success
run_resolver "$TMP/output-success" > "$TMP/success.stdout"
[ "$(jq length "$TMP/output-success/selections.json")" -eq 2 ]
[ -f "$TMP/output-success/alpha-wasm32/alpha-1-rev1-abi18-wasm32-aaaaaaaa.tar.zst" ]
[ -f "$TMP/output-success/beta-wasm32/beta-2-rev3-abi18-wasm32-bbbbbbbb.tar.zst" ]
grep -Fq '/actions/runs/200' "$MOCK_LOG"
grep -Fq '/actions/runs/100' "$MOCK_LOG"
echo 'PASS: recursive stack resolves nearest and ancestor archives'

reset_case missing_release
run_resolver "$TMP/output-missing-release" > "$TMP/missing-release.stdout"
[ "$(jq length "$TMP/output-missing-release/selections.json")" -eq 1 ]
[ "$(jq -r '.[0].package' "$TMP/output-missing-release/selections.json")" = 'beta' ]
echo 'PASS: missing immediate release leaves its key unresolved and continues to ancestors'

reset_case missing_archive
run_resolver "$TMP/output-missing-archive" > "$TMP/missing-archive.stdout"
[ "$(jq length "$TMP/output-missing-archive/selections.json")" -eq 1 ]
[ "$(jq -r '.[0].package' "$TMP/output-missing-archive/selections.json")" = 'beta' ]
echo 'PASS: missing archive leaves its key unresolved for matrix rebuild'

reset_case ambiguous_base
expect_failure ambiguous-base 'must belong to exactly one open same-repo PR'

reset_case fork_base
expect_failure fork-base 'must belong to exactly one open same-repo PR'

reset_case non_ancestor
expect_failure non-ancestor 'is not an ancestor relation'

reset_case wrong_run
expect_failure wrong-run 'is not a same-repo staging-build run'

reset_case release_mutated
expect_failure release-mutated 'mutated while its assets were being resolved'

reset_case release_deleted
expect_failure release-deleted 'was deleted while its assets were being resolved'

reset_case bad_digest
expect_failure bad-digest 'does not match index sha256'

reset_case head_advanced
expect_failure head-advanced 'advanced, closed, or no longer matches'

reset_case archive_invalid
expect_failure archive-invalid 'archive validation failed'

echo 'stacked PR baseline resolver tests passed'
