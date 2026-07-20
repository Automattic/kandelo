#!/usr/bin/env bash
# Generate Kandelo/Homebrew sidecars for the bottle built by the trusted
# Homebrew workflow. Inputs are provided through KANDELO_HOMEBREW_* env vars.
set -euo pipefail

KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-publication-limits.sh"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "homebrew-generate-sidecars-from-env.sh: $name is required" >&2
    exit 2
  fi
}

require_bounded_regular_file() {
  local label="$1" path="$2" maximum="$3" size
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    echo "homebrew-generate-sidecars-from-env.sh: $label must be a regular non-symlink file: $path" >&2
    exit 2
  fi
  size="$(wc -c <"$path" | tr -d '[:space:]')"
  if ! [[ "$size" =~ ^[0-9]+$ ]] || [ "$size" -gt "$maximum" ]; then
    echo "homebrew-generate-sidecars-from-env.sh: $label exceeds $maximum bytes" >&2
    exit 2
  fi
}

for name in \
  KANDELO_HOMEBREW_TAP_ROOT \
  KANDELO_HOMEBREW_SIDECAR_ROOT \
  KANDELO_HOMEBREW_FORMULA \
  KANDELO_HOMEBREW_ARCH \
  KANDELO_HOMEBREW_RELEASE_TAG \
  KANDELO_HOMEBREW_TAP_REPOSITORY \
  KANDELO_HOMEBREW_TAP_NAME \
  KANDELO_HOMEBREW_BOTTLE_ARCHIVE \
  KANDELO_HOMEBREW_BOTTLE_JSON \
  KANDELO_HOMEBREW_BOTTLE_ROOT_URL \
  KANDELO_HOMEBREW_BOTTLE_URL \
  KANDELO_HOMEBREW_BOTTLE_SHA256 \
  KANDELO_HOMEBREW_BOTTLE_BYTES \
  KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE \
  KANDELO_HOMEBREW_RUNTIME_EVIDENCE \
  KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON \
  HOMEBREW_BREW_COMMIT; do
  require_env "$name"
done

case "$KANDELO_HOMEBREW_ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-generate-sidecars-from-env.sh: invalid arch $KANDELO_HOMEBREW_ARCH" >&2; exit 2 ;;
esac

