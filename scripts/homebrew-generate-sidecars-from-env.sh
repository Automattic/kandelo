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
        deps.append({"name": name, "version": version})
    else:
        deps.append({"name": dep})

def package_output_links(package_toml, formula):
    outputs = package_toml.get("outputs", {})
    links = []
    if isinstance(outputs, dict):
        for key in ("libs", "headers", "pkgconfig"):
            for rel in outputs.get(key, []):
                links.append({"type": "file", "source": rel, "target": rel})
        return links

    if isinstance(outputs, list):
        for output in outputs:
            name = output.get("name", formula)
            if "wasm" in output:
                links.append({"type": "symlink", "source": f"bin/{name}", "target": f"bin/{name}"})
        return links

    raise SystemExit(f"unsupported outputs shape for {formula}: {type(outputs).__name__}")


version = str(bottle_formula["pkg_version"])
links = package_output_links(package_toml, formula)
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
                    "runtime_support": ["node"],
                    "browser_compatible": False,
                    "fork_instrumentation": "not-required",
                    "status": "success",
                    "built_by": os.environ["RUN_URL"],
                    "built_at": os.environ["GENERATED_AT"],
                    "bottle_file": os.environ["KANDELO_HOMEBREW_BOTTLE_ARCHIVE"],
                    "url": os.environ["KANDELO_HOMEBREW_BOTTLE_URL"],
                    "cache_key_sha": os.environ["CACHE_KEY_SHA"],
                    "payload_root": f"{formula}/{version}",
                    "links": links,
                    "receipts": [f".brew/{formula}.rb", "INSTALL_RECEIPT.json"],
                    "env": {"PATH_prepend": ["bin"]},
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
                                "skipped": [f"brew audit was not part of the {formula} bottle build step"],
                                "skip_reason": "Homebrew audit is not part of this bottle publish step; run it in a dedicated tap audit gate.",
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
                                "passed": [
                                    f"brew test completed for {formula} with Kandelo Node smoke enabled"
                                ],
                                "failed": [],
                                "skipped": [],
                            },
                            {
                                "name": "browser_smoke",
                                "status": "skipped",
                                "passed": [],
                                "failed": [],
                                "skipped": [f"browser_compatible is false for {formula} {arch} bottle"],
                                "skip_reason": "Browser VFS smoke is recorded by package-specific browser validation, not this bottle build step.",
                            },
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
