#!/usr/bin/env bash
# End-to-end regression for tap-native Homebrew sidecar generation and pour.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

if [ ! -f "$REPO_ROOT/sysroot/lib/libc.a" ]; then
  echo "test-homebrew-tap-native-sidecars.sh: build sysroot/lib/libc.a first" >&2
  exit 2
fi

ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"
TAP="$TMPDIR/tap"
DEP_OUT="$TMPDIR/dep-sidecars"
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
  depends_on "automattic/kandelo-homebrew/sidecar-dep"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
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

FAKE_BREW_PREFIX="$TMPDIR/fake-homebrew"
FAKE_BREW="$FAKE_BREW_PREFIX/bin/brew"
FAKE_BREW_STATE="$TMPDIR/fake-brew-state"
mkdir -p "$FAKE_BREW_STATE" "$FAKE_BREW_PREFIX/bin"
export FAKE_BREW_STATE
cat >"$FAKE_BREW" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

brew_file="$(cd "${0%/*}" && pwd -P)/${0##*/}"
prefix="${brew_file%/*/*}"
repository="$prefix"
if [ -L "$brew_file" ]; then
  target="$(readlink "$brew_file")"
  target_dirname="$(dirname "$target")"
  if [[ "$target_dirname" = /* ]]; then
    target_dir="$(cd "$target_dirname" && pwd -P)"
  else
    target_dir="$(cd "$(dirname "$brew_file")/$target_dirname" && pwd -P)"
  fi
  repository="${target_dir%/*}"
fi

case "${1:-}" in
--prefix)
  printf '%s\n' "$prefix"
  exit 0
  ;;
--cellar)
  printf '%s/Cellar\n' "$prefix"
  exit 0
  ;;
--repository)
  if [ -n "${2:-}" ]; then
    cat "$FAKE_BREW_STATE/tap-root"
  else
    printf '%s\n' "$repository"
  fi
  exit 0
  ;;
tap)
  printf '%s\n' "${3:?tap root required}" >"$FAKE_BREW_STATE/tap-root"
  exit 0
  ;;
trust)
  [ "${2:-}" = "--tap" ]
  exit 0
  ;;
bottle)
  [ "${2:-}" = "--merge" ] || exit 2
  case " $* " in
    *" --keep-old "*) ;;
    *)
      echo "fixture merge requires --keep-old" >&2
      exit 2
      ;;
  esac
  bottle_json="${!#}"
  tap_root="$(cat "$FAKE_BREW_STATE/tap-root")"
  formula_ref="$(jq -er 'keys | if length == 1 then .[0] else error("expected one formula") end' "$bottle_json")"
  formula="${formula_ref##*/}"
  tag="$(jq -er --arg formula_ref "$formula_ref" '.[$formula_ref].bottle.tags | keys | if length == 1 then .[0] else error("expected one tag") end' "$bottle_json")"
  sha="$(jq -er --arg formula_ref "$formula_ref" --arg tag "$tag" '.[$formula_ref].bottle.tags[$tag].sha256' "$bottle_json")"
  root_url="$(jq -er --arg formula_ref "$formula_ref" '.[$formula_ref].bottle.root_url' "$bottle_json")"
  rebuild="$(jq -er --arg formula_ref "$formula_ref" '.[$formula_ref].bottle.rebuild' "$bottle_json")"
  cellar="$(jq -er --arg formula_ref "$formula_ref" '.[$formula_ref].bottle.cellar' "$bottle_json")"
  formula_path="$tap_root/Formula/$formula.rb"
  python3 - "$formula_path" "$root_url" "$rebuild" "$tag" "$cellar" "$sha" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
root_url = sys.argv[2]
rebuild = int(sys.argv[3])
tag = sys.argv[4]
cellar = sys.argv[5]
sha = sys.argv[6]
lines = path.read_text(encoding="utf-8").splitlines()
cellar_dsl = {
    "any": ":any",
    "any_skip_relocation": ":any_skip_relocation",
    "/home/linuxbrew/.linuxbrew/Cellar": '"/home/linuxbrew/.linuxbrew/Cellar"',
}[cellar]
bottle_start = next((index for index, line in enumerate(lines) if line == "  bottle do"), None)
tags = {}
if bottle_start is None:
    if not lines or lines[-1] != "end":
        raise SystemExit("fixture Formula lacks a final class end")
    bottle_end = None
else:
    bottle_end = next(
        (index for index in range(bottle_start + 1, len(lines)) if lines[index] == "  end"),
        None,
    )
    if bottle_end is None:
        raise SystemExit("fixture Formula has an unterminated bottle block")
    for line in lines[bottle_start + 1:bottle_end]:
        match = re.fullmatch(
            r'    sha256 cellar: (:[a-z_]+|"[^"]+"), ((?:wasm32|wasm64)_kandelo): "([0-9a-f]{64})"',
            line,
        )
        if match:
            tags[match.group(2)] = (match.group(1), match.group(3))
tags[tag] = (cellar_dsl, sha)
block = ["  bottle do", f'    root_url "{root_url}"']
if rebuild:
    block.append(f"    rebuild {rebuild}")
for bottle_tag in sorted(tags):
    tag_cellar, tag_sha = tags[bottle_tag]
    block.append(f'    sha256 cellar: {tag_cellar}, {bottle_tag}: "{tag_sha}"')
block.append("  end")
if bottle_start is None:
    lines[-1:-1] = block + [""]
else:
    lines[bottle_start:bottle_end + 1] = block
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
  exit 0
  ;;
--version)
  case "${FAKE_BREW_VERSION_MODE:-success}" in
    empty) exit 0 ;;
    fail)
      echo "Homebrew fixture"
      exit 9
      ;;
  esac
  trap 'exit 141' PIPE
  echo "Homebrew fixture"
  sleep 0.05
  echo "Homebrew/homebrew-core fixture"
  exit 0
  ;;
