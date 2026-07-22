#!/usr/bin/env bash
# End-to-end regression for tap-native Homebrew sidecar generation and pour.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
TEST_FORBIDDEN_ROOT="/trusted/publisher/build-root"
MOCK_BIN="$TMPDIR/mock-bin"
mkdir -p "$MOCK_BIN"
cat >"$MOCK_BIN/oras" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = manifest ] && [ "${2:-}" = fetch ]; then
  jq -nS --arg digest "${MOCK_ORAS_DIGEST:?}" '{
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: $digest,
    size: 1
  }'
  exit 0
fi
echo "unexpected ORAS command in sidecar fixture: $*" >&2
exit 2
EOF
chmod +x "$MOCK_BIN/oras"
export PATH="$MOCK_BIN:$PATH"

if [ ! -f "$REPO_ROOT/sysroot/lib/libc.a" ] || [ -L "$REPO_ROOT/sysroot/lib/libc.a" ]; then
  echo "test-homebrew-tap-native-sidecars.sh: build sysroot/lib/libc.a first" >&2
  exit 2
fi
if [ ! -f "$REPO_ROOT/sysroot64/lib/libc.a" ] || [ -L "$REPO_ROOT/sysroot64/lib/libc.a" ]; then
  echo "test-homebrew-tap-native-sidecars.sh: build sysroot64/lib/libc.a first" >&2
  exit 2
fi

ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"
TAP="$TMPDIR/tap"
DEP_OUT="$TMPDIR/dep-sidecars"
DEP64_OUT="$TMPDIR/dep64-sidecars"
TOOL_OUT="$TMPDIR/tool-sidecars"
TOOL64_OUT="$TMPDIR/tool64-sidecars"
BOTTLE_CACHE="$TMPDIR/bottle-cache"
mkdir -p "$TAP/Formula" "$BOTTLE_CACHE"

cat >"$TAP/Formula/sidecar-dep.rb" <<'RUBY'
class SidecarDep < Formula
  desc "Tap-native sidecar dependency fixture"
  homepage "https://example.invalid/sidecar-dep"
  url "https://example.invalid/sidecar-dep-1.0.tar.gz"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
end
RUBY

cat >"$TAP/Formula/sidecar-tool.rb" <<'RUBY'
class SidecarTool < Formula
  desc "Tap-native sidecar consumer fixture"
  homepage "https://example.invalid/sidecar-tool"
  url "https://example.invalid/sidecar-tool-2.0.tar.gz"
  sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  revision 3
  depends_on "kandelo-dev/tap-core/sidecar-dep"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm64_kandelo: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  end
end
RUBY

cat >"$TAP/Formula/sidecar-optional.rb" <<'RUBY'
class SidecarOptional < Formula
  desc "Optional tap-native sidecar dependency fixture"
  homepage "https://example.invalid/sidecar-optional"
  url "https://example.invalid/sidecar-optional-3.0.tar.gz"
  sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
end
RUBY

git -C "$TAP" init -q
git -C "$TAP" config user.name "Kandelo Test"
git -C "$TAP" config user.email "kandelo-test@example.invalid"
git -C "$TAP" add Formula
git -C "$TAP" commit -q -m "add tap-native fixture formulae"
TAP_SOURCE_COMMIT="$(git -C "$TAP" rev-parse HEAD)"
KANDELO_SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"

HOMEBREW_BREW_COMMIT=34c40c18ffa2029b611b61c73273e32c003d0842
export HOMEBREW_BREW_COMMIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fixture_bottle_filename() {
  local formula="$1" version="$2" arch="$3" rebuild="$4" rebuild_suffix=""
  if [ "$rebuild" != "0" ]; then
    rebuild_suffix=".$rebuild"
  fi
  printf '%s--%s.%s_kandelo.bottle%s.tar.gz\n' \
    "$formula" "$version" "$arch" "$rebuild_suffix"
}

WASM32_SYSROOT_FINGERPRINT="$(sha256_file "$REPO_ROOT/sysroot/lib/libc.a")"
WASM64_SYSROOT_FINGERPRINT="$(sha256_file "$REPO_ROOT/sysroot64/lib/libc.a")"
if [ "$WASM32_SYSROOT_FINGERPRINT" = "$WASM64_SYSROOT_FINGERPRINT" ]; then
  echo "test-homebrew-tap-native-sidecars.sh: wasm32 and wasm64 sysroot fingerprints must differ" >&2
  exit 2
fi

write_dependency_provenance() {
  local formula="$1" arch="$2" tap_commit="$3" out="$4"
  local dependencies dependency_formula_sha dependency_sha
  dependencies='[]'
  if [ "$formula" = "sidecar-tool" ]; then
    dependency_formula_sha="$(sha256_file "$TAP/Formula/sidecar-dep.rb")"
    case "$arch" in
      wasm32) dependency_sha="${dep_bottle[2]}" ;;
      wasm64) dependency_sha="${dep64_bottle[2]}" ;;
      *) echo "unsupported fixture architecture: $arch" >&2; exit 2 ;;
    esac
    dependencies="$(jq -nS \
      --arg arch "$arch" --arg tap_commit "$tap_commit" \
      --arg formula_sha "$dependency_formula_sha" --arg bottle_sha "$dependency_sha" '[{
        bottle: {
          cellar: "any_skip_relocation",
          rebuild: 0,
          sha256: $bottle_sha,
          tag: ($arch + "_kandelo"),
          url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/sidecar-dep/blobs/sha256:" + $bottle_sha)
        },
        declared_directly: true,
        formula: {path: "Formula/sidecar-dep.rb", sha256: $formula_sha},
        full_name: "kandelo-dev/tap-core/sidecar-dep",
        install_log: {
          fetch: [("==> Downloading https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/sidecar-dep/blobs/sha256:" + $bottle_sha)],
          pour: [("==> Pouring sidecar-dep--1.0." + $arch + "_kandelo.bottle.tar.gz")],
          source_build_absent: true
        },
        name: "sidecar-dep",
        receipt: {
          built_as_bottle: true,
          homebrew_version: "Homebrew fixture",
          installed_on_request: false,
          path: "Cellar/sidecar-dep/1.0/INSTALL_RECEIPT.json",
          poured_from_bottle: true,
          sha256: "3333333333333333333333333333333333333333333333333333333333333333",
          source_tap: "kandelo-dev/tap-core",
          source_tap_git_head: $tap_commit
        },
        version: "1.0"
      }]')"
  fi
  jq -nS \
    --arg formula "$formula" --arg arch "$arch" --arg tap_commit "$tap_commit" \
    --arg bottle_tag "${arch}_kandelo" --argjson dependencies "$dependencies" '{
      schema: 2,
      formula: $formula,
      arch: $arch,
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      tap_commit: $tap_commit,
      bottle_root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
      bottle_tag: $bottle_tag,
      dependencies: $dependencies
    }' >"$out"
}

make_publication_handoff() {
  local formula="$1" arch="$2" archive="$3" bottle_json="$4" sidecars="$5" out="$6"
  local tap_commit dependency_provenance oci_root
  tap_commit="$(jq -er '.tap_commit' "$sidecars/sidecars-input.json")"
  dependency_provenance="$TMPDIR/${formula}-${arch}-dependency-provenance.json"
  write_dependency_provenance "$formula" "$arch" "$tap_commit" "$dependency_provenance"
  rm -rf "$out"
  mkdir -p "$out/composition"
  bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula "$formula" \
    --arch "$arch" \
    --release-tag "bottles-abi-v${ABI_VERSION}" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" \
    --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --bottle "$archive" \
    --bottle-json "$bottle_json" \
    --dependency-provenance "$dependency_provenance" \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --out "$out/build" >/dev/null
  oci_root="$TMPDIR/${formula}-${arch}-oci"
  rm -rf "$oci_root"
  mkdir -p "$oci_root"
  bash "$REPO_ROOT/scripts/homebrew-validate-build-handoff.sh" \
    --handoff "$out/build" \
    --formula "$formula" \
    --arch "$arch" \
    --release-tag "bottles-abi-v${ABI_VERSION}" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" \
    --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --tap-root "$TAP" \
    --out-bottle-json "$oci_root/bottle.json" >/dev/null
  python3 "$REPO_ROOT/scripts/homebrew-oci-layout.py" build-child \
    --formula "$formula" \
    --arch "$arch" \
    --abi "$ABI_VERSION" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" \
    --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --bottle "$archive" \
    --bottle-json "$oci_root/bottle.json" \
    --kandelo-root "$REPO_ROOT" \
    --tap-root "$TAP" \
    --out-layout "$oci_root/layout" \
    --out-receipt "$oci_root/receipt.json"
  MOCK_ORAS_DIGEST="$(jq -er '.oci.manifest.digest' "$oci_root/receipt.json")" \
    bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --layout "$oci_root/layout" \
    --layout-receipt "$oci_root/receipt.json" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula "$formula" \
    --out-json "$out/receipt.json" \
    --dry-run >/dev/null
  jq -S '.packages[0].bottles[0].bottle_file = "../build/bottle.tar.gz"' \
    "$sidecars/sidecars-input.json" >"$out/composition/sidecars-input.json"
}

validate_publication_handoff() {
  local formula="$1" arch="$2" handoff="$3" tap_root="$4" tap_commit="$5"
  bash "$REPO_ROOT/scripts/homebrew-validate-publish-handoff.sh" \
    --handoff "$handoff" \
    --formula "$formula" \
    --arch "$arch" \
    --release-tag "bottles-abi-v${ABI_VERSION}" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --tap-commit "$tap_commit" \
    --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
    --bottle-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --forbidden-root "$TEST_FORBIDDEN_ROOT" \
    --tap-root "$tap_root" >/dev/null
}

make_dep_bottle() {
  local stage="$TMPDIR/dep-stage/sidecar-dep/1.0"
  local filename
  filename="$(fixture_bottle_filename sidecar-dep 1.0 wasm32 0)"
  local archive="$TMPDIR/$filename"
  local bottle_json="$TMPDIR/sidecar-dep--1.0.wasm32_kandelo.bottle.json"
  mkdir -p "$stage/bin" "$stage/.brew"
  printf '#!/bin/sh\necho sidecar-dep\n' >"$stage/bin/sidecar-dep"
  chmod +x "$stage/bin/sidecar-dep"
  cp "$TAP/Formula/sidecar-dep.rb" "$stage/.brew/sidecar-dep.rb"
  jq -nS '{
    homebrew_version: "Homebrew fixture",
    changed_files: [],
    source_modified_time: 0,
    compiler: "clang",
    runtime_dependencies: [],
    source: {scm_revision: "fixture"},
    arch: "x86_64",
    built_on: {os: "Linux", os_version: "fixture"}
  }' >"$stage/INSTALL_RECEIPT.json"
  tar -czf "$archive" -C "$TMPDIR/dep-stage" sidecar-dep
  local sha bytes
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  jq -n \
    --arg sha "$sha" \
    --arg filename "$filename" \
    --arg tap_commit "$(git -C "$TAP" rev-parse HEAD)" \
    '{
      "kandelo-dev/tap-core/sidecar-dep": {
        formula: {
          name: "sidecar-dep",
          pkg_version: "1.0",
          path: "Library/Taps/kandelo-dev/homebrew-tap-core/Formula/sidecar-dep.rb",
          tap_git_path: "Formula/sidecar-dep.rb",
          tap_git_revision: $tap_commit
        },
        bottle: {
          root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
          cellar: "any_skip_relocation",
          rebuild: 0,
          tags: {
            wasm32_kandelo: {
              local_filename: $filename,
              sha256: $sha,
              tab: {runtime_dependencies: "untrusted bottle JSON inventory"},
              path_exec_files: ["bin/forged"],
              all_files: ["bin/forged"]
            }
          }
        }
      }
    }' >"$bottle_json"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

