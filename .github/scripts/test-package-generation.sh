#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL="$SCRIPT_DIR/package-generation.py"
ANCESTRY_HELPER="$SCRIPT_DIR/verify-package-generation-ancestry.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# The v2 canonical seal is admissible only while both immutable ancestry
# links remain present. Exercise the shared check directly so prepare and
# publish cannot drift into different interpretations.
mkdir "$TMP_ROOT/ancestry-repo"
git -C "$TMP_ROOT/ancestry-repo" init -q
git -C "$TMP_ROOT/ancestry-repo" config user.name "Kandelo test"
git -C "$TMP_ROOT/ancestry-repo" config user.email test@example.invalid
git -C "$TMP_ROOT/ancestry-repo" commit -q --allow-empty -m producer
ancestry_producer="$(git -C "$TMP_ROOT/ancestry-repo" rev-parse HEAD)"
git -C "$TMP_ROOT/ancestry-repo" commit -q --allow-empty -m preservation
ancestry_preservation="$(git -C "$TMP_ROOT/ancestry-repo" rev-parse HEAD)"
git -C "$TMP_ROOT/ancestry-repo" commit -q --allow-empty -m current
ancestry_current="$(git -C "$TMP_ROOT/ancestry-repo" rev-parse HEAD)"
ancestry_tree="$(git -C "$TMP_ROOT/ancestry-repo" rev-parse 'HEAD^{tree}')"
ancestry_unrelated="$(printf 'unrelated\n' |
  git -C "$TMP_ROOT/ancestry-repo" commit-tree "$ancestry_tree")"
bash "$ANCESTRY_HELPER" \
  --repository-root "$TMP_ROOT/ancestry-repo" \
  --producer-sha "$ancestry_producer" \
  --preservation-authority-sha "$ancestry_preservation" \
  --current-authority-sha "$ancestry_current"
if bash "$ANCESTRY_HELPER" \
    --repository-root "$TMP_ROOT/ancestry-repo" \
    --producer-sha "$ancestry_unrelated" \
    --preservation-authority-sha "$ancestry_preservation" \
    --current-authority-sha "$ancestry_current"; then
  echo "canonical ancestry check accepted an unrelated producer" >&2
  exit 1
fi
if bash "$ANCESTRY_HELPER" \
    --repository-root "$TMP_ROOT/ancestry-repo" \
    --producer-sha "$ancestry_producer" \
    --preservation-authority-sha "$ancestry_preservation" \
    --current-authority-sha "$ancestry_unrelated"; then
  echo "canonical ancestry check accepted unrelated current authority" >&2
  exit 1
fi
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
authority_sha="$(printf '3%.0s' {1..40})"

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
grep -Fq 'startswith($prefix + "-run-")' "$cleanup_workflow"
grep -Fq 'staging(-run-[1-9][0-9]*-attempt-' "$cleanup_workflow"
grep -Fq 'retain-package-staging' "$cleanup_workflow"
if [[ "$tag" == pr-*-staging ||
      "$tag" == pr-*-staging-run-*-attempt-* ]]; then
  echo "durable tag overlaps the staging-cleanup namespace" >&2
  exit 1
fi
promotion_workflow="$SCRIPT_DIR/../workflows/promote-package-generation.yml"
validation_method_input="$(awk '
  /^      validation-method:/ {inside=1}
  /^      expected-abi:/ {inside=0}
  inside
' "$promotion_workflow")"
validation_method_options="$(awk '$1 == "-" {print $2}' \
  <<<"$validation_method_input")"
if [ "$validation_method_options" != \
     $'identical-git-tree-v1\nidentical-package-cache-projection-v1' ]; then
  echo "promotion workflow does not expose the two reviewed validation methods" >&2
  exit 1
fi
prepare_job="$(awk '
  /^  prepare:/ {inside=1}
  /^  publish:/ {inside=0}
  inside
' "$promotion_workflow")"
validation_method_guard="$(awk '
  /- name: Reject unsupported generation validation methods/ {inside=1}
  /- name: Checkout immutable package producer as inert data/ {inside=0}
  inside
' <<<"$prepare_job")"
grep -Fq 'VALIDATION_METHOD: ${{ inputs.validation-method }}' \
  <<<"$validation_method_guard"
grep -Fq 'identical-git-tree-v1|identical-package-cache-projection-v1' \
  <<<"$validation_method_guard"
grep -Fq 'unsupported generation validation method' \
  <<<"$validation_method_guard"
publish_job="$(awk '
  /^  publish:/ {inside=1}
  inside
