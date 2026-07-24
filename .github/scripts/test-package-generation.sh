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

echo "test-package-generation: ok"
