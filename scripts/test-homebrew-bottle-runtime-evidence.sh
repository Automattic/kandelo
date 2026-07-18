#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "test-homebrew-bottle-runtime-evidence.sh: $*" >&2
  exit 1
}

expect_capture_rejection() {
  local label="$1"
  shift
  if python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" capture \
    "${capture_args[@]}" "$@" --out "$TMPDIR/rejected.json" >/dev/null 2>&1; then
    fail "accepted $label"
  fi
}

expect_capture_error() {
  local label="$1" pattern="$2" err="$TMPDIR/rejected.err"
  if python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" capture \
    "${capture_args[@]}" --out "$TMPDIR/rejected.json" >/dev/null 2>"$err"; then
    fail "accepted $label"
  fi
  grep -F "$pattern" "$err" >/dev/null ||
    fail "$label did not report $pattern"
}

tap="$TMPDIR/tap"
formula="hello"
version="1.0"
arch="wasm32"
abi=39
tap_repository="kandelo-dev/homebrew-tap-core"
tap_name="kandelo-dev/tap-core"
tap_commit=""
bottle_root="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
bottle="$TMPDIR/hello--1.0.wasm32_kandelo.bottle.tar.gz"
bottle_json="$TMPDIR/bottle.json"
formula_info="$TMPDIR/formula-info.json"
target_prefix="$TMPDIR/prefix/Cellar/hello/1.0"
target_receipt="$target_prefix/INSTALL_RECEIPT.json"
install_log="$TMPDIR/install.log"
node_receipt="$TMPDIR/node-receipt.json"
dependency_provenance="$TMPDIR/dependency-provenance.json"
selection_receipt="$TMPDIR/selection-receipt.json"
evidence="$TMPDIR/runtime-evidence.json"

mkdir -p "$tap/Formula" "$target_prefix"
cat >"$tap/Formula/hello.rb" <<'EOF'
class Hello < Formula
  desc "fixture"
  url "https://example.invalid/hello-1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "PLACEHOLDER"
  end
end
EOF
printf 'exact bottle fixture\n' >"$bottle"
bottle_sha="$(sha256sum "$bottle" | awk '{print $1}')"
bottle_bytes="$(wc -c <"$bottle" | tr -d '[:space:]')"
bottle_url="$bottle_root/hello/blobs/sha256:$bottle_sha"
sed -i "s/PLACEHOLDER/$bottle_sha/" "$tap/Formula/hello.rb"
git -C "$tap" init -q
git -C "$tap" config user.name fixture
git -C "$tap" config user.email fixture@example.invalid
git -C "$tap" add Formula/hello.rb
git -C "$tap" commit -q -m fixture
tap_commit="$(git -C "$tap" rev-parse HEAD)"
formula_sha="$(sha256sum "$tap/Formula/hello.rb" | awk '{print $1}')"

jq -nS --arg sha "$bottle_sha" '{hello: {
  formula: {name: "hello", path: "Library/Taps/kandelo-dev/homebrew-tap-core/Formula/hello.rb", pkg_version: "1.0"},
  bottle: {root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core", cellar: "any_skip_relocation", rebuild: 0,
    tags: {wasm32_kandelo: {sha256: $sha}}}
}}' >"$bottle_json"
jq -nS --arg sha "$bottle_sha" --arg url "$bottle_url" --arg formula_sha "$formula_sha" '{
  formulae: [{name: "hello", full_name: "kandelo-dev/tap-core/hello",
    versions: {stable: "1.0", head: null, bottle: true}, revision: 0,
    ruby_source_checksum: {sha256: $formula_sha},
    bottle: {stable: {rebuild: 0, files: {wasm32_kandelo: {
      cellar: "any_skip_relocation", sha256: $sha, url: $url
    }}}}}], casks: []
}' >"$formula_info"
jq -nS --arg tap_commit "$tap_commit" '{
  homebrew_version: "Homebrew fixture", built_as_bottle: true,
  poured_from_bottle: true, installed_on_request: true,
  source: {tap: "kandelo-dev/tap-core", tap_git_head: $tap_commit, spec: "stable"},
  runtime_dependencies: []
}' >"$target_receipt"
cat >"$install_log" <<EOF
==> Downloading $bottle_url
==> Pouring hello--1.0.wasm32_kandelo.bottle.tar.gz
EOF
jq -nS --argjson abi "$abi" '{schema: 1, formula: "hello", arch: "wasm32",
  kandelo_abi: $abi, runtime: "node", launcher: "kandelo_run_wasm",
  argv: ["/tmp/hello.wasm", "--version"], status: "success"
}' >"$node_receipt"
jq -nS --arg tap_commit "$tap_commit" '{
  schema: 2, formula: "hello", arch: "wasm32",
  tap_repository: "kandelo-dev/homebrew-tap-core", tap_name: "kandelo-dev/tap-core",
  tap_commit: $tap_commit,
  bottle_root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
  bottle_tag: "wasm32_kandelo", dependencies: []
}' >"$dependency_provenance"
jq -nS --arg sha "$bottle_sha" --arg url "$bottle_url" --argjson bytes "$bottle_bytes" '{
  schema: 1, status: "success", bottle: {
    mode: "anonymous-public-readback", url: $url, sha256: $sha, bytes: $bytes
  }, fetch: [("anonymously downloaded " + $url + " with sha256:" + $sha)]
}' >"$selection_receipt"