' "$promotion_workflow")"
validator_preparer="$SCRIPT_DIR/prepare-current-authority-validator.sh"
assert_authority_validator_job() {
  local job="$1" state_name="$2" label="$3"
  if [ "$(grep -Fc "prepare-current-authority-validator.sh" <<<"$job")" -ne 1 ]; then
    echo "$label does not prepare exactly one current-authority validator" >&2
    exit 1
  fi
  grep -Fq -- \
    "--state-dir \"\$RUNNER_TEMP/$state_name\"" <<<"$job"
  grep -Fq \
    'authority_xtask="$(cat "$validator_state/xtask-path")"' <<<"$job"
  grep -Fq \
    'authority_cargo_home="$(cat "$validator_state/cargo-home-path")"' \
    <<<"$job"
  grep -Fq 'env CARGO_HOME="$authority_cargo_home" \' <<<"$job"
  if ! grep -F -B1 'env CARGO_HOME="$authority_cargo_home" \' <<<"$job" |
       grep -Fq 'bash scripts/dev-shell.sh \'; then
    echo "$label does not consume validator state through the declared dev shell" >&2
    exit 1
  fi
  if grep -Eq 'cargo (fetch|build)|working-directory: producer' <<<"$job"; then
    echo "$label bypasses centralized current-authority validator preparation" >&2
    exit 1
  fi
}
fetch_line="$(
  grep -nF 'cargo fetch --locked --manifest-path "$AUTHORITY_MANIFEST"' \
    "$validator_preparer" | cut -d: -f1
)"
build_line="$(
  grep -nF 'cargo build --locked --release -p xtask' \
    "$validator_preparer" | cut -d: -f1
)"
if [ -z "$fetch_line" ] || [ -z "$build_line" ] ||
   [ "$fetch_line" -ge "$build_line" ]; then
  echo "authority validator preparation does not fetch the complete lock before building" >&2
  exit 1
fi
grep -Fq 'AUTHORITY_MANIFEST="$AUTHORITY_ROOT/Cargo.toml"' \
  "$validator_preparer"
grep -Fq 'cd "$AUTHORITY_ROOT"' "$validator_preparer"
grep -Fq 'export CARGO_HOME="$CARGO_HOME_DIR"' "$validator_preparer"
if grep -Eq \
    'PRODUCER_ROOT|PACKAGE_SOURCE_ROOT|--producer-root|--package-source-root' \
    "$validator_preparer"; then
  echo "authority validator preparation accepts an inert-source execution root" >&2
  exit 1
fi
bash "$SCRIPT_DIR/test-prepare-current-authority-validator.sh"
assert_authority_validator_job \
  "$prepare_job" promotion-prepare-authority-validator "promotion prepare"
assert_authority_validator_job \
  "$publish_job" promotion-publish-authority-validator "promotion publish"
grep -Fq "github.ref == 'refs/heads/main'" \
  <<<"$prepare_job"
grep -Fq "contents: read" <<<"$prepare_job"
if grep -Fq "contents: write" <<<"$prepare_job"; then
  echo "historical package-source job unexpectedly has release-write authority" >&2
  exit 1
fi
grep -Fq "persist-credentials: false" <<<"$prepare_job"
grep -Fq "prepare-durable-package-generation.sh" <<<"$prepare_job"
grep -Fq -- "--producer-sha" <<<"$prepare_job"
grep -Fq -- "--validated-main-sha" <<<"$prepare_job"
grep -Fq "selection-kind" "$promotion_workflow"
if grep -Fq "release-retained-source" "$promotion_workflow" ||
   grep -Fq "gh release delete" "$promotion_workflow" ||
   grep -Fq -- "--remove-label retain-package-staging" "$promotion_workflow"; then
  echo "durable promotion still mutates its retained source lifecycle" >&2
  exit 1
fi
grep -Fq "scripts/dev-shell.sh" <<<"$prepare_job"
grep -Fq "npm ci --ignore-scripts --no-audit --no-fund" <<<"$prepare_job"
grep -Fq -- "--browser-inputs" <<<"$prepare_job"
grep -Fq "browser-binary-package-roots.mjs" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq "staging-reuse scan-source-admitted" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
if [ "$(grep -Fc "staging-reuse scan-source-admitted" \
       "$SCRIPT_DIR/prepare-durable-package-generation.sh")" -ne 1 ] ||
   [ "$(grep -Fc "staging-reuse scan-source" \
       "$SCRIPT_DIR/prepare-durable-package-generation.sh")" -ne 2 ]; then
  echo "durable preparation must gate live authority while treating producer source as evidence" >&2
  exit 1
fi
grep -Fq -- "--exclude-package shell" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq -- "--include-package rootfs" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq -- '--arch "$ARCH"' \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq '/git/ref/heads/$DEFAULT_REF' \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq "producer-evidence-after.json" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
if [ "$(grep -Fc "require_pr_staging_retention" \
       "$SCRIPT_DIR/prepare-durable-package-generation.sh")" -lt 3 ]; then
  echo "preparation does not recheck PR staging retention" >&2
  exit 1
