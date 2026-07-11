#!/usr/bin/env bash
# Focused checks for the trusted Homebrew publish workflow helper scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "test-homebrew-publish-workflow.sh: $*" >&2
  exit 1
}

make_tap() {
  local tap="$1"
  mkdir -p "$tap/Formula" "$tap/Kandelo"
  cat >"$tap/Formula/hello.rb" <<'EOF'
class Hello < Formula
end
EOF
  cat >"$tap/Kandelo/metadata.json" <<'EOF'
{"last":"green"}
EOF
  git -C "$tap" init -q
  git -C "$tap" config user.name "Kandelo Test"
  git -C "$tap" config user.email "kandelo-test@example.invalid"
  git -C "$tap" add .
  git -C "$tap" commit -q -m "initial tap"
}

assert_matrix() {
  local tap="$TMPDIR/matrix-tap"
  make_tap "$tap"
  local matrix
  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32")"
  printf '%s\n' "$matrix" | jq -e '
    length == 2 and
    .[0] == {"formula":"hello","arch":"wasm32"} and
    .[1] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "unexpected matrix: $matrix"
}

assert_matrix_skips_unchanged_cache_key() {
  local tap="$TMPDIR/matrix-skip-tap"
  local expected="$TMPDIR/expected-cache-keys.json"
  make_tap "$tap"
  cat >"$tap/Kandelo/metadata.json" <<'EOF'
{
  "packages": [
    {
      "name": "hello",
      "bottles": [
        {
          "arch": "wasm32",
          "status": "success",
          "cache_key_sha": "cache-key-current"
        },
        {
          "arch": "wasm64",
          "status": "success",
          "cache_key_sha": "cache-key-old"
        }
      ]
    }
  ]
}
EOF
  cat >"$expected" <<'EOF'
{
  "hello": {
    "wasm32": "cache-key-current",
    "wasm64": "cache-key-new"
  }
}
EOF
  local matrix
  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32" \
    --expected-cache-keys "$expected")"
  printf '%s\n' "$matrix" | jq -e '
    length == 1 and
    .[0] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "expected unchanged wasm32 entry to be skipped: $matrix"

  matrix="$(bash "$REPO_ROOT/scripts/homebrew-plan-matrix.sh" \
    --tap-root "$tap" \
    --formulae "hello" \
    --arches "wasm64,wasm32" \
    --expected-cache-keys "$expected" \
    --force)"
  printf '%s\n' "$matrix" | jq -e '
    length == 2 and
    .[0] == {"formula":"hello","arch":"wasm32"} and
    .[1] == {"formula":"hello","arch":"wasm64"}
  ' >/dev/null || fail "expected force to include unchanged cache keys: $matrix"
}

assert_upload_dry_run() {
  local bottle="$TMPDIR/hello.bottle.tar.gz"
  local out="$TMPDIR/upload.env"
  printf 'bottle-bytes' >"$bottle"
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --bottle "$bottle" \
    --out-env "$out" \
    --dry-run >/dev/null
  # shellcheck disable=SC1090
  . "$out"
  [ "${BOTTLE_BYTES:-}" = "12" ] || fail "unexpected bottle byte count"
  case "${BOTTLE_URL:-}" in
    https://ghcr.io/v2/automattic/kandelo-homebrew/hello/blobs/sha256:*) ;;
    *) fail "unexpected bottle URL: ${BOTTLE_URL:-}" ;;
  esac
}

assert_upload_push_uses_relative_layer_path() {
  local bottle="$TMPDIR/hello.bottle.tar.gz"
  local out="$TMPDIR/upload.env"
  local bin="$TMPDIR/bin"
  local log="$TMPDIR/oras.log"
  local oras_configs oras_config
  printf 'bottle-bytes' >"$bottle"
  mkdir -p "$bin"
  cat >"$bin/oras" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$ORAS_LOG"
case "${1:-}" in
  login) cat >/dev/null ;;
  push) ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$bin/oras"
  ORAS_LOG="$log" GH_TOKEN="test-token" GITHUB_ACTOR="test-actor" \
    GITHUB_SHA="cccccccccccccccccccccccccccccccccccccccc" PATH="$bin:$PATH" \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
      --tap-repository Automattic/kandelo-homebrew \
      --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --bottle "$bottle" \
      --out-env "$out" >/dev/null
  grep -F "push --registry-config " "$log" >/dev/null ||
    fail "oras push did not use isolated registry configuration"
  grep -F "ghcr.io/automattic/kandelo-homebrew/hello:bottles-abi-v15-wasm32-" "$log" >/dev/null ||
    fail "oras push was not invoked for the expected image"
  grep -F "hello.bottle.tar.gz:application/vnd.homebrew.bottle.layer.v1+gzip" "$log" >/dev/null ||
    fail "oras push did not use relative bottle layer path"
  ! grep -F "$bottle:application/vnd.homebrew.bottle.layer.v1+gzip" "$log" >/dev/null ||
    fail "oras push used an absolute bottle layer path"
  grep -F "org.opencontainers.image.revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$log" >/dev/null ||
    fail "oras push did not record the planned tap commit"
  grep -F "dev.kandelo.homebrew.kandelo_commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$log" >/dev/null ||
    fail "oras push did not record the planned Kandelo commit"
  ! grep -F "cccccccccccccccccccccccccccccccccccccccc" "$log" >/dev/null ||
    fail "oras push leaked the caller-context commit into provenance"
  oras_configs="$(sed -nE 's/.*--registry-config ([^ ]+).*/\1/p' "$log")"
  [ "$(printf '%s\n' "$oras_configs" | sed '/^$/d' | wc -l | tr -d '[:space:]')" = "2" ] ||
    fail "oras login and push did not both use isolated registry auth"
  [ "$(printf '%s\n' "$oras_configs" | sort -u | wc -l | tr -d '[:space:]')" = "1" ] ||
    fail "oras login and push used different registry auth files"
  oras_config="$(printf '%s\n' "$oras_configs" | head -n1)"
  [ ! -e "$oras_config" ] || fail "oras registry auth survived the upload command"
}

