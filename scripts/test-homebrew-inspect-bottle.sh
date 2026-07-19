#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
# shellcheck source=/dev/null
. "$REPO_ROOT/scripts/homebrew-publication-limits.sh"

FORMULA_SOURCE="$TMP_ROOT/tool.rb"
WASM="$TMP_ROOT/tool.wasm"
ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"
FORBIDDEN_ROOT="/trusted/runner/workspace"
cat >"$FORMULA_SOURCE" <<'RUBY'
class Tool < Formula
  desc "Archive inspector fixture"
end
RUBY
cat >"$TMP_ROOT/tool.wat" <<WAT
(module
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION))
  (func (export "wpk_fork_unwind_begin"))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin"))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state")))
WAT
wat2wasm "$TMP_ROOT/tool.wat" -o "$WASM"

cat >"$TMP_ROOT/make-archive.py" <<'PY'
import io
import json
import pathlib
import sys
import tarfile

kind, output, formula_path, wasm_path, forbidden_root = sys.argv[1:]
formula = pathlib.Path(formula_path).read_bytes()
wasm = pathlib.Path(wasm_path).read_bytes()
forbidden_root = forbidden_root.encode()
root = "tool/1.0"

receipt = json.dumps({
    "runtime_dependencies": [
        {
            "full_name": "kandelo-dev/tap-core/dep",
            "declared_directly": True,
            "pkg_version": "2.0_1",
        },
        {
            "full_name": "bubblewrap",
            "declared_directly": False,
            "version": "0.11.0",
        },
    ]
}, sort_keys=True).encode() + b"\n"

def add_dir(archive, name):
    entry = tarfile.TarInfo(name)
    entry.type = tarfile.DIRTYPE
    entry.mode = 0o755
    archive.addfile(entry)

def add_file(archive, name, payload, mode=0o644):
    entry = tarfile.TarInfo(name)
    entry.size = len(payload)
    entry.mode = mode
    archive.addfile(entry, io.BytesIO(payload))

def add_link(archive, name, target, *, hard=False):
    entry = tarfile.TarInfo(name)
    entry.type = tarfile.LNKTYPE if hard else tarfile.SYMTYPE
    entry.linkname = target
    entry.mode = 0o777
    archive.addfile(entry)

encoding = "ascii" if kind == "non-utf8" else tarfile.ENCODING
errors = "surrogateescape" if kind == "non-utf8" else "surrogateescape"
with tarfile.open(
    output, "w:gz", format=tarfile.PAX_FORMAT, encoding=encoding, errors=errors
) as archive:
    directories = [
        "tool", root, f"{root}/.brew", f"{root}/bin", f"{root}/libexec",
        f"{root}/share",
    ]
    for directory in directories:
        add_dir(archive, directory)
    add_file(archive, f"{root}/.brew/tool.rb", formula)
    add_file(archive, f"{root}/INSTALL_RECEIPT.json", receipt)
    wasm_mode = 0o644 if kind == "nonexec" else 0o755
    add_file(archive, f"{root}/libexec/tool", wasm, wasm_mode)
    add_file(
        archive,
        f"{root}/share/readme.txt",
        b"fixture\n/home/linuxbrew/.linuxbrew/opt/zlib\n/opt/homebrew/opt/zlib\n",
    )

    if kind in {
        "valid", "duplicate", "special", "non-utf8", "forbidden",
        "forbidden-boundary",
    }:
        add_link(archive, f"{root}/bin/tool", "../libexec/tool")
        add_link(archive, f"{root}/bin/tool-hard", f"{root}/libexec/tool", hard=True)
    elif kind in {"standalone", "nonexec"}:
        pass
    elif kind == "escape":
        add_link(archive, f"{root}/bin/tool", "../../../outside")
    elif kind == "dangling":
        add_link(archive, f"{root}/bin/tool", "../libexec/missing")
    elif kind == "cycle":
        add_link(archive, f"{root}/bin/a", "b")
        add_link(archive, f"{root}/bin/b", "a")
    else:
        raise SystemExit(f"unknown fixture kind: {kind}")

    if kind == "duplicate":
        add_file(archive, f"{root}/share/readme.txt", b"duplicate\n")
    elif kind == "special":
        entry = tarfile.TarInfo(f"{root}/special")
        entry.type = tarfile.FIFOTYPE
        archive.addfile(entry)
    elif kind == "non-utf8":
        bad_name = f"{root}/share/" + b"\xff".decode("ascii", errors="surrogateescape")
        add_file(archive, bad_name, b"invalid path\n")
    elif kind == "forbidden":
        add_file(
            archive,
            f"{root}/bin/bashbug",
            b"#!/bin/sh\nsource_dir=" + forbidden_root + b"/source\n",
            0o755,
        )
    elif kind == "forbidden-boundary":
        split_at = 1024 * 1024 - 3
        add_file(
            archive,
            f"{root}/bin/bashbug",
            b"x" * split_at + forbidden_root + b"/source\n",
            0o755,
        )