fi
grep -Fq "main-validation-after.json" \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
grep -Fq '/pulls/$pr_number' \
  "$SCRIPT_DIR/prepare-durable-package-generation.sh"
if grep -Eq 'tested_merge|merge_commit_sha' \
    "$SCRIPT_DIR/prepare-durable-package-generation.sh"; then
  echo "durable preparation retained PR/merge provenance authority" >&2
  exit 1
fi
grep -Fq "browser-binary-package-roots.mjs" \
  "$SCRIPT_DIR/materialize-durable-package-generation.sh"
grep -Fq "contents: write" <<<"$publish_job"
grep -Fq "pull-requests: read" <<<"$publish_job"
if grep -Fq "pull-requests: write" <<<"$publish_job"; then
  echo "durable publisher retains unnecessary PR mutation authority" >&2
  exit 1
fi
grep -Fq "persist-credentials: false" <<<"$publish_job"
grep -Fq "publish-durable-package-generation.sh" <<<"$publish_job"
grep -Fq -- "--authority-xtask" <<<"$publish_job"
grep -Fq -- "--producer-sha" <<<"$publish_job"
grep -Fq -- "--validated-main-sha" <<<"$publish_job"
grep -Fq "staging-reuse scan-source-admitted" \
  "$SCRIPT_DIR/publish-durable-package-generation.sh"
if [ "$(grep -Fc "staging-reuse scan-source-admitted" \
       "$SCRIPT_DIR/publish-durable-package-generation.sh")" -ne 1 ] ||
   [ "$(grep -Fc "staging-reuse scan-source" \
       "$SCRIPT_DIR/publish-durable-package-generation.sh")" -ne 2 ]; then
  echo "durable publisher must gate live authority while treating producer source as evidence" >&2
  exit 1
fi
grep -Fq "rederived-projection" \
  "$SCRIPT_DIR/publish-durable-package-generation.sh"
if [ "$(grep -Fc "validate_publication_source" \
       "$SCRIPT_DIR/publish-durable-package-generation.sh")" -lt 4 ]; then
  echo "publisher does not recheck live provenance at both seal boundaries" >&2
  exit 1
fi
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

# A v2 generation may retain archives from producer S only when current-main
# evidence proves the configured relationship between S and authority M.
producer_sha="$source_sha"
validated_main_sha="$other_source_sha"
producer_tag_sha="$(printf '3%.0s' {1..40})"
staging_tag="pr-1097-staging"
mkdir "$TMP_ROOT/v2-evidence"
jq -nS --arg tag "$staging_tag" --arg tag_sha "$producer_tag_sha" '{
  id:23,tag_name:$tag,target_commitish:$tag_sha,
  draft:false,prerelease:true
}' >"$TMP_ROOT/v2-evidence/release.json"
jq -nS --arg tag "$staging_tag" --arg tag_sha "$producer_tag_sha" '{
  ref:("refs/tags/" + $tag),object:{type:"commit",sha:$tag_sha}
}' >"$TMP_ROOT/v2-evidence/tag.json"
jq -nS --arg producer "$producer_sha" --arg tree "$tree_sha" '{
  sha:$producer,tree:{sha:$tree},parents:[]
}' >"$TMP_ROOT/v2-evidence/producer-commit.json"
jq -nS --arg main "$validated_main_sha" '{
  ref:"refs/heads/main",object:{type:"commit",sha:$main}
}' >"$TMP_ROOT/v2-evidence/main-ref.json"
jq -nS --arg main "$validated_main_sha" --arg tree "$tree_sha" '{
  sha:$main,tree:{sha:$tree},parents:[]
}' >"$TMP_ROOT/v2-evidence/main-commit.json"
printf '{"abi_version":42}\n' >"$TMP_ROOT/v2-evidence/abi-snapshot.json"
python3 "$TOOL" producer-release-evidence \
  --repository Automattic/kandelo \
  --source-tag "$staging_tag" \
  --producer-sha "$producer_sha" \
  --release "$TMP_ROOT/v2-evidence/release.json" \
  --tag-ref "$TMP_ROOT/v2-evidence/tag.json" \
  --producer-commit "$TMP_ROOT/v2-evidence/producer-commit.json" \
  --output "$TMP_ROOT/v2-evidence/producer-evidence.json"
python3 "$TOOL" main-validation-evidence \
  --repository Automattic/kandelo \
  --default-ref main \
  --validated-main-sha "$validated_main_sha" \
  --abi-version 42 \
  --method identical-git-tree-v1 \
  --default-ref-value "$TMP_ROOT/v2-evidence/main-ref.json" \
  --main-commit "$TMP_ROOT/v2-evidence/main-commit.json" \
  --abi-snapshot "$TMP_ROOT/v2-evidence/abi-snapshot.json" \
  --output "$TMP_ROOT/v2-evidence/main-validation.json"
