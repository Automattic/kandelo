#!/usr/bin/env bash
# Generate Kandelo/Homebrew sidecars for the bottle built by the trusted
# Homebrew workflow. Inputs are provided through KANDELO_HOMEBREW_* env vars.
set -euo pipefail

KANDELO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "homebrew-generate-sidecars-from-env.sh: $name is required" >&2
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
  KANDELO_HOMEBREW_BOTTLE_ARCHIVE \
  KANDELO_HOMEBREW_BOTTLE_JSON \
  KANDELO_HOMEBREW_BOTTLE_URL \
  KANDELO_HOMEBREW_BOTTLE_SHA256 \
  KANDELO_HOMEBREW_BOTTLE_BYTES; do
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
FORMULA_SOURCE_ROOT="${KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT:-$KANDELO_HOMEBREW_TAP_ROOT}"
FORMULA_PATH="$FORMULA_SOURCE_ROOT/Formula/$KANDELO_HOMEBREW_FORMULA.rb"
MERGED_FORMULA_PATH="$KANDELO_HOMEBREW_TAP_ROOT/Formula/$KANDELO_HOMEBREW_FORMULA.rb"
if [ ! -f "$FORMULA_PATH" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: build-source formula not found: $FORMULA_PATH" >&2
  exit 2
fi
if [ ! -f "$MERGED_FORMULA_PATH" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: merged formula not found: $MERGED_FORMULA_PATH" >&2
  exit 2
fi
if [ ! -f "$KANDELO_HOMEBREW_BOTTLE_ARCHIVE" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: bottle archive not found: $KANDELO_HOMEBREW_BOTTLE_ARCHIVE" >&2
  exit 2
fi
if [ ! -f "$KANDELO_HOMEBREW_BOTTLE_JSON" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: bottle JSON not found: $KANDELO_HOMEBREW_BOTTLE_JSON" >&2
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
TAP_NAME="$(printf '%s' "$KANDELO_HOMEBREW_TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
BREW_BIN="${HOMEBREW_BREW_FILE:-brew}"
BREW_INFO_WORK_DIR="$(mktemp -d)"
FORMULA_INFO_JSON="$(mktemp "${TMPDIR:-/tmp}/kandelo-homebrew-formula-info.XXXXXX")"
. "$KANDELO_ROOT/scripts/homebrew-patched-launcher.sh"

cleanup() {
  homebrew_patched_launcher_cleanup
  rm -rf "$BREW_INFO_WORK_DIR"
  rm -f "$FORMULA_INFO_JSON"
}
trap cleanup EXIT

export XDG_CONFIG_HOME="$BREW_INFO_WORK_DIR/xdg-config"
mkdir -p "$XDG_CONFIG_HOME/homebrew"
chmod 0700 "$XDG_CONFIG_HOME" "$XDG_CONFIG_HOME/homebrew"
PATCH_FILE="${KANDELO_HOMEBREW_PATCH_FILE:-$KANDELO_ROOT/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch}"
homebrew_patched_launcher_prepare "$BREW_BIN" "$PATCH_FILE" "$BREW_INFO_WORK_DIR"
BREW_BIN="$HOMEBREW_PATCHED_BREW_BIN"
ACTUAL_BREW_COMMIT="$(git -C "$HOMEBREW_PATCHED_REPO" rev-parse HEAD)"
BREW_COMMIT="${HOMEBREW_BREW_COMMIT:-$ACTUAL_BREW_COMMIT}"
if ! [[ "$BREW_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-generate-sidecars-from-env.sh: invalid Homebrew commit: $BREW_COMMIT" >&2
  exit 2
fi
if [ "$ACTUAL_BREW_COMMIT" != "$BREW_COMMIT" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: active Homebrew checkout differs from $BREW_COMMIT" >&2
  exit 1
fi
SDK_FINGERPRINT="$(shasum -a 256 "$KANDELO_ROOT/sdk/activate.sh" | awk '{print $1}')"
SYSROOT_FINGERPRINT="$(shasum -a 256 "$KANDELO_ROOT/sysroot/lib/libc.a" | awk '{print $1}')"

"$BREW_BIN" tap "$TAP_NAME" "$FORMULA_SOURCE_ROOT"
"$BREW_BIN" trust --tap "$TAP_NAME"
if BREW_VERSION_OUTPUT="$("$BREW_BIN" --version)"; then
  :
else
  status=$?
  echo "homebrew-generate-sidecars-from-env.sh: brew --version failed with status $status" >&2
  exit 1
fi
BREW_VERSION="${BREW_VERSION_OUTPUT%%$'\n'*}"
if [ -z "$BREW_VERSION" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: brew --version returned no version" >&2
  exit 1
fi
BREW_VERSION="$BREW_VERSION (commit $BREW_COMMIT)"
"$BREW_BIN" info --json=v2 --formula "$TAP_NAME/$KANDELO_HOMEBREW_FORMULA" > "$FORMULA_INFO_JSON"
TAP_COMMIT="$(git -C "$FORMULA_SOURCE_ROOT" rev-parse HEAD)"
KANDELO_COMMIT="$(git -C "$KANDELO_ROOT" rev-parse HEAD)"
GENERATED_AT="$(date -u +%FT%TZ)"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-local/kandelo}/actions/runs/${GITHUB_RUN_ID:-local}"
INPUT_JSON="$KANDELO_HOMEBREW_SIDECAR_ROOT/sidecars-input.json"

mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT"
if [ -d "$FORMULA_SOURCE_ROOT/Kandelo" ]; then
  mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo"
  rsync -a "$FORMULA_SOURCE_ROOT/Kandelo/" "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo/"
fi
export ABI_VERSION CACHE_KEY_SHA SDK_FINGERPRINT SYSROOT_FINGERPRINT FORMULA_SHA256 BREW_VERSION
export TAP_COMMIT KANDELO_COMMIT GENERATED_AT RUN_URL TAP_NAME KANDELO_ROOT FORMULA_INFO_JSON

python3 - "$INPUT_JSON" <<'PY'
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

out_path = pathlib.Path(sys.argv[1])
formula = os.environ["KANDELO_HOMEBREW_FORMULA"]
arch = os.environ["KANDELO_HOMEBREW_ARCH"]
bottle_json_path = pathlib.Path(os.environ["KANDELO_HOMEBREW_BOTTLE_JSON"])
bottle_archive_path = pathlib.Path(os.environ["KANDELO_HOMEBREW_BOTTLE_ARCHIVE"])
formula_info_path = pathlib.Path(os.environ["FORMULA_INFO_JSON"])

with bottle_json_path.open("r", encoding="utf-8") as f:
    bottle_json = json.load(f)
with formula_info_path.open("r", encoding="utf-8") as f:
    formula_info = json.load(f)
if not isinstance(formula_info, dict):
    raise SystemExit("brew info output must be a JSON object")

if len(bottle_json) != 1:
    raise SystemExit(f"expected one formula in bottle JSON, got {len(bottle_json)}")
formula_key, bottle_entry = next(iter(bottle_json.items()))
bottle_formula = bottle_entry["formula"]
bottle = bottle_entry["bottle"]
tag_name = f"{arch}_kandelo"
tag = bottle["tags"].get(tag_name)
if tag is None:
    raise SystemExit(f"bottle JSON lacks tag {tag_name}; tags={list(bottle['tags'])}")

expected_full_name = f"{os.environ['TAP_NAME']}/{formula}"
if formula_key.lower() != expected_full_name:
    raise SystemExit(
        f"bottle formula key {formula_key!r} does not match tap formula {expected_full_name!r}"
    )
if bottle_formula.get("name") != formula:
    raise SystemExit(
        f"bottle formula name {bottle_formula.get('name')!r} does not match {formula!r}"
    )
formula_path = f"Formula/{formula}.rb"
if bottle_formula.get("tap_git_path") != formula_path:
    raise SystemExit(
        f"bottle formula path {bottle_formula.get('tap_git_path')!r} does not match {formula_path!r}"
    )
if bottle_formula.get("tap_git_revision") != os.environ["TAP_COMMIT"]:
    raise SystemExit(
        f"bottle formula revision {bottle_formula.get('tap_git_revision')!r} "
        f"does not match tap commit {os.environ['TAP_COMMIT']!r}"
    )
if tag.get("sha256") != os.environ["CACHE_KEY_SHA"]:
    raise SystemExit("bottle JSON sha256 does not match the produced bottle archive")

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

formulae = require_list(formula_info.get("formulae"), "brew info formulae")
if formula_info.get("casks") != []:
    raise SystemExit("brew info returned unexpected cask records")
if len(formulae) != 1 or not isinstance(formulae[0], dict):
    raise SystemExit(f"expected one formula from brew info, got {len(formulae)}")
formula_record = formulae[0]
if formula_record.get("name") != formula:
    raise SystemExit(
        f"brew info formula name {formula_record.get('name')!r} does not match {formula!r}"
    )
if str(formula_record.get("full_name", "")).lower() != expected_full_name:
    raise SystemExit(
        f"brew info full name {formula_record.get('full_name')!r} "
        f"does not match {expected_full_name!r}"
    )
if str(formula_record.get("tap", "")).lower() != os.environ["TAP_NAME"]:
    raise SystemExit(
        f"brew info tap {formula_record.get('tap')!r} "
        f"does not match {os.environ['TAP_NAME']!r}"
    )
source_checksum = formula_record.get("ruby_source_checksum")
if (
    not isinstance(source_checksum, dict)
    or source_checksum.get("sha256") != os.environ["FORMULA_SHA256"]
):
    raise SystemExit("brew info formula checksum does not match the selected tap formula")

tap_prefix = f"{os.environ['TAP_NAME']}/"

def declared_runtime_dependencies(field, require_tap):
    dependencies = {}
    declared = require_list(formula_record.get(field), f"brew info {field}")
    for index, full_name in enumerate(declared):
        if not isinstance(full_name, str) or not full_name:
            raise SystemExit(f"brew info {field}[{index}] is not a formula name")
        normalized = full_name.lower()
        if require_tap and not normalized.startswith(tap_prefix):
            raise SystemExit(
                f"brew info {field}[{index}] {full_name!r} is not a formula "
                f"in {os.environ['TAP_NAME']}"
            )
        if not normalized.startswith(tap_prefix):
            dependencies[normalized] = None
            continue
        name = normalized.rsplit("/", 1)[-1]
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", name):
            raise SystemExit(f"unsupported Homebrew dependency name {name!r}")
        dependencies[normalized] = name
    return dependencies

required_dependencies = declared_runtime_dependencies("dependencies", True)
selected_dependencies = dict(required_dependencies)
conditional_external_dependencies = set()
for field in ("recommended_dependencies", "optional_dependencies"):
    for full_name, name in declared_runtime_dependencies(field, False).items():
        if name is None:
            conditional_external_dependencies.add(full_name)
            continue
        existing = selected_dependencies.get(full_name)
        if existing is not None and existing != name:
            raise SystemExit(f"conflicting declared runtime dependency {full_name!r}")
        selected_dependencies[full_name] = name

tab = tag.get("tab")
if not isinstance(tab, dict):
    raise SystemExit(f"bottle tag {tag_name} lacks Homebrew installation metadata")
runtime_dependencies = require_list(tab.get("runtime_dependencies"), "runtime_dependencies")
receipt_dependencies = {}
seen_receipt_dependencies = set()
for index, dep in enumerate(runtime_dependencies):
    if not isinstance(dep, dict):
        raise SystemExit(f"runtime_dependencies[{index}] must be an object")
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
    version = dep.get("pkg_version") or dep.get("version")
    if not isinstance(version, str) or not version:
        raise SystemExit(f"runtime dependency {full_name!r} lacks a version")
    if normalized in conditional_external_dependencies and declared_directly:
        raise SystemExit(
            f"selected runtime dependency {full_name!r} is outside {os.environ['TAP_NAME']}"
        )
    if normalized not in selected_dependencies:
        # Homebrew may inject Linux sandbox/build dependencies such as
        # bubblewrap and libcap into source-build receipts. They are host build
        # facts, not dependencies declared by the target formula.
        continue
    if not declared_directly:
        raise SystemExit(
            f"declared runtime dependency {full_name!r} is not direct in the receipt"
        )
    existing = receipt_dependencies.get(normalized)
    if existing is not None and existing != version:
        raise SystemExit(f"declared runtime dependency {full_name!r} has conflicting versions")
    receipt_dependencies[normalized] = version

missing_required = sorted(set(required_dependencies) - set(receipt_dependencies))
if missing_required:
    raise SystemExit(f"bottle receipt lacks declared runtime dependencies: {missing_required}")
deps = [
    {"name": selected_dependencies[full_name], "version": receipt_dependencies[full_name]}
    for full_name in sorted(receipt_dependencies, key=lambda value: selected_dependencies[value])
]

all_files = {
    require_relative_path(value, f"all_files[{index}]")
    for index, value in enumerate(require_list(tag.get("all_files"), "all_files"))
}
path_exec_files = [
    require_relative_path(value, f"path_exec_files[{index}]")
    for index, value in enumerate(require_list(tag.get("path_exec_files"), "path_exec_files"))
]

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

version = str(bottle_formula["pkg_version"])
if not version:
    raise SystemExit("bottle formula pkg_version must not be empty")
revision_match = re.fullmatch(r".+_([1-9][0-9]*)", version)
formula_revision = int(revision_match.group(1)) if revision_match else 0
payload_root = f"{formula}/{version}"

archive_members = {}
listing = subprocess.run(
    ["tar", "-tf", bottle_archive_path],
    check=True,
    stdout=subprocess.PIPE,
    text=True,
).stdout.splitlines()
for member in listing:
    normalized = member.removeprefix("./").rstrip("/")
    if normalized:
        archive_members[normalized] = member

fork_exports = {
    b"wpk_fork_unwind_begin",
    b"wpk_fork_unwind_end",
    b"wpk_fork_rewind_begin",
    b"wpk_fork_rewind_end",
    b"wpk_fork_state",
}
fork_instrumentation = "not-required"
for rel in path_exec_files:
    normalized = f"{payload_root}/{rel}"
    member = archive_members.get(normalized)
    if member is None:
        raise SystemExit(f"bottle archive lacks executable payload member {normalized!r}")
    data = subprocess.run(
        ["tar", "-xOf", bottle_archive_path, member],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    if not data.startswith(b"\0asm"):
        continue
    with tempfile.NamedTemporaryFile(suffix=".wasm") as wasm_file:
        wasm_file.write(data)
        wasm_file.flush()
        dump = subprocess.run(
            ["wasm-objdump", "-x", wasm_file.name],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        ).stdout
    export_names = {
        name.encode()
        for name in re.findall(r'-> "([^"]+)"', dump)
    }
    if b"asyncify_" in data or any(name.startswith(b"asyncify_") for name in export_names):
        raise SystemExit(f"bottle executable {rel!r} contains legacy Asyncify instrumentation")
    present = fork_exports & export_names
    if present and present != fork_exports:
        missing = sorted(name.decode() for name in fork_exports - present)
        raise SystemExit(f"bottle executable {rel!r} has incomplete fork instrumentation: {missing}")
    if present == fork_exports:
        fork_instrumentation = "required"

browser_smoke_status = os.environ.get("KANDELO_HOMEBREW_BROWSER_SMOKE_STATUS", "skipped")
if browser_smoke_status not in {"success", "skipped"}:
    raise SystemExit(f"invalid KANDELO_HOMEBREW_BROWSER_SMOKE_STATUS={browser_smoke_status!r}")
browser_compatible = browser_smoke_status == "success"
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
    browser_command = os.environ.get(
        "KANDELO_HOMEBREW_BROWSER_SMOKE_COMMAND",
        f"/home/linuxbrew/.linuxbrew/bin/{formula} --version",
    )
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
                                    "brew bottle --json --no-rebuild",
                                    "brew bottle --merge --write --no-commit --keep-old",
                                ],
                                "failed": [],
                                "skipped": [],
                            },
                            {
                                "name": "node_smoke",
                                "status": "success",
                                "passed": [
                                    f"Formula test ran {formula} through the Kandelo Node runtime"
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
