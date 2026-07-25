#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL="$SCRIPT_DIR/package-generation.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir "$TMP_ROOT/archives"

hex_a="$(printf 'a%.0s' {1..64})"
hex_b="$(printf 'b%.0s' {1..64})"
source_sha="$(printf '1%.0s' {1..40})"
other_source_sha="$(printf '2%.0s' {1..40})"
authority_sha="$(printf '3%.0s' {1..40})"

jq -nS --arg a "$hex_a" --arg b "$hex_b" '{
  format:"kandelo-program-packages-v2",
  packages:{
    rootfs:{
      manifestSha256:$b,
      arches:["wasm32"],
      cacheKeys:{wasm32:$b},
      dependencyClosures:{
        wasm32:[{
          packageName:"dep",
          manifestSha256:$a,
          cacheKey:$a
        }]
      }
    }
  }
}' >"$TMP_ROOT/program-packages.json"
jq -nS --arg a "$hex_a" --arg b "$hex_b" '{
  abi_version:42,
  entries:[
    {
      package:"dep",kind:"program",arch:"wasm32",
      version:"1",revision:1,cache_key_sha:$a,git_inputs:[]
    },
    {
      package:"rootfs",kind:"program",arch:"wasm32",
      version:"1",revision:1,cache_key_sha:$b,git_inputs:[]
    },
    {
      package:"unrelated",kind:"program",arch:"wasm32",
      version:"1",revision:1,cache_key_sha:$a,git_inputs:[]
    }
  ]
}' >"$TMP_ROOT/full-expected.json"

python3 "$TOOL" select \
  --program-packages "$TMP_ROOT/program-packages.json" \
  --full-expected-ledger "$TMP_ROOT/full-expected.json" \
  --root-package rootfs \
  --arch wasm32 \
  --expected-abi 42 \
  --projection-out "$TMP_ROOT/projection.json" \
  --expected-out "$TMP_ROOT/expected.json"
[ "$(jq -r '.entries | length' "$TMP_ROOT/projection.json")" = 2 ]
[ "$(jq -r '.entries | length' "$TMP_ROOT/expected.json")" = 2 ]
if jq -e 'any(.entries[]; .package == "unrelated")' \
    "$TMP_ROOT/expected.json" >/dev/null; then
  echo "unrelated package escaped into selected expected ledger" >&2
  exit 1
fi

printf 'dep archive bytes\n' >"$TMP_ROOT/archives/dep.tar.zst"
printf 'root archive bytes\n' >"$TMP_ROOT/archives/rootfs.tar.zst"
printf 'source staging index\n' >"$TMP_ROOT/source-index.toml"
cat >"$TMP_ROOT/localized-index.toml" <<'EOF'
abi_version = 42
generated_at = "1970-01-01T00:00:00Z"
generator = "test"

archive_url = "dep.tar.zst"
archive_url = "rootfs.tar.zst"
EOF

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
dep_sha="$(sha_file "$TMP_ROOT/archives/dep.tar.zst")"
root_sha="$(sha_file "$TMP_ROOT/archives/rootfs.tar.zst")"
dep_size="$(wc -c <"$TMP_ROOT/archives/dep.tar.zst" | tr -d '[:space:]')"
root_size="$(wc -c <"$TMP_ROOT/archives/rootfs.tar.zst" | tr -d '[:space:]')"
jq -nS \
  --arg a "$hex_a" \
  --arg b "$hex_b" \
  --arg dep_sha "$dep_sha" \
  --arg root_sha "$root_sha" \
  --argjson dep_size "$dep_size" \
  --argjson root_size "$root_size" '{
    abi_version:42,
    release_tag:"pr-1079-staging",
    complete_current:true,
    entries:[
      {
        package:"dep",kind:"program",arch:"wasm32",
        version:"1",revision:1,cache_key_sha:$a,current:true,
        asset:"dep.tar.zst",archive_sha256:$dep_sha,size:$dep_size
      },
      {
        package:"rootfs",kind:"program",arch:"wasm32",
        version:"1",revision:1,cache_key_sha:$b,current:true,
        asset:"rootfs.tar.zst",archive_sha256:$root_sha,size:$root_size
      }
    ]
  }' >"$TMP_ROOT/snapshot.json"

