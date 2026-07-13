#!/usr/bin/env bash
# Focused checks for the trusted Homebrew publish workflow helper scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-publication-limits.sh"
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
  local brew_prefix="$TMPDIR/generator-prefix"
  local sidecars="$TMPDIR/generator-sidecars"
  local err="$TMPDIR/generator-brew-commit.err"
  local bottle="$TMPDIR/generator-bottle.tar.gz"
  local bottle_json="$TMPDIR/generator-bottle.json"
  local bottle_sha bottle_bytes abi

  mkdir -p "$brew_repo/Formula" "$(dirname "$brew_bin")" "$brew_prefix"
  git -C "$brew_repo" init -q
  git -C "$brew_repo" config user.name "Kandelo Test"
  git -C "$brew_repo" config user.email "kandelo-test@example.invalid"
  printf 'reviewed brew\n' >"$brew_repo/README.md"
  printf 'class Hello < Formula\nend\n' >"$brew_repo/Formula/hello.rb"
  git -C "$brew_repo" add README.md Formula/hello.rb
  git -C "$brew_repo" commit -q -m "reviewed brew"
  printf 'bottle\n' >"$bottle"
  printf '{}\n' >"$bottle_json"
  bottle_sha="$(sha256sum "$bottle" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$bottle" | awk '{print $1}')"
  bottle_bytes="$(wc -c <"$bottle" | tr -d '[:space:]')"
  cat >"$brew_bin" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  --repository) printf '%s\n' '$brew_repo' ;;
  --prefix) printf '%s\n' '$brew_prefix' ;;
  --version) printf '%s\n' 'Homebrew test' ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$brew_bin"
  abi="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
    "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"

  if HOMEBREW_BREW_FILE="$brew_bin" \
    HOMEBREW_BREW_COMMIT="0000000000000000000000000000000000000000" \
    KANDELO_HOMEBREW_PATCH_FILE="$TMPDIR/generator-missing.patch" \
    KANDELO_HOMEBREW_TAP_ROOT="$brew_repo" \
    KANDELO_HOMEBREW_SIDECAR_ROOT="$sidecars" \
    KANDELO_HOMEBREW_FORMULA="hello" \
    KANDELO_HOMEBREW_ARCH="wasm32" \
    KANDELO_HOMEBREW_RELEASE_TAG="bottles-abi-v${abi}" \
    KANDELO_HOMEBREW_TAP_REPOSITORY="Automattic/kandelo-homebrew" \
    KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$bottle" \
    KANDELO_HOMEBREW_BOTTLE_JSON="$bottle_json" \
    KANDELO_HOMEBREW_BOTTLE_URL="https://ghcr.io/v2/automattic/kandelo-homebrew/hello/blobs/sha256:${bottle_sha}" \
    KANDELO_HOMEBREW_BOTTLE_SHA256="$bottle_sha" \
    KANDELO_HOMEBREW_BOTTLE_BYTES="$bottle_bytes" \
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
  local extra_file_count="${BUILD_HANDOFF_EXTRA_FILE_COUNT:-0}"
  local source_dir="${handoff}.source"
  local bottle="$source_dir/hello--2.12.1.wasm32_kandelo.bottle.tar.gz"
  local bottle_json="$source_dir/hello--2.12.1.wasm32_kandelo.bottle.json"
  local dependency_provenance="$source_dir/dependency-provenance.json"
  local bottle_stage="$source_dir/stage/hello/2.12.1"
  local sha256

  mkdir -p "$bottle_stage/.brew" "$bottle_stage/bin"
  cat >"$bottle_stage/.brew/hello.rb" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