capture_args=(
  --formula "$formula"
  --arch "$arch"
  --abi "$abi"
  --tap-repository "$tap_repository"
  --tap-commit "$tap_commit"
  --tap-root "$tap"
  --bottle-root-url "$bottle_root"
  --bottle-json "$bottle_json"
  --bottle-url "$bottle_url"
  --bottle-sha256 "$bottle_sha"
  --bottle-bytes "$bottle_bytes"
  --dependency-provenance "$dependency_provenance"
  --selection-receipt "$selection_receipt"
  --target-prefix "$target_prefix"
  --target-receipt "$target_receipt"
  --formula-info "$formula_info"
  --install-log "$install_log"
  --node-receipt "$node_receipt"
  --installed-bottle "$bottle"
)
validate_args=(
  --formula "$formula"
  --arch "$arch"
  --abi "$abi"
  --tap-repository "$tap_repository"
  --tap-name "$tap_name"
  --tap-commit "$tap_commit"
  --tap-root "$tap"
  --bottle-root-url "$bottle_root"
  --bottle-json "$bottle_json"
  --bottle-url "$bottle_url"
  --bottle-sha256 "$bottle_sha"
  --bottle-bytes "$bottle_bytes"
  --dependency-provenance "$dependency_provenance"
)

python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" capture \
  "${capture_args[@]}" --out "$evidence"
python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" validate \
  --input "$evidence" "${validate_args[@]}"

jq -e --arg sha "$bottle_sha" --arg url "$bottle_url" --arg tap_name "$tap_name" '
  .schema == 2 and .tap.name == $tap_name and
  .bottle.sha256 == $sha and .bottle.url == $url and
  .selection.bottle.mode == "anonymous-public-readback" and
  .target.receipt.built_as_bottle == true and
  .target.receipt.poured_from_bottle == true and
  .target.install_log.source_build_absent == true and
  (.target.install_log.fetch | length) == 1 and
  (.target.install_log.pour | length) == 1 and
  .node.runtime == "node" and .node.status == "success"
' "$evidence" >/dev/null || fail "valid evidence omitted an exact-bottle runtime fact"

cp "$bottle_json" "$bottle_json.rebuild0"
cp "$formula_info" "$formula_info.rebuild0"
cp "$install_log" "$install_log.rebuild0"
jq '.hello.bottle.rebuild = 1' "$bottle_json" >"$bottle_json.next"
mv "$bottle_json.next" "$bottle_json"
jq '.formulae[0].bottle.stable.rebuild = 1' "$formula_info" >"$formula_info.next"
mv "$formula_info.next" "$formula_info"
cat >"$install_log" <<EOF
==> Downloading $bottle_url
==> Pouring hello--1.0.wasm32_kandelo.bottle.1.tar.gz
EOF
rebuild_evidence="$TMPDIR/runtime-evidence-rebuild1.json"
python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" capture \
  "${capture_args[@]}" --out "$rebuild_evidence"
python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" validate \
  --input "$rebuild_evidence" "${validate_args[@]}"

cp "$install_log" "$install_log.rebuild1"
for wrong_pour in \
  'hello--1.0.wasm32_kandelo.bottle.tar.gz' \
  'hello--1.0.wasm32_kandelo.bottle.2.tar.gz' \
  'hello--1.0.wasm32_kandelo.bottle.1.tar.gz.extra' \
  'other--1.0.wasm32_kandelo.bottle.1.tar.gz' \
  'hello--2.0.wasm32_kandelo.bottle.1.tar.gz'; do
  cat >"$install_log" <<EOF
==> Downloading $bottle_url
==> Pouring $wrong_pour
EOF
  expect_capture_rejection "non-canonical rebuild pour $wrong_pour"