jq --arg tag "$staging_tag" '.release_tag = $tag' \
  "$TMP_ROOT/snapshot.json" >"$TMP_ROOT/v2-snapshot.json"

prepare_v2() {
  local output="$1"
  local main_validation="${2:-$TMP_ROOT/v2-evidence/main-validation.json}"
  local authority="${3:-$validated_main_sha}"
  python3 "$TOOL" prepare \
    --repository Automattic/kandelo \
    --producer-sha "$producer_sha" \
    --authority-sha "$authority" \
    --source-tag "$staging_tag" \
    --producer-evidence "$TMP_ROOT/v2-evidence/producer-evidence.json" \
    --main-validation "$main_validation" \
    --source-index "$TMP_ROOT/source-index.toml" \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/v2-snapshot.json" \
    --localized-index "$TMP_ROOT/localized-index.toml" \
    --archives-dir "$TMP_ROOT/archives" \
    --output-dir "$output"
}

v2_tag="$(prepare_v2 "$TMP_ROOT/v2-bundle")"
python3 "$TOOL" validate \
  --bundle "$TMP_ROOT/v2-bundle" \
  --expected-tag "$v2_tag" >/dev/null
jq -e \
  --arg producer "$producer_sha" \
  --arg main "$validated_main_sha" \
  --arg tree "$tree_sha" '
    .format == "kandelo-package-generation-v2" and
    .identity.format == "kandelo-package-generation-identity-v2" and
    .identity.producer.evidence.producer_sha == $producer and
    .identity.producer.evidence.producer_tree_sha == $tree and
    .identity.validated_against_main.commit == $main and
    .identity.validated_against_main.tree_sha == $tree and
    .identity.validated_against_main.method == "identical-git-tree-v1" and
    .identity.cache_projection == null and
    .release.target_commitish == $main
  ' "$TMP_ROOT/v2-bundle/generation.json" >/dev/null
jq '.tree_sha = ("6" * 40)' \
  "$TMP_ROOT/v2-evidence/main-validation.json" \
  >"$TMP_ROOT/v2-evidence/wrong-tree-main-validation.json"
if prepare_v2 \
    "$TMP_ROOT/v2-wrong-tree" \
    "$TMP_ROOT/v2-evidence/wrong-tree-main-validation.json"; then
  echo "v2 generation accepted unequal producer and main trees" >&2
  exit 1
fi
if prepare_v2 "$TMP_ROOT/v2-wrong-authority" \
    "$TMP_ROOT/v2-evidence/main-validation.json" "$producer_sha"; then
  echo "v2 generation accepted authority other than validated main" >&2
  exit 1
fi

# The selected-input bridge excludes source-only entries from archive
# components while retaining their identity in the schema-2 projection and in
# each materializable package's direct dependency list.
cache_producer_sha="748c2609954d2809bbcbbcb642fa7d257fc0dbc6"
cache_producer_tree="$(printf '6%.0s' {1..40})"
cache_main_tree="$(printf '7%.0s' {1..40})"
# The evidence records the exact current-authority readers from both complete
# trees. Their bytes may differ because current main owns interpretation.
producer_build_deps_blob="$(printf '1%.0s' {1..40})"
producer_staging_reuse_blob="$(printf '2%.0s' {1..40})"
main_build_deps_blob="$(printf '3%.0s' {1..40})"
main_staging_reuse_blob="$(printf '4%.0s' {1..40})"
mkdir "$TMP_ROOT/cache-evidence"
jq -nS \
  --arg a "$hex_a" \
  --arg b "$hex_b" \
  --arg c "$hex_c" \
  --arg e "$hex_e" \
  --arg browser_manifest "$browser_manifest" \
  --arg dep_manifest "$dep_manifest" \
  --arg root_manifest "$root_manifest" '{
    format:"kandelo-selected-package-build-input-closure-v1",
    abi_version:42,
    arch:"wasm32",
    global_toolchain_components:[
      {label:"flake.nix",sha256:("1" * 64)}
    ],
    fork_instrument:{
      users:["browser-app","rootfs"],
      components:[
        {label:"crates/fork-instrument/src",sha256:("2" * 64)}
      ]
    },
    packages:[
      {
        package:"browser-app",kind:"program",version:"1",revision:1,
        manifest_sha256:$browser_manifest,cache_key_sha:$c,
        build:{
          script_path:"packages/registry/browser-app/build.sh",
          inputs:["packages/registry/browser-app/build.sh"],
          git_inputs:[]
        },
        input_components:[
          {
            label:"packages/registry/browser-app/build.sh",
            sha256:("3" * 64)
          }
        ],
        direct_dependencies:[
          {package:"dep",version:"1",cache_key_sha:$a},
          {package:"source-input",version:"1",cache_key_sha:$e}
        ],
        uses_fork_instrument:true
      },
      {
        package:"dep",kind:"program",version:"1",revision:1,
        manifest_sha256:$dep_manifest,cache_key_sha:$a,
        build:{
          script_path:"packages/registry/dep/build.sh",
          inputs:["packages/registry/dep/build.sh"],
          git_inputs:[]
        },
        input_components:[
          {label:"packages/registry/dep/build.sh",sha256:("4" * 64)}
        ],
        direct_dependencies:[],
        uses_fork_instrument:false
      },
      {
        package:"rootfs",kind:"program",version:"1",revision:1,
        manifest_sha256:$root_manifest,cache_key_sha:$b,
        build:{
          script_path:"packages/registry/rootfs/build.sh",
          inputs:["packages/registry/rootfs/build.sh"],
          git_inputs:[]
        },
        input_components:[
          {label:"packages/registry/rootfs/build.sh",sha256:("5" * 64)}
        ],
        direct_dependencies:[
          {package:"dep",version:"1",cache_key_sha:$a}
        ],
        uses_fork_instrument:true
      }
    ]
  }' >"$TMP_ROOT/cache-evidence/components.json"
