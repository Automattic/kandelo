#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL="$SCRIPT_DIR/package-generation.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir "$TMP_ROOT/archives"

sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

hex_a="$(printf 'a%.0s' {1..64})"
hex_b="$(printf 'b%.0s' {1..64})"
hex_c="$(printf 'c%.0s' {1..64})"
hex_d="$(printf 'd%.0s' {1..64})"
hex_e="$(printf 'e%.0s' {1..64})"
source_sha="$(printf '1%.0s' {1..40})"
other_source_sha="$(printf '2%.0s' {1..40})"

for package in browser-app dep rootfs source-input unrelated; do
  mkdir "$TMP_ROOT/$package"
done
cat >"$TMP_ROOT/browser-app/package.toml" <<'EOF'
kind = "program"
name = "browser-app"
version = "1"
EOF
cat >"$TMP_ROOT/dep/package.toml" <<'EOF'
kind = "program"
name = "dep"
version = "1"
EOF
cat >"$TMP_ROOT/rootfs/package.toml" <<'EOF'
kind = "program"
name = "rootfs"
version = "1"
EOF
cat >"$TMP_ROOT/source-input/package.toml" <<'EOF'
kind = "source"
name = "source-input"
version = "1"
EOF
cat >"$TMP_ROOT/unrelated/package.toml" <<'EOF'
kind = "program"
name = "unrelated"
version = "1"
EOF
browser_manifest="$(sha_file "$TMP_ROOT/browser-app/package.toml")"
dep_manifest="$(sha_file "$TMP_ROOT/dep/package.toml")"
root_manifest="$(sha_file "$TMP_ROOT/rootfs/package.toml")"
source_manifest="$(sha_file "$TMP_ROOT/source-input/package.toml")"
unrelated_manifest="$(sha_file "$TMP_ROOT/unrelated/package.toml")"