PY

INSPECTOR="$REPO_ROOT/scripts/homebrew-inspect-bottle.py"
mapfile -t inspector_limits < <(python3 - "$INSPECTOR" <<'PY'
import runpy
import sys

module = runpy.run_path(sys.argv[1])
print(module["MAX_COMPRESSED_BYTES"])
print(module["MAX_ARCHIVE_BYTES"])
PY
)
[ "${inspector_limits[*]}" = \
  "$HOMEBREW_MAX_BOTTLE_BYTES $HOMEBREW_MAX_EXPANDED_BOTTLE_BYTES" ] || {
  echo "test-homebrew-inspect-bottle.sh: inspector publication limits drifted" >&2
  exit 1
}
make_archive() {
  local kind="$1" output="$2" wasm="${3:-$WASM}" formula_source="${4:-$FORMULA_SOURCE}"
  python3 "$TMP_ROOT/make-archive.py" \
    "$kind" "$output" "$formula_source" "$wasm" "$FORBIDDEN_ROOT"
}

VALID_ARCHIVE="$TMP_ROOT/valid.tar.gz"
VALID_JSON="$TMP_ROOT/valid.json"
make_archive valid "$VALID_ARCHIVE"
python3 "$INSPECTOR" \
  --archive "$VALID_ARCHIVE" \
  --formula tool \
  --version 1.0 \
  --expected-abi "$ABI_VERSION" \
  --expected-arch wasm32 \
  --selected-formula "$FORMULA_SOURCE" \
  --forbidden-root "$FORBIDDEN_ROOT" \
  --out "$VALID_JSON"

formula_sha="$(sha256sum "$FORMULA_SOURCE" 2>/dev/null | awk '{print $1}' || \
  shasum -a 256 "$FORMULA_SOURCE" | awk '{print $1}')"
jq -e --arg formula_sha "$formula_sha" '
  keys == [
    "abi_version", "all_files", "arch", "fork_instrumentation", "formula_sha256", "path_exec_files",
    "payload_root", "runtime_dependencies", "schema"
  ] and
  .schema == 1 and
  .abi_version == $abi and
  .arch == "wasm32" and
  .payload_root == "tool/1.0" and
  .formula_sha256 == $formula_sha and
  .fork_instrumentation == "required" and
  .all_files == [
    ".brew/tool.rb",
    "INSTALL_RECEIPT.json",
    "bin/tool",
    "bin/tool-hard",
    "libexec/tool",
    "share/readme.txt"
  ] and
  .path_exec_files == ["bin/tool", "bin/tool-hard"] and
  .runtime_dependencies == [
    {declared_directly: false, full_name: "bubblewrap", version: "0.11.0"},
    {declared_directly: true, full_name: "kandelo-dev/tap-core/dep", version: "2.0_1"}
  ]
' --argjson abi "$ABI_VERSION" "$VALID_JSON" >/dev/null