jq -nS \
  --arg tree "$cache_producer_tree" \
  --arg build_deps "$producer_build_deps_blob" \
  --arg staging_reuse "$producer_staging_reuse_blob" '{
    sha:$tree,truncated:false,tree:[
      {
        path:"tools/xtask/src/build_deps.rs",
        mode:"100644",type:"blob",
        sha:$build_deps
      },
      {
        path:"tools/xtask/src/staging_reuse.rs",
        mode:"100644",type:"blob",
        sha:$staging_reuse
      },
      {
        path:"host/src/kernel-worker.ts",
        mode:"100644",type:"blob",sha:("8" * 40)
      }
    ]
  }' >"$TMP_ROOT/cache-evidence/producer-tree.json"
jq -nS \
  --arg tree "$cache_main_tree" \
  --arg build_deps "$main_build_deps_blob" \
  --arg staging_reuse "$main_staging_reuse_blob" '{
    sha:$tree,truncated:false,tree:[
      {
        path:"tools/xtask/src/build_deps.rs",
        mode:"100644",type:"blob",sha:$build_deps
      },
      {
        path:"tools/xtask/src/staging_reuse.rs",
        mode:"100644",type:"blob",sha:$staging_reuse
      },
      {
        path:"host/src/kernel-worker.ts",
        mode:"100644",type:"blob",sha:("9" * 40)
      }
    ]
  }' >"$TMP_ROOT/cache-evidence/main-tree.json"

cache_evidence_command=(
  python3 "$TOOL" cache-projection-evidence
  --producer-sha "$cache_producer_sha"
  --producer-tree-sha "$cache_producer_tree"
  --validated-main-sha "$validated_main_sha"
  --validated-main-tree-sha "$cache_main_tree"
  --producer-projection "$TMP_ROOT/browser-projection.json"
  --producer-expected-ledger "$TMP_ROOT/browser-expected.json"
  --main-projection "$TMP_ROOT/browser-projection.json"
  --main-expected-ledger "$TMP_ROOT/browser-expected.json"
  --producer-components "$TMP_ROOT/cache-evidence/components.json"
  --main-components "$TMP_ROOT/cache-evidence/components.json"
  --producer-tree "$TMP_ROOT/cache-evidence/producer-tree.json"
  --main-tree "$TMP_ROOT/cache-evidence/main-tree.json"
)
"${cache_evidence_command[@]}" \
  --output "$TMP_ROOT/cache-evidence/cache-projection.json"
jq -e '
  .format == "kandelo-package-cache-projection-v1" and
  .policy == "selected-build-input-closure-v1" and
  [.validator_transitions[].path] == [
    "tools/xtask/src/build_deps.rs",
    "tools/xtask/src/staging_reuse.rs"
  ] and
  [.selected_build_inputs.packages[].package] ==
    ["browser-app","dep","rootfs"] and
  (.selected_build_inputs.packages[0].direct_dependencies |
    map(.package)) == ["dep","source-input"]
' "$TMP_ROOT/cache-evidence/cache-projection.json" >/dev/null

jq '(.packages[0].direct_dependencies[] |
      select(.package == "source-input").cache_key_sha) = ("0" * 64)' \
  "$TMP_ROOT/cache-evidence/components.json" \
  >"$TMP_ROOT/cache-evidence/source-drift-components.json"
cache_source_drift=("${cache_evidence_command[@]}")
cache_source_drift[20]="$TMP_ROOT/cache-evidence/source-drift-components.json"
if "${cache_source_drift[@]}" \
    --output "$TMP_ROOT/cache-evidence/rejected-source-drift.json"; then
  echo "cache projection accepted source-only dependency identity drift" >&2
  exit 1
fi
jq '(.packages[1].input_components[0].sha256) = ("0" * 64)' \
  "$TMP_ROOT/cache-evidence/components.json" \
  >"$TMP_ROOT/cache-evidence/component-drift.json"