assert_generator_rejects_mismatched_homebrew_commit() {
  local brew_repo="$TMPDIR/generator-brew-repo"
  local brew_bin="$TMPDIR/generator-bin/brew"
  local sidecars="$TMPDIR/generator-sidecars"
  local err="$TMPDIR/generator-brew-commit.err"
  local abi

  mkdir -p "$brew_repo" "$(dirname "$brew_bin")"
  git -C "$brew_repo" init -q
  git -C "$brew_repo" config user.name "Kandelo Test"
  git -C "$brew_repo" config user.email "kandelo-test@example.invalid"
  printf 'reviewed brew\n' >"$brew_repo/README.md"
  git -C "$brew_repo" add README.md
  git -C "$brew_repo" commit -q -m "reviewed brew"
  cat >"$brew_bin" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  --repository) printf '%s\n' '$brew_repo' ;;
  --version) printf '%s\n' 'Homebrew test' ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$brew_bin"
  abi="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
    "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"

  if HOMEBREW_BREW_FILE="$brew_bin" \
    HOMEBREW_BREW_COMMIT="0000000000000000000000000000000000000000" \
    KANDELO_HOMEBREW_TAP_ROOT="$brew_repo" \
    KANDELO_HOMEBREW_SIDECAR_ROOT="$sidecars" \
    KANDELO_HOMEBREW_FORMULA="hello" \
    KANDELO_HOMEBREW_ARCH="wasm32" \
    KANDELO_HOMEBREW_RELEASE_TAG="bottles-abi-v${abi}" \
    KANDELO_HOMEBREW_TAP_REPOSITORY="Automattic/kandelo-homebrew" \
    KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$TMPDIR/missing-bottle.tar.gz" \
    KANDELO_HOMEBREW_BOTTLE_JSON="$TMPDIR/missing-bottle.json" \
    KANDELO_HOMEBREW_BOTTLE_URL="https://ghcr.io/v2/automattic/kandelo-homebrew/hello/blobs/sha256:0000000000000000000000000000000000000000000000000000000000000000" \
    KANDELO_HOMEBREW_BOTTLE_SHA256="0000000000000000000000000000000000000000000000000000000000000000" \
    KANDELO_HOMEBREW_BOTTLE_BYTES="1" \
    bash "$REPO_ROOT/scripts/homebrew-generate-sidecars-from-env.sh" \
      >/dev/null 2>"$err"; then
    fail "sidecar generator accepted a Homebrew checkout that differed from the reviewed commit"
  fi
  grep -q "active Homebrew checkout differs" "$err" ||
    fail "sidecar generator did not explain the Homebrew commit mismatch"
  grep -F -- "--keep HOMEBREW_BREW_COMMIT" "$REPO_ROOT/scripts/dev-shell.sh" >/dev/null ||
    fail "dev shell does not preserve the reviewed Homebrew commit"
}

make_build_handoff() {
  local handoff="$1"
  local source_dir="${handoff}.source"
  local bottle="$source_dir/hello--2.12.1.wasm32_kandelo.bottle.tar.gz"
  local bottle_json="$source_dir/hello--2.12.1.wasm32_kandelo.bottle.json"
  local sha256

  mkdir -p "$source_dir"
  printf 'trusted bottle bytes\n' | gzip -n >"$bottle"
  sha256="$(sha256sum "$bottle" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$bottle" | awk '{print $1}')"
  jq -n --arg sha256 "$sha256" '{
    "automattic/kandelo-homebrew/hello": {
      formula: {
        name: "hello",
        path: "Library/Taps/automattic/homebrew-kandelo-homebrew/Formula/hello.rb",
        pkg_version: "2.12.1",
        desc: "this artifact-only field must not reach Homebrew merge"
      },
      bottle: {
        root_url: "https://ghcr.io/v2/automattic/kandelo-homebrew",
        cellar: "any_skip_relocation",
        rebuild: 0,
        tags: {
          wasm32_kandelo: {
            local_filename: "hello--2.12.1.wasm32_kandelo.bottle.tar.gz",
            sha256: $sha256
          }
        }
      }
    }
  }' >"$bottle_json"

  bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --bottle "$bottle" \
    --bottle-json "$bottle_json" \
    --out "$handoff" >/dev/null
}

validate_build_handoff() {
  local handoff="$1"
  shift
  bash "$REPO_ROOT/scripts/homebrew-validate-build-handoff.sh" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    "$@"
}

