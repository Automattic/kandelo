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
PACKAGE_DIR="$KANDELO_ROOT/packages/registry/$KANDELO_HOMEBREW_FORMULA"
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
case "$KANDELO_HOMEBREW_ARCH" in
  wasm64) SYSROOT_LIBC="$KANDELO_ROOT/sysroot64/lib/libc.a" ;;
  *) SYSROOT_LIBC="$KANDELO_ROOT/sysroot/lib/libc.a" ;;
esac
if [ ! -f "$SYSROOT_LIBC" ]; then
  echo "homebrew-generate-sidecars-from-env.sh: sysroot libc not found: $SYSROOT_LIBC" >&2
  exit 2
fi
SYSROOT_FINGERPRINT="$(shasum -a 256 "$SYSROOT_LIBC" | awk '{print $1}')"
BREW_VERSION="$("${HOMEBREW_BREW_FILE:-brew}" --version | head -n 1)"
TAP_COMMIT="$(git -C "$KANDELO_HOMEBREW_TAP_ROOT" rev-parse HEAD)"
KANDELO_COMMIT="$(git -C "$KANDELO_ROOT" rev-parse HEAD)"
GENERATED_AT="$(date -u +%FT%TZ)"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-local/kandelo}/actions/runs/${GITHUB_RUN_ID:-local}"
TAP_NAME="$(printf '%s' "$KANDELO_HOMEBREW_TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')"
INPUT_JSON="$KANDELO_HOMEBREW_SIDECAR_ROOT/sidecars-input.json"

mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT"
if [ -d "$KANDELO_HOMEBREW_TAP_ROOT/Formula" ]; then
  mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT/Formula"
  rsync -a "$KANDELO_HOMEBREW_TAP_ROOT/Formula/" "$KANDELO_HOMEBREW_SIDECAR_ROOT/Formula/"
fi
if [ -d "$KANDELO_HOMEBREW_TAP_ROOT/Kandelo" ]; then
  mkdir -p "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo"
  rsync -a "$KANDELO_HOMEBREW_TAP_ROOT/Kandelo/" "$KANDELO_HOMEBREW_SIDECAR_ROOT/Kandelo/"
fi
export ABI_VERSION CACHE_KEY_SHA SDK_FINGERPRINT SYSROOT_FINGERPRINT BREW_VERSION
export TAP_COMMIT KANDELO_COMMIT GENERATED_AT RUN_URL TAP_NAME PACKAGE_DIR KANDELO_ROOT

python3 - "$INPUT_JSON" <<'PY'
import json
import os
import pathlib
import sys
import tomllib

out_path = pathlib.Path(sys.argv[1])
formula = os.environ["KANDELO_HOMEBREW_FORMULA"]
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
        entry = {"name": name, "version": version}
    else:
        name = dep
        entry = {"name": dep}
    dep_package_toml = pathlib.Path(os.environ["KANDELO_ROOT"]) / "packages" / "registry" / name / "package.toml"
    if dep_package_toml.exists():
        with dep_package_toml.open("rb") as f:
            dep_package = tomllib.load(f)
        if dep_package.get("kind") == "source":
            continue
    deps.append(entry)

version = str(bottle_formula["pkg_version"])
package_kind = package_toml.get("kind", "program")
if package_kind not in {"library", "program"}:
    raise SystemExit(f"unsupported Homebrew sidecar package kind for {formula}: {package_kind!r}")

def package_links_and_env():
    def output_link(kind, rel):
        if kind == "headers" and not rel.endswith((".h", ".hpp", ".hh", ".hxx")):
            return {
                "type": "symlink",
                "source": rel,
                "target": rel,
            }
        return {
            "type": "file",
            "source": rel,
            "target": rel,
            "mode": "0644",
        }

    if package_kind == "library":
        outputs = package_toml.get("outputs", {})
        links = []
        for key in ("headers", "libs", "pkgconfig"):
            for rel in sorted(outputs.get(key, [])):
                links.append(output_link(key, rel))
        if not links:
            raise SystemExit(f"library formula {formula} has no declared package outputs to link")
        return links, {}

    links = []
    outputs = package_toml.get("outputs", [])
    if isinstance(outputs, list):
        for output in outputs:
            name = output.get("name", formula)
            if "wasm" in output:
                links.append({"type": "symlink", "source": f"bin/{name}", "target": f"bin/{name}"})
    if not links:
        links.append({"type": "symlink", "source": f"bin/{formula}", "target": f"bin/{formula}"})

    if formula == "ncurses":
        links.extend([
            {"type": "file", "source": "lib/libncursesw.a", "target": "lib/libncursesw.a", "mode": "0644"},
            {"type": "file", "source": "lib/libtinfow.a", "target": "lib/libtinfow.a", "mode": "0644"},
            {"type": "symlink", "source": "lib/libncurses.a", "target": "lib/libncurses.a"},
            {"type": "symlink", "source": "lib/libtinfo.a", "target": "lib/libtinfo.a"},
            {"type": "symlink", "source": "include/ncursesw", "target": "include/ncursesw"},
            {"type": "symlink", "source": "include/ncurses", "target": "include/ncurses"},
        ])

    return links, {"PATH_prepend": ["bin"]}