expect_failure() {
  local kind="$1" pattern="$2"
  local archive="$TMP_ROOT/$kind.tar.gz" stderr="$TMP_ROOT/$kind.err"
  make_archive "$kind" "$archive"
  if python3 "$INSPECTOR" \
    --archive "$archive" --formula tool --version 1.0 \
    --expected-abi "$ABI_VERSION" \
    --expected-arch wasm32 \
    --forbidden-root "$FORBIDDEN_ROOT" \
    >"$TMP_ROOT/$kind.out" 2>"$stderr"; then
    echo "test-homebrew-inspect-bottle.sh: accepted $kind archive" >&2
    exit 1
  fi
  grep -F "$pattern" "$stderr" >/dev/null || {
    echo "test-homebrew-inspect-bottle.sh: wrong failure for $kind" >&2
    cat "$stderr" >&2
    exit 1
  }
}

expect_failure escape "escapes payload root"
expect_failure dangling "dangling link"
expect_failure cycle "link cycle"
expect_failure duplicate "repeats path"
expect_failure non-utf8 "is not UTF-8"
expect_failure special "unsupported type"
expect_failure forbidden "bin/bashbug' contains forbidden build root"
expect_failure forbidden-boundary "bin/bashbug' contains forbidden build root"

make_wasm() {
  local name="$1"
  shift
  cat >"$TMP_ROOT/$name.wat"
  wat2wasm "$TMP_ROOT/$name.wat" -o "$TMP_ROOT/$name.wasm"
}

expect_wasm_failure() {
  local label="$1" kind="$2" wasm="$3" pattern="$4"
  local archive="$TMP_ROOT/$label.tar.gz" stderr="$TMP_ROOT/$label.err"
  make_archive "$kind" "$archive" "$wasm"
  if python3 "$INSPECTOR" \
    --archive "$archive" --formula tool --version 1.0 \
    --expected-abi "$ABI_VERSION" \
    --expected-arch wasm32 \
    --forbidden-root "$FORBIDDEN_ROOT" \
    >"$TMP_ROOT/$label.out" 2>"$stderr"; then
    echo "test-homebrew-inspect-bottle.sh: accepted $label Wasm" >&2
    exit 1
  fi
  grep -F "$pattern" "$stderr" >/dev/null || {
    echo "test-homebrew-inspect-bottle.sh: wrong failure for $label" >&2
    cat "$stderr" >&2
    exit 1
  }
}

make_wasm fork-import-missing <<WAT
(module
  (import "kernel" "kernel_fork" (func \$kernel_fork))
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION)))
WAT
expect_wasm_failure fork-import-missing valid \
  "$TMP_ROOT/fork-import-missing.wasm" "incomplete/missing fork instrumentation"
expect_wasm_failure nonexec-fork-import-missing nonexec \
  "$TMP_ROOT/fork-import-missing.wasm" "incomplete/missing fork instrumentation"

cp "$TMP_ROOT/fork-import-missing.wasm" "$TMP_ROOT/relocatable-fork-import.wasm"
printf '\000\011\007linking\002' >>"$TMP_ROOT/relocatable-fork-import.wasm"
expect_wasm_failure relocatable-fork-import valid \
  "$TMP_ROOT/relocatable-fork-import.wasm" "relocatable Wasm object"

make_wasm stale-abi <<WAT
(module
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const $((ABI_VERSION + 1)))))
WAT
expect_wasm_failure standalone-stale-abi standalone \
  "$TMP_ROOT/stale-abi.wasm" "does not match expected ABI"
expect_wasm_failure nonexec-stale-abi nonexec \
  "$TMP_ROOT/stale-abi.wasm" "does not match expected ABI"

cat >"$TMP_ROOT/memory64.wat" <<WAT
(module
  (memory i64 1)
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION)))
WAT
wat2wasm --enable-memory64 "$TMP_ROOT/memory64.wat" -o "$TMP_ROOT/memory64.wasm"
expect_wasm_failure mislabeled-memory64 valid \
  "$TMP_ROOT/memory64.wasm" "architecture wasm64 does not match expected architecture wasm32"