jq -nS \
  --arg a "$hex_a" \
  --arg b "$hex_b" \
  --arg c "$hex_c" \
  --arg d "$hex_d" \
  --arg e "$hex_e" \
  --arg browser_manifest "$browser_manifest" \
  --arg dep_manifest "$dep_manifest" \
  --arg root_manifest "$root_manifest" \
  --arg source_manifest "$source_manifest" \
  --arg unrelated_manifest "$unrelated_manifest" '{
  format:"kandelo-program-packages-v2",
  identities:{
    "browser-app":{
      manifestSha256:$browser_manifest,cacheKeys:{wasm32:$c}
    },
    dep:{manifestSha256:$dep_manifest,cacheKeys:{wasm32:$a}},
    rootfs:{manifestSha256:$root_manifest,cacheKeys:{wasm32:$b}},
    "source-input":{
      manifestSha256:$source_manifest,cacheKeys:{wasm32:$e}
    },
    unrelated:{
      manifestSha256:$unrelated_manifest,cacheKeys:{wasm32:$d}
    }
  },
  packages:{
    "browser-app":{
      manifestSha256:$browser_manifest,
      arches:["wasm32"],
      cacheKeys:{wasm32:$c},
      dependencyClosures:{
        wasm32:[
          {
            packageName:"dep",
            manifestSha256:$dep_manifest,
            cacheKey:$a
          },
          {
            packageName:"source-input",
            manifestSha256:$source_manifest,
            cacheKey:$e
          }
        ]
      }
    },
    rootfs:{
      manifestSha256:$root_manifest,
      arches:["wasm32"],
      cacheKeys:{wasm32:$b},
      dependencyClosures:{
        wasm32:[{
          packageName:"dep",
          manifestSha256:$dep_manifest,
          cacheKey:$a
        }]
      }
    },
    unrelated:{
      manifestSha256:$unrelated_manifest,
      arches:["wasm32"],
      cacheKeys:{wasm32:$d},
      dependencyClosures:{wasm32:[]}
    }
  }
}' >"$TMP_ROOT/program-packages.json"
jq -nS \
  --arg a "$hex_a" \
  --arg b "$hex_b" \
  --arg c "$hex_c" \
  --arg d "$hex_d" '{
  abi_version:42,
  entries:[
    {
      package:"browser-app",kind:"program",arch:"wasm32",
      version:"1",revision:1,cache_key_sha:$c,git_inputs:[]
    },
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
      version:"1",revision:1,cache_key_sha:$d,git_inputs:[]
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
jq -e \
  --arg a "$hex_a" \
  --arg b "$hex_b" \
  --arg dep_manifest "$dep_manifest" \
  --arg root_manifest "$root_manifest" '
    . == {
      schema:1,
      root_package:"rootfs",
      arch:"wasm32",
      entries:[
        {
          package:"dep",arch:"wasm32",
          manifest_sha256:$dep_manifest,cache_key_sha:$a
        },
        {
          package:"rootfs",arch:"wasm32",
          manifest_sha256:$root_manifest,cache_key_sha:$b
        }
      ]
    }
  ' "$TMP_ROOT/projection.json" >/dev/null
if jq -e 'any(.entries[]; .package == "unrelated")' \
    "$TMP_ROOT/expected.json" >/dev/null; then
  echo "unrelated package escaped into selected expected ledger" >&2
  exit 1
fi

printf 'browser-app\nrootfs\n' >"$TMP_ROOT/browser-roots.txt"
python3 "$TOOL" select \
  --program-packages "$TMP_ROOT/program-packages.json" \
  --full-expected-ledger "$TMP_ROOT/full-expected.json" \
  --root-set browser-inputs \
  --roots-file "$TMP_ROOT/browser-roots.txt" \
  --arch wasm32 \
  --expected-abi 42 \
  --projection-out "$TMP_ROOT/browser-projection.json" \
  --expected-out "$TMP_ROOT/browser-expected.json"
jq -e '
  .schema == 2 and
  .identity_algorithm == "kandelo-program-packages-v2-manifest-closure-v1" and
  .root_set == "browser-inputs" and
  .roots == ["browser-app","rootfs"] and
  [.closure[].package] == ["browser-app","dep","rootfs","source-input"] and
  [.closure[].disposition] == [
    "program-archive",
    "program-archive",
    "program-archive",
    "source-only"
  ]
' "$TMP_ROOT/browser-projection.json" >/dev/null
[ "$(jq -r '.entries | length' "$TMP_ROOT/browser-expected.json")" = 3 ]
if jq -e 'any(.entries[]; .package == "source-input")' \
    "$TMP_ROOT/browser-expected.json" >/dev/null; then
  echo "source-only closure identity acquired an archive expectation" >&2
  exit 1
fi

assert_browser_selection_rejected() {
  local roots_file="$1"
  local packages="${2:-$TMP_ROOT/program-packages.json}"
  local expected="${3:-$TMP_ROOT/full-expected.json}"
  if python3 "$TOOL" select \
      --program-packages "$packages" \
      --full-expected-ledger "$expected" \
      --root-set browser-inputs \
      --roots-file "$roots_file" \
      --arch wasm32 \
      --expected-abi 42 \
      --projection-out "$TMP_ROOT/rejected-projection.json" \
      --expected-out "$TMP_ROOT/rejected-expected.json"; then
    echo "invalid browser root selection was accepted: $roots_file" >&2
    exit 1
  fi
}

printf 'browser-app\nbrowser-app\nrootfs\n' \
  >"$TMP_ROOT/duplicate-browser-roots.txt"
assert_browser_selection_rejected "$TMP_ROOT/duplicate-browser-roots.txt"
printf 'rootfs\nbrowser-app\n' >"$TMP_ROOT/unsorted-browser-roots.txt"
assert_browser_selection_rejected "$TMP_ROOT/unsorted-browser-roots.txt"
printf 'browser-app\nmissing\nrootfs\n' >"$TMP_ROOT/unknown-browser-roots.txt"
assert_browser_selection_rejected "$TMP_ROOT/unknown-browser-roots.txt"
printf 'browser-app\nrootfs' >"$TMP_ROOT/noncanonical-browser-roots.txt"
assert_browser_selection_rejected "$TMP_ROOT/noncanonical-browser-roots.txt"

jq --arg drift "$hex_d" \
  '.packages."browser-app".dependencyClosures.wasm32[0].manifestSha256 = $drift' \
  "$TMP_ROOT/program-packages.json" >"$TMP_ROOT/manifest-drift-packages.json"
assert_browser_selection_rejected \
  "$TMP_ROOT/browser-roots.txt" \
  "$TMP_ROOT/manifest-drift-packages.json"
jq --arg drift "$hex_d" \
  '.packages."browser-app".dependencyClosures.wasm32[0].cacheKey = $drift' \
  "$TMP_ROOT/program-packages.json" >"$TMP_ROOT/cache-drift-packages.json"
assert_browser_selection_rejected \
  "$TMP_ROOT/browser-roots.txt" \
  "$TMP_ROOT/cache-drift-packages.json"

jq --arg e "$hex_e" '.entries += [{
  package:"source-input",kind:"program",arch:"wasm32",
  version:"1",revision:1,cache_key_sha:$e,git_inputs:[]
}]' "$TMP_ROOT/full-expected.json" >"$TMP_ROOT/source-archive-expected.json"
assert_browser_selection_rejected \
  "$TMP_ROOT/browser-roots.txt" \
  "$TMP_ROOT/program-packages.json" \
  "$TMP_ROOT/source-archive-expected.json"