prepare() {
  local output="$1" sha="$2" index="${3:-$TMP_ROOT/localized-index.toml}"
  python3 "$TOOL" prepare \
    --repository Automattic/kandelo \
    --package-source-sha "$sha" \
    --source-tag pr-1079-staging \
    --source-index "$TMP_ROOT/source-index.toml" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/snapshot.json" \
    --localized-index "$index" \
    --archives-dir "$TMP_ROOT/archives" \
    --output-dir "$output"
}

tag="$(prepare "$TMP_ROOT/bundle" "$source_sha")"
[[ "$tag" =~ ^package-generation-rootfs-wasm32-abi-v42-sha256-[0-9a-f]{64}$ ]]
[ "$tag" = "$(jq -r .tag "$TMP_ROOT/bundle/generation.json")" ]
[ "$(jq -r '.identity.package_source_sha' "$TMP_ROOT/bundle/generation.json")" = "$source_sha" ]
[ "$(find "$TMP_ROOT/bundle" -type f | wc -l | tr -d '[:space:]')" = 4 ]
grep -Fq "/releases/download/$tag/dep.tar.zst" \
  "$TMP_ROOT/bundle/index.toml"
if grep -Fq pr-1079-staging "$TMP_ROOT/bundle/index.toml"; then
  echo "durable index retained its temporary staging URL" >&2
  exit 1
fi
# Ordinary cleanup remains deliberately narrow. Durable generations do not
# acquire a PR-shaped alias merely to escape that lifecycle.
cleanup_workflow="$SCRIPT_DIR/../workflows/staging-cleanup.yml"
grep -Fq 'startswith("pr-")' "$cleanup_workflow"
grep -Fq 'endswith("-staging")' "$cleanup_workflow"
if [[ "$tag" == pr-*-staging ]]; then
  echo "durable tag overlaps the staging-cleanup namespace" >&2
  exit 1
fi
promotion_workflow="$SCRIPT_DIR/../workflows/promote-package-generation.yml"
prepare_job="$(awk '
  /^  prepare:/ {inside=1}
  /^  publish:/ {inside=0}
  inside
' "$promotion_workflow")"
publish_job="$(awk '
  /^  publish:/ {inside=1}
  inside
' "$promotion_workflow")"
grep -Fq "github.ref_name == github.event.repository.default_branch" \
  <<<"$prepare_job"
grep -Fq "contents: read" <<<"$prepare_job"
if grep -Fq "contents: write" <<<"$prepare_job"; then
  echo "historical package-source job unexpectedly has release-write authority" >&2
  exit 1
fi
grep -Fq "persist-credentials: false" <<<"$prepare_job"
grep -Fq "prepare-durable-package-generation.sh" <<<"$prepare_job"
grep -Fq "contents: write" <<<"$publish_job"
grep -Fq "persist-credentials: false" <<<"$publish_job"
grep -Fq "publish-durable-package-generation.sh" <<<"$publish_job"
grep -Fq -- "--authority-xtask" <<<"$publish_job"
if grep -Fq "package-source-target" <<<"$publish_job"; then
  echo "release writer executes historical package-source tooling" >&2
  exit 1
fi

validated_tag="$(python3 "$TOOL" validate \
  --bundle "$TMP_ROOT/bundle" \
  --expected-tag "$tag" \
  --localized-index-out "$TMP_ROOT/recovered-index.toml")"
[ "$validated_tag" = "$tag" ]
cmp "$TMP_ROOT/localized-index.toml" "$TMP_ROOT/recovered-index.toml"

# A consumer commit may differ while the selected package identities remain
# byte-for-byte equal.
cp "$TMP_ROOT/program-packages.json" "$TMP_ROOT/consumer-packages.json"
jq '.packages.unrelated = {
  manifestSha256:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  arches:["wasm32"],
  cacheKeys:{wasm32:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  dependencyClosures:{wasm32:[]}
}' "$TMP_ROOT/consumer-packages.json" >"$TMP_ROOT/consumer-packages.next.json"
mv "$TMP_ROOT/consumer-packages.next.json" "$TMP_ROOT/consumer-packages.json"
python3 "$TOOL" compare-consumer \
  --generation-manifest "$TMP_ROOT/bundle/generation.json" \
  --program-packages "$TMP_ROOT/consumer-packages.json" \
  --full-expected-ledger "$TMP_ROOT/full-expected.json" >/dev/null

# Package drift is never accepted merely because a newer workflow asks for the
# old generation.
jq --arg drift "$(printf 'c%.0s' {1..64})" \
  '.packages.rootfs.cacheKeys.wasm32 = $drift' \
  "$TMP_ROOT/program-packages.json" >"$TMP_ROOT/drift-packages.json"