cache_component_drift=("${cache_evidence_command[@]}")
cache_component_drift[20]="$TMP_ROOT/cache-evidence/component-drift.json"
if "${cache_component_drift[@]}" \
    --output "$TMP_ROOT/cache-evidence/rejected-component-drift.json"; then
  echo "cache projection accepted changed selected build input bytes" >&2
  exit 1
fi
jq '.truncated = true' "$TMP_ROOT/cache-evidence/main-tree.json" \
  >"$TMP_ROOT/cache-evidence/truncated-main-tree.json"
cache_truncated=("${cache_evidence_command[@]}")
cache_truncated[26]="$TMP_ROOT/cache-evidence/truncated-main-tree.json"
if "${cache_truncated[@]}" \
    --output "$TMP_ROOT/cache-evidence/rejected-truncated-tree.json"; then
  echo "cache projection accepted a truncated recursive Git tree" >&2
  exit 1
fi
jq 'del(.tree[] | select(
      .path == "tools/xtask/src/build_deps.rs"
    ))' \
  "$TMP_ROOT/cache-evidence/main-tree.json" \
  >"$TMP_ROOT/cache-evidence/missing-validator-tree.json"
cache_missing_validator=("${cache_evidence_command[@]}")
cache_missing_validator[26]="$TMP_ROOT/cache-evidence/missing-validator-tree.json"
if "${cache_missing_validator[@]}" \
    --output "$TMP_ROOT/cache-evidence/rejected-validator.json"; then
  echo "cache projection accepted missing validator evidence" >&2
  exit 1
fi
jq '
    (.tree[] | select(
      .path == "tools/xtask/src/build_deps.rs"
    ).mode) = "120000"
  ' "$TMP_ROOT/cache-evidence/main-tree.json" \
  >"$TMP_ROOT/cache-evidence/symlink-validator-tree.json"
cache_symlink_validator=("${cache_evidence_command[@]}")
cache_symlink_validator[26]="$TMP_ROOT/cache-evidence/symlink-validator-tree.json"
if "${cache_symlink_validator[@]}" \
    --output "$TMP_ROOT/cache-evidence/rejected-symlink-validator.json"; then
  echo "cache projection accepted a symlinked validator path" >&2
  exit 1
fi

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

# A preserved package closure uses only selected release assets and exact same-run
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

# A canonical source is accepted only when a completed, successful Force
# rebuild supplies the exact same-run closure. Level zero is valid for a leaf
# root; malformed or leading-zero level names are not.
python3 "$TOOL" select-source-assets \
  --source-tag binaries-abi-v42 \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --release-assets "$TMP_ROOT/preserved-release-assets.json" \
  --snapshot-out "$TMP_ROOT/canonical-snapshot.json" \
  --selected-assets-out "$TMP_ROOT/canonical-selected-assets.json"
jq -nS '{
  id:502,tag_name:"binaries-abi-v42",target_commitish:"old-anchor",
  draft:false,prerelease:false
}' >"$TMP_ROOT/canonical-release.json"
jq -nS --arg sha "$other_source_sha" '{
  ref:"refs/tags/binaries-abi-v42",
  object:{type:"commit",sha:$sha}
}' >"$TMP_ROOT/canonical-tag.json"
jq -nS --arg sha "$source_sha" '{
  id:602,run_attempt:1,event:"workflow_dispatch",
  path:".github/workflows/force-rebuild.yml",head_sha:$sha,
  status:"completed",conclusion:"success"
}' >"$TMP_ROOT/canonical-run.json"
jq -nS '[
  {
    id:702,
    name:"matrix-build-level-0 (wasm32, rootfs, 1, digest, 1)",
    status:"completed",conclusion:"success"
  }
]' >"$TMP_ROOT/canonical-jobs.json"
jq 'map(.workflow_run.id = 602)' \
  "$TMP_ROOT/preserved-run-artifacts.json" \
  >"$TMP_ROOT/canonical-run-artifacts.json"
cat >"$TMP_ROOT/canonical-root-job.log" <<'EOF'
2026-01-01T00:00:00Z same-run dependency artifacts:
2026-01-01T00:00:01Z   dep-wasm32
2026-01-01T00:00:02Z dependency artifacts to download:
2026-01-01T00:00:03Z   dep-wasm32
2026-01-01T00:00:04Z downloaded dependency artifact dep-wasm32
EOF