done
mv "$install_log.rebuild1" "$install_log"

jq '.target.install_log.pour = ["==> Pouring hello--1.0.wasm32_kandelo.bottle.2.tar.gz"]' \
  "$rebuild_evidence" >"$TMPDIR/rebuild-evidence-wrong-pour.json"
if python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" validate \
  --input "$TMPDIR/rebuild-evidence-wrong-pour.json" "${validate_args[@]}" \
  >/dev/null 2>&1; then
  fail "validator accepted a runtime-evidence pour for the wrong bottle rebuild"
fi

cp "$formula_info" "$formula_info.rebuild1"
jq '.formulae[0].bottle.stable.rebuild = 2' "$formula_info" >"$formula_info.next"
mv "$formula_info.next" "$formula_info"
expect_capture_rejection "Homebrew Formula info for a different bottle rebuild"
mv "$formula_info.rebuild1" "$formula_info"

for invalid_rebuild in 'true' '-1' '1.5'; do
  cp "$bottle_json" "$bottle_json.valid"
  jq --argjson rebuild "$invalid_rebuild" '.hello.bottle.rebuild = $rebuild' \
    "$bottle_json.valid" >"$bottle_json"
  expect_capture_error "invalid canonical bottle rebuild $invalid_rebuild" \
    "canonical bottle rebuild must be a non-negative integer"
  mv "$bottle_json.valid" "$bottle_json"
done

mv "$bottle_json.rebuild0" "$bottle_json"
mv "$formula_info.rebuild0" "$formula_info"
mv "$install_log.rebuild0" "$install_log"

mv "$node_receipt" "$node_receipt.missing"
expect_capture_rejection "missing Node evidence"
mv "$node_receipt.missing" "$node_receipt"

cp "$install_log" "$install_log.good"
printf '%s\n' '==> Building hello from source' >>"$install_log"
expect_capture_rejection "target source fallback"
mv "$install_log.good" "$install_log"

cp "$target_receipt" "$target_receipt.good"
jq '.poured_from_bottle = false' "$target_receipt" >"$target_receipt.bad"
mv "$target_receipt.bad" "$target_receipt"
expect_capture_rejection "forged poured_from_bottle receipt"
mv "$target_receipt.good" "$target_receipt"

cp "$formula_info" "$formula_info.good"
jq '.formulae[0].ruby_source_checksum.sha256 = ("f" * 64)' "$formula_info" >"$formula_info.bad"
mv "$formula_info.bad" "$formula_info"
expect_capture_rejection "forged Formula source digest"
mv "$formula_info.good" "$formula_info"

cp "$formula_info" "$formula_info.good"
jq '.formulae[0].versions.stable = "2.0"' "$formula_info" >"$formula_info.bad"
mv "$formula_info.bad" "$formula_info"
expect_capture_rejection "wrong Formula version"
mv "$formula_info.good" "$formula_info"

cp "$selection_receipt" "$selection_receipt.good"
jq '.bottle.sha256 = ("e" * 64)' "$selection_receipt" >"$selection_receipt.bad"
mv "$selection_receipt.bad" "$selection_receipt"
expect_capture_rejection "forged public readback digest"
mv "$selection_receipt.good" "$selection_receipt"

cp "$node_receipt" "$node_receipt.good"
jq '.kandelo_abi += 1' "$node_receipt" >"$node_receipt.bad"
mv "$node_receipt.bad" "$node_receipt"
expect_capture_rejection "wrong Node ABI"
mv "$node_receipt.good" "$node_receipt"

cp "$node_receipt" "$node_receipt.good"
jq '.argv = [1]' "$node_receipt" >"$node_receipt.bad"
mv "$node_receipt.bad" "$node_receipt"
expect_capture_rejection "non-string Node argv"
mv "$node_receipt.good" "$node_receipt"

cp "$target_receipt" "$target_receipt.good"
jq '.source.tap_git_head = ("b" * 40)' "$target_receipt" >"$target_receipt.bad"
mv "$target_receipt.bad" "$target_receipt"
expect_capture_rejection "wrong target tap commit"
mv "$target_receipt.good" "$target_receipt"

jq '.unexpected = true' "$evidence" >"$TMPDIR/extra.json"
if python3 "$REPO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" validate \
  --input "$TMPDIR/extra.json" "${validate_args[@]}" >/dev/null 2>&1; then
  fail "validator accepted an extra runtime-evidence field"
fi

echo "test-homebrew-bottle-runtime-evidence.sh: ok"