info)
  [ "${2:-}" = "--json=v2" ] && [ "${3:-}" = "--formula" ] || exit 2
  formula="${4##*/}"
  tap_root="$(cat "$FAKE_BREW_STATE/tap-root")"
  formula_sha="$(shasum -a 256 "$tap_root/Formula/$formula.rb" | awk '{print $1}')"
  if [ "${FAKE_BREW_INFO_MODE:-success}" = "stale-checksum" ]; then
    formula_sha=0000000000000000000000000000000000000000000000000000000000000000
  fi
  case "${4:-}" in
    automattic/kandelo-homebrew/sidecar-dep)
      jq -n --arg formula_sha "$formula_sha" '{formulae: [{
        name: "sidecar-dep",
        full_name: "automattic/kandelo-homebrew/sidecar-dep",
        tap: "automattic/kandelo-homebrew",
        ruby_source_checksum: {sha256: $formula_sha},
        dependencies: [],
        recommended_dependencies: [],
        optional_dependencies: []
      }], casks: []}'
      ;;
    automattic/kandelo-homebrew/sidecar-tool)
      dependencies='["automattic/kandelo-homebrew/sidecar-dep"]'
      optional_dependencies='[]'
      if [ "${FAKE_BREW_INFO_MODE:-success}" = "external-required" ]; then
        dependencies='["cmake"]'
      fi
      if [ "${FAKE_BREW_INFO_MODE:-success}" = "optional" ]; then
        optional_dependencies='["automattic/kandelo-homebrew/sidecar-optional"]'
      fi
      jq -n --arg formula_sha "$formula_sha" \
        --argjson dependencies "$dependencies" \
        --argjson optional_dependencies "$optional_dependencies" '{formulae: [{
        name: "sidecar-tool",
        full_name: "automattic/kandelo-homebrew/sidecar-tool",
        tap: "automattic/kandelo-homebrew",
        ruby_source_checksum: {sha256: $formula_sha},
        dependencies: $dependencies,
        recommended_dependencies: [],
        optional_dependencies: $optional_dependencies
      }], casks: []}'
      ;;
    *) exit 2 ;;
  esac
  exit 0
  ;;
