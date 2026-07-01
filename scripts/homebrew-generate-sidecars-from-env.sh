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
KANDELO_HOMEBREW_PACKAGE="$KANDELO_HOMEBREW_FORMULA"
if [ "$KANDELO_HOMEBREW_PACKAGE" = "file-formula" ]; then
  KANDELO_HOMEBREW_PACKAGE="file"
fi
PACKAGE_DIR="$KANDELO_ROOT/packages/registry/$KANDELO_HOMEBREW_PACKAGE"
if [ ! -d "$PACKAGE_DIR" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: package registry entry not found: $PACKAGE_DIR" >&2
  exit 2
fi

ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' "$KANDELO_ROOT/crates/shared/src/lib.rs" | head -n1)"
if [ "$KANDELO_HOMEBREW_RELEASE_TAG" != "bottles-abi-v${ABI_VERSION}" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: release tag $KANDELO_HOMEBREW_RELEASE_TAG does not match ABI $ABI_VERSION" >&2
  exit 2
fi

CACHE_KEY_SHA="$(
  cd "$KANDELO_ROOT"
  cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
    compute-cache-key-sha --package "$PACKAGE_DIR" --arch "$KANDELO_HOMEBREW_ARCH"
)"

SDK_FINGERPRINT="$(shasum -a 256 "$KANDELO_ROOT/sdk/activate.sh" | awk '{print $1}')"
SYSROOT_FINGERPRINT="$(shasum -a 256 "$KANDELO_ROOT/sysroot/lib/libc.a" | awk '{print $1}')"
BREW_VERSION="$("${HOMEBREW_BREW_FILE:-brew}" --version | head -n 1)"
TAP_COMMIT="$(git -C "$KANDELO_HOMEBREW_TAP_ROOT" rev-parse HEAD)"
KANDELO_COMMIT="$(git -C "$KANDELO_ROOT" rev-parse HEAD)"
GENERATED_AT="$(date -u +%FT%TZ)"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-local/kandelo}/actions/runs/${GITHUB_RUN_ID:-local}"
TAP_NAME="$(printf '%s' "$KANDELO_HOMEBREW_TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
INPUT_JSON="$KANDELO_HOMEBREW_SIDECAR_ROOT/sidecars-input.json"

mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT"
export ABI_VERSION CACHE_KEY_SHA SDK_FINGERPRINT SYSROOT_FINGERPRINT BREW_VERSION
export TAP_COMMIT KANDELO_COMMIT GENERATED_AT RUN_URL TAP_NAME PACKAGE_DIR KANDELO_ROOT
export KANDELO_HOMEBREW_PACKAGE

python3 - "$INPUT_JSON" <<'PY'
import json
import os
import pathlib
import sys
import tomllib

out_path = pathlib.Path(sys.argv[1])
formula = os.environ["KANDELO_HOMEBREW_FORMULA"]
package_name = os.environ["KANDELO_HOMEBREW_PACKAGE"]
arch = os.environ["KANDELO_HOMEBREW_ARCH"]
package_dir = pathlib.Path(os.environ["PACKAGE_DIR"])
bottle_json_path = pathlib.Path(os.environ["KANDELO_HOMEBREW_BOTTLE_JSON"])

with (package_dir / "package.toml").open("rb") as f:
    package_toml = tomllib.load(f)
with bottle_json_path.open("r", encoding="utf-8") as f:
    bottle_json = json.load(f)

if len(bottle_json) != 1:
    raise SystemExit(f"expected one formula in bottle JSON, got {len(bottle_json)}")
formula_key, bottle_entry = next(iter(bottle_json.items()))
bottle_formula = bottle_entry["formula"]
bottle = bottle_entry["bottle"]
tag_name = f"{arch}_kandelo"
tag = bottle["tags"].get(tag_name)
if tag is None:
    raise SystemExit(f"bottle JSON lacks tag {tag_name}; tags={list(bottle['tags'])}")

deps = []
for dep in package_toml.get("depends_on", []):
    if "@" in dep:
        name, version = dep.split("@", 1)
        deps.append({"name": name, "version": version})
    else:
        deps.append({"name": dep})

version = str(bottle_formula["pkg_version"])
package_kind = package_toml.get("kind", "program")
if package_kind not in {"library", "program"}:
    raise SystemExit(f"unsupported Homebrew sidecar package kind for {package_name}: {package_kind!r}")