if python3 "$TOOL" compare-consumer \
    --generation-manifest "$TMP_ROOT/bundle/generation.json" \
    --program-packages "$TMP_ROOT/drift-packages.json" \
    --full-expected-ledger "$TMP_ROOT/full-expected.json"; then
  echo "consumer package drift was accepted" >&2
  exit 1
fi

# The full content digest is not truncated, and changing the exact package
# source or localized index changes the release identity.
other_tag="$(prepare "$TMP_ROOT/other-source" "$other_source_sha")"
[ "$other_tag" != "$tag" ]
cp "$TMP_ROOT/localized-index.toml" "$TMP_ROOT/other-index.toml"
printf '# identity-affecting comment\n' >>"$TMP_ROOT/other-index.toml"
other_index_tag="$(prepare "$TMP_ROOT/other-index" "$source_sha" "$TMP_ROOT/other-index.toml")"
[ "$other_index_tag" != "$tag" ]

cp "$TMP_ROOT/localized-index.toml" "$TMP_ROOT/fallback-index.toml"
printf 'fallback_archive_url = "pr-1079-old.tar.zst"\n' \
  >>"$TMP_ROOT/fallback-index.toml"
if prepare "$TMP_ROOT/fallback" "$source_sha" "$TMP_ROOT/fallback-index.toml"; then
  echo "durable generation accepted a last-green fallback field" >&2
  exit 1
fi

cp -R "$TMP_ROOT/bundle" "$TMP_ROOT/archive-tamper"
printf 'tamper\n' >>"$TMP_ROOT/archive-tamper/dep.tar.zst"
if python3 "$TOOL" validate --bundle "$TMP_ROOT/archive-tamper"; then
  echo "modified archive was accepted" >&2
  exit 1
fi

cp -R "$TMP_ROOT/bundle" "$TMP_ROOT/index-tamper"
printf '# tamper\n' >>"$TMP_ROOT/index-tamper/index.toml"
if python3 "$TOOL" validate --bundle "$TMP_ROOT/index-tamper"; then
  echo "modified index was accepted" >&2
  exit 1
fi

cp -R "$TMP_ROOT/bundle" "$TMP_ROOT/extra-asset"
printf 'extra\n' >"$TMP_ROOT/extra-asset/extra.tar.zst"
if python3 "$TOOL" validate --bundle "$TMP_ROOT/extra-asset"; then
  echo "unexpected asset was accepted" >&2
  exit 1
fi

cp -R "$TMP_ROOT/bundle" "$TMP_ROOT/noncanonical"
jq . "$TMP_ROOT/noncanonical/generation.json" \
  >"$TMP_ROOT/noncanonical/generation.next.json"
mv "$TMP_ROOT/noncanonical/generation.next.json" \
  "$TMP_ROOT/noncanonical/generation.json"
if python3 "$TOOL" validate --bundle "$TMP_ROOT/noncanonical"; then
  echo "noncanonical generation.json was accepted" >&2
  exit 1
fi

printf '{"format":"one","format":"two"}\n' >"$TMP_ROOT/duplicate.json"
if python3 "$TOOL" compare-consumer \
    --generation-manifest "$TMP_ROOT/duplicate.json" \
    --program-packages "$TMP_ROOT/program-packages.json" \
    --full-expected-ledger "$TMP_ROOT/full-expected.json"; then
  echo "duplicate JSON keys were accepted" >&2
  exit 1
fi

truncate -s 4194305 "$TMP_ROOT/oversized.json"
if python3 "$TOOL" compare-consumer \
    --generation-manifest "$TMP_ROOT/oversized.json" \
    --program-packages "$TMP_ROOT/program-packages.json" \
    --full-expected-ledger "$TMP_ROOT/full-expected.json"; then
  echo "oversized public manifest was accepted" >&2
  exit 1
fi

ln -s "$TMP_ROOT/bundle" "$TMP_ROOT/bundle-link"
if python3 "$TOOL" validate --bundle "$TMP_ROOT/bundle-link"; then
  echo "symlinked generation bundle was accepted" >&2
  exit 1
fi

# A preserved PR closure uses only selected release assets and exact same-run
# workflow artifacts. It remains evidence-only even when a current authority
# publishes it.
mkdir \
  "$TMP_ROOT/preserved-archives" \
  "$TMP_ROOT/preserved-run-archives" \
  "$TMP_ROOT/preserved-supporting"