assert_build_handoff_is_minimal_and_validated() {
  local handoff="$TMPDIR/build-handoff-valid"
  local out_env="$TMPDIR/build-handoff-valid.env"
  local rawless_env="$TMPDIR/build-handoff-valid-rawless.env"
  local canonical_json="$TMPDIR/build-handoff-valid.bottle.json"
  local files
  make_build_handoff "$handoff"
  validate_build_handoff "$handoff" --out-env "$rawless_env" >/dev/null
  ! grep -q '^BOTTLE_JSON=' "$rawless_env" ||
    fail "validated handoff env exposed raw artifact bottle JSON without reconstruction"
  validate_build_handoff "$handoff" \
    --out-env "$out_env" \
    --out-bottle-json "$canonical_json" >/dev/null

  files="$(find "$handoff" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort)"
  [ "$files" = $'bottle.json\nbottle.tar.gz\nmanifest.json' ] ||
    fail "build handoff contains files outside its minimal data contract: $files"
  [ ! -e "$handoff/Formula" ] || fail "build handoff included formula source"
  [ ! -e "$handoff/build.env" ] || fail "build handoff included executable environment data"
  (
    # shellcheck disable=SC1090
    . "$out_env"
    [ "$FORMULA" = "hello" ] || fail "validated handoff env has the wrong formula"
    [ "$ARCH" = "wasm32" ] || fail "validated handoff env has the wrong arch"
    [ "$TAP_REPOSITORY" = "Automattic/kandelo-homebrew" ] ||
      fail "validated handoff env has the wrong tap repository"
    [ "$BOTTLE_JSON" -ef "$canonical_json" ] ||
      fail "validated handoff env exposed raw artifact bottle JSON"
    [ "$BOTTLE_SHA256" = "$(sha256sum "$BOTTLE_ARCHIVE" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$BOTTLE_ARCHIVE" | awk '{print $1}')" ] ||
      fail "validated handoff env has the wrong archive SHA-256"
    [ "$BOTTLE_BYTES" = "$(wc -c <"$BOTTLE_ARCHIVE" | tr -d '[:space:]')" ] ||
      fail "validated handoff env has the wrong archive byte count"
    [ "$BOTTLE_RELOCATION_CELLAR" = "any_skip_relocation" ] ||
      fail "validated handoff env lost the Homebrew relocation cellar"
  )
  jq -e --arg sha256 "$(jq -r '.bottle.sha256' "$handoff/manifest.json")" '
    keys == ["hello"] and
    (.hello | keys == ["bottle", "formula"]) and
    (.hello.formula | keys == ["name", "path", "pkg_version"]) and
    .hello.formula == {
      name: "hello",
      path: "Library/Taps/automattic/homebrew-kandelo-homebrew/Formula/hello.rb",
      pkg_version: "2.12.1"
    } and
    (.hello.bottle | keys == ["cellar", "rebuild", "root_url", "tags"]) and
    .hello.bottle.root_url == "https://ghcr.io/v2/automattic/kandelo-homebrew" and
    .hello.bottle.cellar == "any_skip_relocation" and
    .hello.bottle.rebuild == 0 and
    (.hello.bottle.tags | keys == ["wasm32_kandelo"]) and
    .hello.bottle.tags.wasm32_kandelo == {
      sha256: $sha256
    }
  ' "$canonical_json" >/dev/null ||
    fail "validator did not reconstruct the exact minimal Homebrew merge JSON"
  ! grep -q "artifact-only" "$canonical_json" ||
    fail "canonical bottle JSON copied untrusted artifact-only fields"
}

assert_build_handoff_rejects_untrusted_content() {
  local handoff err tmp zstd_bottle zstd_out invalid_gzip invalid_json invalid_out invalid_sha canonical_json

  handoff="$TMPDIR/build-handoff-zstd-seed"
  make_build_handoff "$handoff"
  zstd_bottle="$TMPDIR/hello--2.12.1.wasm32_kandelo.bottle.tar.zst"
  zstd_out="$TMPDIR/build-handoff-zstd"
  cp "$handoff/bottle.tar.gz" "$zstd_bottle"
  if bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --bottle "$zstd_bottle" \
    --bottle-json "${handoff}.source/hello--2.12.1.wasm32_kandelo.bottle.json" \
    --out "$zstd_out" >/dev/null 2>&1; then
    fail "build handoff creator accepted a zstd bottle for the gzip-only publisher"
  fi

  invalid_gzip="$TMPDIR/hello--2.12.1.wasm32_kandelo.bottle.tar.gz"
  invalid_json="$TMPDIR/invalid-gzip.bottle.json"
  invalid_out="$TMPDIR/build-handoff-invalid-gzip"
  printf 'not gzip bytes\n' >"$invalid_gzip"
  invalid_sha="$(sha256sum "$invalid_gzip" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$invalid_gzip" | awk '{print $1}')"
  jq --arg sha256 "$invalid_sha" \
    '.[].bottle.tags.wasm32_kandelo.sha256 = $sha256' \
    "${handoff}.source/hello--2.12.1.wasm32_kandelo.bottle.json" >"$invalid_json"
  if bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --bottle "$invalid_gzip" \
    --bottle-json "$invalid_json" \
    --out "$invalid_out" >/dev/null 2>&1; then
    fail "build handoff creator accepted non-gzip bytes under a gzip filename"
  fi

  handoff="$TMPDIR/build-handoff-extra"
  make_build_handoff "$handoff"
  printf 'FORMULA=untrusted\n' >"$handoff/build.env"
  err="$TMPDIR/build-handoff-extra.err"
  if validate_build_handoff "$handoff" > /dev/null 2>"$err"; then
    fail "build handoff validator accepted an extra environment file"
  fi
  grep -q "exactly three files" "$err" ||
    fail "build handoff validator did not explain the extra file"

  handoff="$TMPDIR/build-handoff-symlink"
  make_build_handoff "$handoff"
  rm "$handoff/bottle.json"
  ln -s manifest.json "$handoff/bottle.json"
  err="$TMPDIR/build-handoff-symlink.err"
  if validate_build_handoff "$handoff" > /dev/null 2>"$err"; then
    fail "build handoff validator accepted a symlinked bottle JSON"
  fi
  grep -q "non-symlink" "$err" ||
    fail "build handoff validator did not explain the symlink"

  handoff="$TMPDIR/build-handoff-identity"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-identity.json"
  jq '.tap_commit = "cccccccccccccccccccccccccccccccccccccccc"' \
    "$handoff/manifest.json" >"$tmp"
  mv "$tmp" "$handoff/manifest.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a manifest from a different tap commit"
  fi

  handoff="$TMPDIR/build-handoff-archive-tamper"
  make_build_handoff "$handoff"
  printf 'tampered\n' >>"$handoff/bottle.tar.gz"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted modified bottle bytes"
  fi

  handoff="$TMPDIR/build-handoff-json-sha"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-json-sha.json"
  jq '.[].bottle.tags.wasm32_kandelo.sha256 =
      "0000000000000000000000000000000000000000000000000000000000000000"' \
    "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a bottle JSON SHA that differs from the archive"
  fi

  handoff="$TMPDIR/build-handoff-formula-path"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-formula-path.json"
  jq '.[].formula.path = "Formula/hello.rb"' "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a non-canonical tap formula path"
  fi

  handoff="$TMPDIR/build-handoff-version-control"
  make_build_handoff "$handoff"
  tmp="$TMPDIR/build-handoff-version-control.json"
  canonical_json="$TMPDIR/build-handoff-version-control.canonical.json"
  jq '.[].formula.pkg_version = "\u0000oops"' "$handoff/bottle.json" >"$tmp"
  mv "$tmp" "$handoff/bottle.json"
  if validate_build_handoff "$handoff" --out-bottle-json "$canonical_json" >/dev/null 2>&1; then
    fail "build handoff validator accepted a control character in pkg_version"
  fi
  [ ! -e "$canonical_json" ] ||
    fail "build handoff validator emitted canonical JSON for an invalid pkg_version"

  handoff="$TMPDIR/build-handoff-large-manifest"
  make_build_handoff "$handoff"
  head -c 65537 /dev/zero | tr '\0' ' ' >>"$handoff/manifest.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a manifest larger than 64 KiB"
  fi

  handoff="$TMPDIR/build-handoff-large-json"
  make_build_handoff "$handoff"
  head -c 1048577 /dev/zero | tr '\0' ' ' >>"$handoff/bottle.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted bottle JSON larger than 1 MiB"
  fi

  handoff="$TMPDIR/build-handoff-large-bottle"
  make_build_handoff "$handoff"
  truncate -s 536870913 "$handoff/bottle.tar.gz"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a compressed bottle larger than 512 MiB"
  fi
}