end
EOF
  printf '{}\n' >"$bottle_stage/INSTALL_RECEIPT.json"
  printf '#!/bin/sh\necho hello\n' >"$bottle_stage/bin/hello"
  chmod +x "$bottle_stage/bin/hello"
  tar -czf "$bottle" -C "$source_dir/stage" hello
  sha256="$(sha256sum "$bottle" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$bottle" | awk '{print $1}')"
  jq -n --arg sha256 "$sha256" '{
    "automattic/kandelo-homebrew/hello": {
      formula: {
        name: "hello",
        path: "Library/Taps/automattic/homebrew-kandelo-homebrew/Formula/hello.rb",
        pkg_version: "2.12.1",
        tap_git_path: "Formula/hello.rb",
        tap_git_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        desc: "this artifact-only field must not reach Homebrew merge"
      },
      bottle: {
        root_url: "https://ghcr.io/v2/automattic/kandelo-homebrew",
        cellar: "any_skip_relocation",
        rebuild: 0,
        tags: {
          wasm32_kandelo: {
            local_filename: "hello--2.12.1.wasm32_kandelo.bottle.tar.gz",
            sha256: $sha256,
            tab: {runtime_dependencies: []},
            path_exec_files: ["bin/hello"],
            all_files: [".brew/hello.rb", "INSTALL_RECEIPT.json", "bin/hello"]
          }
        }
      }
    }
  }' >"$bottle_json"
  if [ "$extra_file_count" -gt 0 ]; then
    local expanded_json="$source_dir/expanded-bottle.json"
    jq --argjson count "$extra_file_count" '
      .[].bottle.tags.wasm32_kandelo.all_files += [
        range(0; $count) | "share/texmf-dist/fixture/path-\(.).tex"
      ]
    ' "$bottle_json" >"$expanded_json"
    mv "$expanded_json" "$bottle_json"
  fi
  jq -nS '{
    schema: 1,
    formula: "hello",
    arch: "wasm32",
    tap_repository: "Automattic/kandelo-homebrew",
    tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bottle_root_url: "https://ghcr.io/v2/automattic/kandelo-homebrew",
    bottle_tag: "wasm32_kandelo",
    dependencies: []
  }' >"$dependency_provenance"

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
    --dependency-provenance "$dependency_provenance" \
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
  [ "$files" = $'bottle.json\nbottle.tar.gz\ndependency-provenance.json\nmanifest.json' ] ||
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
    [ "$DEPENDENCY_PROVENANCE" -ef "$handoff/dependency-provenance.json" ] ||
      fail "validated handoff env lost dependency provenance"
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

  handoff="$TMPDIR/build-handoff-large-valid-json"
  BUILD_HANDOFF_EXTRA_FILE_COUNT=30000 make_build_handoff "$handoff"
  [ "$(wc -c <"$handoff/bottle.json" | tr -d '[:space:]')" -gt 1048576 ] ||
    fail "large bottle JSON fixture did not exceed the old 1 MiB bound"
  validate_build_handoff "$handoff" >/dev/null ||
    fail "build handoff validator rejected a valid large file inventory"
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
    --dependency-provenance "${handoff}.source/dependency-provenance.json" \
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
    --dependency-provenance "${handoff}.source/dependency-provenance.json" \
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
  grep -q "exactly four files" "$err" ||
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

  handoff="$TMPDIR/build-handoff-dependency-tamper"
  make_build_handoff "$handoff"
  jq '.tap_commit = "cccccccccccccccccccccccccccccccccccccccc"' \
    "$handoff/dependency-provenance.json" >"$tmp"
  mv "$tmp" "$handoff/dependency-provenance.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted modified dependency provenance"
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
  head -c 16777217 /dev/zero | tr '\0' ' ' >>"$handoff/bottle.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted bottle JSON larger than 16 MiB"
  fi

  handoff="$TMPDIR/build-handoff-large-bottle"
  make_build_handoff "$handoff"
  truncate -s 2147483649 "$handoff/bottle.tar.gz"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted a compressed bottle larger than 2 GiB"
  fi

  handoff="$TMPDIR/build-handoff-large-dependency-provenance"
  make_build_handoff "$handoff"
  truncate -s 1048577 "$handoff/dependency-provenance.json"
  if validate_build_handoff "$handoff" >/dev/null 2>&1; then
    fail "build handoff validator accepted dependency provenance larger than 1 MiB"
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
  local extra_link_count="${PUBLISH_HANDOFF_EXTRA_LINK_COUNT:-0}"
  local bottle_sha bottle_bytes bottle_url formula_sha

  rm -rf "$handoff" "$tap_root" "$build_stage"
  mkdir -p "$tap_root/Formula" "$handoff/composition"
  cat >"$tap_root/Formula/hello.rb" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