jq 'del(.packages."browser-app".dependencyClosures.wasm32[1])' \
  "$TMP_ROOT/program-packages.json" >"$TMP_ROOT/source-omission-packages.json"
jq --arg drift "$hex_d" '
  .packages."browser-app".dependencyClosures.wasm32[1].cacheKey = $drift
' "$TMP_ROOT/program-packages.json" >"$TMP_ROOT/source-drift-packages.json"
assert_browser_selection_rejected \
  "$TMP_ROOT/browser-roots.txt" \
  "$TMP_ROOT/source-drift-packages.json"

cp "$TMP_ROOT/source-input/package.toml" "$TMP_ROOT/source-input/package.backup.toml"
cat >"$TMP_ROOT/source-input/package.toml" <<'EOF'
kind = "program"
name = "source-input"
version = "1"
EOF
substituted_source_manifest="$(sha_file "$TMP_ROOT/source-input/package.toml")"
jq --arg manifest "$substituted_source_manifest" '
  .identities."source-input".manifestSha256 = $manifest |
  .packages."browser-app".dependencyClosures.wasm32[1].manifestSha256 = $manifest
' "$TMP_ROOT/program-packages.json" \
  >"$TMP_ROOT/source-substitution-packages.json"
assert_browser_selection_rejected \
  "$TMP_ROOT/browser-roots.txt" \
  "$TMP_ROOT/source-substitution-packages.json"
mv "$TMP_ROOT/source-input/package.backup.toml" \
  "$TMP_ROOT/source-input/package.toml"

if python3 "$TOOL" source-evidence --help >/dev/null 2>&1; then
  echo "removed PR-source evidence command remains available" >&2
  exit 1
fi

tag_sha="$(printf '7%.0s' {1..40})"
tree_sha="$(printf '5%.0s' {1..40})"
mkdir "$TMP_ROOT/main-source-evidence-fixture"
jq -nS --arg source "$source_sha" '{
  id:19,tag_name:"binaries-abi-v42",target_commitish:$source,
  draft:false,prerelease:false
}' >"$TMP_ROOT/main-source-evidence-fixture/release.json"
jq -nS --arg tag "$tag_sha" '{
  ref:"refs/tags/binaries-abi-v42",object:{type:"commit",sha:$tag}
}' >"$TMP_ROOT/main-source-evidence-fixture/tag.json"
jq -nS --arg source "$source_sha" '{
  ref:"refs/heads/main",object:{type:"commit",sha:$source}
}' >"$TMP_ROOT/main-source-evidence-fixture/main.json"
jq -nS --arg source "$source_sha" --arg tree "$tree_sha" '{
  sha:$source,tree:{sha:$tree},parents:[]
}' >"$TMP_ROOT/main-source-evidence-fixture/commit.json"