*) exit 2 ;;
esac
SH
chmod +x "$FAKE_BREW"
printf 'unpatched\n' >"$FAKE_BREW_PREFIX/marker.txt"
git -C "$FAKE_BREW_PREFIX" init -q
git -C "$FAKE_BREW_PREFIX" config user.name "Kandelo Test"
git -C "$FAKE_BREW_PREFIX" config user.email "kandelo-test@example.invalid"
git -C "$FAKE_BREW_PREFIX" add .
git -C "$FAKE_BREW_PREFIX" commit -q -m "fake Homebrew"
FAKE_BREW_COMMIT="$(git -C "$FAKE_BREW_PREFIX" rev-parse HEAD)"
FAKE_PATCH="$TMPDIR/fake-homebrew.patch"
cat >"$FAKE_PATCH" <<'PATCH'
diff --git a/marker.txt b/marker.txt
index 5742de9..a95d2c7 100644
--- a/marker.txt
+++ b/marker.txt
@@ -1 +1 @@
-unpatched
+patched
PATCH
export HOMEBREW_BREW_FILE="$FAKE_BREW"
export KANDELO_HOMEBREW_PATCH_FILE="$FAKE_PATCH"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

make_publication_handoff() {
  local formula="$1" arch="$2" archive="$3" bottle_json="$4" sidecars="$5" out="$6"
  local tap_commit
  tap_commit="$(jq -er '.tap_commit' "$sidecars/sidecars-input.json")"
  rm -rf "$out"
  mkdir -p "$out/composition"
  bash "$REPO_ROOT/scripts/homebrew-create-build-handoff.sh" \
    --formula "$formula" \
    --arch "$arch" \
    --release-tag "bottles-abi-v${ABI_VERSION}" \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" \
    --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --bottle "$archive" \
    --bottle-json "$bottle_json" \
    --out "$out/build" >/dev/null
  bash "$REPO_ROOT/scripts/homebrew-ghcr-upload.sh" \
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" \
    --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
    --formula "$formula" \
    --arch "$arch" \
    --release-tag "bottles-abi-v${ABI_VERSION}" \
    --bottle "$out/build/bottle.tar.gz" \
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
    --tap-repository Automattic/kandelo-homebrew \
    --tap-commit "$tap_commit" \
    --kandelo-commit "$KANDELO_SOURCE_COMMIT" \
    --bottle-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
    --tap-root "$tap_root" >/dev/null
}

make_dep_bottle() {
  local stage="$TMPDIR/dep-stage/sidecar-dep/1.0"
  local archive="$TMPDIR/sidecar-dep--1.0.wasm32_kandelo.bottle.tar.gz"
  local bottle_json="$TMPDIR/sidecar-dep--1.0.wasm32_kandelo.bottle.json"
  mkdir -p "$stage/bin" "$stage/.brew"
  printf '#!/bin/sh\necho sidecar-dep\n' >"$stage/bin/sidecar-dep"
  chmod +x "$stage/bin/sidecar-dep"
  cp "$TAP/Formula/sidecar-dep.rb" "$stage/.brew/sidecar-dep.rb"
  printf '{}\n' >"$stage/INSTALL_RECEIPT.json"
  tar -czf "$archive" -C "$TMPDIR/dep-stage" sidecar-dep
  local sha bytes
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  jq -n \
    --arg sha "$sha" \
    --arg tap_commit "$(git -C "$TAP" rev-parse HEAD)" \
    '{
      "automattic/kandelo-homebrew/sidecar-dep": {
        formula: {
          name: "sidecar-dep",
          pkg_version: "1.0",
          path: "Library/Taps/automattic/homebrew-kandelo-homebrew/Formula/sidecar-dep.rb",
          tap_git_path: "Formula/sidecar-dep.rb",
          tap_git_revision: $tap_commit
        },
        bottle: {
          root_url: "https://ghcr.io/v2/automattic/kandelo-homebrew",
          cellar: "any_skip_relocation",
          rebuild: 0,
          tags: {
            wasm32_kandelo: {
              sha256: $sha,
              tab: {runtime_dependencies: []},
              path_exec_files: ["bin/sidecar-dep"],
              all_files: [
                ".brew/sidecar-dep.rb",
                "INSTALL_RECEIPT.json",
                "bin/sidecar-dep"
              ]
            }
          }
        }
      }
    }' >"$bottle_json"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