dep_name="dep-1-rev1-abi42-wasm32-aaaaaaaa.tar.zst"
root_name="rootfs-1-rev1-abi42-wasm32-bbbbbbbb.tar.zst"
cp "$TMP_ROOT/archives/dep.tar.zst" \
  "$TMP_ROOT/preserved-archives/$dep_name"
cp "$TMP_ROOT/archives/rootfs.tar.zst" \
  "$TMP_ROOT/preserved-archives/$root_name"
mkdir \
  "$TMP_ROOT/preserved-run-archives/dep-wasm32" \
  "$TMP_ROOT/preserved-run-archives/rootfs-wasm32"
cp "$TMP_ROOT/preserved-archives/$dep_name" \
  "$TMP_ROOT/preserved-run-archives/dep-wasm32/$dep_name"
cp "$TMP_ROOT/preserved-archives/$root_name" \
  "$TMP_ROOT/preserved-run-archives/rootfs-wasm32/$root_name"
cat >"$TMP_ROOT/preserved-local-index.toml" <<EOF
abi_version = 42
generated_at = "1970-01-01T00:00:00Z"
generator = "test"

archive_url = "$dep_name"
archive_url = "$root_name"
EOF
dep_preserved_sha="$(sha_file "$TMP_ROOT/preserved-archives/$dep_name")"
root_preserved_sha="$(sha_file "$TMP_ROOT/preserved-archives/$root_name")"
jq -nS \
  --arg dep_name "$dep_name" \
  --arg root_name "$root_name" \
  --arg dep_sha "$dep_preserved_sha" \
  --arg root_sha "$root_preserved_sha" \
  --argjson dep_size "$dep_size" \
  --argjson root_size "$root_size" '[
    {
      id:101,name:$dep_name,state:"uploaded",
      size:$dep_size,digest:("sha256:" + $dep_sha)
    },
    {
      id:102,name:$root_name,state:"uploaded",
      size:$root_size,digest:("sha256:" + $root_sha)
    },
    {
      id:999,name:"unrelated.tar.zst",state:"uploaded",
      size:1,digest:("sha256:" + ("f" * 64))
    }
  ]' >"$TMP_ROOT/preserved-release-assets.json"
python3 "$TOOL" select-source-assets \
  --source-tag pr-1079-staging \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --release-assets "$TMP_ROOT/preserved-release-assets.json" \
  --snapshot-out "$TMP_ROOT/preserved-snapshot.json" \
  --selected-assets-out "$TMP_ROOT/preserved-selected-assets.json"
[ "$(jq -r length "$TMP_ROOT/preserved-selected-assets.json")" = 2 ]

jq -nS '{
  id:501,tag_name:"pr-1079-staging",target_commitish:"old-anchor",
  draft:false,prerelease:true
}' >"$TMP_ROOT/preserved-release.json"
jq -nS --arg sha "$other_source_sha" '{
  ref:"refs/tags/pr-1079-staging",
  object:{type:"commit",sha:$sha}
}' >"$TMP_ROOT/preserved-tag.json"
jq -nS --arg sha "$source_sha" '{
  id:601,run_attempt:2,event:"pull_request",
  path:".github/workflows/staging-build.yml",head_sha:$sha,
  status:"in_progress",conclusion:null
}' >"$TMP_ROOT/preserved-run.json"
jq -nS '[
  {
    id:701,
    name:"matrix-build (wasm32, rootfs, 1, digest, 1)",
    status:"completed",conclusion:"success"
  },
  {
    id:799,name:"unrelated job",status:"in_progress",conclusion:null
  }
]' >"$TMP_ROOT/preserved-jobs.json"
jq -nS \
  --arg dep_name "$dep_name" \
  --arg root_name "$root_name" \
  --argjson dep_size "$dep_size" \
  --argjson root_size "$root_size" '[
    {
      id:801,name:"dep-wasm32",expired:false,size_in_bytes:$dep_size,
      workflow_run:{id:601}
    },
    {
      id:802,name:"rootfs-wasm32",expired:false,size_in_bytes:$root_size,
      workflow_run:{id:601}
    },
    {
      id:899,name:"unrelated-wasm32",expired:false,size_in_bytes:1,
      workflow_run:{id:601}
    }
  ]' >"$TMP_ROOT/preserved-run-artifacts.json"