make_dep_wasm64_bottle() {
  local source_archive="$1" source_json="$2"
  local filename
  filename="$(fixture_bottle_filename sidecar-dep 1.0 wasm64 0)"
  local archive="$TMPDIR/$filename"
  local bottle_json="$TMPDIR/sidecar-dep--1.0.wasm64_kandelo.bottle.json"
  cp "$source_archive" "$archive"
  jq --arg filename "$filename" '
    .[] |= (
      .bottle.tags.wasm64_kandelo = .bottle.tags.wasm32_kandelo
      | del(.bottle.tags.wasm32_kandelo)
      | .bottle.tags.wasm64_kandelo.local_filename = $filename
    )
  ' "$source_json" >"$bottle_json"
  local sha bytes
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

make_tool_bottle() {
  local stage="$TMPDIR/tool-stage/sidecar-tool/2.0_3"
  local filename
  filename="$(fixture_bottle_filename sidecar-tool 2.0_3 wasm32 1)"
  local archive="$TMPDIR/$filename"
  local bottle_json="$TMPDIR/sidecar-tool--2.0_3.wasm32_kandelo.bottle.json"
  mkdir -p "$stage/bin" "$stage/include" "$stage/lib" "$stage/share/man/man1" \
    "$stage/share/info" "$stage/.brew"
  cat >"$TMPDIR/sidecar-tool.wat" <<WAT
(module
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION))
  (func (export "_start"))
  (func (export "wpk_fork_unwind_begin"))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin"))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state")))
WAT
  wat2wasm "$TMPDIR/sidecar-tool.wat" -o "$stage/bin/sidecar-tool"
  cp "$stage/bin/sidecar-tool" "$stage/bin/sidecar-tool-helper"
  chmod +x "$stage/bin/sidecar-tool" "$stage/bin/sidecar-tool-helper"
  printf '#define SIDECAR_TOOL 1\n' >"$stage/include/sidecar-tool.h"
  printf 'archive\n' >"$stage/lib/libsidecar-tool.a"
  printf 'sidecar-tool(1)\n' >"$stage/share/man/man1/sidecar-tool.1"
  printf 'generated index must not be linked\n' >"$stage/share/info/dir"
  cp "$TAP/Formula/sidecar-tool.rb" "$stage/.brew/sidecar-tool.rb"
  jq -nS '{
    homebrew_version: "Homebrew fixture",
    changed_files: [],
    source_modified_time: 0,
    compiler: "clang",
    runtime_dependencies: [{
      full_name: "kandelo-dev/tap-core/sidecar-dep",
      version: "1.0",
      declared_directly: true
    }],
    source: {scm_revision: "fixture"},
    arch: "x86_64",
    built_on: {os: "Linux", os_version: "fixture"}
  }' >"$stage/INSTALL_RECEIPT.json"
  tar -czf "$archive" -C "$TMPDIR/tool-stage" sidecar-tool
  local sha bytes
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  jq -n \
    --arg sha "$sha" \
    --arg filename "$filename" \
    --arg tap_commit "$(git -C "$TAP" rev-parse HEAD)" \
    '{
      "kandelo-dev/tap-core/sidecar-tool": {
        formula: {
          name: "sidecar-tool",
          pkg_version: "2.0_3",
          path: "Library/Taps/kandelo-dev/homebrew-tap-core/Formula/sidecar-tool.rb",
          tap_git_path: "Formula/sidecar-tool.rb",
          tap_git_revision: $tap_commit
        },
        bottle: {
          root_url: "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
          cellar: "any_skip_relocation",
          rebuild: 1,
          tags: {
            wasm32_kandelo: {
              local_filename: $filename,
              sha256: $sha,
              tab: {runtime_dependencies: "untrusted bottle JSON inventory"},
              path_exec_files: ["bin/forged"],
              all_files: ["bin/forged"]
            }
          }
        }
      }
    }' >"$bottle_json"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

make_tool_wasm64_bottle() {
  local source_archive="$1" source_json="$2"
  local stage_parent="$TMPDIR/tool-stage-wasm64"
  local stage="$stage_parent/sidecar-tool/2.0_3"
  local filename
  filename="$(fixture_bottle_filename sidecar-tool 2.0_3 wasm64 1)"
  local archive="$TMPDIR/$filename"
  local bottle_json="$TMPDIR/sidecar-tool--2.0_3.wasm64_kandelo.bottle.json"
  rm -rf "$stage_parent"
  mkdir -p "$stage_parent"
  tar -xzf "$source_archive" -C "$stage_parent"
  cat >"$TMPDIR/sidecar-tool-wasm64.wat" <<WAT
(module
  (memory i64 1)
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION))
  (func (export "wpk_fork_unwind_begin"))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin"))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state")))
WAT
  wat2wasm --enable-memory64 "$TMPDIR/sidecar-tool-wasm64.wat" \
    -o "$stage/bin/sidecar-tool"
  cp "$stage/bin/sidecar-tool" "$stage/bin/sidecar-tool-helper"
  chmod +x "$stage/bin/sidecar-tool" "$stage/bin/sidecar-tool-helper"
  tar -czf "$archive" -C "$stage_parent" sidecar-tool
  local sha bytes
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  jq --arg sha "$sha" --arg filename "$filename" '
    .[] |= (
      .bottle.tags.wasm64_kandelo = .bottle.tags.wasm32_kandelo
      | del(.bottle.tags.wasm32_kandelo)
      | .bottle.tags.wasm64_kandelo.sha256 = $sha
      | .bottle.tags.wasm64_kandelo.local_filename = $filename
    )
  ' "$source_json" >"$bottle_json"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

repack_fixture_bottle() {
  local stage_parent="$1" formula="$2" raw_json="$3" arch="$4" label="$5"
  local formula_key version rebuild filename fixture_dir archive bottle_json
  formula_key="$(jq -er 'keys[0]' "$raw_json")"
  version="$(jq -er --arg key "$formula_key" '.[$key].formula.pkg_version' "$raw_json")"
  rebuild="$(jq -er --arg key "$formula_key" '.[$key].bottle.rebuild' "$raw_json")"
  filename="$(fixture_bottle_filename "$formula" "$version" "$arch" "$rebuild")"
  fixture_dir="$TMPDIR/repacked-$label"
  rm -rf "$fixture_dir"
  mkdir -p "$fixture_dir"
  archive="$fixture_dir/$filename"
  bottle_json="$fixture_dir/${formula}--${version}.${arch}_kandelo.bottle.json"
  local sha bytes
  tar -czf "$archive" -C "$stage_parent" "$formula"
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  jq --arg tag "${arch}_kandelo" --arg sha "$sha" --arg filename "$filename" \
    '.[] |= (
      .bottle.tags[$tag].sha256 = $sha |
      .bottle.tags[$tag].local_filename = $filename
    )' \
    "$raw_json" >"$bottle_json"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

generate_sidecars() {
  local formula="$1" archive="$2" bottle_json="$3" sha="$4" bytes="$5" out="$6"
  local arch="${SIDECAR_TEST_ARCH:-wasm32}"
  local bottle_filename
  local merged_tap="${out}-merged-tap"
  local canonical_json="${out}-merge-bottle.json"
  local dependency_provenance="${out}-dependency-provenance.json"
  local runtime_evidence="${out}-runtime-evidence.json"
  local tap_commit provenance_sha runtime_provenance_sha
  local runtime_dependency_bottle_sha runtime_dependency_receipt_sha version
  bottle_filename="$(basename "$archive")"
  tap_commit="$(git -C "$TAP" rev-parse HEAD)"
  rm -rf "$merged_tap" "$out"
  cp -a "$TAP" "$merged_tap"
  mkdir -p "$out"
  jq -e --arg formula "$formula" --arg tag "${arch}_kandelo" '
    if type != "object" or length != 1 then
      error("expected one raw bottle entry")
    else
      to_entries[0].value as $entry |
      {($formula): {
        formula: {
          name: $entry.formula.name,
          path: $entry.formula.path,
          pkg_version: $entry.formula.pkg_version
        },
        bottle: {
          root_url: $entry.bottle.root_url,
          cellar: $entry.bottle.cellar,
          rebuild: $entry.bottle.rebuild,
          tags: {($tag): {sha256: $entry.bottle.tags[$tag].sha256}}
        }
      }}
    end
  ' \
    "$bottle_json" >"$canonical_json"
  write_dependency_provenance \
    "$formula" "$arch" "$tap_commit" "$dependency_provenance"
  bash "$REPO_ROOT/scripts/homebrew-merge-bottle-json.sh" \
    --tap-root "$merged_tap" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula "$formula" \
    --arch "$arch" \
    --release-tag "bottles-abi-v${ABI_VERSION}" \
    --bottle-json "$canonical_json" \
    --expected-sha256 "$sha" \
    --expected-root-url https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
    --expected-cellar any_skip_relocation >/dev/null
  provenance_sha="$(sha256_file "$dependency_provenance")"
  runtime_provenance_sha="${SIDECAR_RUNTIME_PROVENANCE_SHA:-$provenance_sha}"
  runtime_dependency_bottle_sha="${SIDECAR_RUNTIME_DEPENDENCY_BOTTLE_SHA:-}"
  runtime_dependency_receipt_sha="${SIDECAR_RUNTIME_DEPENDENCY_RECEIPT_SHA:-}"
  version="$(jq -er --arg formula "$formula" '.[$formula].formula.pkg_version' \
    "$canonical_json")"
  jq -nS \
    --arg formula "$formula" \
    --arg arch "$arch" \
    --argjson abi "$ABI_VERSION" \
    --arg tap_commit "$tap_commit" \
    --arg sha "$sha" \
    --argjson bytes "$bytes" \
    --arg version "$version" \
    --arg bottle_filename "$bottle_filename" \
    --arg provenance_sha "$runtime_provenance_sha" \
    --arg runtime_dependency_bottle_sha "$runtime_dependency_bottle_sha" \
    --arg runtime_dependency_receipt_sha "$runtime_dependency_receipt_sha" \
    --slurpfile provenance "$dependency_provenance" '{
      schema: 2,
      formula: $formula,
      arch: $arch,
      abi: $abi,
      tap: {
        repository: "kandelo-dev/homebrew-tap-core",
        name: "kandelo-dev/tap-core",
        commit: $tap_commit
      },
      bottle: {
        bytes: $bytes,
        sha256: $sha,
        tag: ($arch + "_kandelo"),
        url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/" + $formula + "/blobs/sha256:" + $sha),
        version: $version
      },
      dependencies: {
        provenance_sha256: $provenance_sha,
        bottles: [
          $provenance[0].dependencies[] | {
            full_name: .full_name,
            version: .version,
            sha256: (
              if $runtime_dependency_bottle_sha == "" then
                .bottle.sha256
              else
                $runtime_dependency_bottle_sha
              end
            ),
            tag: .bottle.tag,
            receipt_sha256: (
              if $runtime_dependency_receipt_sha == "" then
                .receipt.sha256
              else
                $runtime_dependency_receipt_sha
              end
            )
          }
        ]
      },
      selection: {
        schema: 1,
        status: "success",
        bottle: {
          bytes: $bytes,
          mode: "local-dry-run",
          sha256: $sha,
          url: ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/" + $formula + "/blobs/sha256:" + $sha)
        },
        fetch: [("selected local bottle sha256:" + $sha)]
      },
      target: {
        install_log: {
          fetch: [("selected local bottle sha256:" + $sha)],
          pour: [("==> Pouring " + $bottle_filename)],
          source_build_absent: true
        },
        receipt: {
          built_as_bottle: true,
          homebrew_version: "Homebrew fixture",
          installed_on_request: true,
          path: ("Cellar/" + $formula + "/" + $version + "/INSTALL_RECEIPT.json"),
          poured_from_bottle: true,
          sha256: "4444444444444444444444444444444444444444444444444444444444444444",
          source_tap: "kandelo-dev/tap-core",
          source_tap_git_head: $tap_commit
        }
      },
      node: {
        argv: ["/tmp/sidecar-fixture.wasm"],
        launcher: "kandelo_run_wasm",
        receipt_sha256: "5555555555555555555555555555555555555555555555555555555555555555",
        runtime: "node",
        status: "success"
      }
    }' >"$runtime_evidence"
  KANDELO_HOMEBREW_TAP_ROOT="$merged_tap" \
  KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$TAP" \
  KANDELO_HOMEBREW_SIDECAR_ROOT="$out" \
  KANDELO_HOMEBREW_FORMULA="$formula" \
  KANDELO_HOMEBREW_ARCH="$arch" \
  KANDELO_HOMEBREW_RELEASE_TAG="bottles-abi-v${ABI_VERSION}" \
  KANDELO_HOMEBREW_TAP_REPOSITORY=kandelo-dev/homebrew-tap-core \
  KANDELO_HOMEBREW_TAP_NAME=kandelo-dev/tap-core \
  KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$archive" \
  KANDELO_HOMEBREW_BOTTLE_JSON="$canonical_json" \
  KANDELO_HOMEBREW_BOTTLE_ROOT_URL=https://ghcr.io/v2/kandelo-dev/homebrew-tap-core \
  KANDELO_HOMEBREW_BOTTLE_URL="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/${formula}/blobs/sha256:${sha}" \
  KANDELO_HOMEBREW_BOTTLE_SHA256="$sha" \
  KANDELO_HOMEBREW_BOTTLE_BYTES="$bytes" \
  KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE="$dependency_provenance" \
  KANDELO_HOMEBREW_RUNTIME_EVIDENCE="$runtime_evidence" \
  KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON='["/trusted/publisher/build-root"]' \
  HOMEBREW_BREW_COMMIT="$HOMEBREW_BREW_COMMIT" \
    bash "$REPO_ROOT/scripts/homebrew-generate-sidecars-from-env.sh"
}