def package_fork_instrumentation():
    outputs = package_toml.get("outputs", [])
    disabled_wasm_output = False
    if isinstance(outputs, list):
        for output in outputs:
            if "wasm" not in output:
                continue
            fork_instrumentation = output.get("fork_instrumentation", "not-required")
            if output.get("name", formula) == formula:
                return fork_instrumentation
            if fork_instrumentation == "disabled":
                disabled_wasm_output = True
    if disabled_wasm_output:
        return "disabled"
    return "not-required"

def default_node_smoke_text():
    if package_kind == "library":
        return (
            f"Formula test compiled a {formula} consumer against the installed keg "
            "and ran the resulting Wasm through "
            "node --import tsx/esm examples/run-example.ts"
        )
    if formula == "bzip2":
        return (
            "Formula test ran bzip2 --help through "
            "node --import tsx/esm examples/run-example.ts"
        )
    return (
        f"Formula test ran {formula} --version through "
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

links, link_env = package_links_and_env()
browser_smoke_status = os.environ.get("KANDELO_HOMEBREW_BROWSER_SMOKE_STATUS", "skipped")
if browser_smoke_status not in {"success", "skipped", "failed"}:
    raise SystemExit(f"invalid KANDELO_HOMEBREW_BROWSER_SMOKE_STATUS={browser_smoke_status!r}")
browser_compatible = browser_smoke_status == "success"
if browser_compatible and arch != "wasm32":
    raise SystemExit("browser smoke can only mark wasm32 bottles browser-compatible")

def parse_hosts_env(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return list(default)
    hosts = [part.strip() for part in raw.split(",") if part.strip()]
    invalid = [host for host in hosts if host not in {"node", "browser"}]
    if invalid:
        raise SystemExit(f"{name} contains unsupported hosts: {', '.join(invalid)}")
    return hosts

default_runtime_support = ["node", "browser"] if browser_compatible else ["node"]
runtime_support = parse_hosts_env("KANDELO_HOMEBREW_RUNTIME_SUPPORT", default_runtime_support)
unsupported_hosts = parse_hosts_env("KANDELO_HOMEBREW_RUNTIME_UNSUPPORTED_HOSTS", [])
if (
    not unsupported_hosts
    and formula in {"spidermonkey", "spidermonkey-node", "node"}
    and package_fork_instrumentation() == "disabled"
):
    unsupported_hosts = ["node", "browser"]
    runtime_support = []

unsupported_reason_code = os.environ.get(
    "KANDELO_HOMEBREW_RUNTIME_UNSUPPORTED_REASON_CODE",
    "fork-instrumentation-disabled-imports-kernel-fork",
)
unsupported_reason = os.environ.get(
    "KANDELO_HOMEBREW_RUNTIME_UNSUPPORTED_REASON",
    "The linked Wasm imports kernel.kernel_fork but intentionally disables wasm-fork-instrument; VFS images must reject it.",
)
for host in unsupported_hosts:
    if host in runtime_support:
        runtime_support.remove(host)
if "browser" in runtime_support and not browser_compatible:
    raise SystemExit("runtime_support may include browser only after successful browser smoke")

runtime_status = {}
for host in ("node", "browser"):
    if host in runtime_support:
        runtime_status[host] = {"status": "supported"}
    elif host in unsupported_hosts:
        runtime_status[host] = {
            "status": "unsupported",
            "reason_code": unsupported_reason_code,
            "reason": unsupported_reason,
        }
    else:
        runtime_status[host] = {
            "status": "not-validated",
            "reason_code": "smoke-not-recorded",
            "reason": f"No successful {host} VFS smoke was recorded for {formula} {arch}.",
        }

browser_reason = os.environ.get(
    "KANDELO_HOMEBREW_BROWSER_SMOKE_REASON",
    f"No successful browser VFS smoke was recorded for {formula} {arch}.",
)
browser_smoke_outcome = skipped_outcome("browser_smoke", browser_reason)
if browser_smoke_status == "failed":
    browser_smoke_outcome = failed_outcome("browser_smoke", browser_reason)
if browser_compatible:
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
if runtime_status["node"]["status"] == "supported":
    node_smoke_outcome = {
        "name": "node_smoke",
        "status": "success",
        "passed": [node_smoke_text],
        "failed": [],
        "skipped": [],
    }
else:
    node_smoke_outcome = skipped_outcome("node_smoke", runtime_status["node"]["reason"])

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
                    "runtime_status": runtime_status,
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
                            node_smoke_outcome,
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
cp "$KANDELO_HOMEBREW_TAP_ROOT/Formula/$KANDELO_HOMEBREW_FORMULA.rb" \
  "$KANDELO_HOMEBREW_SIDECAR_ROOT/Formula/"

(
  cd "$KANDELO_ROOT"
  sidecar_args=(
    homebrew-sidecars
    --tap-root "$KANDELO_HOMEBREW_SIDECAR_ROOT"
    --input "$INPUT_JSON"
  )
  if [ -f "$KANDELO_HOMEBREW_TAP_ROOT/Kandelo/metadata.json" ]; then
    sidecar_args+=(--previous-metadata "$KANDELO_HOMEBREW_TAP_ROOT/Kandelo/metadata.json")
  fi
  cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
    "${sidecar_args[@]}"
)