assert_upload_receipt_is_bound_to_build_handoff() {
  local handoff="$TMPDIR/upload-receipt-handoff"
  local receipt="$TMPDIR/upload-receipt.json"
  local out_env="$TMPDIR/upload-receipt.env"
  local canonical_json="$TMPDIR/upload-receipt.bottle.json"
  local colliding_output="$TMPDIR/upload-receipt-collision.out"
  local bad_receipt="$TMPDIR/upload-receipt-bad.json"
  make_build_handoff "$handoff"

  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --bottle "$handoff/bottle.tar.gz" \
    --out-json "$receipt" \
    --dry-run >/dev/null

  bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --out-env "$out_env" \
    --out-bottle-json "$canonical_json" >/dev/null
  (
    # shellcheck disable=SC1090
    . "$out_env"
    [ "$BOTTLE_URL" = "https://ghcr.io/v2/automattic/kandelo-homebrew/hello/blobs/sha256:${BOTTLE_SHA256}" ] ||
      fail "validated receipt env has the wrong bottle URL"
    [ "$BOTTLE_JSON" -ef "$canonical_json" ] ||
      fail "validated receipt env exposed raw artifact bottle JSON"
  )

  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --out-env "$colliding_output" \
    --out-bottle-json "$colliding_output" >/dev/null 2>&1; then
    fail "upload receipt validator accepted colliding output paths"
  fi
  [ ! -e "$colliding_output" ] ||
    fail "upload receipt validator wrote a colliding output before rejecting it"

  jq '.unexpected = true' "$receipt" >"$bad_receipt"
  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$bad_receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew >/dev/null 2>&1; then
    fail "upload receipt validator accepted an undeclared field"
  fi

  jq '.bottle.bytes += 1' "$receipt" >"$bad_receipt"
  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$bad_receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew >/dev/null 2>&1; then
    fail "upload receipt validator accepted a byte count not backed by the build handoff"
  fi

  cp "$receipt" "$bad_receipt"
  head -c 65537 /dev/zero | tr '\0' ' ' >>"$bad_receipt"
  if bash "$REPO_ROOT/scripts/homebrew-validate-upload-receipt.sh" \
    --receipt "$bad_receipt" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew >/dev/null 2>&1; then
    fail "upload receipt validator accepted a receipt larger than 64 KiB"
  fi
}