expect_generate_failure() {
  local label="$1" pattern="$2"
  shift 2
  local stdout="$TMPDIR/$label.out" stderr="$TMPDIR/$label.err"
  if generate_sidecars "$@" >"$stdout" 2>"$stderr"; then
    echo "expected sidecar generation failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$pattern" "$stderr"; then
    echo "sidecar generation failed for the wrong reason: $label" >&2
    cat "$stderr" >&2
    exit 1
  fi
}

mapfile -t dep_bottle < <(make_dep_bottle)
mapfile -t dep64_bottle < <(make_dep_wasm64_bottle "${dep_bottle[0]}" "${dep_bottle[1]}")
generate_sidecars sidecar-dep "${dep_bottle[@]}" "$DEP_OUT"
SIDECAR_TEST_ARCH=wasm64 generate_sidecars sidecar-dep "${dep64_bottle[@]}" "$DEP64_OUT"
jq -e \
  --arg wasm32 "$WASM32_SYSROOT_FINGERPRINT" \
  --arg wasm64 "$WASM64_SYSROOT_FINGERPRINT" '
    .packages[0].bottles[0].arch == "wasm64" and
    .packages[0].bottles[0].build.sysroot_fingerprint == $wasm64 and
    .packages[0].bottles[0].build.sysroot_fingerprint != $wasm32
  ' "$DEP64_OUT/sidecars-input.json" >/dev/null || {
    echo "wasm64 sidecar input did not fingerprint sysroot64/lib/libc.a" >&2
    exit 1
  }

cp "$TAP/Formula/sidecar-dep.rb" "$TMPDIR/sidecar-dep.original.rb"
python3 - "$TAP/Formula/sidecar-dep.rb" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(text.replace("\nend\n", '\n  depends_on "cmake"\nend\n'), encoding="utf-8")
PY
cp "$TAP/Formula/sidecar-dep.rb" \
  "$TMPDIR/dep-stage/sidecar-dep/1.0/.brew/sidecar-dep.rb"
mapfile -t external_required_bottle < <(repack_fixture_bottle \
  "$TMPDIR/dep-stage" sidecar-dep "${dep_bottle[1]}" wasm32 \
  sidecar-dep-external-required)
expect_generate_failure external-required \
  'required external Formula dependencies are unsupported in the runtime closure: ["kandelo-dev/tap-core/sidecar-dep:cmake"]' \
  sidecar-dep "${external_required_bottle[@]}" \
  "$TMPDIR/external-required-sidecars"
cp "$TMPDIR/sidecar-dep.original.rb" "$TAP/Formula/sidecar-dep.rb"
cp "$TMPDIR/sidecar-dep.original.rb" \
  "$TMPDIR/dep-stage/sidecar-dep/1.0/.brew/sidecar-dep.rb"

DEP_HANDOFF="$TMPDIR/dep-publication-handoff"
DEP64_HANDOFF="$TMPDIR/dep64-publication-handoff"
make_publication_handoff sidecar-dep wasm32 \
  "${dep_bottle[0]}" "${dep_bottle[1]}" "$DEP_OUT" "$DEP_HANDOFF"
validate_publication_handoff sidecar-dep wasm32 "$DEP_HANDOFF" "$TAP" "$TAP_SOURCE_COMMIT"
bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
  --kandelo-root "$REPO_ROOT" \
  --tap-root "$TAP" \
  --publication-handoff "$DEP_HANDOFF" \
  --formula sidecar-dep \
  --arch wasm32 \
  --release-tag "bottles-abi-v${ABI_VERSION}" \
  --status success \
  --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
  --tap-commit "$TAP_SOURCE_COMMIT" \
  --dry-run \
  --no-lock >/dev/null
make_publication_handoff sidecar-dep wasm64 \
  "${dep64_bottle[0]}" "${dep64_bottle[1]}" "$DEP64_OUT" "$DEP64_HANDOFF"
DEP64_VALIDATION_TAP="$TMPDIR/dep64-validation-tap"
git -C "$TAP" worktree add --detach "$DEP64_VALIDATION_TAP" "$TAP_SOURCE_COMMIT" >/dev/null
validate_publication_handoff sidecar-dep wasm64 \
  "$DEP64_HANDOFF" "$DEP64_VALIDATION_TAP" "$TAP_SOURCE_COMMIT"
git -C "$TAP" worktree remove --force "$DEP64_VALIDATION_TAP" >/dev/null
bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
  --kandelo-root "$REPO_ROOT" \
  --tap-root "$TAP" \
  --publication-handoff "$DEP64_HANDOFF" \
  --formula sidecar-dep \
  --arch wasm64 \
  --release-tag "bottles-abi-v${ABI_VERSION}" \
  --status success \
  --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
  --tap-commit "$TAP_SOURCE_COMMIT" \
  --dry-run \
  --no-lock >/dev/null
DEP64_REPORT="$TAP/Kandelo/reports/sidecar-dep-1.0-rebuild0-wasm64.provenance.json"
jq -e \
  --arg wasm32 "$WASM32_SYSROOT_FINGERPRINT" \
  --arg wasm64 "$WASM64_SYSROOT_FINGERPRINT" '
    .subject.arch == "wasm64" and
    .build.sysroot_fingerprint == $wasm64 and
    .build.sysroot_fingerprint != $wasm32
  ' "$DEP64_REPORT" >/dev/null || {
    echo "generated wasm64 bottle provenance did not fingerprint sysroot64/lib/libc.a" >&2
    exit 1
  }

jq '.packages += [{
  name: "sidecar-tool",
  version: "1.9",
  formula_revision: 2,
  bottle_rebuild: 0,
  bottles: [{
    arch: "wasm64",
    bottle_tag: "wasm64_kandelo",
    status: "success",
    sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  }]
}]' "$TAP/Kandelo/metadata.json" >"$TMPDIR/old-identity-metadata.json"
mv "$TMPDIR/old-identity-metadata.json" "$TAP/Kandelo/metadata.json"
git -C "$TAP" add Kandelo/metadata.json
git -C "$TAP" commit -q -m "seed prior sidecar-tool bottle identity"

TOOL_PLAN_COMMIT="$(git -C "$TAP" rev-parse HEAD)"
mapfile -t tool_bottle < <(make_tool_bottle)
mapfile -t tool64_bottle < <(make_tool_wasm64_bottle \
  "${tool_bottle[0]}" "${tool_bottle[1]}")

cp "$TAP/Formula/sidecar-tool.rb" "$TMPDIR/sidecar-tool.original.rb"
cp "$TMPDIR/tool-stage/sidecar-tool/2.0_3/INSTALL_RECEIPT.json" \
  "$TMPDIR/sidecar-tool.original-receipt.json"
python3 - "$TAP/Formula/sidecar-tool.rb" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(
    text.replace(
        "  bottle do\n",
        '  depends_on "bubblewrap" => :optional\n\n  bottle do\n',
    ),
    encoding="utf-8",
)
PY
cp "$TAP/Formula/sidecar-tool.rb" \
  "$TMPDIR/tool-stage/sidecar-tool/2.0_3/.brew/sidecar-tool.rb"
jq '.runtime_dependencies += [{
  full_name: "bubblewrap", version: "0.11.2", declared_directly: true
}]' "$TMPDIR/sidecar-tool.original-receipt.json" \
  >"$TMPDIR/tool-stage/sidecar-tool/2.0_3/INSTALL_RECEIPT.json"
mapfile -t selected_external_bottle < <(repack_fixture_bottle \
  "$TMPDIR/tool-stage" sidecar-tool "${tool_bottle[1]}" wasm32 \
  sidecar-tool-selected-external)
expect_generate_failure selected-conditional-external \
  "runtime dependency 'bubblewrap' lacks validated provenance" \
  sidecar-tool "${selected_external_bottle[@]}" \
  "$TMPDIR/selected-external-sidecars"

cp "$TMPDIR/sidecar-tool.original.rb" "$TAP/Formula/sidecar-tool.rb"
cp "$TMPDIR/sidecar-tool.original.rb" \
  "$TMPDIR/tool-stage/sidecar-tool/2.0_3/.brew/sidecar-tool.rb"
jq '.runtime_dependencies = [{
  full_name: "libcap", version: "2.78", declared_directly: false
}]' "$TMPDIR/sidecar-tool.original-receipt.json" \
  >"$TMPDIR/tool-stage/sidecar-tool/2.0_3/INSTALL_RECEIPT.json"
mapfile -t transitive_external_bottle < <(repack_fixture_bottle \
  "$TMPDIR/tool-stage" sidecar-tool "${tool_bottle[1]}" wasm32 \
  sidecar-tool-transitive-external)