cat >"$TMP_ROOT/preserved-rootfs-job.log" <<'EOF'
2026-01-01T00:00:00Z selected program dependency artifacts:
2026-01-01T00:00:01Z   dep-wasm32
2026-01-01T00:00:02Z dependency artifacts to download:
2026-01-01T00:00:03Z   dep-wasm32
2026-01-01T00:00:04Z downloaded dependency artifact dep-wasm32
EOF

capture_preserved() {
  local release_assets="$1" output="$2"
  python3 "$TOOL" capture-source \
    --repository Automattic/kandelo \
    --package-source-sha "$source_sha" \
    --source-tag pr-1079-staging \
    --run-id 601 \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/preserved-snapshot.json" \
    --release "$TMP_ROOT/preserved-release.json" \
    --tag-ref "$TMP_ROOT/preserved-tag.json" \
    --release-assets "$release_assets" \
    --run "$TMP_ROOT/preserved-run.json" \
    --jobs "$TMP_ROOT/preserved-jobs.json" \
    --run-artifacts "$TMP_ROOT/preserved-run-artifacts.json" \
    --archives-dir "$TMP_ROOT/preserved-archives" \
    --run-archives-dir "$TMP_ROOT/preserved-run-archives" \
    --root-job-log "$TMP_ROOT/preserved-rootfs-job.log" \
    --capture-out "$output"
}
capture_preserved \
  "$TMP_ROOT/preserved-release-assets.json" \
  "$TMP_ROOT/preserved-capture.json"
[ "$(jq -r \
  .source_staging.observed_tag_object_sha \
  "$TMP_ROOT/preserved-capture.json")" = "$other_source_sha" ]
[ "$other_source_sha" != "$source_sha" ]

# The stale locator anchor is deliberately not producer authority, but it is
# part of the captured race identity: changing it must change the capture.
cp "$TMP_ROOT/preserved-tag.json" "$TMP_ROOT/preserved-tag-original.json"
jq --arg sha "$authority_sha" '.object.sha = $sha' \
  "$TMP_ROOT/preserved-tag-original.json" >"$TMP_ROOT/preserved-tag.json"
capture_preserved \
  "$TMP_ROOT/preserved-release-assets.json" \
  "$TMP_ROOT/preserved-capture-with-moved-locator.json"
if cmp -s \
    "$TMP_ROOT/preserved-capture.json" \
    "$TMP_ROOT/preserved-capture-with-moved-locator.json"; then
  echo "moved staging locator did not change the captured race identity" >&2
  exit 1
fi
mv "$TMP_ROOT/preserved-tag-original.json" "$TMP_ROOT/preserved-tag.json"

jq 'map(if .id == 101 then .size += 1 else . end)' \
  "$TMP_ROOT/preserved-release-assets.json" \
  >"$TMP_ROOT/preserved-release-assets-with-selected-tamper.json"
if capture_preserved \
    "$TMP_ROOT/preserved-release-assets-with-selected-tamper.json" \
    "$TMP_ROOT/preserved-capture-with-selected-tamper.json"; then
  echo "changed selected release-asset identity was accepted" >&2
  exit 1
fi

cp "$TMP_ROOT/preserved-rootfs-job.log" \
  "$TMP_ROOT/preserved-rootfs-job-before-log-tests.log"
grep -v 'downloaded dependency artifact dep-wasm32' \
  "$TMP_ROOT/preserved-rootfs-job-before-log-tests.log" \
  >"$TMP_ROOT/preserved-rootfs-job.log"
if capture_preserved \
    "$TMP_ROOT/preserved-release-assets.json" \
    "$TMP_ROOT/preserved-capture-with-missing-download.json"; then
  echo "missing selected-dependency download evidence was accepted" >&2
  exit 1
fi
cp "$TMP_ROOT/preserved-rootfs-job-before-log-tests.log" \
  "$TMP_ROOT/preserved-rootfs-job.log"
printf '%s\n' \
  '::warning::dependency artifact dep-wasm32 is absent; continuing without overlay' \
  >>"$TMP_ROOT/preserved-rootfs-job.log"
if capture_preserved \
    "$TMP_ROOT/preserved-release-assets.json" \
    "$TMP_ROOT/preserved-capture-with-fallback.json"; then
  echo "selected-dependency fallback evidence was accepted" >&2
  exit 1
fi
mv \
  "$TMP_ROOT/preserved-rootfs-job-before-log-tests.log" \
  "$TMP_ROOT/preserved-rootfs-job.log"