make_publish_handoff() {
  local handoff="$1" tap_root="$2"
  local build_stage="${handoff}.build"
  local bottle_sha bottle_bytes bottle_url formula_sha link_name provenance_name

  make_build_handoff "$build_stage"
  mkdir -p "$handoff"
  mv "$build_stage" "$handoff/build"
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --bottle "$handoff/build/bottle.tar.gz" \
    --out-json "$handoff/receipt.json" \
    --dry-run >/dev/null

  bottle_sha="$(jq -r '.bottle.sha256' "$handoff/receipt.json")"
  bottle_bytes="$(jq -r '.bottle.bytes' "$handoff/receipt.json")"
  bottle_url="$(jq -r '.bottle.url' "$handoff/receipt.json")"
  link_name="hello-2.12.1-rebuild0-wasm32.json"
  provenance_name="hello-2.12.1-rebuild0-wasm32.provenance.json"

  mkdir -p "$tap_root/Formula"
  cat >"$tap_root/Formula/hello.rb" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
end
EOF

  mkdir -p \
    "$handoff/sidecars/Formula" \
    "$handoff/sidecars/Kandelo/formula" \
    "$handoff/sidecars/Kandelo/link" \
    "$handoff/sidecars/Kandelo/reports"
  cat >"$handoff/sidecars/Formula/hello.rb" <<EOF
class Hello < Formula
  desc "reviewed fixture"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "$bottle_sha"
  end
end
EOF
  formula_sha="$(sha256sum "$handoff/sidecars/Formula/hello.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$handoff/sidecars/Formula/hello.rb" | awk '{print $1}')"

  jq -n \
    --arg sha "$bottle_sha" --arg bytes "$bottle_bytes" --arg url "$bottle_url" \
    --arg formula_sha "$formula_sha" --arg link "Kandelo/link/$link_name" '{
      schema: 1,
      tap_repository: "Automattic/kandelo-homebrew",
      tap_name: "automattic/kandelo-homebrew",
      tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kandelo_abi: 18,
      source_metadata: "Kandelo/metadata.json",
      name: "hello",
      full_name: "automattic/kandelo-homebrew/hello",
      version: "2.12.1",
      formula_revision: 0,
      bottle_rebuild: 0,
      formula_path: "Formula/hello.rb",
      dependencies: [],
      bottles: [{
        arch: "wasm32",
        bottle_tag: "wasm32_kandelo",
        kandelo_abi: 18,
        cellar: "/home/linuxbrew/.linuxbrew/Cellar",
        prefix: "/home/linuxbrew/.linuxbrew",
        url: $url,
        sha256: $sha,
        bytes: ($bytes | tonumber),
        cache_key_sha: $sha,
        link_manifest: $link,
        runtime_support: ["node"],
        browser_compatible: false,
        fork_instrumentation: "not-required",
        status: "success",
        built_from: {
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          tap_repository: "Automattic/kandelo-homebrew",
          tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          formula_sha256: $formula_sha
        }
      }]
    }' >"$handoff/sidecars/Kandelo/formula/hello.json"

  jq -n \
    --arg sha "$bottle_sha" --arg bytes "$bottle_bytes" --arg url "$bottle_url" \
    --arg formula_sha "$formula_sha" --arg link "Kandelo/link/$link_name" '{
      schema: 1,
      tap_repository: "Automattic/kandelo-homebrew",
      tap_name: "automattic/kandelo-homebrew",
      tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      kandelo_abi: 18,
      release_tag: "bottles-abi-v18",
      packages: [{
        name: "hello",
        full_name: "automattic/kandelo-homebrew/hello",
        version: "2.12.1",
        formula_revision: 0,
        bottle_rebuild: 0,
        formula_path: "Formula/hello.rb",
        formula_metadata: "Kandelo/formula/hello.json",
        dependencies: [],
        bottles: [{
          arch: "wasm32",
          bottle_tag: "wasm32_kandelo",
          kandelo_abi: 18,
          cellar: "/home/linuxbrew/.linuxbrew/Cellar",
          prefix: "/home/linuxbrew/.linuxbrew",
          url: $url,
          sha256: $sha,
          bytes: ($bytes | tonumber),
          cache_key_sha: $sha,
          link_manifest: $link,
          status: "success",
          built_from: {
            kandelo_repository: "Automattic/kandelo",
            kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            tap_repository: "Automattic/kandelo-homebrew",
            tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            formula_sha256: $formula_sha
          }
        }]
      }]
    }' >"$handoff/sidecars/Kandelo/metadata.json"

  jq -n --arg sha "$bottle_sha" --arg bytes "$bottle_bytes" --arg url "$bottle_url" '{
    schema: 1,
    package: "hello",
    version: "2.12.1",
    arch: "wasm32",
    kandelo_abi: 18,
    prefix: "/home/linuxbrew/.linuxbrew",
    cellar: "/home/linuxbrew/.linuxbrew/Cellar",
    keg: "/home/linuxbrew/.linuxbrew/Cellar/hello/2.12.1",
    bottle: {url: $url, sha256: $sha, bytes: ($bytes | tonumber), cache_key_sha: $sha},
    links: [], receipts: [], env: {PATH_prepend: ["bin"]}
  }' >"$handoff/sidecars/Kandelo/link/$link_name"

  jq -n \
    --arg sha "$bottle_sha" --arg bytes "$bottle_bytes" --arg url "$bottle_url" \
    --arg formula_sha "$formula_sha" '{
      schema: 1,
      subject: {package: "hello", version: "2.12.1", arch: "wasm32", bottle_rebuild: 0, kandelo_abi: 18},
      repositories: {
        kandelo_repository: "Automattic/kandelo",
        kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tap_repository: "Automattic/kandelo-homebrew",
        tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      formula: {path: "Formula/hello.rb", sha256: $formula_sha},
      bottle: {
        url: $url, sha256: $sha, bytes: ($bytes | tonumber), cache_key_sha: $sha,
        bottle_tag: "wasm32_kandelo", cellar: "/home/linuxbrew/.linuxbrew/Cellar",
        prefix: "/home/linuxbrew/.linuxbrew"
      },
      build: {}, validation: {}, metadata: {}
    }' >"$handoff/sidecars/Kandelo/reports/$provenance_name"
}

refresh_publish_formula_sha() {
  local handoff="$1" formula_sha tmp
  formula_sha="$(sha256sum "$handoff/sidecars/Formula/hello.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$handoff/sidecars/Formula/hello.rb" | awk '{print $1}')"
  tmp="$TMPDIR/refresh-formula.json"
  jq --arg sha "$formula_sha" '(.bottles[]?.built_from.formula_sha256) = $sha' "$handoff/sidecars/Kandelo/formula/hello.json" >"$tmp"
  mv "$tmp" "$handoff/sidecars/Kandelo/formula/hello.json"
  jq --arg sha "$formula_sha" '(.packages[]?.bottles[]?.built_from.formula_sha256) = $sha' "$handoff/sidecars/Kandelo/metadata.json" >"$tmp"
  mv "$tmp" "$handoff/sidecars/Kandelo/metadata.json"
  jq --arg sha "$formula_sha" '.formula.sha256 = $sha' "$handoff/sidecars/Kandelo/reports/"*.provenance.json >"$tmp"
  mv "$tmp" "$handoff/sidecars/Kandelo/reports/"*.provenance.json
}

validate_publish_handoff() {
  local handoff="$1" tap_root="$2"
  bash "$REPO_ROOT/scripts/homebrew-validate-publish-handoff.sh" \
    --handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --tap-root "$tap_root"
}