expect_generate_failure transitive-external \
  "runtime dependency 'libcap' lacks validated provenance" \
  sidecar-tool "${transitive_external_bottle[@]}" \
  "$TMPDIR/transitive-external-sidecars"
cp "$TMPDIR/sidecar-tool.original-receipt.json" \
  "$TMPDIR/tool-stage/sidecar-tool/2.0_3/INSTALL_RECEIPT.json"

cp "$TMPDIR/sidecar-tool.original.rb" "$TAP/Formula/sidecar-tool.rb"
python3 - "$TAP/Formula/sidecar-tool.rb" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(
    text.replace(
        "  bottle do\n",
        '  depends_on "kandelo-dev/tap-core/sidecar-optional" => :optional\n\n'
        "  bottle do\n",
    ),
    encoding="utf-8",
)
PY
cp "$TAP/Formula/sidecar-tool.rb" \
  "$TMPDIR/tool-stage/sidecar-tool/2.0_3/.brew/sidecar-tool.rb"
mapfile -t optional_absent_bottle < <(repack_fixture_bottle \
  "$TMPDIR/tool-stage" sidecar-tool "${tool_bottle[1]}" wasm32 \
  sidecar-tool-optional-absent)
OPTIONAL_ABSENT_OUT="$TMPDIR/optional-absent-sidecars"
generate_sidecars sidecar-tool "${optional_absent_bottle[@]}" "$OPTIONAL_ABSENT_OUT"
jq -e '.packages[0].dependencies == [{"name":"sidecar-dep","full_name":"kandelo-dev/tap-core/sidecar-dep","version":"1.0"}]' \
  "$OPTIONAL_ABSENT_OUT/sidecars-input.json" >/dev/null

cp "$TMPDIR/sidecar-tool.original.rb" "$TAP/Formula/sidecar-tool.rb"
cp "$TMPDIR/sidecar-tool.original.rb" \
  "$TMPDIR/tool-stage/sidecar-tool/2.0_3/.brew/sidecar-tool.rb"
generate_sidecars sidecar-tool "${tool_bottle[@]}" "$TOOL_OUT"
SIDECAR_TEST_ARCH=wasm64 generate_sidecars sidecar-tool "${tool64_bottle[@]}" "$TOOL64_OUT"
SIDECAR_RUNTIME_PROVENANCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SIDECAR_RUNTIME_DEPENDENCY_RECEIPT_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  generate_sidecars sidecar-tool "${tool_bottle[@]}" \
  "$TMPDIR/independent-runtime-dependency-evidence"
SIDECAR_RUNTIME_DEPENDENCY_BOTTLE_SHA=0000000000000000000000000000000000000000000000000000000000000000 \
  expect_generate_failure runtime-dependency-bottle-drift \
  "runtime evidence dependency closure does not match" \
  sidecar-tool "${tool_bottle[@]}" "$TMPDIR/runtime-dependency-bottle-drift"

TOOL_HANDOFF="$TMPDIR/tool-publication-handoff"
TOOL64_HANDOFF="$TMPDIR/tool64-publication-handoff"
make_publication_handoff sidecar-tool wasm32 \
  "${tool_bottle[0]}" "${tool_bottle[1]}" "$TOOL_OUT" "$TOOL_HANDOFF"
make_publication_handoff sidecar-tool wasm64 \
  "${tool64_bottle[0]}" "${tool64_bottle[1]}" "$TOOL64_OUT" "$TOOL64_HANDOFF"
validate_publication_handoff sidecar-tool wasm32 "$TOOL_HANDOFF" "$TAP" "$TOOL_PLAN_COMMIT"
validate_publication_handoff sidecar-tool wasm64 "$TOOL64_HANDOFF" "$TAP" "$TOOL_PLAN_COMMIT"

CHANGED_TAP="$TMPDIR/changed-tap"
CHANGED_TAP_ERROR="$TMPDIR/changed-tap.err"
git clone -q "$TAP" "$CHANGED_TAP"
git -C "$CHANGED_TAP" config user.name "Kandelo Test"
git -C "$CHANGED_TAP" config user.email "kandelo-test@example.invalid"
python3 - "$CHANGED_TAP/Formula/sidecar-tool.rb" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(
    text.replace("Tap-native sidecar consumer fixture", "Changed after bottle build"),
    encoding="utf-8",
)
PY
git -C "$CHANGED_TAP" add Formula/sidecar-tool.rb
git -C "$CHANGED_TAP" commit -q -m "change Formula after bottle build"
if bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
  --kandelo-root "$REPO_ROOT" \
  --tap-root "$CHANGED_TAP" \
  --publication-handoff "$TOOL_HANDOFF" \
  --formula sidecar-tool \
  --arch wasm32 \
  --release-tag "bottles-abi-v${ABI_VERSION}" \
  --status success \
  --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
  --tap-commit "$TOOL_PLAN_COMMIT" \
  --dry-run \
  --no-lock > /dev/null 2>"$CHANGED_TAP_ERROR"; then
  echo "publisher accepted a bottle built from stale Formula source" >&2
  exit 1
fi
grep -F "Formula source changed after the bottle build" \
  "$CHANGED_TAP_ERROR" >/dev/null

bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
  --kandelo-root "$REPO_ROOT" \
  --tap-root "$TAP" \
  --publication-handoff "$TOOL_HANDOFF" \
  --formula sidecar-tool \
  --arch wasm32 \
  --release-tag "bottles-abi-v${ABI_VERSION}" \
  --status success \
  --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
  --tap-commit "$TOOL_PLAN_COMMIT" \
  --dry-run \
  --no-lock >/dev/null
if grep -F 'wasm64_kandelo: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"' \
  "$TAP/Formula/sidecar-tool.rb" >/dev/null; then
  echo "first transitioned publication retained the prior identity's sibling bottle" >&2
  exit 1
fi
jq -e '
  (.packages[] | select(.name == "sidecar-tool") |
    .version == "2.0_3" and .formula_revision == 3 and .bottle_rebuild == 1 and
    [.bottles[].arch] == ["wasm32"])
' "$TAP/Kandelo/metadata.json" >/dev/null
bash "$REPO_ROOT/scripts/homebrew-publish-sidecars.sh" \
  --kandelo-root "$REPO_ROOT" \
  --tap-root "$TAP" \
  --publication-handoff "$TOOL64_HANDOFF" \
  --formula sidecar-tool \
  --arch wasm64 \
  --release-tag "bottles-abi-v${ABI_VERSION}" \
  --status success \
  --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
  --tap-commit "$TOOL_PLAN_COMMIT" \
  --dry-run \
  --no-lock >/dev/null

[ ! -e "$REPO_ROOT/packages/registry/sidecar-dep" ]
[ ! -e "$REPO_ROOT/packages/registry/sidecar-tool" ]

jq -e --arg tool_sha "${tool_bottle[2]}" --arg tool64_sha "${tool64_bottle[2]}" '
  [.packages[].name] == ["sidecar-dep", "sidecar-tool"] and
  (.packages[] | select(.name == "sidecar-dep") |
    [.bottles[].arch] == ["wasm32","wasm64"]) and
  (.packages[] | select(.name == "sidecar-tool") |
    .version == "2.0_3" and
    .formula_revision == 3 and
    .bottle_rebuild == 1 and
    .dependencies == [{"name":"sidecar-dep","full_name":"kandelo-dev/tap-core/sidecar-dep","version":"1.0"}] and
    [.bottles[].arch] == ["wasm32","wasm64"] and
    .bottles[0].cache_key_sha == $tool_sha and
    .bottles[0].fork_instrumentation == "required" and
    .bottles[1].cache_key_sha == $tool64_sha and
    .bottles[1].fork_instrumentation == "required")
' "$TAP/Kandelo/metadata.json" >/dev/null
grep -F "wasm32_kandelo: \"${dep_bottle[2]}\"" "$TAP/Formula/sidecar-dep.rb" >/dev/null
grep -F "wasm64_kandelo: \"${dep64_bottle[2]}\"" "$TAP/Formula/sidecar-dep.rb" >/dev/null
grep -F "wasm32_kandelo: \"${tool_bottle[2]}\"" "$TAP/Formula/sidecar-tool.rb" >/dev/null
grep -F "wasm64_kandelo: \"${tool64_bottle[2]}\"" "$TAP/Formula/sidecar-tool.rb" >/dev/null
jq -e --arg expected "Homebrew source commit $HOMEBREW_BREW_COMMIT" '
  .packages[0].bottles[0].build.brew_version == $expected
' "$TOOL_OUT/sidecars-input.json" >/dev/null

TOOL_LINK="$TAP/Kandelo/link/sidecar-tool-2.0_3-rebuild1-wasm32.json"
jq -e '
  [.links[].target] == [
    "bin/sidecar-tool",
    "bin/sidecar-tool-helper",
    "include/sidecar-tool.h",
    "lib/libsidecar-tool.a",
    "share/man/man1/sidecar-tool.1"
  ] and
  .receipts == [".brew/sidecar-tool.rb", "INSTALL_RECEIPT.json"] and
  .env == {"PATH_prepend":["bin"]}
' "$TOOL_LINK" >/dev/null

cp "${dep_bottle[0]}" "$BOTTLE_CACHE/${dep_bottle[2]}.tar.gz"
cp "${tool_bottle[0]}" "$BOTTLE_CACHE/${tool_bottle[2]}.tar.gz"
BREWFILE="$TMPDIR/Brewfile"
cat > "$BREWFILE" <<'EOF'
tap "kandelo-dev/tap-core"
brew "kandelo-dev/tap-core/sidecar-tool"
EOF
BREWFILE_SHA256="$(sha256_file "$BREWFILE")"
BREWFILE_BYTES="$(wc -c < "$BREWFILE" | tr -d ' ')"
SHELL_CONFIG="$TMPDIR/shell.json"
printf '\357\273\277' > "$SHELL_CONFIG"
cat >> "$SHELL_CONFIG" <<'EOF'
{
  "version": 1,
  "path": "/home/linuxbrew/.linuxbrew/bin/sidecar-tool-helper",
  "argv": ["sidecar-tool-helper", "--interactive"]
}
EOF
SHELL_CONFIG_SHA256="$(sha256_file "$SHELL_CONFIG")"
SHELL_CONFIG_BYTES="$(wc -c < "$SHELL_CONFIG" | tr -d ' ')"
DEMO_CONFIG="$TMPDIR/demo.json"
cat > "$DEMO_CONFIG" <<'EOF'
{
  "version": 1,
  "profiles": {
    "selected": {
      "presentation": {
        "bootPrimary": "syslog",
        "runningPrimary": ["terminal", "syslog"],
        "terminalAccess": "primary",
        "internalsAccess": "drawer"
      }
    },
    "unselected": {
      "guide": { "title": "Still validated" }
    }
  }
}
EOF
DEMO_CONFIG_SHA256="$(sha256_file "$DEMO_CONFIG")"
DEMO_CONFIG_BYTES="$(wc -c < "$DEMO_CONFIG" | tr -d ' ')"
BASE_ROOT="$TMPDIR/base-root"
BASE_MANIFEST="$TMPDIR/base.MANIFEST"
BASE_IMAGE="$TMPDIR/base.vfs"
BAD_BASE_IMAGE="$TMPDIR/bad-base.vfs"
UNLABELED_BASE_IMAGE="$TMPDIR/unlabeled-base.vfs"
COMPOSED_MARKER_BASE_IMAGE="$TMPDIR/composed-marker-base.vfs"
BASE_RECORDED_MAX_BYTES=33554432
BASE_REQUESTED_MAX_BYTES=134217728
mkdir -p "$BASE_ROOT/etc"
printf '%s\n' 'base-image-marker' > "$BASE_ROOT/etc/base-image-marker"
cat > "$BASE_MANIFEST" <<'EOF'
/etc d 0755 0 0
/etc/base-image-marker f 0644 0 0
EOF
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" build \
  "$BASE_MANIFEST" "$BASE_ROOT" \
  --sab-size 16777216 \
  --max-size "$BASE_RECORDED_MAX_BYTES" \
  --kernel-abi "$ABI_VERSION" \
  -o "$BASE_IMAGE" >/dev/null
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" build \
  "$BASE_MANIFEST" "$BASE_ROOT" \
  --sab-size 16777216 \
  --max-size 134217728 \
  --kernel-abi "$((ABI_VERSION + 1))" \
  -o "$BAD_BASE_IMAGE" >/dev/null
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" build \
  "$BASE_MANIFEST" "$BASE_ROOT" \
  --sab-size 16777216 \
  --max-size 134217728 \
  -o "$UNLABELED_BASE_IMAGE" >/dev/null