run_main_source_evidence() {
  local fixture="$1" output="$2"
  python3 "$TOOL" main-source-evidence \
    --repository Automattic/kandelo \
    --source-tag binaries-abi-v42 \
    --default-ref main \
    --package-source-sha "$source_sha" \
    --release "$fixture/release.json" \
    --tag-ref "$fixture/tag.json" \
    --default-ref-value "$fixture/main.json" \
    --source-commit "$fixture/commit.json" \
    --output "$output"
}
run_main_source_evidence \
  "$TMP_ROOT/main-source-evidence-fixture" \
  "$TMP_ROOT/main-source-evidence.json"
jq -e \
  --arg source "$source_sha" \
  --arg tree "$tree_sha" '
    .format == "kandelo-main-package-activation-v1" and
    .tag == "binaries-abi-v42" and .default_ref == "main" and
    .package_source_sha == $source and .tree_sha == $tree
  ' "$TMP_ROOT/main-source-evidence.json" >/dev/null

assert_main_source_evidence_rejected() {
  local fixture="$1"
  if run_main_source_evidence \
      "$fixture" "$TMP_ROOT/rejected-main-source-evidence.json"; then
    echo "non-main source relationship was accepted: $fixture" >&2
    exit 1
  fi
}
cp -R "$TMP_ROOT/main-source-evidence-fixture" "$TMP_ROOT/not-main-ref"
jq '.ref = "refs/heads/release"' "$TMP_ROOT/not-main-ref/main.json" \
  >"$TMP_ROOT/not-main-ref/main.next.json"
mv "$TMP_ROOT/not-main-ref/main.next.json" "$TMP_ROOT/not-main-ref/main.json"
assert_main_source_evidence_rejected "$TMP_ROOT/not-main-ref"

cp -R "$TMP_ROOT/main-source-evidence-fixture" "$TMP_ROOT/prerelease-source"
jq '.prerelease = true' "$TMP_ROOT/prerelease-source/release.json" \
  >"$TMP_ROOT/prerelease-source/release.next.json"
mv "$TMP_ROOT/prerelease-source/release.next.json" \
  "$TMP_ROOT/prerelease-source/release.json"
assert_main_source_evidence_rejected "$TMP_ROOT/prerelease-source"

cp -R "$TMP_ROOT/main-source-evidence-fixture" "$TMP_ROOT/ancestor-substitute"
jq --arg other "$other_source_sha" '.object.sha = $other' \
  "$TMP_ROOT/ancestor-substitute/main.json" \
  >"$TMP_ROOT/ancestor-substitute/main.next.json"
mv "$TMP_ROOT/ancestor-substitute/main.next.json" \
  "$TMP_ROOT/ancestor-substitute/main.json"
assert_main_source_evidence_rejected "$TMP_ROOT/ancestor-substitute"

cp -R "$TMP_ROOT/main-source-evidence-fixture" "$TMP_ROOT/same-tree-substitute"
jq --arg other "$other_source_sha" '.sha = $other' \
  "$TMP_ROOT/same-tree-substitute/commit.json" \
  >"$TMP_ROOT/same-tree-substitute/commit.next.json"
mv "$TMP_ROOT/same-tree-substitute/commit.next.json" \
  "$TMP_ROOT/same-tree-substitute/commit.json"
assert_main_source_evidence_rejected "$TMP_ROOT/same-tree-substitute"

printf 'dep archive bytes\n' >"$TMP_ROOT/archives/dep.tar.zst"
printf 'browser archive bytes\n' >"$TMP_ROOT/archives/browser-app.tar.zst"
printf 'root archive bytes\n' >"$TMP_ROOT/archives/rootfs.tar.zst"
printf 'activated source index\n' >"$TMP_ROOT/source-index.toml"
cat >"$TMP_ROOT/localized-index.toml" <<'EOF'
abi_version = 42
generated_at = "1970-01-01T00:00:00Z"
generator = "test"

archive_url = "dep.tar.zst"
archive_url = "rootfs.tar.zst"
EOF