PROGRAM_ALIASES = {
    "cpython": ["python", "python3"],
    "coreutils": [
        "cat", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
        "head", "tail", "wc", "sort", "uniq", "tr", "cut", "paste", "tee",
        "true", "false", "yes", "env", "printenv", "printf", "expr", "test", "[",
        "basename", "dirname", "readlink", "realpath", "stat", "touch", "date",
        "sleep", "id", "whoami", "uname", "hostname", "pwd", "dd", "od", "md5sum",
        "sha256sum", "base64", "seq", "factor", "nproc", "du", "df",
    ],
    "gzip": ["gunzip", "zcat"],
    "php": ["php-fpm"],
    "tcl": ["tclsh"],
    "unzip": ["zipinfo", "funzip"],
    "zstd": ["unzstd", "zstdcat"],
}

EXTRA_PROGRAM_LINKS = {
    "cpython": [
        {"type": "directory", "source": "lib/python3.13", "target": "lib/python3.13", "mode": "0755"},
    ],
    "erlang": [
        {"type": "directory", "source": "libexec/erlang", "target": "libexec/erlang", "mode": "0755"},
    ],
    "file": [
        {"type": "file", "source": "share/file/magic.lite", "target": "share/file/magic.lite", "mode": "0644"},
    ],
    "php": [
        {"type": "file", "source": "lib/php/extensions/opcache.so", "target": "lib/php/extensions/opcache.so", "mode": "0644"},
    ],
    "perl": [
        {"type": "directory", "source": "lib/perl5", "target": "lib/perl5", "mode": "0755"},
    ],
    "ruby": [
        {"type": "directory", "source": "lib/ruby", "target": "lib/ruby", "mode": "0755"},
        {"type": "file", "source": "share/ruby-runtime.zip", "target": "share/ruby-runtime.zip", "mode": "0644"},
    ],
    "tcl": [
        {"type": "directory", "source": "lib/tcl8.6", "target": "lib/tcl8.6", "mode": "0755"},
    ],
    "texlive": [
        {"type": "directory", "source": "share/texmf-dist", "target": "share/texmf-dist", "mode": "0755"},
        {"type": "file", "source": "share/texlive/texlive-bundle.json", "target": "share/texlive/texlive-bundle.json", "mode": "0644"},
    ],
}

FORK_INSTRUMENTED_PROGRAMS = {"coreutils", "php", "ruby", "tcl"}

def package_links_and_env():
    if package_kind == "library":
        outputs = package_toml.get("outputs", {})
        links = []
        for key in ("headers", "libs", "pkgconfig"):
            for rel in sorted(outputs.get(key, [])):
                links.append({
                    "type": "file",
                    "source": rel,
                    "target": rel,
                    "mode": "0644",
                })
        if not links:
            raise SystemExit(f"library formula {formula} has no declared package outputs to link")
        return links, {}

    outputs = package_toml.get("outputs", [])
    if not isinstance(outputs, list):
        raise SystemExit(f"program formula {formula} has invalid outputs shape")

    bin_names = []
    for output in outputs:
        output_name = output.get("name")
        wasm_name = output.get("wasm", "")
        if output_name and wasm_name.endswith(".wasm"):
            bin_names.append(output_name)
    if not bin_names:
            bin_names.append(package_name)

    names = []
    for name in [*bin_names, *PROGRAM_ALIASES.get(package_name, [])]:
        if name not in names:
            names.append(name)

    links = [
        {"type": "symlink", "source": f"bin/{name}", "target": f"bin/{name}"}
        for name in names
    ]
    links.extend(EXTRA_PROGRAM_LINKS.get(package_name, []))
    return links, {"PATH_prepend": ["bin"]}

def package_fork_instrumentation():
    if package_name in FORK_INSTRUMENTED_PROGRAMS:
        return "required"
    outputs = package_toml.get("outputs", [])
    if isinstance(outputs, list):
        for output in outputs:
            if output.get("name") == package_name:
                return output.get("fork_instrumentation", "not-required")
    return "not-required"

def default_node_smoke_text():
    if package_kind == "library":
        return (
            f"Formula test compiled packages/registry/{package_name}/test/{package_name}_basic.c "
            "against the installed keg and ran the resulting Wasm through "
            "node --import tsx/esm examples/run-example.ts"
        )
    if package_name == "bzip2":
        return (
            "Formula test ran bzip2 --help through "
            "node --import tsx/esm examples/run-example.ts"
        )
    return (
        f"Formula test ran {package_name} --version through "
        "node --import tsx/esm examples/run-example.ts"
    )