make_tool_bottle() {
  local stage="$TMPDIR/tool-stage/sidecar-tool/2.0_3"
  local archive="$TMPDIR/sidecar-tool--2.0_3.wasm32_kandelo.bottle.tar.gz"
  local bottle_json="$TMPDIR/sidecar-tool--2.0_3.wasm32_kandelo.bottle.json"
  mkdir -p "$stage/bin" "$stage/include" "$stage/lib" "$stage/share/man/man1" \
    "$stage/share/info" "$stage/.brew"
  cat >"$TMPDIR/sidecar-tool.wat" <<'WAT'
(module
  (func (export "wpk_fork_unwind_begin"))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin"))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state")))
WAT
  wat2wasm "$TMPDIR/sidecar-tool.wat" -o "$stage/bin/sidecar-tool"
  printf '#!/bin/sh\necho helper\n' >"$stage/bin/sidecar-tool-helper"
  chmod +x "$stage/bin/sidecar-tool" "$stage/bin/sidecar-tool-helper"
  printf '#define SIDECAR_TOOL 1\n' >"$stage/include/sidecar-tool.h"
  printf 'archive\n' >"$stage/lib/libsidecar-tool.a"
  printf 'sidecar-tool(1)\n' >"$stage/share/man/man1/sidecar-tool.1"
  printf 'generated index must not be linked\n' >"$stage/share/info/dir"
  cp "$TAP/Formula/sidecar-tool.rb" "$stage/.brew/sidecar-tool.rb"
  printf '{}\n' >"$stage/INSTALL_RECEIPT.json"
  tar -czf "$archive" -C "$TMPDIR/tool-stage" sidecar-tool
  local sha bytes
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  jq -n \
    --arg sha "$sha" \
    --arg tap_commit "$(git -C "$TAP" rev-parse HEAD)" \
    '{
      "automattic/kandelo-homebrew/sidecar-tool": {
        formula: {
          name: "sidecar-tool",
          pkg_version: "2.0_3",
          path: "Library/Taps/automattic/homebrew-kandelo-homebrew/Formula/sidecar-tool.rb",
          tap_git_path: "Formula/sidecar-tool.rb",
          tap_git_revision: $tap_commit
        },
        bottle: {
          root_url: "https://ghcr.io/v2/automattic/kandelo-homebrew",
          cellar: "any_skip_relocation",
          rebuild: 1,
          tags: {
            wasm32_kandelo: {
              sha256: $sha,
              tab: {
                runtime_dependencies: [
                  {
                    full_name: "libcap",
                    version: "2.78",
                    revision: 0,
                    pkg_version: "2.78",
                    declared_directly: false
                  },
                  {
                    full_name: "bubblewrap",
                    version: "0.11.2",
                    revision: 0,
                    pkg_version: "0.11.2",
                    declared_directly: true
                  },
                  {
                    full_name: "automattic/kandelo-homebrew/sidecar-dep",
                    version: "1.0",
                    revision: 0,
                    pkg_version: "1.0",
                    declared_directly: true
                  },
                  {
                    full_name: "automattic/kandelo-homebrew/transitive-only",
                    version: "9.0",
                    revision: 0,
                    pkg_version: "9.0",
                    declared_directly: false
                  }
                ]
              },
              path_exec_files: ["bin/sidecar-tool", "bin/sidecar-tool-helper"],
              all_files: [
                ".brew/sidecar-tool.rb",
                "INSTALL_RECEIPT.json",
                "bin/sidecar-tool",
                "bin/sidecar-tool-helper",
                "include/sidecar-tool.h",
                "lib/libsidecar-tool.a",
                "share/info/dir",
                "share/man/man1/sidecar-tool.1"
              ]
            }
          }
        }
      }
    }' >"$bottle_json"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