assert_publish_handoff_is_exact_inert_data() {
  local handoff tap_root tmp link

  handoff="$TMPDIR/publish-handoff-valid"
  tap_root="$TMPDIR/publish-handoff-valid-tap"
  make_publish_handoff "$handoff" "$tap_root"
  validate_publish_handoff "$handoff" "$tap_root" >/dev/null

  handoff="$TMPDIR/publish-handoff-extra"
  tap_root="$TMPDIR/publish-handoff-extra-tap"
  make_publish_handoff "$handoff" "$tap_root"
  printf 'untrusted\n' >"$handoff/sidecars/run.sh"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted an extra executable sidecar"
  fi

  handoff="$TMPDIR/publish-handoff-symlink"
  tap_root="$TMPDIR/publish-handoff-symlink-tap"
  make_publish_handoff "$handoff" "$tap_root"
  rm "$handoff/sidecars/Kandelo/formula/hello.json"
  ln -s ../metadata.json "$handoff/sidecars/Kandelo/formula/hello.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a symlinked sidecar"
  fi

  handoff="$TMPDIR/publish-handoff-link-name"
  tap_root="$TMPDIR/publish-handoff-link-name-tap"
  make_publish_handoff "$handoff" "$tap_root"
  link="$(find "$handoff/sidecars/Kandelo/link" -type f -print -quit)"
  mv "$link" "$handoff/sidecars/Kandelo/link/hello-2.12.1-rebuild0-wasm64.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a link filename for another architecture"
  fi

  handoff="$TMPDIR/publish-handoff-formula"
  tap_root="$TMPDIR/publish-handoff-formula-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-formula.rb"
  sed 's/desc "reviewed fixture"/desc "artifact-mutated code"/' \
    "$handoff/sidecars/Formula/hello.rb" >"$tmp"
  mv "$tmp" "$handoff/sidecars/Formula/hello.rb"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted Formula code that differs from the reviewed tap"
  fi

  handoff="$TMPDIR/publish-handoff-root"
  tap_root="$TMPDIR/publish-handoff-root-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-root.rb"
  sed 's|root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"|root_url "https://example.invalid/bottles"|' \
    "$handoff/sidecars/Formula/hello.rb" >"$tmp"
  mv "$tmp" "$handoff/sidecars/Formula/hello.rb"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a Formula bottle root that differs from the plan"
  fi

  handoff="$TMPDIR/publish-handoff-duplicate-selected-tag"
  tap_root="$TMPDIR/publish-handoff-duplicate-selected-tag-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-duplicate-selected-tag.rb"
  awk '
    { print }
    /wasm32_kandelo:/ {
      print "    sha256 cellar: :any_skip_relocation, wasm32_kandelo: \"0000000000000000000000000000000000000000000000000000000000000000\""
    }
  ' "$handoff/sidecars/Formula/hello.rb" >"$tmp"
  mv "$tmp" "$handoff/sidecars/Formula/hello.rb"
  refresh_publish_formula_sha "$handoff"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a duplicate selected bottle tag"
  fi

  handoff="$TMPDIR/publish-handoff-mutated-sibling-tag"
  tap_root="$TMPDIR/publish-handoff-mutated-sibling-tag-tap"
  make_publish_handoff "$handoff" "$tap_root"
  cat >"$tap_root/Formula/hello.rb" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end
end
EOF
  tmp="$TMPDIR/publish-handoff-mutated-sibling-tag.rb"
  awk '
    { print }
    /wasm32_kandelo:/ {
      print "    sha256 cellar: :any_skip_relocation, wasm64_kandelo: \"2222222222222222222222222222222222222222222222222222222222222222\""
    }
  ' "$handoff/sidecars/Formula/hello.rb" >"$tmp"
  mv "$tmp" "$handoff/sidecars/Formula/hello.rb"
  refresh_publish_formula_sha "$handoff"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a changed reviewed sibling bottle tag"
  fi

  handoff="$TMPDIR/publish-handoff-large-metadata"
  tap_root="$TMPDIR/publish-handoff-large-metadata-tap"
  make_publish_handoff "$handoff" "$tap_root"
  truncate -s 16777217 "$handoff/sidecars/Kandelo/metadata.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted oversized metadata JSON"
  fi
}

assert_bottle_build_trusts_selected_tap() {
  local tap="$TMPDIR/bottle-trust-tap"
  local brew_repo="$TMPDIR/bottle-trust-brew-repo"
  local brew_prefix="$TMPDIR/bottle-trust-prefix"
  local fake_brew="$TMPDIR/bottle-trust-brew"
  local out="$TMPDIR/bottle-trust-out"
  local log="$TMPDIR/bottle-trust.log"
  local caller_config="$TMPDIR/caller-homebrew-config"
  make_tap "$tap"
  mkdir -p "$brew_repo" "$brew_prefix" "$caller_config"

  cat >"$fake_brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  export HOMEBREW_USER_CONFIG_HOME="$XDG_CONFIG_HOME/homebrew"
fi
printf '%s|%s\n' "${HOMEBREW_USER_CONFIG_HOME:-}" "$*" >>"$FAKE_BREW_LOG"
case "${1:-}" in
  --prefix)
    printf '%s\n' "$FAKE_BREW_PREFIX"
    ;;
  --repository)
    if [ "$#" -eq 1 ]; then
      printf '%s\n' "$FAKE_BREW_REPOSITORY"
    else
      printf '%s\n' "$FAKE_TAP_ROOT"
    fi
    ;;
  tap)
    ;;
  trust)
    [ "${2:-}" = "--tap" ]
    [ "${3:-}" = "automattic/kandelo-homebrew" ]
    [ -d "${HOMEBREW_USER_CONFIG_HOME:-}" ]
    permissions="$(stat -c %a "$HOMEBREW_USER_CONFIG_HOME" 2>/dev/null || stat -f %Lp "$HOMEBREW_USER_CONFIG_HOME")"
    [ "$permissions" = "700" ]
    case "$HOMEBREW_USER_CONFIG_HOME" in
      */xdg-config/homebrew) ;;
      *) exit 43 ;;
    esac
    ;;
  install)
    exit 42
    ;;
  *)
    exit 44
    ;;