if ! [[ "$KANDELO_HOMEBREW_FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-generate-sidecars-from-env.sh: invalid formula $KANDELO_HOMEBREW_FORMULA" >&2
  exit 2
fi

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
BUILD_ROOT="${KANDELO_HOMEBREW_BUILD_ROOT:-$KANDELO_ROOT}"
BUILD_ROOT="$(cd "$BUILD_ROOT" && pwd -P)"
FORMULA_SOURCE_ROOT="${KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT:-$KANDELO_HOMEBREW_TAP_ROOT}"
FORMULA_PATH="$FORMULA_SOURCE_ROOT/Formula/$KANDELO_HOMEBREW_FORMULA.rb"
MERGED_FORMULA_PATH="$KANDELO_HOMEBREW_TAP_ROOT/Formula/$KANDELO_HOMEBREW_FORMULA.rb"
require_bounded_regular_file \
  "build-source Formula" "$FORMULA_PATH" "$HOMEBREW_MAX_FORMULA_BYTES"
require_bounded_regular_file \
  "merged Formula" "$MERGED_FORMULA_PATH" "$HOMEBREW_MAX_FORMULA_BYTES"
require_bounded_regular_file \
  "bottle archive" "$KANDELO_HOMEBREW_BOTTLE_ARCHIVE" "$HOMEBREW_MAX_BOTTLE_BYTES"
require_bounded_regular_file \
  "bottle JSON" "$KANDELO_HOMEBREW_BOTTLE_JSON" "$HOMEBREW_MAX_BOTTLE_JSON_BYTES"
require_bounded_regular_file \
  "dependency provenance" "$KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE" \
  "$HOMEBREW_MAX_DEPENDENCY_PROVENANCE_BYTES"
require_bounded_regular_file \
  "runtime evidence" "$KANDELO_HOMEBREW_RUNTIME_EVIDENCE" \
  "$HOMEBREW_MAX_DEPENDENCY_PROVENANCE_BYTES"
if ! [[ "$HOMEBREW_BREW_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-generate-sidecars-from-env.sh: invalid Homebrew commit: $HOMEBREW_BREW_COMMIT" >&2
  exit 2
fi

ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' "$KANDELO_ROOT/crates/shared/src/lib.rs" | head -n1)"
if [ "$KANDELO_HOMEBREW_RELEASE_TAG" != "bottles-abi-v${ABI_VERSION}" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: release tag $KANDELO_HOMEBREW_RELEASE_TAG does not match ABI $ABI_VERSION" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_BOTTLE_SHA256="$(sha256sum "$KANDELO_HOMEBREW_BOTTLE_ARCHIVE" | awk '{print $1}')"
else
  ACTUAL_BOTTLE_SHA256="$(shasum -a 256 "$KANDELO_HOMEBREW_BOTTLE_ARCHIVE" | awk '{print $1}')"
fi
ACTUAL_BOTTLE_BYTES="$(wc -c < "$KANDELO_HOMEBREW_BOTTLE_ARCHIVE" | tr -d '[:space:]')"
if [ "$ACTUAL_BOTTLE_SHA256" != "$KANDELO_HOMEBREW_BOTTLE_SHA256" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: bottle sha256 does not match produced archive" >&2
  exit 1
fi
if [ "$ACTUAL_BOTTLE_BYTES" != "$KANDELO_HOMEBREW_BOTTLE_BYTES" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: bottle byte count does not match produced archive" >&2
  exit 1
fi

# Homebrew bottles are content-addressed independently of the legacy Kandelo
# package registry. The archive digest is the stable cache identity consumed by
# sidecar validation and VFS planning.
CACHE_KEY_SHA="$ACTUAL_BOTTLE_SHA256"

FORMULA_SHA256="$(shasum -a 256 "$FORMULA_PATH" | awk '{print $1}')"
# shellcheck source=/dev/null
. "$KANDELO_ROOT/scripts/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name \
  "$KANDELO_HOMEBREW_TAP_REPOSITORY" "$KANDELO_HOMEBREW_TAP_NAME")"
SDK_FINGERPRINT="$(shasum -a 256 "$KANDELO_ROOT/sdk/activate.sh" | awk '{print $1}')"
SYSROOT_FINGERPRINT="$(bash "$KANDELO_ROOT/scripts/homebrew-sysroot-fingerprint.sh" \
  --kandelo-root "$BUILD_ROOT" --arch "$KANDELO_HOMEBREW_ARCH")"
TAP_COMMIT="$(git -C "$FORMULA_SOURCE_ROOT" rev-parse HEAD)"
KANDELO_COMMIT="$(git -C "$KANDELO_ROOT" rev-parse HEAD)"
BUILD_COMMIT="$(git -C "$BUILD_ROOT" rev-parse HEAD)"
if [ "$BUILD_COMMIT" != "$KANDELO_COMMIT" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: build evidence root differs from the fresh generator commit" >&2
  exit 2
fi
for commit in "$TAP_COMMIT" "$KANDELO_COMMIT"; do
  if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "homebrew-generate-sidecars-from-env.sh: invalid source commit" >&2
    exit 2
  fi
done
python3 "$KANDELO_ROOT/scripts/homebrew-dependency-provenance.py" validate \
  --input "$KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE" \
  --formula "$KANDELO_HOMEBREW_FORMULA" \
  --arch "$KANDELO_HOMEBREW_ARCH" \
  --tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --bottle-root-url "$KANDELO_HOMEBREW_BOTTLE_ROOT_URL" \
  --tap-root "$FORMULA_SOURCE_ROOT"
python3 "$KANDELO_ROOT/scripts/homebrew-bottle-runtime-evidence.py" validate \
  --input "$KANDELO_HOMEBREW_RUNTIME_EVIDENCE" \
  --formula "$KANDELO_HOMEBREW_FORMULA" \
  --arch "$KANDELO_HOMEBREW_ARCH" \
  --abi "$ABI_VERSION" \
  --tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY" \
  --tap-name "$TAP_NAME" \
  --tap-commit "$TAP_COMMIT" \
  --tap-root "$KANDELO_HOMEBREW_TAP_ROOT" \
  --dependency-tap-root "$FORMULA_SOURCE_ROOT" \
  --bottle-root-url "$KANDELO_HOMEBREW_BOTTLE_ROOT_URL" \
  --bottle-json "$KANDELO_HOMEBREW_BOTTLE_JSON" \
  --bottle-url "$KANDELO_HOMEBREW_BOTTLE_URL" \
  --bottle-sha256 "$KANDELO_HOMEBREW_BOTTLE_SHA256" \
  --bottle-bytes "$KANDELO_HOMEBREW_BOTTLE_BYTES" \
  --dependency-provenance "$KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE"
BREW_VERSION="Homebrew source commit $HOMEBREW_BREW_COMMIT"
GENERATED_AT="$(date -u +%FT%TZ)"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-local/kandelo}/actions/runs/${GITHUB_RUN_ID:-local}"
INPUT_JSON="$KANDELO_HOMEBREW_SIDECAR_ROOT/sidecars-input.json"

mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT"
if [ -d "$FORMULA_SOURCE_ROOT/Kandelo" ]; then
  mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo"
  rsync -a "$FORMULA_SOURCE_ROOT/Kandelo/" "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo/"
fi
export ABI_VERSION CACHE_KEY_SHA SDK_FINGERPRINT SYSROOT_FINGERPRINT FORMULA_SHA256 BREW_VERSION
export TAP_COMMIT KANDELO_COMMIT GENERATED_AT RUN_URL TAP_NAME KANDELO_ROOT FORMULA_SOURCE_ROOT
export FORMULA_PATH

python3 - "$INPUT_JSON" <<'PY'
import json
import os
import pathlib
import re
import subprocess
import sys

out_path = pathlib.Path(sys.argv[1])
formula = os.environ["KANDELO_HOMEBREW_FORMULA"]
arch = os.environ["KANDELO_HOMEBREW_ARCH"]
bottle_json_path = pathlib.Path(os.environ["KANDELO_HOMEBREW_BOTTLE_JSON"])
bottle_archive_path = pathlib.Path(os.environ["KANDELO_HOMEBREW_BOTTLE_ARCHIVE"])
dependency_provenance_path = pathlib.Path(
    os.environ["KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE"]
)
runtime_evidence_path = pathlib.Path(os.environ["KANDELO_HOMEBREW_RUNTIME_EVIDENCE"])
try:
    forbidden_roots = json.loads(os.environ["KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON"])
except json.JSONDecodeError as error:
    raise SystemExit(f"forbidden roots are not valid JSON: {error}")
if (
    not isinstance(forbidden_roots, list)
    or not forbidden_roots
    or len(forbidden_roots) > 32
    or any(not isinstance(root, str) or not root for root in forbidden_roots)
):
    raise SystemExit("forbidden roots must be a non-empty JSON string array of at most 32 entries")

with bottle_json_path.open("r", encoding="utf-8") as f:
    bottle_json = json.load(f)
with dependency_provenance_path.open("r", encoding="utf-8") as f:
    dependency_provenance = json.load(f)
with runtime_evidence_path.open("r", encoding="utf-8") as f:
    runtime_evidence = json.load(f)
if not isinstance(dependency_provenance, dict):
    raise SystemExit("dependency provenance must be a JSON object")
if not isinstance(runtime_evidence, dict):
    raise SystemExit("runtime evidence must be a JSON object")

if not isinstance(bottle_json, dict) or len(bottle_json) != 1:
    raise SystemExit(f"expected one formula in bottle JSON, got {len(bottle_json)}")
formula_key, bottle_entry = next(iter(bottle_json.items()))
if not isinstance(bottle_entry, dict) or set(bottle_entry) != {"formula", "bottle"}:
    raise SystemExit("canonical bottle JSON entry has unexpected fields")
bottle_formula = bottle_entry["formula"]
bottle = bottle_entry["bottle"]
if not isinstance(bottle_formula, dict) or set(bottle_formula) != {"name", "path", "pkg_version"}:
    raise SystemExit("canonical bottle Formula metadata has unexpected fields")
if not isinstance(bottle, dict) or set(bottle) != {"root_url", "cellar", "rebuild", "tags"}:
    raise SystemExit("canonical bottle metadata has unexpected fields")
tag_name = f"{arch}_kandelo"
if not isinstance(bottle.get("tags"), dict) or set(bottle["tags"]) != {tag_name}:
    raise SystemExit(f"canonical bottle JSON must contain only tag {tag_name}")
tag = bottle["tags"].get(tag_name)
if tag is None:
    raise SystemExit(f"bottle JSON lacks tag {tag_name}; tags={list(bottle['tags'])}")
if not isinstance(tag, dict) or set(tag) != {"sha256"}:
    raise SystemExit(f"canonical bottle tag {tag_name} has unexpected fields")
root_url = bottle.get("root_url")
if (
    not isinstance(root_url, str)
    or not re.fullmatch(r"https://ghcr\.io/v2/[a-z0-9._/-]+", root_url)
    or root_url.endswith("/")
    or root_url != os.environ["KANDELO_HOMEBREW_BOTTLE_ROOT_URL"]
):
    raise SystemExit("bottle JSON root URL does not match the selected publication root")
if bottle.get("cellar") not in {
    "any", "any_skip_relocation", "/home/linuxbrew/.linuxbrew/Cellar"
}:
    raise SystemExit("canonical bottle JSON has an invalid relocation cellar")
rebuild = bottle.get("rebuild")
if isinstance(rebuild, bool) or not isinstance(rebuild, int) or rebuild < 0:
    raise SystemExit("canonical bottle JSON has an invalid rebuild")

expected_full_name = f"{os.environ['TAP_NAME']}/{formula}"
if formula_key != formula:
    raise SystemExit(
        f"canonical bottle formula key {formula_key!r} does not match {formula!r}"
    )
if bottle_formula.get("name") != formula:
    raise SystemExit(
        f"bottle formula name {bottle_formula.get('name')!r} does not match {formula!r}"
    )
tap_owner, tap_repository = os.environ["TAP_NAME"].split("/", 1)
formula_path = f"Library/Taps/{tap_owner}/homebrew-{tap_repository}/Formula/{formula}.rb"
if bottle_formula.get("path") != formula_path:
    raise SystemExit(
        f"bottle formula path {bottle_formula.get('path')!r} does not match {formula_path!r}"
    )
if tag.get("sha256") != os.environ["CACHE_KEY_SHA"]:
    raise SystemExit("bottle JSON sha256 does not match the produced bottle archive")
expected_bottle_url = (
    f"{os.environ['KANDELO_HOMEBREW_BOTTLE_ROOT_URL']}/{formula}/blobs/"
    f"sha256:{os.environ['CACHE_KEY_SHA']}"
)
if os.environ["KANDELO_HOMEBREW_BOTTLE_URL"] != expected_bottle_url:
    raise SystemExit("bottle URL is not bound to the selected root, formula, and digest")

def require_list(value, label):
    if not isinstance(value, list):
        raise SystemExit(f"{label} must be an array")
    return value

def require_relative_path(value, label):
    if not isinstance(value, str) or not value:
        raise SystemExit(f"{label} must be a non-empty relative path")
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise SystemExit(f"{label} is not a safe relative path: {value!r}")
    return value

version = bottle_formula.get("pkg_version")
if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}", version):
    raise SystemExit("bottle formula pkg_version is invalid")
revision_match = re.fullmatch(r".+_([1-9][0-9]*)", version)
formula_revision = int(revision_match.group(1)) if revision_match else 0
payload_root = f"{formula}/{version}"

def run_json_command(command, label, maximum_bytes, timeout=None):
    try:
        result = subprocess.run(
            command,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f"cannot run {label}: {error}")
    if len(result.stdout) > maximum_bytes or len(result.stderr) > maximum_bytes:
        raise SystemExit(f"{label} output exceeds {maximum_bytes} bytes")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")
        raise SystemExit(f"{label} failed: {stderr[:4096]}")
    try:
        return json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{label} did not return UTF-8 JSON: {error}")

inspection_command = [
    sys.executable,
    str(
        pathlib.Path(os.environ["KANDELO_ROOT"])
        / "scripts/homebrew-inspect-bottle.py"
    ),
    "--archive",
    str(bottle_archive_path),
    "--formula",
    formula,
    "--version",
    version,
    "--expected-abi",
    os.environ["ABI_VERSION"],
    "--expected-arch",
    os.environ["KANDELO_HOMEBREW_ARCH"],
    "--selected-formula",
    os.environ["FORMULA_PATH"],
]
for forbidden_root in forbidden_roots:
    inspection_command.extend(("--forbidden-root", forbidden_root))
inspection = run_json_command(
    inspection_command,
    "bounded bottle inspection",
    64 * 1024 * 1024,
)
expected_inspection_keys = {
    "schema", "abi_version", "arch", "payload_root", "all_files", "path_exec_files",
    "runtime_dependencies", "formula_sha256", "fork_instrumentation",
}
if not isinstance(inspection, dict) or set(inspection) != expected_inspection_keys:
    raise SystemExit("bounded bottle inspection returned an unexpected schema")
if inspection.get("schema") != 1 or inspection.get("payload_root") != payload_root:
    raise SystemExit("bounded bottle inspection identity does not match the selected bottle")
if inspection.get("abi_version") != int(os.environ["ABI_VERSION"]):
    raise SystemExit("bounded bottle inspection ABI does not match the selected release")
if inspection.get("arch") != os.environ["KANDELO_HOMEBREW_ARCH"]:
    raise SystemExit("bounded bottle inspection architecture does not match the selected bottle")
fork_instrumentation = inspection.get("fork_instrumentation")
if fork_instrumentation not in {"required", "not-required"}:
    raise SystemExit("bounded bottle inspection returned invalid fork instrumentation")

all_files_list = require_list(inspection.get("all_files"), "inspected all_files")
all_files = {
    require_relative_path(value, f"inspected all_files[{index}]")
    for index, value in enumerate(all_files_list)
}
if len(all_files) != len(all_files_list) or all_files_list != sorted(all_files_list):
    raise SystemExit("inspected all_files must be uniquely sorted")
path_exec_files = [
    require_relative_path(value, f"inspected path_exec_files[{index}]")
    for index, value in enumerate(
        require_list(inspection.get("path_exec_files"), "inspected path_exec_files")
    )
]
if path_exec_files != sorted(set(path_exec_files)):
    raise SystemExit("inspected path_exec_files must be uniquely sorted")
if not set(path_exec_files).issubset(all_files):
    raise SystemExit("inspected path_exec_files are not bottle payload files")

declarations = run_json_command(
    [
        "ruby",
        str(
            pathlib.Path(os.environ["KANDELO_ROOT"])
            / "scripts/homebrew-formula-runtime-closure.rb"
        ),
        os.environ["FORMULA_SOURCE_ROOT"],
        os.environ["TAP_NAME"],
        formula,
        "--declarations-json",
    ],
    "static Formula declaration inspection",
    1024 * 1024,
    timeout=120,
)
if not isinstance(declarations, dict) or set(declarations) != {
    "schema", "tap", "formula", "full_name", "dependencies"
}:
    raise SystemExit("static Formula declarations returned an unexpected schema")
if (
    declarations.get("schema") != 1
    or declarations.get("tap") != os.environ["TAP_NAME"]
    or declarations.get("formula") != formula
    or declarations.get("full_name") != expected_full_name
):
    raise SystemExit("static Formula declaration identity does not match the selected Formula")

tap_prefix = f"{os.environ['TAP_NAME']}/"
selected_direct_declarations = set()
unsupported_external_declarations = set()
seen_declarations = set()
for index, declaration in enumerate(
    require_list(declarations.get("dependencies"), "static Formula dependencies")
):
    if not isinstance(declaration, dict) or set(declaration) != {"kind", "name", "same_tap"}:
        raise SystemExit(f"static Formula dependencies[{index}] has an unexpected schema")
    name = declaration.get("name")
    kind = declaration.get("kind")
    same_tap = declaration.get("same_tap")
    if not isinstance(name, str) or not name or len(name.encode("utf-8")) > 4096:
        raise SystemExit(f"static Formula dependencies[{index}] has an invalid name")
    if kind not in {"required", "recommended", "optional"} or not isinstance(same_tap, bool):
        raise SystemExit(f"static Formula dependencies[{index}] has invalid classification")
    normalized = name.lower()
    if normalized in seen_declarations:
        raise SystemExit(f"static Formula dependency {name!r} is duplicated")
    seen_declarations.add(normalized)
    if same_tap != normalized.startswith(tap_prefix):
        raise SystemExit(f"static Formula dependency {name!r} has invalid tap classification")
    if same_tap:
        if name != normalized:
            raise SystemExit(f"same-tap Formula dependency {name!r} is not normalized lowercase")
        if kind != "optional":
            selected_direct_declarations.add(name)
    elif kind == "required":
        if normalized.count("/") == 2 and name == normalized:
            selected_direct_declarations.add(normalized)
        else:
            unsupported_external_declarations.add(normalized)
    elif kind == "recommended":
        if normalized.count("/") == 2 and name == normalized:
            selected_direct_declarations.add(normalized)
        else:
            unsupported_external_declarations.add(normalized)

if unsupported_external_declarations:
    raise SystemExit(
        "unqualified required or recommended external Formula dependencies are unsupported: "
        f"{sorted(unsupported_external_declarations)}"
    )
provenance_records = require_list(
    dependency_provenance.get("dependencies"), "dependency provenance dependencies"
)
provenance_dependencies = {}
for index, record in enumerate(provenance_records):
    if not isinstance(record, dict):
        raise SystemExit(f"dependency provenance dependencies[{index}] must be an object")
    full_name = record.get("full_name")
    name = record.get("name")
    version_value = record.get("version")
    declared_directly = record.get("declared_directly")
    if (
        not isinstance(full_name, str)
        or full_name != full_name.lower()
        or full_name.count("/") != 2
        or full_name.rsplit("/", 1)[-1] != name
        or not isinstance(version_value, str)
    ):
        raise SystemExit(f"dependency provenance dependencies[{index}] has invalid identity")
    if not isinstance(declared_directly, bool) or full_name in provenance_dependencies:
        raise SystemExit(f"dependency provenance dependencies[{index}] has invalid directness")
    provenance_dependencies[full_name] = record

provenance_direct_dependencies = {
    full_name
    for full_name, record in provenance_dependencies.items()
    if record["declared_directly"]
}
if selected_direct_declarations != provenance_direct_dependencies:
    missing = sorted(selected_direct_declarations - provenance_direct_dependencies)
    unexpected = sorted(provenance_direct_dependencies - selected_direct_declarations)
    raise SystemExit(
        "validated direct dependency provenance differs from static Formula declarations "
        f"(missing={missing}, unexpected={unexpected})"
    )

runtime_dependencies = require_list(
    inspection.get("runtime_dependencies"), "inspected runtime_dependencies"
)
receipt_dependencies = {}
seen_receipt_dependencies = set()
for index, dep in enumerate(runtime_dependencies):
    if not isinstance(dep, dict) or set(dep) != {"declared_directly", "full_name", "version"}:
        raise SystemExit(f"runtime_dependencies[{index}] has an unexpected schema")
    full_name = dep.get("full_name")
    if not isinstance(full_name, str) or not full_name:
        raise SystemExit(f"runtime_dependencies[{index}].full_name must be a non-empty string")
    declared_directly = dep.get("declared_directly")
    if not isinstance(declared_directly, bool):
        raise SystemExit(f"runtime_dependencies[{index}].declared_directly must be boolean")
    normalized = full_name.lower()
    if normalized in seen_receipt_dependencies:
        raise SystemExit(f"duplicate runtime dependency {full_name!r} in bottle receipt")
    seen_receipt_dependencies.add(normalized)
    version_value = dep.get("version")
    if not isinstance(version_value, str) or not version_value:
        raise SystemExit(f"runtime dependency {full_name!r} lacks a version")
    record = provenance_dependencies.get(normalized)
    if record is None:
        raise SystemExit(f"runtime dependency {full_name!r} lacks validated provenance")
    if full_name != normalized:
        raise SystemExit(f"runtime dependency {full_name!r} is not normalized lowercase")
    if version_value != record["version"] or declared_directly != record["declared_directly"]:
        raise SystemExit(f"runtime dependency {full_name!r} differs from validated provenance")
    receipt_dependencies[normalized] = version_value

if set(receipt_dependencies) != set(provenance_dependencies):
    missing = sorted(set(provenance_dependencies) - set(receipt_dependencies))
    unexpected = sorted(set(receipt_dependencies) - set(provenance_dependencies))
    raise SystemExit(
        "bottle receipt does not match validated immutable-tap dependency provenance "
        f"(missing={missing}, unexpected={unexpected})"
    )
deps = sorted(
    (
        {
            "name": record["name"],
            "full_name": record["full_name"],
            "version": record["version"],
        }
        for record in provenance_dependencies.values()
        if record["declared_directly"]
    ),
    key=lambda dependency: dependency["full_name"],
)

def is_linkable_file(rel):
    parts = pathlib.PurePosixPath(rel).parts
    if not parts or parts[0] not in {"bin", "etc", "include", "lib", "sbin", "share", "var"}:
        return False
    if rel == "lib/charset.alias" or rel == "share/locale/locale.alias":
        return False
    if rel == "share/info/dir" or rel.endswith("/.DS_Store"):
        return False
    if re.fullmatch(r"share/icons/.+/icon-theme\.cache", rel):
        return False
    if "/site-packages/" in rel and pathlib.PurePosixPath(rel).suffix in {".pyc", ".pyo"}:
        return False
    return True

link_paths = sorted(rel for rel in all_files if is_linkable_file(rel))
missing_execs = sorted(set(path_exec_files) - set(link_paths))
if missing_execs:
    raise SystemExit(f"executable bottle paths are not linkable payload files: {missing_execs}")
links = [{"type": "symlink", "source": rel, "target": rel} for rel in link_paths]
path_prepend = [
    directory
    for directory in ("bin", "sbin")
    if any(rel.startswith(f"{directory}/") for rel in path_exec_files)
]
link_env = {"PATH_prepend": path_prepend} if path_prepend else {}

receipts = [f".brew/{formula}.rb", "INSTALL_RECEIPT.json"]
missing_receipts = [receipt for receipt in receipts if receipt not in all_files]
if missing_receipts:
    raise SystemExit(f"bottle payload lacks required Homebrew receipts: {missing_receipts}")

node_runtime = runtime_evidence.get("node")
selection_runtime = runtime_evidence.get("selection")
target_runtime = runtime_evidence.get("target")
if (
    not isinstance(node_runtime, dict)
    or node_runtime.get("runtime") != "node"
    or node_runtime.get("status") != "success"
    or not isinstance(selection_runtime, dict)
    or selection_runtime.get("status") != "success"
    or not isinstance(target_runtime, dict)
):
    raise SystemExit("validated runtime evidence does not prove exact-bottle Node success")

browser_evidence_path = os.environ.get("KANDELO_HOMEBREW_BROWSER_EVIDENCE", "")
browser_evidence = None
if browser_evidence_path:
    path = pathlib.Path(browser_evidence_path)
    metadata = path.lstat()
    if path.is_symlink() or not path.is_file() or metadata.st_size > 1024 * 1024:
        raise SystemExit("browser evidence must be a bounded regular non-symlink file")
    browser_evidence = json.loads(path.read_text(encoding="utf-8"))
    expected_browser_keys = {
        "arch", "bottle_sha256", "bottle_url", "command", "engine",
        "formula", "runtime", "schema", "status",
    }
    if not isinstance(browser_evidence, dict) or set(browser_evidence) != expected_browser_keys:
        raise SystemExit("browser evidence has an unexpected schema")
    if (
        browser_evidence.get("schema") != 1
        or browser_evidence.get("formula") != formula
        or browser_evidence.get("arch") != arch
        or browser_evidence.get("bottle_sha256") != os.environ["KANDELO_HOMEBREW_BOTTLE_SHA256"]
        or browser_evidence.get("bottle_url") != os.environ["KANDELO_HOMEBREW_BOTTLE_URL"]
        or browser_evidence.get("runtime") != "browser"
        or browser_evidence.get("engine") != "chromium"
        or browser_evidence.get("status") != "success"
        or not isinstance(browser_evidence.get("command"), str)
        or not browser_evidence["command"]
    ):
        raise SystemExit("browser evidence does not match the exact selected bottle")
browser_compatible = browser_evidence is not None
if browser_compatible and arch != "wasm32":
    raise SystemExit("browser smoke can only mark wasm32 bottles browser-compatible")
runtime_support = ["node", "browser"] if browser_compatible else ["node"]

browser_smoke_outcome = {
    "name": "browser_smoke",
    "status": "skipped",
    "passed": [],
    "failed": [],
    "skipped": ["browser_compatible is false for this bottle"],
    "skip_reason": "No successful browser VFS smoke was recorded for this bottle.",
}
if browser_compatible:
    vfs_image = os.environ.get("KANDELO_HOMEBREW_VFS_IMAGE", "")
    vfs_report = os.environ.get("KANDELO_HOMEBREW_VFS_REPORT", "")
    gallery_root = os.environ.get("KANDELO_HOMEBREW_GALLERY_ROOT", "")
    browser_url = os.environ.get("KANDELO_HOMEBREW_BROWSER_SMOKE_URL", "")
    browser_command = browser_evidence["command"]
    missing = [
        name for name, value in [
            ("KANDELO_HOMEBREW_VFS_IMAGE", vfs_image),
            ("KANDELO_HOMEBREW_VFS_REPORT", vfs_report),
            ("KANDELO_HOMEBREW_GALLERY_ROOT", gallery_root),
            ("KANDELO_HOMEBREW_BROWSER_SMOKE_URL", browser_url),
        ] if not value
    ]
    if missing:
        raise SystemExit("browser smoke success is missing env: " + ", ".join(missing))
    browser_smoke_outcome = {
        "name": "browser_smoke",
        "status": "success",
        "passed": [
            f"built {vfs_image}",
            f"wrote report {vfs_report}",
            f"Playwright chromium launched {browser_url}",
            f"terminal command passed: {browser_command}",
            f"generated {gallery_root}/gallery.json",
            f"generated {gallery_root}/index.toml",
            "scripts/validate-software-gallery.mjs accepted generated gallery assets",
        ],
        "failed": [],
        "skipped": [],
    }

manifest = {
    "schema": 1,
    "tap_repository": os.environ["KANDELO_HOMEBREW_TAP_REPOSITORY"],
    "tap_name": os.environ["TAP_NAME"],
    "tap_commit": os.environ["TAP_COMMIT"],
    "kandelo_repository": "Automattic/kandelo",
    "kandelo_commit": os.environ["KANDELO_COMMIT"],
    "kandelo_abi": int(os.environ["ABI_VERSION"]),
    "release_tag": os.environ["KANDELO_HOMEBREW_RELEASE_TAG"],
    "generated_at": os.environ["GENERATED_AT"],
    "generator": "kandelo-homebrew-publish 1",
    "packages": [
        {
            "name": formula,
            "full_name": expected_full_name,
            "version": version,
            "formula_revision": formula_revision,
            "bottle_rebuild": int(bottle["rebuild"]),
            "formula_path": f"Formula/{formula}.rb",
            "formula_source_sha256": os.environ["FORMULA_SHA256"],
            "dependencies": deps,
            "bottles": [
                {
                    "arch": arch,
                    "bottle_tag": tag_name,
                    "cellar": "/home/linuxbrew/.linuxbrew/Cellar",
                    "prefix": "/home/linuxbrew/.linuxbrew",
                    "runtime_support": runtime_support,
                    "browser_compatible": browser_compatible,
                    "fork_instrumentation": fork_instrumentation,
                    "status": "success",
                    "built_by": os.environ["RUN_URL"],
                    "built_at": os.environ["GENERATED_AT"],
                    "bottle_file": os.environ["KANDELO_HOMEBREW_BOTTLE_ARCHIVE"],
                    "archived_formula_sha256": inspection["formula_sha256"],
                    "url": os.environ["KANDELO_HOMEBREW_BOTTLE_URL"],
                    "cache_key_sha": os.environ["CACHE_KEY_SHA"],
                    "payload_root": payload_root,
                    "links": links,
                    "receipts": receipts,
                    "env": link_env,
                    "build": {
                        "github_run": os.environ["RUN_URL"],
                        "job": os.environ.get("GITHUB_JOB", "local"),
                        "runner_os": os.environ.get("RUNNER_OS", "local"),
                        "brew_version": os.environ["BREW_VERSION"],
                        "dev_shell": "scripts/dev-shell.sh",
                        "sdk_fingerprint": os.environ["SDK_FINGERPRINT"],
                        "sysroot_fingerprint": os.environ["SYSROOT_FINGERPRINT"],
                    },
                    "validation": {
                        "outcome_lists": [
                            {
                                "name": "schema",
                                "status": "success",
                                "passed": [
                                    "Kandelo/metadata.json",
                                    f"Kandelo/formula/{formula}.json",
                                    f"Kandelo/link/{formula}-{version}-rebuild{bottle['rebuild']}-{arch}.json",
                                    f"Kandelo/reports/{formula}-{version}-rebuild{bottle['rebuild']}-{arch}.provenance.json",
                                ],
                                "failed": [],
                                "skipped": [],
                            },
                            {
                                "name": "homebrew_audit",
                                "status": "skipped",
                                "passed": [],
                                "failed": [],
                                "skipped": ["brew audit was not part of kd-8ho.5 local verification"],
                                "skip_reason": "kd-8ho.5 validates the first bottle build and sidecars; tap audit can run in the real tap publication gate.",
                            },
                            {
                                "name": "bottle_build",
                                "status": "success",
                                "passed": [
                                    "brew install --build-bottle",
                                    "brew test",
                                    "brew bottle --json --keep-old",
                                    "scripts/homebrew-merge-bottle-json.sh statically composed canonical bottle metadata",
                                ],
                                "failed": [],
                                "skipped": [],
                            },
                            {
                                "name": "node_smoke",
                                "status": "success",
                                "passed": [
                                    f"Homebrew force-poured {formula} from {selection_runtime['bottle']['mode']}",
                                    f"brew test emitted Kandelo Node receipt via {node_runtime['launcher']}",
                                    f"exact bottle sha256: {os.environ['KANDELO_HOMEBREW_BOTTLE_SHA256']}",
                                ],
                                "failed": [],
                                "skipped": [],
                            },
                            browser_smoke_outcome,
                        ],
                    },
                }
            ],
        }
    ],
}
out_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT/Formula"
cp "$MERGED_FORMULA_PATH" \
  "$KANDELO_HOMEBREW_SIDECAR_ROOT/Formula/"

(
  cd "$KANDELO_ROOT"
  sidecar_args=(
    homebrew-sidecars
    --tap-root "$KANDELO_HOMEBREW_SIDECAR_ROOT"
    --input "$INPUT_JSON"
  )
  if [ -f "$FORMULA_SOURCE_ROOT/Kandelo/metadata.json" ]; then
    sidecar_args+=(--previous-metadata "$FORMULA_SOURCE_ROOT/Kandelo/metadata.json")
  fi
  cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
    "${sidecar_args[@]}"
)