make_tool_wasm64_bottle() {
  local source_archive="$1" source_json="$2"
  local archive="$TMPDIR/sidecar-tool--2.0_3.wasm64_kandelo.bottle.tar.gz"
  local bottle_json="$TMPDIR/sidecar-tool--2.0_3.wasm64_kandelo.bottle.json"
  cp "$source_archive" "$archive"
  jq '
    .[] |= (
      .bottle.tags.wasm64_kandelo = .bottle.tags.wasm32_kandelo
      | del(.bottle.tags.wasm32_kandelo)
    )
  ' "$source_json" >"$bottle_json"
  local sha bytes
  sha="$(sha256_file "$archive")"
  bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
  printf '%s\n%s\n%s\n%s\n' "$archive" "$bottle_json" "$sha" "$bytes"
}

generate_sidecars() {
  local formula="$1" archive="$2" bottle_json="$3" sha="$4" bytes="$5" out="$6"
  local arch="${SIDECAR_TEST_ARCH:-wasm32}"
  local merged_tap="${out}-merged-tap"
  local canonical_json="${out}-merge-bottle.json"
  rm -rf "$merged_tap" "$out"
  cp -a "$TAP" "$merged_tap"
  mkdir -p "$out"
  jq --arg formula "$formula" '{($formula): (to_entries[0].value)}' \
    "$bottle_json" >"$canonical_json"
  HOMEBREW_BREW_FILE="$FAKE_BREW" \
    bash "$REPO_ROOT/scripts/homebrew-merge-bottle-json.sh" \
      --tap-root "$merged_tap" \
      --tap-repository Automattic/kandelo-homebrew \
      --formula "$formula" \
      --arch "$arch" \
      --bottle-json "$canonical_json" \
      --expected-sha256 "$sha" \
      --expected-root-url https://ghcr.io/v2/automattic/kandelo-homebrew \
      --expected-cellar any_skip_relocation >/dev/null
  KANDELO_HOMEBREW_TAP_ROOT="$merged_tap" \
  KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$TAP" \
  KANDELO_HOMEBREW_SIDECAR_ROOT="$out" \
  KANDELO_HOMEBREW_FORMULA="$formula" \
  KANDELO_HOMEBREW_ARCH="$arch" \
  KANDELO_HOMEBREW_RELEASE_TAG="bottles-abi-v${ABI_VERSION}" \
  KANDELO_HOMEBREW_TAP_REPOSITORY=Automattic/kandelo-homebrew \
  KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$archive" \
  KANDELO_HOMEBREW_BOTTLE_JSON="$bottle_json" \
  KANDELO_HOMEBREW_BOTTLE_URL="https://ghcr.io/v2/automattic/kandelo-homebrew/${formula}/blobs/sha256:${sha}" \
  KANDELO_HOMEBREW_BOTTLE_SHA256="$sha" \
  KANDELO_HOMEBREW_BOTTLE_BYTES="$bytes" \
  FAKE_BREW_VERSION_MODE="${FAKE_BREW_VERSION_MODE:-success}" \
  FAKE_BREW_INFO_MODE="${FAKE_BREW_INFO_MODE:-success}" \
  HOMEBREW_BREW_FILE="$FAKE_BREW" \
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
FAKE_BREW_VERSION_MODE=empty expect_generate_failure empty-brew-version \
  "brew --version returned no version" \
  sidecar-dep "${dep_bottle[@]}" "$TMPDIR/empty-version-sidecars"
FAKE_BREW_VERSION_MODE=fail expect_generate_failure failed-brew-version \
  "brew --version failed with status 9" \
  sidecar-dep "${dep_bottle[@]}" "$TMPDIR/failed-version-sidecars"
generate_sidecars sidecar-dep "${dep_bottle[@]}" "$DEP_OUT"

mapfile -t tool_bottle < <(make_tool_bottle)
mapfile -t tool64_bottle < <(make_tool_wasm64_bottle "${tool_bottle[0]}" "${tool_bottle[1]}")

FAKE_BREW_INFO_MODE=stale-checksum expect_generate_failure stale-formula \
  "brew info formula checksum does not match the selected tap formula" \
  sidecar-tool "${tool_bottle[@]}" "$TMPDIR/stale-formula-sidecars"
FAKE_BREW_INFO_MODE=external-required expect_generate_failure external-required \
  "brew info dependencies[0] 'cmake' is not a formula in automattic/kandelo-homebrew" \
  sidecar-tool "${tool_bottle[@]}" "$TMPDIR/external-required-sidecars"

MISSING_REQUIRED_JSON="$TMPDIR/sidecar-tool-missing-required.json"
jq '.[].bottle.tags.wasm32_kandelo.tab.runtime_dependencies |=
  map(select(.full_name != "automattic/kandelo-homebrew/sidecar-dep"))' \
  "${tool_bottle[1]}" >"$MISSING_REQUIRED_JSON"
expect_generate_failure missing-required "bottle receipt lacks declared runtime dependencies" \
  sidecar-tool "${tool_bottle[0]}" "$MISSING_REQUIRED_JSON" \
  "${tool_bottle[2]}" "${tool_bottle[3]}" "$TMPDIR/missing-required-sidecars"

INDIRECT_REQUIRED_JSON="$TMPDIR/sidecar-tool-indirect-required.json"
jq '.[].bottle.tags.wasm32_kandelo.tab.runtime_dependencies |= map(
  if .full_name == "automattic/kandelo-homebrew/sidecar-dep"
  then .declared_directly = false else . end)' \
  "${tool_bottle[1]}" >"$INDIRECT_REQUIRED_JSON"