MEMORY64_ARCHIVE="$TMP_ROOT/memory64.tar.gz"
MEMORY64_JSON="$TMP_ROOT/memory64.json"
make_archive valid "$MEMORY64_ARCHIVE" "$TMP_ROOT/memory64.wasm"
python3 "$INSPECTOR" \
  --archive "$MEMORY64_ARCHIVE" \
  --formula tool \
  --version 1.0 \
  --expected-abi "$ABI_VERSION" \
  --expected-arch wasm64 \
  --selected-formula "$FORMULA_SOURCE" \
  --forbidden-root "$FORBIDDEN_ROOT" \
  --out "$MEMORY64_JSON"
jq -e '.arch == "wasm64" and .abi_version == $abi' \
  --argjson abi "$ABI_VERSION" "$MEMORY64_JSON" >/dev/null

SELECTED_WASM32_BOTTLE_FORMULA="$TMP_ROOT/tool-selected-wasm32-bottle.rb"
ARCHIVED_WASM64_RECEIPT_FORMULA="$TMP_ROOT/tool-archived-wasm64-receipt.rb"
DRIFTED_MULTIARCH_FORMULA="$TMP_ROOT/tool-drifted-multiarch.rb"
REPLACED_MULTIARCH_FORMULA="$TMP_ROOT/tool-replaced-multiarch.rb"
# A later wasm64 build receives tap source that already contains the published
# wasm32 stanza. Homebrew archives the same Formula with that stanza removed.
cat >"$SELECTED_WASM32_BOTTLE_FORMULA" <<'RUBY'
class Tool < Formula
  desc "Archive inspector fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2222222222222222222222222222222222222222222222222222222222222222"
  end

end
RUBY
cat >"$ARCHIVED_WASM64_RECEIPT_FORMULA" <<'RUBY'
class Tool < Formula
  desc "Archive inspector fixture"

end
RUBY
cat >"$DRIFTED_MULTIARCH_FORMULA" <<'RUBY'
class Tool < Formula
  desc "Archive inspector fixture"
  system "touch", "/tmp/untrusted-receipt-drift"

end
RUBY
cat >"$REPLACED_MULTIARCH_FORMULA" <<'RUBY'
class Tool < Formula
  desc "Archive inspector fixture"

  bottle do
    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
    sha256 cellar: :any_skip_relocation, wasm64_kandelo: "3333333333333333333333333333333333333333333333333333333333333333"
  end

end
RUBY

MULTIARCH_RECEIPT_ARCHIVE="$TMP_ROOT/multiarch-receipt.tar.gz"
make_archive valid "$MULTIARCH_RECEIPT_ARCHIVE" \
  "$TMP_ROOT/memory64.wasm" "$ARCHIVED_WASM64_RECEIPT_FORMULA"
python3 "$INSPECTOR" \
  --archive "$MULTIARCH_RECEIPT_ARCHIVE" \
  --formula tool \
  --version 1.0 \
  --expected-abi "$ABI_VERSION" \
  --expected-arch wasm64 \
  --selected-formula "$SELECTED_WASM32_BOTTLE_FORMULA" \
  --forbidden-root "$FORBIDDEN_ROOT" \
  --out "$TMP_ROOT/multiarch-receipt.json"

expect_formula_receipt_failure() {
  local label="$1" archived_formula="$2"
  local archive="$TMP_ROOT/$label.tar.gz" stderr="$TMP_ROOT/$label.err"
  make_archive valid "$archive" "$TMP_ROOT/memory64.wasm" "$archived_formula"
  if python3 "$INSPECTOR" \
    --archive "$archive" \
    --formula tool \
    --version 1.0 \
    --expected-abi "$ABI_VERSION" \
    --expected-arch wasm64 \
    --selected-formula "$SELECTED_WASM32_BOTTLE_FORMULA" \
    --forbidden-root "$FORBIDDEN_ROOT" \
    >"$TMP_ROOT/$label.out" 2>"$stderr"; then
    echo "test-homebrew-inspect-bottle.sh: accepted $label Formula receipt" >&2
    exit 1
  fi
  grep -F "archived Formula receipt does not match the selected tap Formula" \
    "$stderr" >/dev/null || {
    echo "test-homebrew-inspect-bottle.sh: wrong failure for $label Formula receipt" >&2
    cat "$stderr" >&2
    exit 1
  }
}