capture_canonical() {
  local output="$1"
  local jobs="$TMP_ROOT/canonical-jobs.json"
  local run="$TMP_ROOT/canonical-run.json"
  shift
  if [ "$#" -gt 0 ]; then jobs="$1"; shift; fi
  if [ "$#" -gt 0 ]; then run="$1"; shift; fi
  python3 "$TOOL" capture-source \
    --repository Automattic/kandelo \
    --package-source-sha "$source_sha" \
    --source-tag binaries-abi-v42 \
    --run-id 602 \
    --projection "$TMP_ROOT/projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/canonical-snapshot.json" \
    --release "$TMP_ROOT/canonical-release.json" \
    --tag-ref "$TMP_ROOT/canonical-tag.json" \
    --release-assets "$TMP_ROOT/preserved-release-assets.json" \
    --run "$run" \
    --jobs "$jobs" \
    --run-artifacts "$TMP_ROOT/canonical-run-artifacts.json" \
    --archives-dir "$TMP_ROOT/preserved-archives" \
    --run-archives-dir "$TMP_ROOT/preserved-run-archives" \
    --root-job-log "$TMP_ROOT/canonical-root-job.log" \
    "$@" \
    --capture-out "$output"
}
capture_canonical "$TMP_ROOT/canonical-capture.json"
jq -e '
  .format == "kandelo-preserved-package-source-capture-v2" and
  .source_release.tag == "binaries-abi-v42" and
  .source_run.event == "workflow_dispatch" and
  .source_run.workflow_path == ".github/workflows/force-rebuild.yml"
' "$TMP_ROOT/canonical-capture.json" >/dev/null

for bad_level in 00 01 -1 x; do
  jq --arg level "$bad_level" \
    '.[0].name = ("matrix-build-level-" + $level +
      " (wasm32, rootfs, 1, digest, 1)")' \
    "$TMP_ROOT/canonical-jobs.json" >"$TMP_ROOT/canonical-bad-jobs.json"
  if capture_canonical \
      "$TMP_ROOT/canonical-bad-level.json" \
      "$TMP_ROOT/canonical-bad-jobs.json" \
      "$TMP_ROOT/canonical-run.json"; then
    echo "canonical capture accepted malformed level $bad_level" >&2
    exit 1
  fi
done

jq '.status = "in_progress" | .conclusion = null' \
  "$TMP_ROOT/canonical-run.json" >"$TMP_ROOT/canonical-incomplete-run.json"
if capture_canonical \
    "$TMP_ROOT/canonical-incomplete-capture.json" \
    "$TMP_ROOT/canonical-jobs.json" \
    "$TMP_ROOT/canonical-incomplete-run.json"; then
  echo "canonical capture accepted an incomplete Force rebuild" >&2
  exit 1
fi

if capture_canonical \
    "$TMP_ROOT/canonical-v1-capture.json" \
    "$TMP_ROOT/canonical-jobs.json" \
    "$TMP_ROOT/canonical-run.json" \
    --capture-format kandelo-preserved-pr-source-capture-v1; then
  echo "canonical Force evidence expanded the immutable v1 PR format" >&2
  exit 1
fi

cp "$TMP_ROOT/preserved-run-archives/dep-wasm32/$dep_name" \
  "$TMP_ROOT/canonical-run-archive-before-tamper"
printf 'tamper\n' \
  >>"$TMP_ROOT/preserved-run-archives/dep-wasm32/$dep_name"
if capture_canonical "$TMP_ROOT/canonical-tampered-bytes.json"; then
  echo "canonical capture accepted changed same-run archive bytes" >&2
  exit 1
fi
mv "$TMP_ROOT/canonical-run-archive-before-tamper" \
  "$TMP_ROOT/preserved-run-archives/dep-wasm32/$dep_name"

mkdir "$TMP_ROOT/canonical-supporting"
cp "$TMP_ROOT/canonical-root-job.log" \
  "$TMP_ROOT/canonical-supporting/root-package-job.log"
canonical_preserved_tag="$(python3 "$TOOL" prepare-preserved \
  --repository Automattic/kandelo \
  --package-source-sha "$source_sha" \
  --authority-sha "$authority_sha" \
  --source-capture "$TMP_ROOT/canonical-capture.json" \
  --projection "$TMP_ROOT/projection.json" \
  --expected-ledger "$TMP_ROOT/expected.json" \
  --snapshot "$TMP_ROOT/canonical-snapshot.json" \
  --localized-index "$TMP_ROOT/preserved-local-index.toml" \
  --archives-dir "$TMP_ROOT/preserved-archives" \
  --supporting-assets-dir "$TMP_ROOT/canonical-supporting" \
  --output-dir "$TMP_ROOT/canonical-preserved-bundle")"
python3 "$TOOL" validate \
  --bundle "$TMP_ROOT/canonical-preserved-bundle" \
  --expected-tag "$canonical_preserved_tag" >/dev/null
jq -e '
  .format == "kandelo-preserved-package-generation-v2" and
  .identity.format ==
    "kandelo-preserved-package-generation-identity-v2" and
  .identity.source_capture.source_release.tag == "binaries-abi-v42" and
  .identity.admission == "none"