expect_generate_failure indirect-required "is not direct in the receipt" \
  sidecar-tool "${tool_bottle[0]}" "$INDIRECT_REQUIRED_JSON" \
  "${tool_bottle[2]}" "${tool_bottle[3]}" "$TMPDIR/indirect-required-sidecars"

MALFORMED_NAME_JSON="$TMPDIR/sidecar-tool-malformed-name.json"
jq '.[].bottle.tags.wasm32_kandelo.tab.runtime_dependencies[0].full_name = null' \
  "${tool_bottle[1]}" >"$MALFORMED_NAME_JSON"
expect_generate_failure malformed-name ".full_name must be a non-empty string" \
  sidecar-tool "${tool_bottle[0]}" "$MALFORMED_NAME_JSON" \
  "${tool_bottle[2]}" "${tool_bottle[3]}" "$TMPDIR/malformed-name-sidecars"

MALFORMED_DIRECT_JSON="$TMPDIR/sidecar-tool-malformed-direct.json"
jq '.[].bottle.tags.wasm32_kandelo.tab.runtime_dependencies[0].declared_directly = "false"' \
  "${tool_bottle[1]}" >"$MALFORMED_DIRECT_JSON"
expect_generate_failure malformed-direct ".declared_directly must be boolean" \
  sidecar-tool "${tool_bottle[0]}" "$MALFORMED_DIRECT_JSON" \
  "${tool_bottle[2]}" "${tool_bottle[3]}" "$TMPDIR/malformed-direct-sidecars"

DUPLICATE_JSON="$TMPDIR/sidecar-tool-duplicate.json"
jq '.[].bottle.tags.wasm32_kandelo.tab.runtime_dependencies |= . + [.[0]]' \
  "${tool_bottle[1]}" >"$DUPLICATE_JSON"
expect_generate_failure duplicate-dependency "duplicate runtime dependency 'libcap'" \
  sidecar-tool "${tool_bottle[0]}" "$DUPLICATE_JSON" \
  "${tool_bottle[2]}" "${tool_bottle[3]}" "$TMPDIR/duplicate-sidecars"

OPTIONAL_ABSENT_OUT="$TMPDIR/optional-absent-sidecars"
FAKE_BREW_INFO_MODE=optional generate_sidecars sidecar-tool "${tool_bottle[@]}" "$OPTIONAL_ABSENT_OUT"
jq -e '.packages[0].dependencies == [{"name":"sidecar-dep","version":"1.0"}]' \
  "$OPTIONAL_ABSENT_OUT/sidecars-input.json" >/dev/null