dep_sha="$(sha_file "$TMP_ROOT/archives/dep.tar.zst")"
browser_sha="$(sha_file "$TMP_ROOT/archives/browser-app.tar.zst")"
root_sha="$(sha_file "$TMP_ROOT/archives/rootfs.tar.zst")"
dep_size="$(wc -c <"$TMP_ROOT/archives/dep.tar.zst" | tr -d '[:space:]')"
browser_size="$(wc -c <"$TMP_ROOT/archives/browser-app.tar.zst" | tr -d '[:space:]')"
root_size="$(wc -c <"$TMP_ROOT/archives/rootfs.tar.zst" | tr -d '[:space:]')"
jq -nS \
  --arg a "$hex_a" \
  --arg b "$hex_b" \
  --arg dep_sha "$dep_sha" \
  --arg root_sha "$root_sha" \
  --argjson dep_size "$dep_size" \
  --argjson root_size "$root_size" '{
    abi_version:42,
    release_tag:"binaries-abi-v42",
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

cat >"$TMP_ROOT/browser-localized-index.toml" <<'EOF'
abi_version = 42
generated_at = "1970-01-01T00:00:00Z"
generator = "browser test"

archive_url = "browser-app.tar.zst"
archive_url = "dep.tar.zst"
archive_url = "rootfs.tar.zst"
EOF
jq -nS \
  --arg a "$hex_a" \
  --arg b "$hex_b" \
  --arg c "$hex_c" \
  --arg browser_sha "$browser_sha" \
  --arg dep_sha "$dep_sha" \
  --arg root_sha "$root_sha" \
  --argjson browser_size "$browser_size" \
  --argjson dep_size "$dep_size" \
  --argjson root_size "$root_size" '{
    abi_version:42,
    release_tag:"binaries-abi-v42",
    complete_current:true,
    entries:[
      {
        package:"browser-app",kind:"program",arch:"wasm32",
        version:"1",revision:1,cache_key_sha:$c,current:true,
        asset:"browser-app.tar.zst",
        archive_sha256:$browser_sha,size:$browser_size
      },
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
  }' >"$TMP_ROOT/browser-snapshot.json"

prepare() {
  local output="$1" sha="$2" index="${3:-$TMP_ROOT/localized-index.toml}"
  python3 "$TOOL" prepare \
    --repository Automattic/kandelo \
    --package-source-sha "$sha" \
    --authority-sha "$sha" \
    --source-tag binaries-abi-v42 \
    --source-evidence "$TMP_ROOT/main-source-evidence.json" \
    --source-index "$TMP_ROOT/source-index.toml" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/snapshot.json" \
    --localized-index "$index" \
    --archives-dir "$TMP_ROOT/archives" \
    --output-dir "$output"
}

prepare_browser() {
  local output="$1"
  local projection="${2:-$TMP_ROOT/browser-projection.json}"
  local evidence="${3:-$TMP_ROOT/main-source-evidence.json}"
  python3 "$TOOL" prepare \
    --repository Automattic/kandelo \
    --package-source-sha "$source_sha" \
    --authority-sha "$source_sha" \
    --source-tag binaries-abi-v42 \
    --source-evidence "$evidence" \
    --source-index "$TMP_ROOT/source-index.toml" \
    --projection "$projection" \
    --expected-ledger "$TMP_ROOT/browser-expected.json" \
    --snapshot "$TMP_ROOT/browser-snapshot.json" \
    --localized-index "$TMP_ROOT/browser-localized-index.toml" \
    --archives-dir "$TMP_ROOT/archives" \
    --output-dir "$output"
}

tag="$(prepare "$TMP_ROOT/bundle" "$source_sha")"
[[ "$tag" =~ ^package-generation-rootfs-wasm32-abi-v42-sha256-[0-9a-f]{64}$ ]]
[ "$tag" = "$(jq -r .tag "$TMP_ROOT/bundle/generation.json")" ]
[ "$(jq -r '.identity.package_source_sha' "$TMP_ROOT/bundle/generation.json")" = "$source_sha" ]
jq -e '
  .identity.projection.schema == 1 and
  (.identity.source_activation | keys) ==
    ["evidence","index_bytes","index_sha256"] and
  .identity.authority_sha == .identity.package_source_sha and
  .identity.source_activation.evidence.default_ref == "main"