npx tsx -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { MemoryFileSystem } from '$REPO_ROOT/host/src/vfs/memory-fs.ts';
(async () => {
  const fs = MemoryFileSystem.fromImage(new Uint8Array(readFileSync('$BASE_IMAGE')));
  const metadata = fs.getImageMetadata();
  if (!metadata) throw new Error('expected base metadata');
  const image = await fs.saveImage({
    metadata: {
      ...metadata,
      platformBase: { source: 'sidecar-test' },
      signature: 's'.repeat(55_000),
      provenance: { issuer: 'fixture-builder', subject: 'base-only' },
    },
  });
  writeFileSync('$BASE_IMAGE', image);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
" >/dev/null
BASE_IMAGE_SHA256="$(sha256_file "$BASE_IMAGE")"
BASE_IMAGE_BYTES="$(wc -c < "$BASE_IMAGE" | tr -d ' ')"
cp "$BASE_IMAGE" "$TMPDIR/base-image.bin"
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --base-image "$TMPDIR/base-image.bin" \
  --out "$TMPDIR/bad-extension.vfs.zst" \
  --report "$TMPDIR/bad-extension-report.json" \
  > /dev/null 2>"$TMPDIR/bad-extension.err"; then
  echo "Homebrew VFS builder accepted an ambiguous base-image extension" >&2
  exit 1
fi
grep -F -- "--base-image must end in .vfs or .vfs.zst" \
  "$TMPDIR/bad-extension.err" >/dev/null
cp "$BASE_IMAGE" "$COMPOSED_MARKER_BASE_IMAGE"
printf '%s\n' '{"schema":1}' > "$TMPDIR/homebrew-vfs.json"
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" add \
  "$COMPOSED_MARKER_BASE_IMAGE" /etc/kandelo --dir >/dev/null
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" add \
  "$COMPOSED_MARKER_BASE_IMAGE" /etc/kandelo/homebrew-vfs.json \
  --file "$TMPDIR/homebrew-vfs.json" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$UNLABELED_BASE_IMAGE" \
  --out "$TMPDIR/unlabeled-base-output.vfs.zst" \
  --report "$TMPDIR/unlabeled-base-report.json" \
  > /dev/null 2>"$TMPDIR/unlabeled-base.err"; then
  echo "Homebrew VFS builder accepted an unlabeled base image" >&2
  exit 1
fi
grep -F "does not declare its required kernel ABI" \
  "$TMPDIR/unlabeled-base.err" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$COMPOSED_MARKER_BASE_IMAGE" \
  --out "$TMPDIR/composed-marker-output.vfs.zst" \
  --report "$TMPDIR/composed-marker-report.json" \
  > /dev/null 2>"$TMPDIR/composed-marker.err"; then
  echo "Homebrew VFS builder accepted a base composition marker" >&2
  exit 1
fi
grep -F "already contains a Homebrew composition" \
  "$TMPDIR/composed-marker.err" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$BASE_IMAGE" \
  --max-bytes "$((BASE_RECORDED_MAX_BYTES + 1))" \
  --out "$TMPDIR/unaligned-output.vfs.zst" \
  --report "$TMPDIR/unaligned-report.json" \
  > /dev/null 2>"$TMPDIR/unaligned.err"; then
  echo "Homebrew VFS builder accepted an unaligned filesystem maximum" >&2
  exit 1
fi
grep -F -- "--max-bytes must be a multiple of 4096 bytes" \
  "$TMPDIR/unaligned.err" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$BAD_BASE_IMAGE" \
  --out "$TMPDIR/bad-base-output.vfs.zst" \
  --report "$TMPDIR/bad-base-report.json" \
  > /dev/null 2>"$TMPDIR/bad-base.err"; then
  echo "Homebrew VFS builder accepted an ABI-mismatched base image" >&2
  exit 1
fi
grep -F "but bottle metadata requires ABI $ABI_VERSION" \
  "$TMPDIR/bad-base.err" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --brewfile "$BREWFILE" \
  --package sidecar-tool \
  --out "$TMPDIR/mixed-selection.vfs.zst" \
  --report "$TMPDIR/mixed-selection-report.json" \
  > /dev/null 2>"$TMPDIR/mixed-selection.err"; then
  echo "Homebrew VFS builder accepted mixed package selection modes" >&2
  exit 1
fi
grep -F -- "--brewfile cannot be combined with --package" \
  "$TMPDIR/mixed-selection.err" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --brewfile "$BREWFILE" \
  --brewfile "$BREWFILE" \
  --out "$TMPDIR/repeated-brewfile.vfs.zst" \
  --report "$TMPDIR/repeated-brewfile-report.json" \
  > /dev/null 2>"$TMPDIR/repeated-brewfile.err"; then
  echo "Homebrew VFS builder accepted more than one --brewfile" >&2
  exit 1
fi
grep -F -- "--brewfile may be provided only once" \
  "$TMPDIR/repeated-brewfile.err" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --brewfile "$BREWFILE" \
  --shell-config "$SHELL_CONFIG" \
  --out "$TMPDIR/shell-without-profile.vfs.zst" \
  --report "$TMPDIR/shell-without-profile-report.json" \
  > /dev/null 2>"$TMPDIR/shell-without-profile.err"; then
  echo "Homebrew VFS builder accepted a default shell without profile setup" >&2
  exit 1
fi
grep -F -- "--shell-config requires --write-profile" \
  "$TMPDIR/shell-without-profile.err" >/dev/null

expect_demo_config_failure() {
  local config_path="$1"
  local fixture_name="$2"
  local expected="$3"
  if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
    --metadata "$TAP/Kandelo/metadata.json" \
    --tap-root "$TAP" \
    --package sidecar-tool \
    --demo-config "$config_path" \
    --out "$TMPDIR/demo-$fixture_name.vfs.zst" \
    --report "$TMPDIR/demo-$fixture_name-report.json" \
    > /dev/null 2>"$TMPDIR/demo-$fixture_name.err"; then
    echo "Homebrew VFS builder accepted invalid demo config fixture: $fixture_name" >&2
    exit 1
  fi
  grep -F -- "$expected" "$TMPDIR/demo-$fixture_name.err" >/dev/null
}

head -c 262145 /dev/zero > "$TMPDIR/demo-oversized.json"
expect_demo_config_failure \
  "$TMPDIR/demo-oversized.json" oversized "exceeds 262144 bytes"
ln -s "$DEMO_CONFIG" "$TMPDIR/demo-symlink.json"
expect_demo_config_failure \
  "$TMPDIR/demo-symlink.json" symlink "must be a regular non-symlink file"
printf '\377' > "$TMPDIR/demo-bad-utf8.json"
expect_demo_config_failure \
  "$TMPDIR/demo-bad-utf8.json" bad-utf8 "is not valid UTF-8"
printf '%s' '{"version":1' > "$TMPDIR/demo-bad-json.json"
expect_demo_config_failure \
  "$TMPDIR/demo-bad-json.json" bad-json "is not valid JSON"
printf '%s\n' '{"version":2}' > "$TMPDIR/demo-unsupported.json"
expect_demo_config_failure \
  "$TMPDIR/demo-unsupported.json" unsupported "has an unsupported version"
cat > "$TMPDIR/demo-malformed-unselected.json" <<'EOF'
{
  "version": 1,
  "profiles": {
    "selected": {},
    "unselected": {
      "presentation": {
        "bootPrimary": "syslog",
        "runningPrimary": ["not-a-surface"],
        "terminalAccess": "primary",
        "internalsAccess": "drawer"
      }
    }
  }
}
EOF
expect_demo_config_failure \
  "$TMPDIR/demo-malformed-unselected.json" malformed-unselected \
  "presentation.runningPrimary[0] must be one of"

npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --out "$TMPDIR/sidecar-tool-clean.vfs.zst" \
  --report "$TMPDIR/sidecar-tool-clean-report.json" >/dev/null
jq -e 'has("base_image") | not' \
  "$TMPDIR/sidecar-tool-clean-report.json" >/dev/null
npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$BASE_IMAGE" \
  --out "$TMPDIR/sidecar-tool-base-default.vfs.zst" \
  --report "$TMPDIR/sidecar-tool-base-default-report.json" >/dev/null
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$TMPDIR/sidecar-tool-base-default.vfs.zst" \
  --out "$TMPDIR/recomposed-output.vfs.zst" \
  --report "$TMPDIR/recomposed-report.json" \
  > /dev/null 2>"$TMPDIR/recomposed.err"; then
  echo "Homebrew VFS builder accepted composed image metadata" >&2
  exit 1
fi
grep -F "already contains a Homebrew composition" \
  "$TMPDIR/recomposed.err" >/dev/null
npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-dep \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$BASE_IMAGE" \
  --max-bytes "$BASE_REQUESTED_MAX_BYTES" \
  --write-profile \
  --no-fallback \
  --out "$TMPDIR/sidecar-dep-base.vfs.zst" \
  --report "$TMPDIR/sidecar-dep-base-report.json" >/dev/null
LAYER_BASE_VFS_SHA256="$(sha256_file "$TMPDIR/sidecar-dep-base.vfs.zst")"
LAYER_BASE_VFS_BYTES="$(wc -c <"$TMPDIR/sidecar-dep-base.vfs.zst" | tr -d '[:space:]')"
LAYER_BASE_PACKAGE_SOURCE="$TMPDIR/shell-package-output.json"
jq -nS \
  --arg output_sha256 "$LAYER_BASE_VFS_SHA256" \
  --argjson output_bytes "$LAYER_BASE_VFS_BYTES" \
  --argjson abi "$ABI_VERSION" \
  '{
    schema: 1,
    kind: "kandelo-package-output",
    index: {
      url: "https://packages.example.invalid/abi/index.toml",
      sha256: ("a" * 64),
      bytes: 123,
      abi: $abi
    },
    package: {
      name: "shell",
      version: "0.1.0",
      revision: 1,
      arch: "wasm32",
      cache_key_sha: ("b" * 64)
    },
    archive: {
      format: "kandelo-package-tar-zstd-v2",
      url: "https://packages.example.invalid/shell.tar.zst",
      sha256: ("c" * 64),
      bytes: 456
    },
    output: {
      name: "shell",
      path: "shell.vfs.zst",
      sha256: $output_sha256,
      bytes: $output_bytes
    }
  }' >"$LAYER_BASE_PACKAGE_SOURCE"
RUNTIME_LAYER_ID="sidecar-tool"
RUNTIME_LAYER_POLICY="$TMPDIR/runtime-layer-policy.json"
jq -nS --arg id "$RUNTIME_LAYER_ID" '{
  schema: 1,
  kind: "kandelo-homebrew-runtime-layer-policy",
  base_package: "shell",
  layers: [{
    id: $id,
    root_package: ("kandelo-dev/tap-core/" + $id)
  }]
}' >"$RUNTIME_LAYER_POLICY"
RUNTIME_LAYER_PAYLOAD="$TMPDIR/kandelo-homebrew-${RUNTIME_LAYER_ID}-layer.bin"
RUNTIME_LAYER_DESCRIPTOR="$TMPDIR/kandelo-homebrew-${RUNTIME_LAYER_ID}-layer.json"
npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --brewfile "$BREWFILE" \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$BASE_IMAGE" \
  --max-bytes "$BASE_REQUESTED_MAX_BYTES" \
  --write-profile \
  --shell-config "$SHELL_CONFIG" \
  --demo-config "$DEMO_CONFIG" \
  --no-fallback \
  --lazy-layer-out "$RUNTIME_LAYER_PAYLOAD" \
  --lazy-layer-descriptor "$RUNTIME_LAYER_DESCRIPTOR" \
  --lazy-layer-base-image "$TMPDIR/sidecar-dep-base.vfs.zst" \
  --lazy-layer-base-package-source "$LAYER_BASE_PACKAGE_SOURCE" \
  --runtime-layer-id "$RUNTIME_LAYER_ID" \
  --runtime-layer-policy "$RUNTIME_LAYER_POLICY" \
  --out "$TMPDIR/sidecar-tool.vfs.zst" \
  --report "$TMPDIR/sidecar-tool-report.json" >/dev/null