def skipped_outcome(name, reason):
    return {
        "name": name,
        "status": "skipped",
        "passed": [],
        "failed": [],
        "skipped": [reason],
        "skip_reason": reason,
    }

def failed_outcome(name, reason):
    return {
        "name": name,
        "status": "failed",
        "passed": [],
        "failed": [reason],
        "skipped": [],
    }

def browser_outcome_from_summary(summary_path, summary_formula, arch):
    with pathlib.Path(summary_path).open("r", encoding="utf-8") as f:
        summary = json.load(f)
    packages = summary.get("packages")
    if not isinstance(packages, list):
        raise SystemExit(f"browser smoke summary lacks packages list: {summary_path}")
    matches = [
        package for package in packages
        if package.get("formula") == summary_formula and package.get("arch") == arch
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"browser smoke summary expected one {summary_formula} {arch} entry, got {len(matches)}"
        )
    package = matches[0]
    status = package.get("status")
    if status not in {"success", "failed", "skipped"}:
        raise SystemExit(f"invalid browser smoke summary status for {summary_formula} {arch}: {status!r}")

    def strings(key):
        value = package.get(key, [])
        if not isinstance(value, list):
            raise SystemExit(f"browser smoke summary {summary_formula} {arch} {key} must be a list")
        out = []
        for entry in value:
            text = str(entry)
            if text:
                out.append(text)
        return out

    passed = strings("passed")
    failed = strings("failed")
    skipped = strings("skipped")
    if status == "success" and not passed:
        raise SystemExit(f"browser smoke summary success for {summary_formula} {arch} has no passed evidence")
    if status == "failed" and not failed:
        failed = [f"browser smoke failed for {summary_formula} {arch}; see {summary_path}"]
    if status == "skipped" and not skipped:
        skipped = [package.get("skip_reason") or f"browser smoke skipped for {summary_formula} {arch}; see {summary_path}"]

    outcome = {
        "name": "browser_smoke",
        "status": status,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
    }
    if status == "skipped":
        outcome["skip_reason"] = package.get("skip_reason") or skipped[0]
    return status, outcome

links, link_env = package_links_and_env()
browser_summary = os.environ.get("KANDELO_HOMEBREW_BROWSER_SMOKE_SUMMARY", "")
browser_smoke_outcome = None
if browser_summary:
    browser_smoke_status, browser_smoke_outcome = browser_outcome_from_summary(
        browser_summary,
        package_name,
        arch,
    )
else:
    browser_smoke_status = os.environ.get("KANDELO_HOMEBREW_BROWSER_SMOKE_STATUS", "skipped")
    if browser_smoke_status not in {"success", "skipped", "failed"}:
        raise SystemExit(f"invalid KANDELO_HOMEBREW_BROWSER_SMOKE_STATUS={browser_smoke_status!r}")
browser_compatible = browser_smoke_status == "success"
if browser_compatible and arch != "wasm32":
    raise SystemExit("browser smoke can only mark wasm32 bottles browser-compatible")
runtime_support = ["node", "browser"] if browser_compatible else ["node"]

if browser_smoke_outcome is None:
    browser_reason = os.environ.get(
        "KANDELO_HOMEBREW_BROWSER_SMOKE_REASON",
        f"No successful browser VFS smoke was recorded for {package_name} {arch}.",
    )
    browser_smoke_outcome = skipped_outcome("browser_smoke", browser_reason)
    if browser_smoke_status == "failed":
        browser_smoke_outcome = failed_outcome("browser_smoke", browser_reason)