end
EOF
  formula_sha="$(sha256sum "$tap_root/Formula/hello.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap_root/Formula/hello.rb" | awk '{print $1}')"
  make_build_handoff "$build_stage"
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
  jq -nS \
    --arg sha "$bottle_sha" --arg bytes "$bottle_bytes" --arg url "$bottle_url" \
    --arg formula_sha "$formula_sha" '{
      schema: 1,
      tap_repository: "Automattic/kandelo-homebrew",
      tap_name: "automattic/kandelo-homebrew",
      tap_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      kandelo_abi: 18,
      release_tag: "bottles-abi-v18",
      generated_at: "2026-07-12T00:00:00Z",
      generator: "workflow fixture",
      packages: [{
        name: "hello",
        full_name: "automattic/kandelo-homebrew/hello",
        version: "2.12.1",
        formula_revision: 0,
        bottle_rebuild: 0,
        formula_path: "Formula/hello.rb",
        formula_source_sha256: $formula_sha,
        dependencies: [],
        bottles: [{
          arch: "wasm32",
          bottle_tag: "wasm32_kandelo",
          cellar: "/home/linuxbrew/.linuxbrew/Cellar",
          prefix: "/home/linuxbrew/.linuxbrew",
          runtime_support: ["node"],
          browser_compatible: false,
          fork_instrumentation: "not-required",
          status: "success",
          built_by: "https://example.invalid/actions/runs/1",
          built_at: "2026-07-12T00:00:00Z",
          bottle_file: "../build/bottle.tar.gz",
          url: $url,
          cache_key_sha: $sha,
          payload_root: "hello/2.12.1",
          links: [{type: "symlink", source: "bin/hello", target: "bin/hello"}],
          receipts: [".brew/hello.rb", "INSTALL_RECEIPT.json"],
          env: {PATH_prepend: ["bin"]},
          build: {
            github_run: "https://example.invalid/actions/runs/1",
            job: "verify-bottle",
            runner_os: "linux",
            brew_version: "Homebrew fixture",
            dev_shell: "scripts/dev-shell.sh",
            sdk_fingerprint: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            sysroot_fingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
          },
          validation: {outcome_lists: [{
            name: "schema", status: "success", passed: ["fixture"], failed: [], skipped: []
          }]}
        }]
      }]
    }' >"$handoff/composition/sidecars-input.json"
  if [ "$extra_link_count" -gt 0 ]; then
    local expanded_input="$handoff/composition/sidecars-input.expanded.json"
    jq --argjson count "$extra_link_count" '
      .packages[0].bottles[0].links += [
        range(0; $count) | {
          type: "symlink",
          source: "bin/hello",
          target: "share/texmf-dist/fixture/path-\(.).tex"
        }
      ]
    ' "$handoff/composition/sidecars-input.json" >"$expanded_input"
    mv "$expanded_input" "$handoff/composition/sidecars-input.json"
  fi
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
  local handoff tap_root tmp external before after err generated composed host link

  handoff="$TMPDIR/publish-handoff-valid"
  tap_root="$TMPDIR/publish-handoff-valid-tap"
  make_publish_handoff "$handoff" "$tap_root"
  validate_publish_handoff "$handoff" "$tap_root" >/dev/null

  handoff="$TMPDIR/publish-handoff-large-valid-sidecar"
  tap_root="$TMPDIR/publish-handoff-large-valid-sidecar-tap"
  generated="$TMPDIR/publish-handoff-large-valid-sidecar-generated"
  composed="$TMPDIR/publish-handoff-large-valid-sidecar.rb"
  PUBLISH_HANDOFF_EXTRA_LINK_COUNT=25000 make_publish_handoff "$handoff" "$tap_root"
  validate_publish_handoff "$handoff" "$tap_root" >/dev/null
  cp -a "$tap_root" "$generated"
  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$generated/Formula/hello.rb" "$tap_root/Formula/hello.rb" \
    https://ghcr.io/v2/automattic/kandelo-homebrew \
    0 wasm32_kandelo any_skip_relocation \
    "$(jq -r '.bottle.sha256' "$handoff/receipt.json")" \
    discard "$composed"
  mv "$composed" "$generated/Formula/hello.rb"
  host="$(rustc -vV | awk '/^host/ {print $2}')"
  (
    cd "$REPO_ROOT"
    cargo run --release -p xtask --target "$host" --quiet -- \
      homebrew-sidecars --tap-root "$generated" \
      --input "$handoff/composition/sidecars-input.json"
    cargo run --release -p xtask --target "$host" --quiet -- \
      homebrew-validate --tap-root "$generated"
  ) >/dev/null
  link="$(find "$generated/Kandelo/link" -mindepth 1 -maxdepth 1 -type f -print -quit)"
  [ -n "$link" ] || fail "large sidecar fixture did not generate a link manifest"
  [ "$(wc -c <"$link" | tr -d '[:space:]')" -gt 2097152 ] ||
    fail "valid large link sidecar did not exceed the old 2 MiB bound"
  [ "$(wc -c <"$link" | tr -d '[:space:]')" -le "$HOMEBREW_MAX_SIDECAR_JSON_BYTES" ] ||
    fail "valid large link sidecar exceeded the current 16 MiB bound"

  handoff="$TMPDIR/publish-handoff-extra"
  tap_root="$TMPDIR/publish-handoff-extra-tap"
  make_publish_handoff "$handoff" "$tap_root"
  printf 'untrusted\n' >"$handoff/run.sh"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted an extra top-level executable"
  fi

  handoff="$TMPDIR/publish-handoff-symlink"
  tap_root="$TMPDIR/publish-handoff-symlink-tap"
  make_publish_handoff "$handoff" "$tap_root"
  rm "$handoff/composition/sidecars-input.json"
  ln -s ../receipt.json "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a symlinked composition input"
  fi

  handoff="$TMPDIR/publish-handoff-extra-field"
  tap_root="$TMPDIR/publish-handoff-extra-field-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-extra-field.json"
  jq '.untrusted = "command"' "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted an unknown composition field"
  fi

  handoff="$TMPDIR/publish-handoff-formula-drift"
  tap_root="$TMPDIR/publish-handoff-formula-drift-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-formula.rb"
  sed 's/desc "reviewed fixture"/desc "artifact-mutated code"/' \
    "$tap_root/Formula/hello.rb" >"$tmp"
  mv "$tmp" "$tap_root/Formula/hello.rb"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted Formula source drift"
  fi

  handoff="$TMPDIR/publish-handoff-bottle-path"
  tap_root="$TMPDIR/publish-handoff-bottle-path-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-bottle-path.json"
  jq '.packages[0].bottles[0].bottle_file = "../../outside.tar.gz"' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted a bottle path outside the handoff"
  fi

  handoff="$TMPDIR/publish-handoff-wrong-sha"
  tap_root="$TMPDIR/publish-handoff-wrong-sha-tap"
  make_publish_handoff "$handoff" "$tap_root"
  tmp="$TMPDIR/publish-handoff-wrong-sha.json"
  jq '.packages[0].bottles[0].cache_key_sha = "0000000000000000000000000000000000000000000000000000000000000000"' \
    "$handoff/composition/sidecars-input.json" >"$tmp"
  mv "$tmp" "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted bottle digest drift"
  fi

  handoff="$TMPDIR/publish-handoff-large-input"
  tap_root="$TMPDIR/publish-handoff-large-input-tap"
  make_publish_handoff "$handoff" "$tap_root"
  truncate -s 4194305 "$handoff/composition/sidecars-input.json"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>&1; then
    fail "publish handoff validator accepted oversized composition input"
  fi

  handoff="$TMPDIR/publish-handoff-tap-symlink"
  tap_root="$TMPDIR/publish-handoff-tap-symlink-tap"
  external="$TMPDIR/publish-handoff-external-formula.rb"
  err="$TMPDIR/publish-handoff-tap-symlink.err"
  make_publish_handoff "$handoff" "$tap_root"
  cp "$tap_root/Formula/hello.rb" "$external"
  rm "$tap_root/Formula/hello.rb"
  ln -s "$external" "$tap_root/Formula/hello.rb"
  before="$(sha256sum "$external" 2>/dev/null || shasum -a 256 "$external")"
  if validate_publish_handoff "$handoff" "$tap_root" >/dev/null 2>"$err"; then
    fail "publish handoff validator accepted a symlink in the tap Formula tree"
  fi
  grep -F "symlink" "$err" >/dev/null ||
    fail "publish handoff validator did not explain the tap symlink"

  git -C "$tap_root" init -q
  git -C "$tap_root" config user.name "Kandelo Test"
  git -C "$tap_root" config user.email "kandelo-test@example.invalid"
  git -C "$tap_root" add Formula
  git -C "$tap_root" commit -q -m "add symlinked Formula fixture"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$tap_root" \
    --publication-handoff "$handoff" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v18 \
    --status success \
    --tap-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --kandelo-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "sidecar publisher accepted a tracked symlink in the tap Formula tree"
  fi
  after="$(sha256sum "$external" 2>/dev/null || shasum -a 256 "$external")"
  [ "$before" = "$after" ] || fail "sidecar publisher wrote through the tap Formula symlink"
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
  deps)
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