' "$TMP_ROOT/canonical-preserved-bundle/generation.json" >/dev/null
[ "$(jq -r .release.target_commitish \
  "$TMP_ROOT/canonical-preserved-bundle/generation.json")" = \
  "$authority_sha" ]
[ "$authority_sha" != "$source_sha" ]

cp "$TMP_ROOT/preserved-rootfs-job.log" \
  "$TMP_ROOT/preserved-supporting/rootfs-job.log"
if python3 "$TOOL" prepare-preserved \
    --repository Automattic/kandelo \
    --package-source-sha "$source_sha" \
    --authority-sha "$authority_sha" \
    --source-capture "$TMP_ROOT/preserved-capture.json" \
    --projection "$TMP_ROOT/browser-projection.json" \
    --expected-ledger "$TMP_ROOT/expected.json" \
    --snapshot "$TMP_ROOT/preserved-snapshot.json" \
    --localized-index "$TMP_ROOT/preserved-local-index.toml" \
    --archives-dir "$TMP_ROOT/preserved-archives" \
    --supporting-assets-dir "$TMP_ROOT/preserved-supporting" \
    --output-dir "$TMP_ROOT/preserved-schema2-bundle" \
    2>"$TMP_ROOT/preserved-schema2.err"; then
  echo "preserved evidence accepted a schema-2 root-set projection" >&2
  exit 1
fi
grep -Fq \
  "preserved package generations require a schema-1 projection" \
  "$TMP_ROOT/preserved-schema2.err"
if grep -Fq "Traceback" "$TMP_ROOT/preserved-schema2.err"; then
  echo "schema-2 preserved projection failed through an internal exception" >&2
  exit 1
fi
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
    --consumer-projection "$TMP_ROOT/projection.json" \
    --consumer-expected-ledger "$TMP_ROOT/expected.json"; then
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
assert_authority_validator_job \
  "$preserve_prepare_job" preservation-prepare-authority-validator \
  "preservation prepare"
assert_authority_validator_job \
  "$preserve_publish_job" preservation-publish-authority-validator \
  "preservation publish"
if grep -Fq "working-directory: package-source" <<<"$preserve_prepare_job" ||
   grep -Fq "package-source-target" <<<"$preserve_prepare_job" ||
   grep -Fq "source-xtask" <<<"$preserve_prepare_job"; then
  echo "preservation workflow executes unmerged producer tooling" >&2
  exit 1
fi
grep -Fq "working-directory: authority" <<<"$preserve_prepare_job"
grep -Fq "staging-reuse scan-source" \
  "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"
v1_capture_format="$(jq -er .format "$TMP_ROOT/preserved-capture.json")"
v2_capture_format="$(jq -er .format "$TMP_ROOT/canonical-capture.json")"
grep -Fq "  $v1_capture_format)" \
  "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"
grep -Fq "  $v2_capture_format)" \
  "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"
grep -Fq 'supporting_log_name="rootfs-job.log"' \
  "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"
grep -Fq 'supporting_log_name="root-package-job.log"' \
  "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"
if grep -Fq "staging-reuse scan-source-admitted" \
     "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"; then
  echo "preservation-only evidence unexpectedly requires publication admission" >&2
  exit 1
fi
if grep -Fq "staging-reuse expected" \
     "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh" ||
   grep -Fq "package-generation.py\" select " \
     "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"; then
  echo "preservation preparation derives producer identities through the checkout-relative reader" >&2
  exit 1
fi
if grep -Fq "reviewed 15-archive closure" \
     "$SCRIPT_DIR/prepare-preserved-pr-package-generation.sh"; then
  echo "preservation remains hard-coded to the historical rootfs closure" >&2
  exit 1
fi
grep -Fq "contents: write" <<<"$preserve_publish_job"
grep -Fq "actions: read" <<<"$preserve_publish_job"
grep -Fq -- '--expected-authority-sha "$GITHUB_SHA"' \
  <<<"$preserve_publish_job"
grep -Fq -- '--default-ref main' <<<"$preserve_publish_job"
grep -Fq "verify-preserved-package-source.sh" \
  "$SCRIPT_DIR/publish-durable-package-generation.sh"
grep -Fq "publish-durable-package-generation.sh" <<<"$preserve_publish_job"
stable_bundle_name='name: preserved-package-generation-${{ github.run_id }}'
[ "$(grep -Fxc "          $stable_bundle_name" "$preservation_workflow")" = 2 ] || {
  echo "preservation producer and consumer do not share one rerun-stable bundle name" >&2
  exit 1
}
if grep -F \
     'name: preserved-package-generation-${{ github.run_id }}-${{ github.run_attempt }}' \
     "$preservation_workflow" >/dev/null; then
  echo "preservation bundle is incorrectly coupled to the current rerun attempt" >&2
  exit 1
fi
grep -Fq "          overwrite: true" <<<"$preserve_prepare_job"

echo "test-package-generation: ok"