expect_formula_receipt_failure non-bottle-receipt-drift "$DRIFTED_MULTIARCH_FORMULA"
expect_formula_receipt_failure replaced-bottle-receipt "$REPLACED_MULTIARCH_FORMULA"

make_wasm missing-abi <<'WAT'
(module (memory 1) (func (export "tool")))
WAT
expect_wasm_failure missing-abi valid \
  "$TMP_ROOT/missing-abi.wasm" "lacks __abi_version"

make_wasm malformed-abi <<WAT
(module
  (memory 1)
  (func (export "__abi_version") (result i32)
    (i32.add (i32.const $ABI_VERSION) (i32.const 0))))
WAT
expect_wasm_failure malformed-abi valid \
  "$TMP_ROOT/malformed-abi.wasm" "cannot validate __abi_version"

cat >"$TMP_ROOT/slow-objdump" <<'SH'
#!/usr/bin/env bash
sleep 30
SH
chmod +x "$TMP_ROOT/slow-objdump"
if python3 "$INSPECTOR" \
  --archive "$VALID_ARCHIVE" --formula tool --version 1.0 \
  --expected-abi "$ABI_VERSION" \
  --expected-arch wasm32 \
  --forbidden-root "$FORBIDDEN_ROOT" \
  --wasm-validator "$TMP_ROOT/slow-objdump" --wasm-timeout-seconds 1 \
  >"$TMP_ROOT/timeout.out" 2>"$TMP_ROOT/timeout.err"; then
  echo "test-homebrew-inspect-bottle.sh: accepted timed-out Wasm inspection" >&2
  exit 1
fi
grep -F "Wasm inspection timed out" "$TMP_ROOT/timeout.err" >/dev/null

cat >"$TMP_ROOT/noisy-objdump" <<'SH'
#!/usr/bin/env bash
yes x
SH
chmod +x "$TMP_ROOT/noisy-objdump"
if python3 "$INSPECTOR" \
  --archive "$VALID_ARCHIVE" --formula tool --version 1.0 \
  --expected-abi "$ABI_VERSION" \
  --expected-arch wasm32 \
  --forbidden-root "$FORBIDDEN_ROOT" \
  --wasm-validator "$TMP_ROOT/noisy-objdump" \
  >"$TMP_ROOT/noisy.out" 2>"$TMP_ROOT/noisy.err"; then
  echo "test-homebrew-inspect-bottle.sh: accepted unbounded Wasm inspection output" >&2
  exit 1
fi
grep -F "Wasm inspection output exceeds its limit" "$TMP_ROOT/noisy.err" >/dev/null

expect_argument_failure() {
  local label="$1" pattern="$2"
  shift 2
  if python3 "$INSPECTOR" \
    --archive "$VALID_ARCHIVE" --formula tool --version 1.0 \
    --expected-abi "$ABI_VERSION" --expected-arch wasm32 \
    "$@" >"$TMP_ROOT/$label.out" 2>"$TMP_ROOT/$label.err"; then
    echo "test-homebrew-inspect-bottle.sh: accepted invalid $label arguments" >&2
    exit 1
  fi
  grep -F -- "$pattern" "$TMP_ROOT/$label.err" >/dev/null || {
    echo "test-homebrew-inspect-bottle.sh: wrong argument failure for $label" >&2
    cat "$TMP_ROOT/$label.err" >&2
    exit 1
  }
}

expect_argument_failure missing-forbidden-root "--forbidden-root"
expect_argument_failure relative-forbidden-root \
  "forbidden root must be a non-root absolute POSIX path" \
  --forbidden-root relative/build
expect_argument_failure double-slash-forbidden-root \
  "forbidden root must be a non-root absolute POSIX path" \
  --forbidden-root //trusted/build
expect_argument_failure normalized-forbidden-root \
  "forbidden root must be a normalized absolute POSIX path" \
  --forbidden-root /trusted/runner/../build
expect_argument_failure duplicate-forbidden-root \
  "--forbidden-root values must be unique" \
  --forbidden-root "$FORBIDDEN_ROOT" --forbidden-root "$FORBIDDEN_ROOT"

echo "test-homebrew-inspect-bottle.sh: passed"