LAYER_ACCEPTANCE_VFS_SHA256="$(sha256_file "$TMPDIR/sidecar-tool.vfs.zst")"
jq -e '
  . as $descriptor |
  .schema == 4 and .kind == "kandelo-homebrew-deferred-layer-draft" and
  .mount_prefix == "/" and
  .selection.requested_packages == ["sidecar-tool"] and
  .selection.package_order == [
    "kandelo-dev/tap-core/sidecar-dep",
    "kandelo-dev/tap-core/sidecar-tool"
  ] and
  .selection.base_package_order == ["kandelo-dev/tap-core/sidecar-dep"] and
  .selection.layer_package_order == ["kandelo-dev/tap-core/sidecar-tool"] and
  [.packages.base[].name] == ["sidecar-dep"] and
  [.packages.layer[].name] == ["sidecar-tool"] and
  .base_vfs.sha256 == $base_vfs_sha and
  .base_vfs.package_source.output == {
    "name":"shell",
    "path":"shell.vfs.zst",
    "sha256":$base_vfs_sha,
    "bytes":$base_vfs_bytes
  } and
  .acceptance_vfs.sha256 == $acceptance_vfs_sha and
  (.deferred_trees | length) == 1 and
  (.deferred_trees[0] as $tree |
  $tree.id == "sidecar-tool" and
  $tree.activation == {
    "mode":"first-use",
    "capabilities":["homebrew-runtime:sidecar-tool"],
    "roots":["/home/linuxbrew/.linuxbrew/Cellar/sidecar-tool/2.0_3"]
  } and
  $tree.content.media_type == "application/zip" and
  $tree.content.decoder == "zip-v1" and
  ($tree.content.sha256 | test("^[0-9a-f]{64}$")) and
  ($tree.content.bytes | type == "number" and . > 0) and
  $tree.transports == [{
    "kind":"bundle-release",
    "asset":"kandelo-homebrew-sidecar-tool-layer.bin"
  }] and
  $tree.inventory.entry_count == ($tree.inventory.entries | length) and
  $tree.inventory.source_entry_count ==
    ([$tree.inventory.entries[].source_path] | unique | length) and
  $tree.inventory.regular_inode_count ==
    ([$tree.inventory.entries[] | select(.type == "file" or .type == "hardlink") | .inode_group] | unique | length) and
  $tree.inventory.layer_entry_count ==
    ([$tree.inventory.entries[] | select(.ownership == "layer")] | length) and
  $tree.inventory.shared_base_directory_count ==
    ([$tree.inventory.entries[] | select(.ownership == "shared-base-directory")] | length) and
  $tree.inventory.expanded_bytes ==
    ([$tree.inventory.entries[] | select(.type != "hardlink") | .size] | add) and
  $tree.inventory.payload_bytes ==
    ([$tree.inventory.entries[] | select(.type == "file") | .size] | add) and
  ([$tree.inventory.entries[].path] == ([$tree.inventory.entries[].path] | sort)))
' --arg base_vfs_sha "$LAYER_BASE_VFS_SHA256" \
  --argjson base_vfs_bytes "$LAYER_BASE_VFS_BYTES" \
  --arg acceptance_vfs_sha "$LAYER_ACCEPTANCE_VFS_SHA256" \
  "$RUNTIME_LAYER_DESCRIPTOR" >/dev/null
python3 - "$RUNTIME_LAYER_PAYLOAD" \
  "$RUNTIME_LAYER_DESCRIPTOR" <<'PY'
import hashlib, json, pathlib, stat, sys, zipfile

archive_path, descriptor_path = map(pathlib.Path, sys.argv[1:])
descriptor = json.loads(descriptor_path.read_text())
tree = descriptor["deferred_trees"][0]
entries = tree["inventory"]["entries"]
payload = archive_path.read_bytes()
assert len(payload) == tree["content"]["bytes"]
assert hashlib.sha256(payload).hexdigest() == tree["content"]["sha256"]
with zipfile.ZipFile(archive_path) as archive:
    infos = archive.infolist()
    expected = [
        entry["source_path"] + ("/" if entry["type"] == "directory" else "")
        for entry in entries
        if entry["type"] != "hardlink"
    ]
    actual_names = [info.filename for info in infos]
    assert actual_names == expected
    assert archive.comment == b""
    kinds = {
        "directory": stat.S_IFDIR,
        "file": stat.S_IFREG,
        "symlink": stat.S_IFLNK,
    }
    source_entries = {
        entry["source_path"]: entry
        for entry in entries
        if entry["type"] != "hardlink"
    }
    for info in infos:
        entry = source_entries[info.filename.removesuffix("/")]
        mode = info.external_attr >> 16
        assert info.create_system == 3
        assert info.date_time == (1980, 1, 1, 0, 0, 0)
        assert info.comment == b"" and info.extra == b""
        assert stat.S_IFMT(mode) == kinds[entry["type"]]
        assert (mode & 0o7777) == entry["mode"]
        assert len(archive.read(info)) == entry["size"]
    executable = archive.getinfo(
        "home/linuxbrew/.linuxbrew/Cellar/sidecar-tool/2.0_3/bin/sidecar-tool"
    )
    assert ((executable.external_attr >> 16) & 0o7777) == 0o755
    linked = archive.getinfo("home/linuxbrew/.linuxbrew/bin/sidecar-tool")
    assert stat.S_ISLNK(linked.external_attr >> 16)
    assert archive.read(linked).decode() == (
        "/home/linuxbrew/.linuxbrew/Cellar/sidecar-tool/2.0_3/bin/sidecar-tool"
    )
    assert not any(name.startswith("etc/") for name in actual_names)
    assert not any("/Cellar/sidecar-dep/" in name for name in actual_names)
PY

jq -e --slurpfile metadata "$TAP/Kandelo/metadata.json" '
  [.packages[].name] == ["sidecar-dep", "sidecar-tool"] and
  .metadata.tap_commit == $metadata[0].tap_commit and
  ($metadata[0].packages[] | select(.name == "sidecar-dep") |
    .bottles[] | select(.arch == "wasm32") | .built_from.tap_commit) as $dep_build_commit |
  $dep_build_commit != $metadata[0].tap_commit and
  all(.packages[]; . as $report |
    ($metadata[0].packages[] | select(.name == $report.name) |
      .bottles[] | select(.arch == $report.arch) | .built_from) as $built_from |
    $report.tap_commit == $built_from.tap_commit and
    $report.built_from == $built_from) and
  .selection.kind == "brewfile" and
  .selection.requested_packages == ["sidecar-tool"] and
  (.selection.requested_packages_sha256 | test("^[0-9a-f]{64}$")) and
  .selection.brewfile == {
    "parser":"kandelo-static-brewfile-v1",
    "sha256":$brewfile_sha,
    "bytes":$brewfile_bytes
  } and
  .default_shell == {
    "path":"/home/linuxbrew/.linuxbrew/bin/sidecar-tool-helper",
    "argv":["sidecar-tool-helper","--interactive"],
    "config_sha256":$shell_config_sha,
    "config_bytes":$shell_config_bytes
  } and
  .demo_config == {
    "path":"/etc/kandelo/demo.json",
    "sha256":$demo_config_sha,
    "bytes":$demo_config_bytes
  } and
  (.packages[] | select(.name == "sidecar-tool") | .links) == [
    "bin/sidecar-tool",
    "bin/sidecar-tool-helper",
    "include/sidecar-tool.h",
    "lib/libsidecar-tool.a",
    "share/man/man1/sidecar-tool.1"
  ] and
  (.packages[] | select(.name == "sidecar-dep") | .opt_link) == {
    "path":"opt/sidecar-dep",
    "target":"../Cellar/sidecar-dep/1.0"
  } and
  (.packages[] | select(.name == "sidecar-tool") | .opt_link) == {
    "path":"opt/sidecar-tool",
    "target":"../Cellar/sidecar-tool/2.0_3"
  } and
  .base_image.sha256 == $base_sha and
  .base_image.bytes == $base_bytes and
  .base_image.kernelAbi == $abi and
  .base_image.metadata.platformBase == {"source":"sidecar-test"} and
  (.base_image.metadata.signature | length) == 55000 and
  .base_image.metadata.provenance == {
    "issuer":"fixture-builder",
    "subject":"base-only"
  }
' --arg base_sha "$BASE_IMAGE_SHA256" --argjson base_bytes "$BASE_IMAGE_BYTES" \
  --arg brewfile_sha "$BREWFILE_SHA256" \
  --argjson brewfile_bytes "$BREWFILE_BYTES" \
  --arg shell_config_sha "$SHELL_CONFIG_SHA256" \
  --argjson shell_config_bytes "$SHELL_CONFIG_BYTES" \
  --arg demo_config_sha "$DEMO_CONFIG_SHA256" \
  --argjson demo_config_bytes "$DEMO_CONFIG_BYTES" \
  --argjson abi "$ABI_VERSION" \
  "$TMPDIR/sidecar-tool-report.json" >/dev/null
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" extract \
  "$TMPDIR/sidecar-tool-clean.vfs.zst" "$TMPDIR/sidecar-tool-clean-root" >/dev/null
if [ -e "$TMPDIR/sidecar-tool-clean-root/etc/base-image-marker" ]; then
  echo "Homebrew VFS builder added the base marker without --base-image" >&2
  exit 1
fi
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" extract \
  "$TMPDIR/sidecar-tool.vfs.zst" "$TMPDIR/sidecar-tool-root" >/dev/null