esac
EOF
  chmod +x "$fake_brew"

  if FAKE_BREW_LOG="$log" \
    FAKE_BREW_PREFIX="$brew_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    XDG_CONFIG_HOME="$caller_config" \
    bash "$REPO_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello \
      --arch wasm32 \
      --out "$out" \
      --bottle-root-url https://example.invalid/bottles \
      >/dev/null 2>&1; then
    fail "bottle trust fixture unexpectedly completed its sentinel install"
  fi

  local tap_line trust_line install_line trust_config first_config
  tap_line="$(grep -n '|tap automattic/kandelo-homebrew ' "$log" | cut -d: -f1)"
  trust_line="$(grep -n '|trust --tap automattic/kandelo-homebrew$' "$log" | cut -d: -f1)"
  install_line="$(grep -n '|install --build-bottle --formula automattic/kandelo-homebrew/hello$' "$log" | cut -d: -f1)"
  [ -n "$tap_line" ] && [ -n "$trust_line" ] && [ -n "$install_line" ] ||
    fail "bottle build did not tap, trust, and install the selected tap"
  [ "$tap_line" -lt "$trust_line" ] && [ "$trust_line" -lt "$install_line" ] ||
    fail "bottle build did not trust the selected tap before formula evaluation"

  trust_config="$(grep '|trust --tap automattic/kandelo-homebrew$' "$log" | cut -d'|' -f1)"
  first_config="$(head -n1 "$log" | cut -d'|' -f1)"
  [ -n "$trust_config" ] || fail "bottle build trust used no isolated config store"
  [ "$first_config" = "$trust_config" ] ||
    fail "launcher discovery ran outside the build-local Homebrew config store"
  [ "$trust_config" != "$caller_config/homebrew" ] ||
    fail "bottle build reused the caller's Homebrew config store"
  [ ! -e "$trust_config" ] || fail "build-local Homebrew config survived cleanup"
  [ -z "$(find "$caller_config" -mindepth 1 -print -quit)" ] ||
    fail "bottle build mutated the caller's Homebrew config store"
}

assert_failure_preserves_metadata() {
  local tap="$TMPDIR/failure-tap"
  make_tap "$tap"
  local before after
  before="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "intentional test failure" \
    --dry-run \
    --no-lock >/dev/null
  after="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  [ "$before" = "$after" ] || fail "failure path modified metadata.json"
  find "$tap/Kandelo/reports/failures" -type f -name '*-hello-wasm32.json' -print -quit |
    grep -q . || fail "failure path did not write failure report"
}

assert_failure_reports_do_not_collide_within_one_second() {
  local tap="$TMPDIR/failure-collision-tap"
  local bin="$TMPDIR/failure-collision-bin"
  local report_count
  make_tap "$tap"
  mkdir -p "$bin"
  cat >"$bin/date" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = "-u +%FT%TZ" ]; then
  printf '%s\n' '2026-07-12T12:34:56Z'
else
  exec /bin/date "$@"
fi
EOF
  chmod +x "$bin/date"

  PATH="$bin:$PATH" GITHUB_RUN_ID=100 GITHUB_RUN_ATTEMPT=1 \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
      --tap-root "$tap" \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --status failed \
      --error "first same-second failure" \
      --dry-run \
      --no-lock >/dev/null
  PATH="$bin:$PATH" GITHUB_RUN_ID=101 GITHUB_RUN_ATTEMPT=2 \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
      --tap-root "$tap" \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --status failed \
      --error "second same-second failure" \
      --dry-run \
      --no-lock >/dev/null

  report_count="$(find "$tap/Kandelo/reports/failures" -type f -name '*-hello-wasm32.json' | wc -l | tr -d '[:space:]')"
  [ "$report_count" = "2" ] || fail "same-second failure reports overwrote one another"
  find "$tap/Kandelo/reports/failures" -type f -name '*-run-100-attempt-1-hello-wasm32.json' -print -quit |
    grep -q . || fail "first failure report lacks stable run identity"
  find "$tap/Kandelo/reports/failures" -type f -name '*-run-101-attempt-2-hello-wasm32.json' -print -quit |
    grep -q . || fail "second failure report lacks stable run identity"
}