' "$TMP_ROOT/bundle/generation.json" >/dev/null
[ "$(find "$TMP_ROOT/bundle" -type f | wc -l | tr -d '[:space:]')" = 4 ]
if python3 "$TOOL" prepare \
    --repository Automattic/kandelo \
    --package-source-sha "$source_sha" \
    --source-tag binaries-abi-v42 \
    --source-index "$TMP_ROOT/source-index.toml" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/snapshot.json" \
    --localized-index "$TMP_ROOT/localized-index.toml" \
    --archives-dir "$TMP_ROOT/archives" \
    --output-dir "$TMP_ROOT/rootfs-with-pr-evidence"; then
  echo "generation without exact-main evidence was accepted" >&2
  exit 1
fi
grep -Fq "/releases/download/$tag/dep.tar.zst" \
  "$TMP_ROOT/bundle/index.toml"
if grep -Fq binaries-abi-v42 "$TMP_ROOT/bundle/index.toml"; then
  echo "durable index retained its mutable source-release URL" >&2
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
grep -Fq "github.ref == 'refs/heads/main'" \
  <<<"$prepare_job"
grep -Fq "contents: read" <<<"$prepare_job"
if grep -Fq "contents: write" <<<"$prepare_job"; then
  echo "historical package-source job unexpectedly has release-write authority" >&2
  exit 1
fi
grep -Fq "persist-credentials: false" <<<"$prepare_job"
grep -Fq "prepare-durable-package-generation.sh" <<<"$prepare_job"
grep -Fq "selection-kind" "$promotion_workflow"
grep -Fq "scripts/dev-shell.sh" <<<"$prepare_job"
grep -Fq "npm ci --ignore-scripts --no-audit --no-fund" <<<"$prepare_job"
grep -Fq -- "--browser-inputs" <<<"$prepare_job"
grep -Fq "browser-binary-package-roots.mjs" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq -- "--exclude-package shell" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq -- "--include-package rootfs" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq -- '--arch "$ARCH"' \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq '/git/ref/heads/$DEFAULT_REF' \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq "main-source-evidence-after.json" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
if grep -Eq '/pulls/|tested_merge|merge_commit_sha' \
    "$SCRIPT_DIR/prepare-durable-package-generation.sh"; then
  echo "durable preparation retained PR/merge provenance authority" >&2
  exit 1
fi
grep -Fq "browser-binary-package-roots.mjs" \
  "$SCRIPT_DIR/materialize-durable-package-generation.sh"
grep -Fq "contents: write" <<<"$publish_job"
grep -Fq "persist-credentials: false" <<<"$publish_job"
grep -Fq "publish-durable-package-generation.sh" <<<"$publish_job"
grep -Fq -- "--authority-xtask" <<<"$publish_job"
grep -Fq "staging-reuse scan-source" \
  "$SCRIPT_DIR/publish-durable-package-generation.sh"
grep -Fq "rederived-projection" \
  "$SCRIPT_DIR/publish-durable-package-generation.sh"
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

# The consumer scanner output is already current-authority data. Comparison
# accepts only the exact projection and exact expected archive ledger.
python3 "$TOOL" compare-consumer \
  --generation-manifest "$TMP_ROOT/bundle/generation.json" \
  --consumer-projection "$TMP_ROOT/projection.json" \
  --consumer-expected-ledger "$TMP_ROOT/expected.json" >/dev/null

# The named browser root set is independently content-addressed and a consumer
# must reproduce both its authoritative roots and their exact dependency union.
if python3 "$TOOL" prepare \
    --repository Automattic/kandelo \
    --package-source-sha "$source_sha" \
    --authority-sha "$source_sha" \
    --source-tag binaries-abi-v42 \
    --source-index "$TMP_ROOT/source-index.toml" \
    --projection "$TMP_ROOT/browser-projection.json" \
    --expected-ledger "$TMP_ROOT/browser-expected.json" \
    --snapshot "$TMP_ROOT/browser-snapshot.json" \
    --localized-index "$TMP_ROOT/browser-localized-index.toml" \
    --archives-dir "$TMP_ROOT/archives" \
    --output-dir "$TMP_ROOT/browser-without-pr-evidence"; then
  echo "schema-2 generation omitted exact-main source evidence" >&2
  exit 1