grep -Fx 'base-image-marker' \
  "$TMPDIR/sidecar-tool-root/etc/base-image-marker" >/dev/null
[ "$(readlink "$TMPDIR/sidecar-tool-root/home/linuxbrew/.linuxbrew/opt/sidecar-dep")" = \
  "../Cellar/sidecar-dep/1.0" ]
[ "$(readlink "$TMPDIR/sidecar-tool-root/home/linuxbrew/.linuxbrew/opt/sidecar-tool")" = \
  "../Cellar/sidecar-tool/2.0_3" ]
cmp \
  "$TMPDIR/sidecar-tool-root/home/linuxbrew/.linuxbrew/opt/sidecar-tool/bin/sidecar-tool" \
  "$TMPDIR/sidecar-tool-root/home/linuxbrew/.linuxbrew/Cellar/sidecar-tool/2.0_3/bin/sidecar-tool"
jq -e '
  .selection.kind == "brewfile" and
  .selection.requested_packages == ["sidecar-tool"] and
  .selection.brewfile.sha256 == $brewfile_sha and
  .selection.brewfile.bytes == $brewfile_bytes
' --arg brewfile_sha "$BREWFILE_SHA256" \
  --argjson brewfile_bytes "$BREWFILE_BYTES" \
  "$TMPDIR/sidecar-tool-root/etc/kandelo/homebrew-vfs.json" >/dev/null
cmp "$SHELL_CONFIG" "$TMPDIR/sidecar-tool-root/etc/kandelo/shell.json"
cmp "$DEMO_CONFIG" "$TMPDIR/sidecar-tool-root/etc/kandelo/demo.json"
grep -F '/home/linuxbrew/.linuxbrew/bin' \
  "$TMPDIR/sidecar-tool-root/etc/profile.d/kandelo-homebrew.sh" >/dev/null
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" inspect \
  "$TMPDIR/sidecar-tool.vfs.zst" --format json --metadata \
  > "$TMPDIR/sidecar-tool-inspect.json"
jq -e '
  .metadata.baseImage == {
    "sha256":$base_sha,
    "bytes":$base_bytes,
    "kernelAbi":$abi
  } and
  .metadata.homebrew.tapRepository == "kandelo-dev/homebrew-tap-core" and
  .metadata.homebrew.tapName == "kandelo-dev/tap-core" and
  .metadata.homebrew.selection == {
    "kind":"brewfile",
    "requestedPackageCount":1,
    "requestedPackagesSha256":$requested_sha,
    "brewfile":{
      "parser":"kandelo-static-brewfile-v1",
      "sha256":$brewfile_sha,
      "bytes":$brewfile_bytes
    }
  } and
  .metadata.homebrew.defaultShell == {
    "path":"/home/linuxbrew/.linuxbrew/bin/sidecar-tool-helper",
    "argv":["sidecar-tool-helper","--interactive"],
    "configSha256":$shell_config_sha
  } and
  .metadata.homebrew.demoConfig == {
    "path":"/etc/kandelo/demo.json",
    "sha256":$demo_config_sha,
    "bytes":$demo_config_bytes
  } and
  ($requested_sha | test("^[0-9a-f]{64}$")) and
  (.metadata.baseImage | has("metadata") | not) and
  (.metadata | has("platformBase") | not) and
  (.metadata | has("signature") | not) and
  (.metadata | has("provenance") | not) and
  .metadata.kernelAbi == $abi and
  .metadata.createdBy == "images/vfs/scripts/build-homebrew-vfs-image.ts"
' --arg base_sha "$BASE_IMAGE_SHA256" \
  --arg requested_sha "$(jq -r '.selection.requested_packages_sha256' \
    "$TMPDIR/sidecar-tool-report.json")" \
  --arg brewfile_sha "$BREWFILE_SHA256" \
  --argjson brewfile_bytes "$BREWFILE_BYTES" \
  --arg shell_config_sha "$SHELL_CONFIG_SHA256" \
  --arg demo_config_sha "$DEMO_CONFIG_SHA256" \
  --argjson demo_config_bytes "$DEMO_CONFIG_BYTES" \
  --argjson base_bytes "$BASE_IMAGE_BYTES" \
  --argjson abi "$ABI_VERSION" "$TMPDIR/sidecar-tool-inspect.json" >/dev/null

# Exercise the acceptance verifier against the dependency-bearing fixture.
# This test checks the artifact/provenance contract only. Real Node and Chromium
# boot evidence is produced by the trusted publisher from public bottles and a
# real kernel.
ACCEPTANCE_TAP="$TMPDIR/acceptance-tap"
cp -a "$TAP" "$ACCEPTANCE_TAP"
cat >"$TMPDIR/acceptance-kernel.wat" <<WAT
(module
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION)))
WAT
wat2wasm "$TMPDIR/acceptance-kernel.wat" -o "$TMPDIR/acceptance-kernel.wasm"
cat >"$TMPDIR/validate-homebrew-vfs-acceptance.ts" <<EOF
import { writeFileSync } from "node:fs";
import { validateHomebrewVfsAcceptance } from "$REPO_ROOT/scripts/homebrew-vfs-acceptance-smoke.ts";