if browser_compatible and not browser_summary:
    vfs_image = os.environ.get("KANDELO_HOMEBREW_VFS_IMAGE", "")
    vfs_report = os.environ.get("KANDELO_HOMEBREW_VFS_REPORT", "")
    browser_url = os.environ.get("KANDELO_HOMEBREW_BROWSER_SMOKE_URL", "")
    browser_command = os.environ.get(
        "KANDELO_HOMEBREW_BROWSER_SMOKE_COMMAND",
        f"/home/linuxbrew/.linuxbrew/bin/{formula} --version",
    )
    missing = [
        name for name, value in [
            ("KANDELO_HOMEBREW_VFS_IMAGE", vfs_image),
            ("KANDELO_HOMEBREW_VFS_REPORT", vfs_report),
            ("KANDELO_HOMEBREW_BROWSER_SMOKE_URL", browser_url),
        ] if not value
    ]
    if missing:
        raise SystemExit("browser smoke success is missing env: " + ", ".join(missing))
    browser_passed = [
        f"built precomposed VFS image {vfs_image}",
        f"wrote VFS report {vfs_report}",
        f"Playwright chromium launched {browser_url}",
        f"terminal command passed: {browser_command}",
    ]
    gallery_root = os.environ.get("KANDELO_HOMEBREW_GALLERY_ROOT", "")
    if gallery_root:
        browser_passed.extend([
            f"generated {gallery_root}/gallery.json",
            f"generated {gallery_root}/index.toml",
            "scripts/validate-software-gallery.mjs accepted generated gallery assets",
        ])
    browser_smoke_outcome = {
        "name": "browser_smoke",
        "status": "success",
        "passed": browser_passed,
        "failed": [],
        "skipped": [],
    }

node_smoke_text = os.environ.get("KANDELO_HOMEBREW_NODE_SMOKE_COMMAND", default_node_smoke_text())

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
            "name": package_name,
            "full_name": formula_key,
            "version": version,
            "formula_revision": 0,
            "bottle_rebuild": int(bottle["rebuild"]),
            "formula_path": f"Formula/{formula}.rb",
            "dependencies": deps,
            "bottles": [
                {
                    "arch": arch,
                    "bottle_tag": tag_name,
                    "cellar": "/home/linuxbrew/.linuxbrew/Cellar",
                    "prefix": "/home/linuxbrew/.linuxbrew",
                    "runtime_support": runtime_support,
                    "browser_compatible": browser_compatible,
                    "fork_instrumentation": package_fork_instrumentation(),
                    "status": "success",
                    "built_by": os.environ["RUN_URL"],
                    "built_at": os.environ["GENERATED_AT"],
                    "bottle_file": os.environ["KANDELO_HOMEBREW_BOTTLE_ARCHIVE"],
                    "url": os.environ["KANDELO_HOMEBREW_BOTTLE_URL"],
                    "cache_key_sha": os.environ["CACHE_KEY_SHA"],
                    "payload_root": f"{formula}/{version}",
                    "links": links,
                    "receipts": [f".brew/{formula}.rb", "INSTALL_RECEIPT.json"],
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
                                "skipped": ["brew audit was not part of this local dry-run verification"],
                                "skip_reason": "Tap audit can run in the trusted tap publication gate.",
                            },
                            {
                                "name": "bottle_build",
                                "status": "success",
                                "passed": [
                                    "brew install --build-bottle",
                                    "brew test",
                                    "brew bottle --json --no-rebuild",
                                    "brew bottle --merge --write --no-commit",
                                ],
                                "failed": [],
                                "skipped": [],
                            },
                            {
                                "name": "node_smoke",
                                "status": "success",
                                "passed": [node_smoke_text],
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
if os.environ.get("KANDELO_HOMEBREW_ACCUMULATE_INPUTS") == "1" and out_path.exists():
    with out_path.open("r", encoding="utf-8") as f:
        previous_manifest = json.load(f)
    previous_packages = previous_manifest.get("packages", [])
    if not isinstance(previous_packages, list):
        raise SystemExit(f"existing {out_path} has invalid packages list")
    current_names = {pkg["name"] for pkg in manifest["packages"]}
    manifest["packages"] = [
        pkg for pkg in previous_packages
        if isinstance(pkg, dict) and pkg.get("name") not in current_names
    ] + manifest["packages"]
out_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT/Formula"
cp "$KANDELO_HOMEBREW_TAP_ROOT/Formula/$KANDELO_HOMEBREW_FORMULA.rb" \
  "$KANDELO_HOMEBREW_SIDECAR_ROOT/Formula/"

(
  cd "$KANDELO_ROOT"
  sidecar_args=(
    homebrew-sidecars
    --tap-root "$KANDELO_HOMEBREW_SIDECAR_ROOT"
    --input "$INPUT_JSON"
  )
  if [ -f "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo/metadata.json" ]; then
    sidecar_args+=(--previous-metadata "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo/metadata.json")
  elif [ -f "$KANDELO_HOMEBREW_TAP_ROOT/Kandelo/metadata.json" ]; then
    sidecar_args+=(--previous-metadata "$KANDELO_HOMEBREW_TAP_ROOT/Kandelo/metadata.json")
  fi
  cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
    "${sidecar_args[@]}"
)