assert_bottle_build_forces_same_tap_dependencies() {
  local tap="$TMPDIR/bottle-dependency-tap"
  local brew_repo="$TMPDIR/bottle-dependency-brew-repo"
  local brew_prefix="$TMPDIR/bottle-dependency-prefix"
  local fake_brew="$TMPDIR/bottle-dependency-brew"
  local out="$TMPDIR/bottle-dependency-out"
  local log="$TMPDIR/bottle-dependency.log"
  make_tap "$tap"
  mkdir -p "$brew_repo" "$brew_prefix"
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
end
EOF

  cat >"$fake_brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_BREW_LOG"
case "${1:-}" in
  --prefix) printf '%s\n' "$FAKE_BREW_PREFIX" ;;
  --repository)
    if [ "$#" -eq 1 ]; then
      printf '%s\n' "$FAKE_BREW_REPOSITORY"
    else
      printf '%s\n' "$FAKE_TAP_ROOT"
    fi
    ;;
  tap|trust) ;;
  deps)
    printf '%s\n' 'cmake' 'automattic/kandelo-homebrew/zlib'
    ;;
  install)
    if [ "$*" = 'install --force-bottle --as-dependency --ignore-dependencies --formula automattic/kandelo-homebrew/zlib' ]; then
      exit 42
    fi
    exit 43
    ;;
  *) exit 44 ;;
esac
EOF
  chmod +x "$fake_brew"

  if FAKE_BREW_LOG="$log" \
    FAKE_BREW_PREFIX="$brew_prefix" \
    FAKE_BREW_REPOSITORY="$brew_repo" \
    FAKE_TAP_ROOT="$tap" \
    HOMEBREW_BREW_FILE="$fake_brew" \
    bash "$REPO_ROOT/scripts/homebrew-bottle-build.sh" \
      --tap-root "$tap" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula hello \
      --arch wasm32 \
      --out "$out" \
      --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
      >/dev/null 2>&1; then
    fail "dependency force-bottle fixture unexpectedly completed"
  fi

  grep -Fx 'deps --topological --full-name --formula automattic/kandelo-homebrew/hello' "$log" >/dev/null ||
    fail "bottle build did not resolve the runtime dependency closure"
  grep -Fx 'install --force-bottle --as-dependency --ignore-dependencies --formula automattic/kandelo-homebrew/zlib' "$log" >/dev/null ||
    fail "bottle build did not force the selected same-tap dependency bottle"
  ! grep -F 'install --force-bottle' "$log" | grep -F 'cmake' >/dev/null ||
    fail "bottle build treated a host dependency as a Kandelo bottle"
  ! grep -F 'install --build-bottle' "$log" >/dev/null ||
    fail "bottle build continued to the target source build after a dependency bottle failure"
}

assert_dependency_pour_provenance_is_bounded() {
  local root="$TMPDIR/dependency-provenance"
  local tap="$root/tap"
  local cellar="$root/cellar/zlib/1.3.1"
  local target_receipt="$root/target-receipt.json"
  local expected_dependencies="$root/expected-dependencies.txt"
  local install_log="$root/install.log"
  local fake_brew="$root/prefix/bin/brew"
  local fake_brew_target="$root/homebrew/bin/brew"
  local info="$root/zlib-info.json"
  local output="$root/provenance.json"
  local bad="$root/bad.json"
  local formula_sha
  local bottle_sha="1111111111111111111111111111111111111111111111111111111111111111"
  local tap_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  mkdir -p "$tap/Formula" "$cellar" "$(dirname "$fake_brew")" "$(dirname "$fake_brew_target")"
  cat >"$tap/Formula/zlib.rb" <<'EOF'
class Zlib < Formula
  desc "fixture"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end
end
EOF
  cat >"$tap/Formula/curl.rb" <<'EOF'
class Curl < Formula
  desc "consumer fixture"
  depends_on "automattic/kandelo-homebrew/zlib"
end
EOF
  formula_sha="$(sha256sum "$tap/Formula/zlib.rb" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$tap/Formula/zlib.rb" | awk '{print $1}')"
  jq -nS --arg tap_commit "$tap_commit" '{
    homebrew_version: "Homebrew fixture",
    built_as_bottle: true,
    poured_from_bottle: true,
    installed_on_request: false,
    source: {
      tap: "automattic/kandelo-homebrew",
      tap_git_head: $tap_commit
    },
    runtime_dependencies: []
  }' >"$cellar/INSTALL_RECEIPT.json"
  jq -nS '{runtime_dependencies: [{
    full_name: "automattic/kandelo-homebrew/zlib",
    version: "1.3.1",
    pkg_version: "1.3.1",
    revision: 0,
    bottle_rebuild: 0,
    declared_directly: true
  }]}' >"$target_receipt"
  printf '%s\n' 'automattic/kandelo-homebrew/zlib' >"$expected_dependencies"
  jq -nS --arg formula_sha "$formula_sha" --arg bottle_sha "$bottle_sha" '{
    formulae: [{
      name: "zlib",
      full_name: "automattic/kandelo-homebrew/zlib",
      ruby_source_checksum: {sha256: $formula_sha},
      bottle: {stable: {
        rebuild: 0,
        files: {wasm32_kandelo: {
          cellar: "any_skip_relocation",
          url: ("https://ghcr.io/v2/automattic/kandelo-homebrew/zlib/blobs/sha256:" + $bottle_sha),
          sha256: $bottle_sha
        }}
      }}
    }],
    casks: []
  }' >"$info"
  cat >"$fake_brew_target" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