cp "$TMP_ROOT/preserved-run.json" "$TMP_ROOT/preserved-run-original.json"
jq '.event = "workflow_dispatch"' \
  "$TMP_ROOT/preserved-run-original.json" >"$TMP_ROOT/preserved-run.json"
if capture_preserved \
    "$TMP_ROOT/preserved-release-assets.json" \
    "$TMP_ROOT/preserved-capture-with-wrong-event.json"; then
  echo "non-pull-request source run was accepted" >&2
  exit 1
fi
mv "$TMP_ROOT/preserved-run-original.json" "$TMP_ROOT/preserved-run.json"

cp "$TMP_ROOT/preserved-rootfs-job.log" \
  "$TMP_ROOT/preserved-supporting/rootfs-job.log"
preserved_tag="$(python3 "$TOOL" prepare-preserved \
  --repository Automattic/kandelo \
  --package-source-sha "$source_sha" \
  --authority-sha "$authority_sha" \
  --source-capture "$TMP_ROOT/preserved-capture.json" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/preserved-snapshot.json" \
  --localized-index "$TMP_ROOT/preserved-local-index.toml" \
  --archives-dir "$TMP_ROOT/preserved-archives" \
  --supporting-assets-dir "$TMP_ROOT/preserved-supporting" \
  --output-dir "$TMP_ROOT/preserved-bundle")"
[[ "$preserved_tag" =~ \
  ^preserved-package-generation-rootfs-wasm32-abi-v42-source-${source_sha}-sha256-[0-9a-f]{64}$ ]]
[ "$(jq -r .identity.admission "$TMP_ROOT/preserved-bundle/generation.json")" = none ]
[ "$(jq -r \
  .release.target_commitish \
  "$TMP_ROOT/preserved-bundle/generation.json")" = "$source_sha" ]
[ "$(jq -r \
  .identity.authority_sha \
  "$TMP_ROOT/preserved-bundle/generation.json")" = "$authority_sha" ]
[ "$(find "$TMP_ROOT/preserved-bundle" -type f | wc -l | tr -d '[:space:]')" = 5 ]
python3 "$TOOL" validate \
  --bundle "$TMP_ROOT/preserved-bundle" \
  --expected-tag "$preserved_tag" >/dev/null
if python3 "$TOOL" compare-consumer \
    --generation-manifest "$TMP_ROOT/preserved-bundle/generation.json" \
    --program-packages "$TMP_ROOT/program-packages.json" \
    --full-expected-ledger "$TMP_ROOT/full-expected.json"; then
  echo "preserved evidence was admitted for consumer materialization" >&2
  exit 1
fi

jq -cS '.source_run.attempt = 3' \
  "$TMP_ROOT/preserved-capture.json" \
  >"$TMP_ROOT/preserved-capture-with-moved-attempt.json"
if python3 "$TOOL" compare-source-capture \
    --generation-manifest "$TMP_ROOT/preserved-bundle/generation.json" \
    --source-capture "$TMP_ROOT/preserved-capture-with-moved-attempt.json"; then
  echo "moved source-run attempt matched the sealed capture" >&2
  exit 1
fi

cp -R "$TMP_ROOT/preserved-bundle" "$TMP_ROOT/preserved-log-tamper"
printf 'tamper\n' >>"$TMP_ROOT/preserved-log-tamper/rootfs-job.log"
if python3 "$TOOL" validate --bundle "$TMP_ROOT/preserved-log-tamper"; then
  echo "modified rootfs source evidence was accepted" >&2
  exit 1
fi

cp "$TMP_ROOT/preserved-rootfs-job.log" \
  "$TMP_ROOT/preserved-rootfs-job-with-duplicate-download.log"
printf '2026-01-01T00:00:05Z downloaded dependency artifact dep-wasm32\n' \
  >>"$TMP_ROOT/preserved-rootfs-job-with-duplicate-download.log"
mv \
  "$TMP_ROOT/preserved-rootfs-job.log" \
  "$TMP_ROOT/preserved-rootfs-job-original.log"
mv \
  "$TMP_ROOT/preserved-rootfs-job-with-duplicate-download.log" \
  "$TMP_ROOT/preserved-rootfs-job.log"
if capture_preserved \
    "$TMP_ROOT/preserved-release-assets.json" \
    "$TMP_ROOT/preserved-capture-with-duplicate-download.json"; then
  echo "duplicate selected-dependency download evidence was accepted" >&2
  exit 1