fi
jq --arg wrong "$other_source_sha" '.package_source_sha = $wrong' \
  "$TMP_ROOT/main-source-evidence.json" >"$TMP_ROOT/wrong-source-evidence.json"
if prepare_browser \
    "$TMP_ROOT/browser-with-wrong-source-evidence" \
    "$TMP_ROOT/browser-projection.json" \
    "$TMP_ROOT/wrong-source-evidence.json"; then
  echo "schema-2 generation accepted evidence for another package source" >&2
  exit 1
fi
browser_tag="$(prepare_browser "$TMP_ROOT/browser-bundle")"
[[ "$browser_tag" =~ ^package-generation-browser-inputs-wasm32-abi-v42-sha256-[0-9a-f]{64}$ ]]
[ "$browser_tag" != "$tag" ]
jq -e '
  (.identity.projection.closure | length) == 4 and
  (.identity.archives | length) == 3 and
  any(.identity.projection.closure[];
    .package == "source-input" and .disposition == "source-only") and
  all(.identity.archives[]; .package != "source-input")
' "$TMP_ROOT/browser-bundle/generation.json" >/dev/null
python3 "$TOOL" validate \
  --bundle "$TMP_ROOT/browser-bundle" \
  --expected-tag "$browser_tag" >/dev/null
python3 "$TOOL" compare-consumer \
  --generation-manifest "$TMP_ROOT/browser-bundle/generation.json" \
  --consumer-projection "$TMP_ROOT/browser-projection.json" \
  --consumer-expected-ledger "$TMP_ROOT/browser-expected.json" >/dev/null

assert_browser_consumer_rejected() {
  local projection="$1"
  if python3 "$TOOL" compare-consumer \
      --generation-manifest "$TMP_ROOT/browser-bundle/generation.json" \
      --consumer-projection "$projection" \
      --consumer-expected-ledger "$TMP_ROOT/browser-expected.json"; then
    echo "browser generation accepted a different consumer root set" >&2
    exit 1
  fi
}

jq '.roots = ["rootfs"]' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/consumer-missing-root.json"
jq '.roots += ["unrelated"]' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/consumer-extra-root.json"
jq '.roots += ["rootfs"]' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/consumer-duplicate-root.json"
jq '.roots |= reverse' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/consumer-unsorted-root.json"
jq 'del(.closure[1])' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/consumer-omitted-closure.json"
jq '.closure[1].cache_key_sha = ("f" * 64)' \
  "$TMP_ROOT/browser-projection.json" >"$TMP_ROOT/consumer-drift.json"
for projection in \
  "$TMP_ROOT/consumer-missing-root.json" \
  "$TMP_ROOT/consumer-extra-root.json" \
  "$TMP_ROOT/consumer-duplicate-root.json" \
  "$TMP_ROOT/consumer-unsorted-root.json" \
  "$TMP_ROOT/consumer-omitted-closure.json" \
  "$TMP_ROOT/consumer-drift.json"
do
  assert_browser_consumer_rejected "$projection"
done

# Even when a named root set's remaining archives overlap another selection,
# changing the bound roots changes the full content tag.
printf 'rootfs\n' >"$TMP_ROOT/missing-browser-root.txt"
python3 "$TOOL" select \
  --program-packages "$TMP_ROOT/program-packages.json" \
  --full-expected-ledger "$TMP_ROOT/full-expected.json" \
  --root-set browser-inputs \
  --roots-file "$TMP_ROOT/missing-browser-root.txt" \
  --arch wasm32 \
  --expected-abi 42 \
  --projection-out "$TMP_ROOT/rootfs-set-projection.json" \
  --expected-out "$TMP_ROOT/rootfs-set-expected.json"
rootfs_set_tag="$(python3 "$TOOL" prepare \
  --repository Automattic/kandelo \
  --package-source-sha "$source_sha" \
  --authority-sha "$source_sha" \
  --source-tag binaries-abi-v42 \
  --source-evidence "$TMP_ROOT/main-source-evidence.json" \
  --source-index "$TMP_ROOT/source-index.toml" \
  --projection "$TMP_ROOT/rootfs-set-projection.json" \
  --expected-ledger "$TMP_ROOT/rootfs-set-expected.json" \
  --snapshot "$TMP_ROOT/snapshot.json" \
  --localized-index "$TMP_ROOT/localized-index.toml" \
  --archives-dir "$TMP_ROOT/archives" \
  --output-dir "$TMP_ROOT/rootfs-set-bundle")"