assert_write_publish_requires_attached_branch_and_pushes_explicit_ref() {
  local remote="$TMPDIR/publish-origin.git"
  local seed="$TMPDIR/publish-seed"
  local tap="$TMPDIR/publish-tap"
  local report_tap="$TMPDIR/publish-report-tap"
  local updater="$TMPDIR/publish-updater"
  local err="$TMPDIR/detached-publish.err"
  local local_head remote_head report planned_tap planned_kandelo

  git init --bare -q "$remote"
  make_tap "$seed"
  git -C "$seed" branch -M main
  git -C "$seed" remote add origin "$remote"
  git -C "$seed" push -q -u origin main
  git --git-dir="$remote" symbolic-ref HEAD refs/heads/main
  git clone -q "$remote" "$tap"
  git -C "$tap" config user.name "Kandelo Test"
  git -C "$tap" config user.email "kandelo-test@example.invalid"
  planned_tap="$(git -C "$tap" rev-parse HEAD)"
  planned_kandelo="$(git -C "$REPO_ROOT" rev-parse HEAD)"

  git -C "$tap" checkout -q --detach
  if GITHUB_SHA="cccccccccccccccccccccccccccccccccccccccc" \
    bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "detached publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "write publication accepted a detached tap checkout"
  fi
  grep -q "requires an attached tap branch" "$err" ||
    fail "detached publication did not explain the branch requirement"

  git -C "$tap" switch -q --force-create feature HEAD
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "feature publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "write publication accepted a non-main tap branch"
  fi
  grep -q "requires tap main" "$err" ||
    fail "non-main publication did not explain the main-branch requirement"

  git -C "$tap" switch -q --force-create main HEAD
  printf '\nUNVALIDATED_PARTIAL\n' >>"$tap/Formula/hello.rb"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "dirty failure publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "failure publication accepted a dirty tap checkout"
  fi
  grep -q "must be clean before publication" "$err" ||
    fail "dirty failure publication did not explain the clean-checkout requirement"
  ! git --git-dir="$remote" show main:Formula/hello.rb | grep -q UNVALIDATED_PARTIAL ||
    fail "dirty failure publication pushed an unvalidated partial payload"

  git -C "$tap" add Formula/hello.rb
  git -C "$tap" commit -q -m "unvalidated local success attempt"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "locally committed failure publication must fail" \
    --no-lock > /dev/null 2>"$err"; then
    fail "failure publication accepted an unpushed local commit"
  fi
  grep -q "must match origin/main after refresh" "$err" ||
    fail "local-ahead failure publication did not explain the remote-main requirement"
  ! git --git-dir="$remote" show main:Formula/hello.rb | grep -q UNVALIDATED_PARTIAL ||
    fail "local-ahead failure publication pushed an unvalidated partial payload"

  git clone -q "$remote" "$updater"
  git -C "$updater" config user.name "Kandelo Test"
  git -C "$updater" config user.email "kandelo-test@example.invalid"
  printf 'remote advance\n' >"$updater/README.md"
  git -C "$updater" add README.md
  git -C "$updater" commit -q -m "advance tap main"
  git -C "$updater" push -q origin main

  git clone -q "$remote" "$report_tap"
  git -C "$report_tap" checkout -q --detach "$planned_tap"
  git -C "$report_tap" switch -q --force-create main "$planned_tap"
  GITHUB_SHA="cccccccccccccccccccccccccccccccccccccccc" \
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$report_tap" \
    --kandelo-commit "$planned_kandelo" \
    --tap-commit "$planned_tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --error "record after refresh" \
    --no-lock >/dev/null

  local_head="$(git -C "$report_tap" rev-parse HEAD)"
  remote_head="$(git --git-dir="$remote" rev-parse refs/heads/main)"
  [ "$local_head" = "$remote_head" ] ||
    fail "sidecar publication did not push the attached main branch"
  git -C "$report_tap" merge-base --is-ancestor "$(git -C "$updater" rev-parse HEAD)" HEAD ||
    fail "sidecar publication did not refresh from remote main before committing"
  report="$(find "$report_tap/Kandelo/reports/failures" -type f -name '*-hello-wasm32.json' -print -quit)"
  [ -n "$report" ] || fail "attached publication did not write its failure report"
  jq -e --arg tap "$planned_tap" --arg kandelo "$planned_kandelo" '
    .tap_commit == $tap and .kandelo_commit == $kandelo
  ' "$report" >/dev/null || fail "failure report did not record the planned source commits"
  ! grep -q "cccccccccccccccccccccccccccccccccccccccc" "$report" ||
    fail "failure report leaked the caller-context commit into provenance"
  if git --git-dir="$remote" show-ref --verify --quiet refs/heads/HEAD; then
    fail "sidecar publication created an inferred HEAD branch"
  fi
}

assert_failed_payload_rejects_success_status() {
  local tap="$TMPDIR/failure-payload-tap"
  local payload="$TMPDIR/failure-success-payload"
  local err="$TMPDIR/failure-success-payload.err"
  make_tap "$tap"
  mkdir -p "$payload/Kandelo"
  cat >"$payload/Kandelo/metadata.json" <<'EOF'
{
  "packages": [
    {
      "name": "hello",
      "bottles": [
        {
          "arch": "wasm32",
          "status": "success"
        }
      ]
    }
  ]
}
EOF
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --sidecar-root "$payload" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status failed \
    --dry-run \
    --no-lock > /dev/null 2>"$err"; then
    fail "failed publish accepted a success sidecar payload"
  fi
  grep -q "missing a non-success status" "$err" ||
    fail "failed publish did not explain rejected success payload"
}

assert_rollback_preserves_metadata() {
  local tap="$TMPDIR/rollback-tap"
  make_tap "$tap"
  local before after report
  before="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status rollback \
    --reason "bad bottle block selected by tap commit" \
    --rollback-ref "refs/heads/main~1" \
    --dry-run \
    --no-lock >/dev/null
  after="$(sha256sum "$tap/Kandelo/metadata.json" 2>/dev/null || shasum -a 256 "$tap/Kandelo/metadata.json")"
  [ "$before" = "$after" ] || fail "rollback path modified metadata.json"
  report="$(find "$tap/Kandelo/reports/rollbacks" -type f -name '*-hello-wasm32.json' -print -quit)"
  [ -n "$report" ] || fail "rollback path did not write rollback report"
  jq -e '
    .status == "rollback" and
    .rollback_ref == "refs/heads/main~1" and
    .package_deletion.performed == false and
    (.package_deletion.policy | contains("exceptional"))
  ' "$report" >/dev/null || fail "rollback report did not record rollback policy"
}

assert_rollback_deletion_requires_reason() {
  local tap="$TMPDIR/rollback-deletion-tap"
  local err="$TMPDIR/rollback-deletion.err"
  make_tap "$tap"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status rollback \
    --reason "legal package removal" \
    --deleted-package-url "https://ghcr.io/v2/example/package/blobs/sha256:bad" \
    --dry-run \
    --no-lock > /dev/null 2>"$err"; then
    fail "rollback package deletion without reason unexpectedly succeeded"
  fi
  grep -q -- "--deletion-reason is required" "$err" ||
    fail "rollback deletion did not explain missing deletion reason"
}

assert_publisher_trust_contract() {
  ruby "$REPO_ROOT/scripts/check-homebrew-publish-workflow-trust.rb"
}

assert_matrix
assert_matrix_skips_unchanged_cache_key
assert_upload_dry_run
assert_upload_push_uses_relative_layer_path
assert_bottle_build_trusts_selected_tap
assert_generator_rejects_mismatched_homebrew_commit
assert_build_handoff_is_minimal_and_validated
assert_build_handoff_rejects_untrusted_content
assert_upload_receipt_is_bound_to_build_handoff
assert_publish_handoff_is_exact_inert_data
assert_failure_preserves_metadata
assert_failure_reports_do_not_collide_within_one_second
assert_write_publish_requires_attached_branch_and_pushes_explicit_ref
assert_failed_payload_rejects_success_status
assert_rollback_preserves_metadata
assert_rollback_deletion_requires_reason
bash "$REPO_ROOT/scripts/test-homebrew-patched-launcher.sh"
assert_publisher_trust_contract

echo "test-homebrew-publish-workflow.sh: ok"