const [
  metadataPath,
  tapRoot,
  brewfilePath,
  expectedRootPackage,
  executablePath,
  evidencePath,
  reviewedShellConfigPath,
  reviewedReportPath,
] = process.argv.slice(2);
validateHomebrewVfsAcceptance({
  metadataPath,
  tapRoot,
  brewfilePath,
  baseImagePath: "$BASE_IMAGE",
  baseOrigin: "kandelo-package-registry",
  imagePath: "$TMPDIR/sidecar-tool.vfs.zst",
  reportPath: reviewedReportPath ?? "$TMPDIR/sidecar-tool-report.json",
  kernelPath: "$TMPDIR/acceptance-kernel.wasm",
  kernelOrigin: "worktree-build",
  expectedRootPackage,
  executablePath,
  argv: [expectedRootPackage, "--version"],
  expectedStdout: expectedRootPackage,
  timeoutMs: 120000,
  shellConfigPath: reviewedShellConfigPath ?? "$SHELL_CONFIG",
}).then((validated) => {
  writeFileSync(evidencePath, JSON.stringify(validated.evidence));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF
ACCEPTANCE_EVIDENCE="$TMPDIR/acceptance-evidence.json"
npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" "$BREWFILE" \
  sidecar-tool /home/linuxbrew/.linuxbrew/bin/sidecar-tool \
  "$ACCEPTANCE_EVIDENCE"
jq -e --slurpfile metadata "$ACCEPTANCE_TAP/Kandelo/metadata.json" '
  .status == "validated" and
  .dependency_edges == [{
    "from":"kandelo-dev/tap-core/sidecar-tool",
    "to":"kandelo-dev/tap-core/sidecar-dep",
    "version":"1.0"
  }] and
  .browser_plan == {
    "compatibility_basis":"pending-exact-image-runtime-test",
    "packages":[
      "kandelo-dev/tap-core/sidecar-dep",
      "kandelo-dev/tap-core/sidecar-tool"
    ]
  } and
  [.homebrew_bottles[].name] == ["sidecar-dep", "sidecar-tool"] and
  all(.homebrew_bottles[]; . as $bottle |
    $bottle.url == ("https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/" + $bottle.name +
      "/blobs/sha256:" + $bottle.sha256) and
    $bottle.built_from == ($metadata[0].packages[] | select(.name == $bottle.name) |
      .bottles[] | select(.arch == "wasm32") | .built_from) and
    $bottle.declared_runtime_support == ["node"] and
    $bottle.declared_browser_compatible == false) and
  .platform_inputs[0].role == "base-vfs" and
  .platform_inputs[0].origin == "kandelo-package-registry" and
  .platform_inputs[1].role == "kernel" and
  .platform_inputs[1].origin == "worktree-build" and
  .default_shell == {
    "config_artifact":"shell.json",
    "config_sha256":$shell_config_sha,
    "config_bytes":$shell_config_bytes,
    "path":"/home/linuxbrew/.linuxbrew/bin/sidecar-tool-helper",
    "argv":["sidecar-tool-helper","--interactive"],
    "bottle_package":"sidecar-tool"
  } and
  (.image.sha256 | test("^[0-9a-f]{64}$"))
' --arg shell_config_sha "$SHELL_CONFIG_SHA256" \
  --argjson shell_config_bytes "$SHELL_CONFIG_BYTES" \
  "$ACCEPTANCE_EVIDENCE" >/dev/null

TAMPERED_BUILD_SOURCE_REPORT="$TMPDIR/tampered-build-source-report.json"
jq '(.packages[] | select(.name == "sidecar-dep") |
  .built_from.formula_sha256) = ("0" * 64)' \
  "$TMPDIR/sidecar-tool-report.json" >"$TAMPERED_BUILD_SOURCE_REPORT"
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" "$BREWFILE" \
  sidecar-tool /home/linuxbrew/.linuxbrew/bin/sidecar-tool \
  "$TMPDIR/tampered-build-source-evidence.json" "$SHELL_CONFIG" \
  "$TAMPERED_BUILD_SOURCE_REPORT" \
  > /dev/null 2>"$TMPDIR/tampered-build-source.err"; then
  echo "Homebrew VFS acceptance accepted altered bottle build provenance" >&2
  exit 1
fi
grep -F "VFS report package sidecar-dep.built_from.formula_sha256 is" \
  "$TMPDIR/tampered-build-source.err" >/dev/null

MISMATCHED_SHELL_CONFIG="$TMPDIR/mismatched-shell.json"
jq '.argv[1] = "--different"' "$SHELL_CONFIG" >"$MISMATCHED_SHELL_CONFIG"
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" "$BREWFILE" \
  sidecar-tool /home/linuxbrew/.linuxbrew/bin/sidecar-tool \
  "$TMPDIR/mismatched-shell-evidence.json" "$MISMATCHED_SHELL_CONFIG" \
  > /dev/null 2>"$TMPDIR/mismatched-shell.err"; then
  echo "Homebrew VFS acceptance accepted a shell config different from the composed image" >&2
  exit 1
fi
grep -F "VFS report default shell.argv does not match" \
  "$TMPDIR/mismatched-shell.err" >/dev/null

SYMLINK_SHELL_CONFIG="$TMPDIR/symlink-shell.json"
ln -s "$SHELL_CONFIG" "$SYMLINK_SHELL_CONFIG"
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" "$BREWFILE" \
  sidecar-tool /home/linuxbrew/.linuxbrew/bin/sidecar-tool \
  "$TMPDIR/symlink-shell-evidence.json" "$SYMLINK_SHELL_CONFIG" \
  > /dev/null 2>"$TMPDIR/symlink-shell.err"; then
  echo "Homebrew VFS acceptance accepted a symlink shell config" >&2
  exit 1
fi
grep -F "shell config must be a non-empty regular file" \
  "$TMPDIR/symlink-shell.err" >/dev/null

NO_SHELL_OWNER_TAP="$TMPDIR/no-shell-owner-tap"
cp -a "$ACCEPTANCE_TAP" "$NO_SHELL_OWNER_TAP"
NO_SHELL_OWNER_LINK="$NO_SHELL_OWNER_TAP/Kandelo/link/sidecar-tool-2.0_3-rebuild1-wasm32.json"
jq '.links |= map(select(.target != "bin/sidecar-tool-helper"))' \
  "$NO_SHELL_OWNER_LINK" >"$NO_SHELL_OWNER_LINK.tmp"
mv "$NO_SHELL_OWNER_LINK.tmp" "$NO_SHELL_OWNER_LINK"
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$NO_SHELL_OWNER_TAP/Kandelo/metadata.json" "$NO_SHELL_OWNER_TAP" "$BREWFILE" \
  sidecar-tool /home/linuxbrew/.linuxbrew/bin/sidecar-tool \
  "$TMPDIR/no-shell-owner-evidence.json" \
  > /dev/null 2>"$TMPDIR/no-shell-owner.err"; then
  echo "Homebrew VFS acceptance accepted a shell not owned by a selected bottle" >&2
  exit 1
fi
grep -F "default shell /home/linuxbrew/.linuxbrew/bin/sidecar-tool-helper must be linked by exactly one selected Homebrew bottle" \
  "$TMPDIR/no-shell-owner.err" >/dev/null

DEP_ONLY_BREWFILE="$TMPDIR/dependency-only.Brewfile"
cat >"$DEP_ONLY_BREWFILE" <<'EOF'
tap "kandelo-dev/tap-core"
brew "sidecar-dep"
EOF
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" \
  "$DEP_ONLY_BREWFILE" sidecar-dep \
  /home/linuxbrew/.linuxbrew/bin/sidecar-dep "$TMPDIR/no-edge-evidence.json" \
  > /dev/null 2>"$TMPDIR/no-edge.err"; then
  echo "Homebrew VFS acceptance accepted a Brewfile without a dependency edge" >&2
  exit 1
fi
grep -F "selected acceptance formula must resolve at least one real package dependency edge" \
  "$TMPDIR/no-edge.err" >/dev/null

UNRELATED_EDGE_BREWFILE="$TMPDIR/unrelated-edge.Brewfile"
cat >"$UNRELATED_EDGE_BREWFILE" <<'EOF'
tap "kandelo-dev/tap-core"
brew "sidecar-dep"
brew "sidecar-tool"
EOF
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" \
  "$UNRELATED_EDGE_BREWFILE" sidecar-dep \
  /home/linuxbrew/.linuxbrew/bin/sidecar-dep \
  "$TMPDIR/unrelated-edge-evidence.json" \
  > /dev/null 2>"$TMPDIR/unrelated-edge.err"; then
  echo "Homebrew VFS acceptance credited an unrelated root's dependency edge" >&2
  exit 1
fi
grep -F "selected acceptance formula must resolve at least one real package dependency edge" \
  "$TMPDIR/unrelated-edge.err" >/dev/null
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" "$BREWFILE" \
  sidecar-dep /home/linuxbrew/.linuxbrew/bin/sidecar-dep \
  "$TMPDIR/non-root-evidence.json" > /dev/null 2>"$TMPDIR/non-root.err"; then
  echo "Homebrew VFS acceptance accepted a transitive package as its selected root" >&2
  exit 1
fi
grep -F "acceptance formula sidecar-dep is not a Brewfile root" \
  "$TMPDIR/non-root.err" >/dev/null

SYMLINK_BREWFILE="$TMPDIR/symlink.Brewfile"
ln -s "$BREWFILE" "$SYMLINK_BREWFILE"
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$ACCEPTANCE_TAP/Kandelo/metadata.json" "$ACCEPTANCE_TAP" \
  "$SYMLINK_BREWFILE" sidecar-tool \
  /home/linuxbrew/.linuxbrew/bin/sidecar-tool \
  "$TMPDIR/symlink-evidence.json" > /dev/null 2>"$TMPDIR/symlink.err"; then
  echo "Homebrew VFS acceptance accepted a symlink Brewfile" >&2
  exit 1
fi
grep -F "Brewfile must be a non-empty regular file" "$TMPDIR/symlink.err" >/dev/null

NON_GHCR_TAP="$TMPDIR/non-ghcr-tap"
cp -a "$ACCEPTANCE_TAP" "$NON_GHCR_TAP"
jq '
  .packages |= map(
    .name as $name |
    .bottles |= map(
      if .arch == "wasm32"
      then .url = ("https://example.invalid/" + $name)
      else .
      end
    )
  )
' "$ACCEPTANCE_TAP/Kandelo/metadata.json" \
  >"$NON_GHCR_TAP/Kandelo/metadata.json"
for link in "$NON_GHCR_TAP"/Kandelo/link/*-wasm32.json; do
  jq '.package as $name | .bottle.url = ("https://example.invalid/" + $name)' \
    "$link" >"$link.tmp"
  mv "$link.tmp" "$link"
done
if npx tsx "$TMPDIR/validate-homebrew-vfs-acceptance.ts" \
  "$NON_GHCR_TAP/Kandelo/metadata.json" "$NON_GHCR_TAP" "$BREWFILE" \
  sidecar-tool /home/linuxbrew/.linuxbrew/bin/sidecar-tool \
  "$TMPDIR/non-ghcr-evidence.json" > /dev/null 2>"$TMPDIR/non-ghcr.err"; then
  echo "Homebrew VFS acceptance accepted non-GHCR package sources" >&2
  exit 1
fi
grep -F "does not match repository-rooted GHCR URL" "$TMPDIR/non-ghcr.err" >/dev/null
npx tsx -e "
import { readFileSync } from 'node:fs';
import { MemoryFileSystem } from '$REPO_ROOT/host/src/vfs/memory-fs.ts';
for (const [path, expected] of [
  ['$TMPDIR/sidecar-tool-base-default.vfs.zst', $BASE_RECORDED_MAX_BYTES],
  ['$TMPDIR/sidecar-tool.vfs.zst', $BASE_REQUESTED_MAX_BYTES],
]) {
  const bytes = new Uint8Array(readFileSync(path));
  const capacity = MemoryFileSystem.readImageCapacity(bytes);
  if (capacity.maxByteLength !== expected) {
    throw new Error(path + ': configured maximum does not match ' + expected);
  }
  const fs = MemoryFileSystem.fromImagePreservingCapacity(bytes);
  const stats = fs.statfs('/');
  const statfsCapacity = stats.blocks * stats.bsize;
  if (statfsCapacity !== expected) {
    throw new Error(path + ': expected capacity ' + expected + ', got ' + statfsCapacity);
  }
}

const base = MemoryFileSystem.fromImagePreservingCapacity(
  new Uint8Array(readFileSync('$BASE_IMAGE')),
);
const composed = MemoryFileSystem.fromImagePreservingCapacity(
  new Uint8Array(readFileSync('$TMPDIR/sidecar-tool-base-default.vfs.zst')),
);
const rebased = MemoryFileSystem.fromImagePreservingCapacity(
  new Uint8Array(readFileSync('$TMPDIR/sidecar-tool.vfs.zst')),
);
const marker = '/etc/base-image-marker';
const baseCtimeMs = base.stat(marker).ctimeMs;
const composedCtimeMs = composed.stat(marker).ctimeMs;
const rebasedCtimeMs = rebased.stat(marker).ctimeMs;
if (
  !Number.isFinite(baseCtimeMs) ||
  !Number.isFinite(composedCtimeMs) ||
  !Number.isFinite(rebasedCtimeMs)
) {
  throw new Error('base marker ctime is unavailable');
}
if (baseCtimeMs !== composedCtimeMs) {
  throw new Error('default composition rebuilt an unchanged base inode');
}
if (baseCtimeMs === rebasedCtimeMs) {
  throw new Error('explicit rebase did not exercise fresh-inode copying');
}
" >/dev/null

THIRD_PARTY_TAP="$TMPDIR/third-party-tap"
mkdir -p "$THIRD_PARTY_TAP/Kandelo"
cp -R "$TAP/Kandelo/link" "$THIRD_PARTY_TAP/Kandelo/link"
jq '
  .tap_repository = "Example/homebrew-kandelo-tools" |
  .tap_name = "example/kandelo-tools" |
  (.packages[].full_name |= sub("^kandelo-dev/tap-core/"; "example/kandelo-tools/")) |
  (.packages[].dependencies[]?.full_name |= sub("^kandelo-dev/tap-core/"; "example/kandelo-tools/")) |
  (.packages[].bottles[].built_from.tap_repository? = "Example/homebrew-kandelo-tools")
' "$TAP/Kandelo/metadata.json" > "$THIRD_PARTY_TAP/Kandelo/metadata.json"
THIRD_PARTY_BREWFILE="$TMPDIR/third-party.Brewfile"
cat > "$THIRD_PARTY_BREWFILE" <<'EOF'
tap "example/kandelo-tools"
brew "sidecar-tool"
EOF
THIRD_PARTY_BREWFILE_SHA256="$(sha256_file "$THIRD_PARTY_BREWFILE")"
THIRD_PARTY_BREWFILE_BYTES="$(wc -c < "$THIRD_PARTY_BREWFILE" | tr -d ' ')"
if npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$THIRD_PARTY_TAP/Kandelo/metadata.json" \
  --tap-root "$THIRD_PARTY_TAP" \
  --brewfile "$BREWFILE" \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$BASE_IMAGE" \
  --out "$TMPDIR/wrong-tap.vfs.zst" \
  --report "$TMPDIR/wrong-tap-report.json" \
  > /dev/null 2>"$TMPDIR/wrong-tap.err"; then
  echo "Homebrew VFS builder accepted a Brewfile for a different tap" >&2
  exit 1
fi
grep -F 'metadata tap "example/kandelo-tools" does not match requested tap "kandelo-dev/tap-core"' \
  "$TMPDIR/wrong-tap.err" >/dev/null
npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$THIRD_PARTY_TAP/Kandelo/metadata.json" \
  --tap-root "$THIRD_PARTY_TAP" \
  --brewfile "$THIRD_PARTY_BREWFILE" \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --base-image "$BASE_IMAGE" \
  --out "$TMPDIR/third-party.vfs.zst" \
  --report "$TMPDIR/third-party-report.json" >/dev/null
npx tsx "$REPO_ROOT/tools/mkrootfs/src/index.ts" inspect \
  "$TMPDIR/third-party.vfs.zst" --format json --metadata \
  > "$TMPDIR/third-party-inspect.json"
jq -e '
  .metadata.homebrew.tapRepository == "Example/homebrew-kandelo-tools" and
  .metadata.homebrew.tapName == "example/kandelo-tools" and
  .metadata.homebrew.selection.kind == "brewfile" and
  .metadata.homebrew.selection.brewfile.sha256 == $brewfile_sha and
  .metadata.homebrew.selection.brewfile.bytes == $brewfile_bytes
' --arg brewfile_sha "$THIRD_PARTY_BREWFILE_SHA256" \
  --argjson brewfile_bytes "$THIRD_PARTY_BREWFILE_BYTES" \
  "$TMPDIR/third-party-inspect.json" >/dev/null
jq -e '
  .metadata.tap_repository == "Example/homebrew-kandelo-tools" and
  .metadata.tap_name == "example/kandelo-tools" and
  .selection.kind == "brewfile" and
  .selection.requested_packages == ["sidecar-tool"] and
  .selection.brewfile.sha256 == $brewfile_sha and
  .selection.brewfile.bytes == $brewfile_bytes
' --arg brewfile_sha "$THIRD_PARTY_BREWFILE_SHA256" \
  --argjson brewfile_bytes "$THIRD_PARTY_BREWFILE_BYTES" \
  "$TMPDIR/third-party-report.json" >/dev/null

echo "test-homebrew-tap-native-sidecars.sh: ok"