fi
mv \
  "$TMP_ROOT/preserved-rootfs-job-original.log" \
  "$TMP_ROOT/preserved-rootfs-job.log"

# Unrelated release additions are outside the selected closure and therefore
# do not perturb the source capture.
jq '. + [{
  id:1000,name:"later-unrelated.tar.zst",state:"uploaded",size:1,
  digest:("sha256:" + ("e" * 64))
}]' "$TMP_ROOT/preserved-release-assets.json" \
  >"$TMP_ROOT/preserved-release-assets-with-unrelated.json"
capture_preserved \
  "$TMP_ROOT/preserved-release-assets-with-unrelated.json" \
  "$TMP_ROOT/preserved-capture-with-unrelated.json"
cmp \
  "$TMP_ROOT/preserved-capture.json" \
  "$TMP_ROOT/preserved-capture-with-unrelated.json"

preservation_workflow="$SCRIPT_DIR/../workflows/preserve-pr-package-generation.yml"
preserve_prepare_job="$(awk '
  /^  prepare:/ {inside=1}
  /^  publish:/ {inside=0}
  inside
' "$preservation_workflow")"
preserve_publish_job="$(awk '
  /^  publish:/ {inside=1}
  inside
' "$preservation_workflow")"
grep -Fq "github.ref_name == github.event.repository.default_branch" \
  <<<"$preserve_prepare_job"
grep -Fq "github.ref_type == 'branch'" <<<"$preserve_prepare_job"
grep -Fq "actions: read" <<<"$preserve_prepare_job"
if grep -Fq "contents: write" <<<"$preserve_prepare_job"; then
  echo "preserved source reader unexpectedly has release-write authority" >&2
  exit 1
fi
grep -Fq "prepare-preserved-pr-package-generation.sh" \
  <<<"$preserve_prepare_job"
grep -Fq 'cargo_home="$RUNNER_TEMP/prepare-authority-cargo-home"' \
  <<<"$preserve_prepare_job"
grep -Fq 'export CARGO_HOME="$cargo_home"' <<<"$preserve_prepare_job"
grep -Fq 'cargo fetch --locked --manifest-path Cargo.toml' \
  <<<"$preserve_prepare_job"
grep -Fq 'CARGO_HOME="$authority_cargo_home"' <<<"$preserve_prepare_job"
fetch_line="$(
  grep -nF 'cargo fetch --locked --manifest-path Cargo.toml' \
    "$preservation_workflow" | cut -d: -f1
)"
build_line="$(
  grep -nF 'cargo build --release -p xtask' \
    "$preservation_workflow" | head -1 | cut -d: -f1
)"
if [ -z "$fetch_line" ] || [ -z "$build_line" ] ||
   [ "$fetch_line" -ge "$build_line" ]; then
  echo "preservation does not warm the isolated authority lock before building the validator" >&2
  exit 1
fi
if grep -F 'cargo fetch' "$preservation_workflow" |
   grep -Fq 'package-source'; then
  echo "preservation fetch consults the unmerged producer checkout" >&2
  exit 1
fi
if grep -Fq "working-directory: package-source" <<<"$preserve_prepare_job" ||
   grep -Fq "package-source-target" <<<"$preserve_prepare_job" ||
   grep -Fq "source-xtask" <<<"$preserve_prepare_job"; then
  echo "preservation workflow executes unmerged producer tooling" >&2
  exit 1
fi
grep -Fq "working-directory: authority" <<<"$preserve_prepare_job"
grep -Fq "staging-reuse scan-source" \
  "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"
if grep -Fq "staging-reuse expected" \
     "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh" ||
   grep -Fq "package-generation.py\" select " \
     "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"; then
  echo "preservation preparation derives producer identities through the checkout-relative reader" >&2
  exit 1
fi
grep -Fq "reviewed 15-archive closure" \
  "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"
grep -Fq "contents: write" <<<"$preserve_publish_job"
grep -Fq "actions: read" <<<"$preserve_publish_job"
grep -Fq -- '--expected-authority-sha "$GITHUB_SHA"' \
  <<<"$preserve_publish_job"
grep -Fq "verify-preserved-package-source.sh" \
  "$SCRIPT_DIR/publish-durable-package-generation.sh"
grep -Fq "publish-durable-package-generation.sh" <<<"$preserve_publish_job"

echo "test-package-generation: ok"