[[ "$rootfs_set_tag" =~ ^package-generation-browser-inputs-wasm32-abi-v42-sha256-[0-9a-f]{64}$ ]]
[ "$rootfs_set_tag" != "$browser_tag" ]

# Projection keys are a sealed schema. Neither a missing root binding nor an
# extension field can be smuggled through the publication bundle.
jq 'del(.roots)' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/missing-roots-projection.json"
if prepare_browser \
    "$TMP_ROOT/missing-roots-bundle" \
    "$TMP_ROOT/missing-roots-projection.json"; then
  echo "browser projection without roots was accepted" >&2
  exit 1
fi
jq '.ignored = true' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/extra-key-projection.json"
if prepare_browser \
    "$TMP_ROOT/extra-key-bundle" \
    "$TMP_ROOT/extra-key-projection.json"; then
  echo "browser projection with an extra key was accepted" >&2
  exit 1
fi
jq '.schema = true' "$TMP_ROOT/browser-projection.json" \
  >"$TMP_ROOT/noninteger-schema-projection.json"
if prepare_browser \
    "$TMP_ROOT/noninteger-schema-bundle" \
    "$TMP_ROOT/noninteger-schema-projection.json"; then
  echo "browser projection with a non-integer schema was accepted" >&2
  exit 1
fi

# Package drift is never accepted merely because a newer workflow asks for the
# old generation.
jq --arg drift "$(printf 'c%.0s' {1..64})" \
  '.entries[1].cache_key_sha = $drift' \
  "$TMP_ROOT/projection.json" >"$TMP_ROOT/drift-projection.json"
if python3 "$TOOL" compare-consumer \
    --generation-manifest "$TMP_ROOT/bundle/generation.json" \
    --consumer-projection "$TMP_ROOT/drift-projection.json" \
    --consumer-expected-ledger "$TMP_ROOT/expected.json"; then
  echo "consumer package drift was accepted" >&2
  exit 1
fi

# The full content digest is not truncated, and changing the exact package
# source or localized index changes the release identity. A non-main source
# cannot be substituted even when all package bytes are otherwise identical.
if prepare "$TMP_ROOT/other-source" "$other_source_sha"; then
  echo "generation accepted a non-main package source SHA" >&2
  exit 1
fi
cp "$TMP_ROOT/localized-index.toml" "$TMP_ROOT/other-index.toml"
printf '# identity-affecting comment\n' >>"$TMP_ROOT/other-index.toml"
other_index_tag="$(prepare "$TMP_ROOT/other-index" "$source_sha" "$TMP_ROOT/other-index.toml")"
[ "$other_index_tag" != "$tag" ]

cp "$TMP_ROOT/localized-index.toml" "$TMP_ROOT/fallback-index.toml"
printf 'fallback_archive_url = "obsolete.tar.zst"\n' \
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
    --consumer-projection "$TMP_ROOT/projection.json" \
    --consumer-expected-ledger "$TMP_ROOT/expected.json"; then
  echo "duplicate JSON keys were accepted" >&2
  exit 1
fi

truncate -s 4194305 "$TMP_ROOT/oversized.json"
if python3 "$TOOL" compare-consumer \
    --generation-manifest "$TMP_ROOT/oversized.json" \
    --consumer-projection "$TMP_ROOT/projection.json" \
    --consumer-expected-ledger "$TMP_ROOT/expected.json"; then
  echo "oversized public manifest was accepted" >&2
  exit 1
fi

ln -s "$TMP_ROOT/bundle" "$TMP_ROOT/bundle-link"
if python3 "$TOOL" validate --bundle "$TMP_ROOT/bundle-link"; then
  echo "symlinked generation bundle was accepted" >&2
  exit 1
fi

echo "test-package-generation: ok"