launcher_prefix="$(cd "$(dirname "$0")/.." && pwd -P)"
expected_prefix="$(cd "$FAKE_PREFIX" && pwd -P)"
[ "$launcher_prefix" = "$expected_prefix" ] || {
  echo "brew launcher derived the wrong prefix: $launcher_prefix" >&2
  exit 3
}
case "${1:-}" in
  --cellar)
    [ "${2:-}" = "automattic/kandelo-homebrew/zlib" ]
    printf '%s\n' "$FAKE_CELLAR/zlib"
    ;;
  info)
    [ "${2:-}" = "--json=v2" ]
    [ "${3:-}" = "automattic/kandelo-homebrew/zlib" ]
    cat "$FAKE_INFO"
    ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$fake_brew_target"
  ln -s "$fake_brew_target" "$fake_brew"
  cat >"$install_log" <<EOF
==> Downloading https://ghcr.io/v2/automattic/kandelo-homebrew/zlib/manifests/1.3.1
==> Downloading https://ghcr.io/v2/automattic/kandelo-homebrew/zlib/blobs/sha256:$bottle_sha
==> Pouring zlib--1.3.1.wasm32_kandelo.bottle.tar.gz
EOF

  FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" \
      --tap-root "$tap" \
      --tap-repository Automattic/kandelo-homebrew \
      --tap-commit "$tap_commit" \
      --formula curl \
      --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
      --target-receipt "$target_receipt" \
      --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" \
      --out "$output"
  python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$output" \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" \
    --formula curl \
    --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --tap-root "$tap"
  jq -e --arg bottle_sha "$bottle_sha" '
    (.dependencies | length) == 1 and
    .dependencies[0].name == "zlib" and
    .dependencies[0].bottle.sha256 == $bottle_sha and
    .dependencies[0].receipt.built_as_bottle == true and
    .dependencies[0].receipt.poured_from_bottle == true and
    .dependencies[0].receipt.installed_on_request == false and
    (.dependencies[0].install_log.fetch | length) == 1 and
    (.dependencies[0].install_log.pour | length) == 1 and
    .dependencies[0].install_log.source_build_absent == true
  ' "$output" >/dev/null || fail "dependency provenance omitted exact bottle-pour evidence"

  local fabricated_sha="2222222222222222222222222222222222222222222222222222222222222222"
  jq --arg fabricated_sha "$fabricated_sha" '
    .dependencies[0].bottle.sha256 = $fabricated_sha |
    .dependencies[0].bottle.url =
      ("https://ghcr.io/v2/automattic/kandelo-homebrew/zlib/blobs/sha256:" + $fabricated_sha) |
    .dependencies[0].install_log.fetch = [
      ("==> Downloading https://ghcr.io/v2/automattic/kandelo-homebrew/zlib/blobs/sha256:" + $fabricated_sha)
    ]
  ' "$output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "fresh dependency validation accepted fabricated prior-bottle metadata"
  fi

  jq '.dependencies = []' "$output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "fresh dependency validation accepted an omitted exact-tap closure"
  fi

  jq '.runtime_dependencies = []' "$target_receipt" >"$bad"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository Automattic/kandelo-homebrew --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
      --target-receipt "$bad" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$root/missing-dependency.json" \
      >/dev/null 2>&1; then
    fail "dependency provenance accepted a target receipt missing a resolved dependency"
  fi

  jq '.poured_from_bottle = false' "$cellar/INSTALL_RECEIPT.json" >"$bad"
  mv "$bad" "$cellar/INSTALL_RECEIPT.json"
  if FAKE_PREFIX="$root/prefix" FAKE_CELLAR="$root/cellar" FAKE_INFO="$info" \
    python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" capture \
      --brew-bin "$fake_brew" --tap-root "$tap" \
      --tap-repository Automattic/kandelo-homebrew --tap-commit "$tap_commit" \
      --formula curl --arch wasm32 \
      --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
      --target-receipt "$target_receipt" --expected-dependencies "$expected_dependencies" \
      --install-log "$install_log" --out "$bad" \
      >/dev/null 2>&1; then
    fail "dependency provenance accepted a source-built dependency receipt"
  fi

  jq '.dependencies[0].install_log.source_build_absent = false' "$output" >"$bad"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$bad" --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    >/dev/null 2>&1; then
    fail "dependency provenance validator accepted a source-build claim"
  fi

  printf '# changed after build\n' >>"$tap/Formula/zlib.rb"
  if python3 "$REPO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
    --input "$output" --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" --formula curl --arch wasm32 \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --tap-root "$tap" >/dev/null 2>&1; then
    fail "dependency provenance accepted Formula drift from the exact tap"
  fi
}