OPTIONAL_PRESENT_JSON="$TMPDIR/sidecar-tool-optional-present.json"
jq '.[].bottle.tags.wasm32_kandelo.tab.runtime_dependencies += [{
  full_name: "automattic/kandelo-homebrew/sidecar-optional",
  version: "3.0",
  revision: 0,
  pkg_version: "3.0",
  declared_directly: true
}]' "${tool_bottle[1]}" >"$OPTIONAL_PRESENT_JSON"
OPTIONAL_PRESENT_OUT="$TMPDIR/optional-present-sidecars"
FAKE_BREW_INFO_MODE=optional generate_sidecars sidecar-tool \
  "${tool_bottle[0]}" "$OPTIONAL_PRESENT_JSON" \
  "${tool_bottle[2]}" "${tool_bottle[3]}" "$OPTIONAL_PRESENT_OUT"
jq -e '.packages[0].dependencies == [
  {"name":"sidecar-dep","version":"1.0"},
  {"name":"sidecar-optional","version":"3.0"}
]' "$OPTIONAL_PRESENT_OUT/sidecars-input.json" >/dev/null

DEP_HANDOFF="$TMPDIR/dep-publication-handoff"
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
jq --arg tap_commit "$TOOL_PLAN_COMMIT" \
  '.[].formula.tap_git_revision = $tap_commit' \
  "${tool_bottle[1]}" >"${tool_bottle[1]}.updated"
mv "${tool_bottle[1]}.updated" "${tool_bottle[1]}"
jq --arg tap_commit "$TOOL_PLAN_COMMIT" \
  '.[].formula.tap_git_revision = $tap_commit' \
  "${tool64_bottle[1]}" >"${tool64_bottle[1]}.updated"
mv "${tool64_bottle[1]}.updated" "${tool64_bottle[1]}"
generate_sidecars sidecar-tool "${tool_bottle[@]}" "$TOOL_OUT"
SIDECAR_TEST_ARCH=wasm64 generate_sidecars sidecar-tool "${tool64_bottle[@]}" "$TOOL64_OUT"

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
    [.bottles[].arch] == ["wasm32"]) and
  (.packages[] | select(.name == "sidecar-tool") |
    .version == "2.0_3" and
    .formula_revision == 3 and
    .bottle_rebuild == 1 and
    .dependencies == [{"name":"sidecar-dep","version":"1.0"}] and
    [.bottles[].arch] == ["wasm32","wasm64"] and
    .bottles[0].cache_key_sha == $tool_sha and
    .bottles[0].fork_instrumentation == "required" and
    .bottles[1].cache_key_sha == $tool64_sha and
    .bottles[1].fork_instrumentation == "required")
' "$TAP/Kandelo/metadata.json" >/dev/null
grep -F "wasm32_kandelo: \"${dep_bottle[2]}\"" "$TAP/Formula/sidecar-dep.rb" >/dev/null
grep -F "wasm32_kandelo: \"${tool_bottle[2]}\"" "$TAP/Formula/sidecar-tool.rb" >/dev/null
grep -F "wasm64_kandelo: \"${tool64_bottle[2]}\"" "$TAP/Formula/sidecar-tool.rb" >/dev/null
jq -e --arg expected "Homebrew fixture (commit $FAKE_BREW_COMMIT)" '
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
npx tsx "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP/Kandelo/metadata.json" \
  --tap-root "$TAP" \
  --package sidecar-tool \
  --arch wasm32 \
  --runtime node \
  --bottle-cache "$BOTTLE_CACHE" \
  --out "$TMPDIR/sidecar-tool.vfs.zst" \
  --report "$TMPDIR/sidecar-tool-report.json" >/dev/null

jq -e '
  [.packages[].name] == ["sidecar-dep", "sidecar-tool"] and
  (.packages[] | select(.name == "sidecar-tool") | .links) == [
    "bin/sidecar-tool",
    "bin/sidecar-tool-helper",
    "include/sidecar-tool.h",
    "lib/libsidecar-tool.a",
    "share/man/man1/sidecar-tool.1"
  ]
' "$TMPDIR/sidecar-tool-report.json" >/dev/null

echo "test-homebrew-tap-native-sidecars.sh: ok"