assert_static_formula_closure_is_fail_closed() {
  local tap="$TMPDIR/static-closure-tap"
  local output
  mkdir -p "$tap/Formula"
  cat >"$tap/Formula/dep-b.rb" <<'RUBY'
class DepB < Formula
end
RUBY
  cat >"$tap/Formula/dep-a.rb" <<'RUBY'
class DepA < Formula
  depends_on "automattic/kandelo-homebrew/dep-b"
end
RUBY
  cat >"$tap/Formula/dep-recommended.rb" <<'RUBY'
class DepRecommended < Formula
end
RUBY
  cat >"$tap/Formula/root.rb" <<'RUBY'
class Root < Formula
  depends_on "pkgconf" => :build
  depends_on "wabt" => [:build, :test]
  depends_on "automattic/kandelo-homebrew/dep-a"
  depends_on "automattic/kandelo-homebrew/dep-recommended" => :recommended
  depends_on "automattic/kandelo-homebrew/not-installed" => :optional
end
RUBY
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" Automattic/kandelo-homebrew root)"
  [ "$output" = $'automattic/kandelo-homebrew/dep-a\nautomattic/kandelo-homebrew/dep-b\nautomattic/kandelo-homebrew/dep-recommended' ] ||
    fail "static Formula resolver did not produce the recursive runtime closure: $output"

  cat >"$tap/Formula/rich-static.rb" <<'RUBY'
class RichStatic < Formula
  PAYLOAD_VERSION = "1.0".freeze
  PAYLOAD_NAME = "payload-#{PAYLOAD_VERSION}".freeze

  depends_on "automattic/kandelo-homebrew/dep-a"

  on_macos do
    keg_only :provided_by_macos
  end

  resource "payload" do
    url "https://example.invalid/payload.tar.gz"
    version PAYLOAD_VERSION
    sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  end

  def install
    verify_payload_contract
  end

  private

  def verify_payload_contract
    dependencies = [PAYLOAD_NAME]
    dependencies.fetch(0)
  end
end
RUBY
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" Automattic/kandelo-homebrew rich-static)"
  [ "$output" = $'automattic/kandelo-homebrew/dep-a\nautomattic/kandelo-homebrew/dep-b' ] ||
    fail "static Formula resolver rejected safe constants, resources, or private helpers: $output"

  expect_static_closure_failure() {
    local formula="$1" label="$2"
    if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
      "$tap" Automattic/kandelo-homebrew "$formula" >/dev/null 2>&1; then
      fail "static Formula resolver accepted $label"
    fi
  }

  cat >"$tap/Formula/conditional.rb" <<'RUBY'
class Conditional < Formula
  if ENV["INCLUDE_DEP"]
    depends_on "automattic/kandelo-homebrew/dep-a"
  end
end
RUBY
  expect_static_closure_failure conditional "a conditional dependency"

  cat >"$tap/Formula/modifier.rb" <<'RUBY'
class Modifier < Formula
  depends_on "automattic/kandelo-homebrew/dep-a" if ENV["INCLUDE_DEP"]
end
RUBY
  expect_static_closure_failure modifier "a modifier-if dependency"

  cat >"$tap/Formula/interpolated.rb" <<'RUBY'
class Interpolated < Formula
  dependency = "dep-a"
  depends_on "automattic/kandelo-homebrew/#{dependency}"
end
RUBY
  expect_static_closure_failure interpolated "an interpolated dependency"

  cat >"$tap/Formula/helper.rb" <<'RUBY'
class Helper < Formula
  def self.declare_dependency
    depends_on "automattic/kandelo-homebrew/dep-a"
  end
end
RUBY
  expect_static_closure_failure helper "a dependency hidden in a helper"

  cat >"$tap/Formula/initializer.rb" <<'RUBY'
class Initializer < Formula
  def initialize(*args)
    super
    self.class.__send__("depends_" + "on", "automattic/kandelo-homebrew/dep-a")
  end
end
RUBY
  expect_static_closure_failure initializer "an initialization-time dependency dispatch"

  cat >"$tap/Formula/dependencies-override.rb" <<'RUBY'
class DependenciesOverride < Formula
  def dependencies
    []
  end
end
RUBY
  expect_static_closure_failure dependencies-override "a Formula dependency accessor override"

  cat >"$tap/Formula/receiver.rb" <<'RUBY'
class Receiver < Formula
  self.depends_on "automattic/kandelo-homebrew/dep-a"
end
RUBY
  expect_static_closure_failure receiver "a dependency with a dynamic receiver"

  cat >"$tap/Formula/string-dispatch.rb" <<'RUBY'
class StringDispatch < Formula
  send("depends_" + "on", "automattic/kandelo-homebrew/dep-a")
end
RUBY
  expect_static_closure_failure string-dispatch "a dependency built through string dispatch"

  cat >"$tap/Formula/class-eval.rb" <<'RUBY'
class ClassEval < Formula
  class_eval("depends_" + "on \"automattic/kandelo-homebrew/dep-a\"")
end
RUBY
  expect_static_closure_failure class-eval "a dependency built through class_eval"

  cat >"$tap/Formula/patch-execution.rb" <<'RUBY'
class PatchExecution < Formula
  patch do
    PatchExecution.singleton_class.instance_method(("depends_" + "on").to_sym).bind_call(
      PatchExecution,
      "automattic/kandelo-homebrew/dep-a",
    )
  end
end
RUBY
  expect_static_closure_failure patch-execution "executable dependency dispatch in a patch block"

  cat >"$tap/Formula/on-macos-argument.rb" <<'RUBY'
class OnMacosArgument < Formula
  on_macos(system("touch", "/tmp/untrusted-formula-block")) do
  end
end
RUBY
  expect_static_closure_failure on-macos-argument "executable arguments on an on_macos block"

  cat >"$tap/Formula/patch-argument.rb" <<'RUBY'
class PatchArgument < Formula
  patch(system("touch", "/tmp/untrusted-formula-block")) do
  end
end
RUBY
  expect_static_closure_failure patch-argument "executable arguments on a patch block"

  cat >"$tap/Formula/test-argument.rb" <<'RUBY'
class TestArgument < Formula
  test(system("touch", "/tmp/untrusted-formula-block")) do
  end
end
RUBY
  expect_static_closure_failure test-argument "executable arguments on a test block"

  cat >"$tap/Formula/private-hook.rb" <<'RUBY'
class PrivateHook < Formula
  private

  def recursive_dependencies
    []
  end
end
RUBY
  expect_static_closure_failure private-hook "a private Formula dependency hook override"

  cat >"$tap/Formula/private-copy-hook.rb" <<'RUBY'
class PrivateCopyHook < Formula
  private

  def initialize_copy(other)
    super
  end
end
RUBY
  expect_static_closure_failure private-copy-hook "a private Ruby initialization hook override"

  cat >"$tap/Formula/foreign-include.rb" <<'RUBY'
class ForeignInclude < Formula
  include DependencyDeclaringSupport
end
RUBY
  expect_static_closure_failure foreign-include "an alternate class-body support module"

  mkdir -p "$tap/Kandelo/formula_support"
  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  KANDELO_TAP_FORMULA_PREFIX = "automattic/kandelo-homebrew/"

  def formula_opt_prefix(name)
    name.delete_prefix(KANDELO_TAP_FORMULA_PREFIX)
  end

  def kandelo_fixture
    "fixture"
  end
end
RUBY
  cat >"$tap/Formula/support-ok.rb" <<'RUBY'
require (Tap.fetch("automattic", "kandelo-homebrew").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class SupportOk < Formula
  include KandeloFormulaSupport
  depends_on "automattic/kandelo-homebrew/dep-a"
end
RUBY
  output="$(ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$tap" Automattic/kandelo-homebrew support-ok)"
  [ "$output" = $'automattic/kandelo-homebrew/dep-a\nautomattic/kandelo-homebrew/dep-b' ] ||
    fail "static Formula resolver rejected a canonical benign support module: $output"

  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def self.included(formula)
    formula.singleton_class.instance_method(("depends_" + "on").to_sym).bind_call(
      formula,
      "automattic/kandelo-homebrew/dep-a",
    )
  end
end
RUBY
  cat >"$tap/Formula/support-hook.rb" <<'RUBY'
require (Tap.fetch("automattic", "kandelo-homebrew").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class SupportHook < Formula
  include KandeloFormulaSupport
end
RUBY
  expect_static_closure_failure support-hook "a load-time Kandelo support-module hook"

  cat >"$tap/Kandelo/formula_support/kandelo_formula_support.rb" <<'RUBY'
require "fileutils"
require "json"
require "shellwords"

module KandeloFormulaSupport
  def kandelo_fixture
  end
ensure
  Formula.singleton_class.instance_method(("depends_" + "on").to_sym).bind(Formula).call(
    "automattic/kandelo-homebrew/dep-a",
  )
end
RUBY
  cat >"$tap/Formula/support-ensure.rb" <<'RUBY'
require (Tap.fetch("automattic", "kandelo-homebrew").path/"Kandelo/formula_support/kandelo_formula_support").to_s

class SupportEnsure < Formula
  include KandeloFormulaSupport
end
RUBY
  expect_static_closure_failure support-ensure "an executable support-module ensure tail"

  cat >"$tap/Formula/uses-from-macos.rb" <<'RUBY'
class UsesFromMacos < Formula
  uses_from_macos "automattic/kandelo-homebrew/dep-a"
end
RUBY
  expect_static_closure_failure uses-from-macos "an alternate dependency DSL"

  cat >"$tap/Formula/deps-mutation.rb" <<'RUBY'
class DepsMutation < Formula
  deps << Dependency.new("automattic/kandelo-homebrew/dep-a")
end
RUBY
  expect_static_closure_failure deps-mutation "a direct dependency collector mutation"

  cat >"$tap/Formula/top-level.rb" <<'RUBY'
warn "unexpected Formula-load execution"

class TopLevel < Formula
  depends_on "automattic/kandelo-homebrew/dep-a"
end
RUBY
  expect_static_closure_failure top-level "an unsupported top-level executable statement"

  cat >"$tap/Formula/class-ensure.rb" <<'RUBY'
class ClassEnsure < Formula
  desc "fixture"
ensure
  singleton_class.instance_method(("depends_" + "on").to_sym).bind(self).call(
    "automattic/kandelo-homebrew/dep-a",
  )
end
RUBY
  expect_static_closure_failure class-ensure "an executable Formula class ensure tail"

  cat >"$tap/Formula/unnormalized.rb" <<'RUBY'
class Unnormalized < Formula
  depends_on "Automattic/kandelo-homebrew/dep-a"
end
RUBY
  expect_static_closure_failure unnormalized "an unnormalized same-tap dependency"

  cat >"$tap/Formula/unknown-tag.rb" <<'RUBY'
class UnknownTag < Formula
  depends_on "automattic/kandelo-homebrew/dep-a" => :mystery
end
RUBY
  expect_static_closure_failure unknown-tag "an unknown dependency tag"

  cat >"$tap/Formula/wrong-name.rb" <<'RUBY'
class Wrong < Formula
end
RUBY
  expect_static_closure_failure wrong-name "a Formula class that does not match its filename"

  cat >"$tap/Formula/cycle-a.rb" <<'RUBY'
class CycleA < Formula
  depends_on "automattic/kandelo-homebrew/cycle-b"
end
RUBY
  cat >"$tap/Formula/cycle-b.rb" <<'RUBY'
class CycleB < Formula
  depends_on "automattic/kandelo-homebrew/cycle-a"
end
RUBY
  expect_static_closure_failure cycle-a "a same-tap dependency cycle"

  mkdir -p "$TMPDIR/static-closure-symlink-tap"
  ln -s "$tap/Formula" "$TMPDIR/static-closure-symlink-tap/Formula"
  if ruby "$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb" \
    "$TMPDIR/static-closure-symlink-tap" Automattic/kandelo-homebrew root \
    >/dev/null 2>&1; then
    fail "static Formula resolver accepted a symlinked Formula directory"
  fi
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

assert_success_payload_size_bounds_are_final() {
  local tap="$TMPDIR/oversized-sidecar-tap"
  local payload="$TMPDIR/oversized-sidecar-payload"
  local err="$TMPDIR/oversized-sidecar.err"
  local link
  make_tap "$tap"
  mkdir -p "$tap/Kandelo/formula" "$tap/Kandelo/link"
  printf '{}\n' >"$tap/Kandelo/formula/hello.json"
  printf '{}\n' >"$tap/Kandelo/link/hello-1-rebuild0-wasm32.json"
  git -C "$tap" add Kandelo
  git -C "$tap" commit -q -m "add sidecar size fixtures"
  link="$(find "$tap/Kandelo/link" -mindepth 1 -maxdepth 1 -type f -print -quit)"

  for relative in \
    Kandelo/metadata.json \
    Kandelo/formula/hello.json \
    "Kandelo/link/$(basename "$link")"; do
    rm -rf "$payload"
    cp -a "$tap" "$payload"
    truncate -s "$((HOMEBREW_MAX_SIDECAR_JSON_BYTES + 1))" "$payload/$relative"
    if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
      --tap-root "$tap" \
      --sidecar-root "$payload" \
      --formula hello \
      --arch wasm32 \
      --release-tag bottles-abi-v15 \
      --status success \
      --dry-run \
      --no-lock >/dev/null 2>"$err"; then
      fail "sidecar publisher accepted oversized final $relative"
    fi
    grep -q "exceeds $HOMEBREW_MAX_SIDECAR_JSON_BYTES bytes" "$err" ||
      fail "sidecar publisher did not explain oversized final $relative"
  done

  rm -rf "$payload"
  cp -a "$tap" "$payload"
  truncate -s "$((HOMEBREW_MAX_SIDECAR_JSON_BYTES + 1))" \
    "$tap/Kandelo/formula/stale.json"
  git -C "$tap" add Kandelo/formula/stale.json
  git -C "$tap" commit -q -m "add stale oversized sidecar"
  if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
    --tap-root "$tap" \
    --sidecar-root "$payload" \
    --formula hello \
    --arch wasm32 \
    --release-tag bottles-abi-v15 \
    --status success \
    --dry-run \
    --no-lock >/dev/null 2>"$err"; then
    fail "sidecar publisher accepted an oversized stale file in the final merged tap"
  fi
  grep -q "exceeds $HOMEBREW_MAX_SIDECAR_JSON_BYTES bytes" "$err" ||
    fail "sidecar publisher did not explain an oversized stale file in the final merged tap"
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

assert_formula_composition_is_static_and_lossless() {
  local planned="$TMPDIR/formula-planned.rb"
  local current="$TMPDIR/formula-current.rb"
  local composed="$TMPDIR/formula-composed.rb"
  local malicious="$TMPDIR/formula-malicious.rb"
  local planned_digest current_digest

  cat >"$planned" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
end
EOF
  cat >"$current" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"
  end
end
EOF
  planned_digest="$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$planned")"
  current_digest="$(ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$current")"
  [ "$planned_digest" = "$current_digest" ] ||
    fail "Formula source digest treated a static sibling bottle as source drift"

  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$current" "$planned" \
    https://ghcr.io/v2/automattic/kandelo-homebrew \
    0 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    preserve \
    "$composed"
  grep -F 'wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"' \
    "$composed" >/dev/null || fail "Formula composer omitted the selected bottle tag"
  grep -F 'wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"' \
    "$composed" >/dev/null || fail "Formula composer dropped the refreshed sibling bottle tag"

  ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$current" "$planned" \
    https://ghcr.io/v2/automattic/kandelo-homebrew \
    1 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    discard \
    "$composed"
  grep -F 'rebuild 1' "$composed" >/dev/null ||
    fail "Formula composer did not apply the transitioned bottle rebuild"
  if grep -F 'wasm64_kandelo: "1111111111111111111111111111111111111111111111111111111111111111"' \
    "$composed" >/dev/null; then
    fail "Formula composer retained a sibling bottle across an identity transition"
  fi

  cat >"$malicious" <<'EOF'
class Hello < Formula
  desc "reviewed fixture"
  bottle { system "touch", "/tmp/untrusted" }
end
EOF
  if ruby "$REPO_ROOT/scripts/homebrew-formula-source-digest.rb" "$malicious" \
    >/dev/null 2>&1; then
    fail "Formula source digest accepted a noncanonical executable bottle block"
  fi
  if ruby "$REPO_ROOT/scripts/homebrew-compose-formula-bottle.rb" \
    "$malicious" "$planned" \
    https://ghcr.io/v2/automattic/kandelo-homebrew \
    0 wasm32_kandelo any_skip_relocation \
    2222222222222222222222222222222222222222222222222222222222222222 \
    preserve \
    "$composed" >/dev/null 2>&1; then
    fail "Formula composer accepted a noncanonical executable bottle block"
  fi
}

assert_matrix
assert_matrix_skips_unchanged_cache_key
assert_upload_dry_run
assert_upload_push_uses_relative_layer_path
assert_bottle_build_trusts_selected_tap
assert_bottle_build_forces_same_tap_dependencies
assert_dependency_pour_provenance_is_bounded
assert_static_formula_closure_is_fail_closed
assert_generator_rejects_mismatched_homebrew_commit
assert_build_handoff_is_minimal_and_validated
assert_build_handoff_rejects_untrusted_content
assert_upload_receipt_is_bound_to_build_handoff
assert_publish_handoff_is_exact_inert_data
assert_failure_preserves_metadata
assert_success_payload_size_bounds_are_final
assert_failure_reports_do_not_collide_within_one_second
assert_write_publish_requires_attached_branch_and_pushes_explicit_ref
assert_failed_payload_rejects_success_status
assert_rollback_preserves_metadata
assert_rollback_deletion_requires_reason
bash "$REPO_ROOT/scripts/test-homebrew-patched-launcher.sh"
assert_formula_composition_is_static_and_lossless
assert_publisher_trust_contract

echo "test-homebrew-publish-workflow.sh: ok"
