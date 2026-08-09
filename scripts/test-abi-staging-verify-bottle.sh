#!/usr/bin/env bash
# Focused contract tests for exact-digest, uncredentialed candidate verification.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VERIFIER="$REPO_ROOT/scripts/abi-staging-verify-bottle.sh"
TMP_ROOT="$(mktemp -d)"
cleanup() {
  if [ "${KANDELO_KEEP_TEST_TMP:-0}" = 1 ]; then
    echo "test-abi-staging-verify-bottle.sh: retained $TMP_ROOT" >&2
  else
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

fail() {
  echo "test-abi-staging-verify-bottle.sh: $*" >&2
  exit 1
}

[ -x "$VERIFIER" ] || fail "verifier is absent"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?test must run through scripts/dev-shell.sh}"

FIXTURE="$TMP_ROOT/fixture"
TAP_ROOT="$TMP_ROOT/tap"
SYSROOT="$TMP_ROOT/sysroot"
MOCK_BIN="$TMP_ROOT/mock-bin"
mkdir -p "$FIXTURE" "$TAP_ROOT/Formula" "$SYSROOT" "$MOCK_BIN"
printf 'class MiniTool < Formula\nend\n' >"$TAP_ROOT/Formula/mini-tool.rb"
printf 'class MiniBase < Formula\nend\n' >"$TAP_ROOT/Formula/mini-base.rb"
git -C "$TAP_ROOT" init -q
git -C "$TAP_ROOT" add Formula/mini-base.rb Formula/mini-tool.rb
git -C "$TAP_ROOT" -c user.name=Fixture -c user.email=fixture.invalid \
  commit -qm 'fixture Formula'
TAP_COMMIT="$(git -C "$TAP_ROOT" rev-parse HEAD)"

printf 'miniature bottle layer\n' >"$FIXTURE/bottle.tar.gz"
jq -ncS '{
  job: "verify-candidate",
  repository: "kandelo-dev/homebrew-tap-core",
  run_attempt: 1,
  run_id: 808,
  workflow_ref: ".github/workflows/abi-staging-reconcile.yml@refs/heads/main"
}' >"$FIXTURE/run.json"
jq -ncS '{
  hosts: ["build"],
  id: "bottle-structure",
  kandelo_paths: [
    "scripts/homebrew-inspect-bottle.py",
    "scripts/test-homebrew-inspect-bottle.sh"
  ],
  policy: "kandelo-bottle-structure-v1"
}' >"$FIXTURE/test-definition.json"
TEST_DEFINITION_SHA256="$(sha256sum "$FIXTURE/test-definition.json" | awk '{print $1}')"

python3 - "$FIXTURE" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])

def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode()

def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()

def descriptor(role: str, title: str, media_type: str, body: bytes) -> dict[str, object]:
    return {
        "annotations": {
            "dev.kandelo.abi-staging.role": role,
            "org.opencontainers.image.title": title,
        },
        "digest": "sha256:" + digest(body),
        "mediaType": media_type,
        "size": len(body),
    }

bottle = (root / "bottle.tar.gz").read_bytes()
repository = "ghcr.io/kandelo-dev/homebrew-tap-core-abi-8-candidates/mini-tool"
bottle_identity = {
    "bytes": len(bottle),
    "immutable_reference": f"{repository}@sha256:{digest(bottle)}",
    "sha256": digest(bottle),
}
dependency_digest = "f" * 64
dependency_artifact = {
    "bytes": 128,
    "immutable_reference": (
        "ghcr.io/kandelo-dev/homebrew-tap-core-abi-8-candidates/"
        f"mini-base@sha256:{dependency_digest}"
    ),
    "sha256": dependency_digest,
}
(root / "dependencies.json").write_bytes(canonical({
    "architecture": "wasm32",
    "dependency_layers": [
        {"artifact": dependency_artifact, "formula": "mini-base"}
    ],
    "kind": "kandelo-abi-staging-dependency-layers",
    "schema": 1,
    "tap_repository": "kandelo-dev/homebrew-tap-core",
    "target_abi": 8,
}))
metadata = canonical({
    "mini-tool": {
        "bottle": {
            "rebuild": 0,
            "root_url": "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-8-candidates/mini-tool",
            "tags": {"wasm32_kandelo": {"sha256": digest(bottle)}},
        },
        "formula": {"name": "mini-tool", "pkg_version": "1.0"},
    }
})
(root / "bottle-metadata.json").write_bytes(metadata)
metadata_identity = {
    "bytes": len(metadata),
    "immutable_reference": f"{repository}@sha256:{digest(metadata)}",
    "sha256": digest(metadata),
}
record = {
    "candidate": {
        "bottle_layer": bottle_identity,
        "direct_dependency_layers": [
            {"artifact": dependency_artifact, "id": "mini-base-wasm32"}
        ],
        "formula": {
            "architecture": "wasm32",
            "bottle_contract_sha256": "d" * 64,
            "bottle_rebuild": 0,
            "formula": "mini-tool",
            "revision": 0,
            "tap": "kandelo-dev/homebrew-tap-core",
            "target_abi": 8,
            "version": "1.0",
        },
        "nonendorsed": True,
        "normalized_components": [
            {"artifact": metadata_identity, "id": "bottle-metadata"},
            {
                "artifact": {
                    "bytes": 1,
                    "immutable_reference": f"{repository}@sha256:{'d' * 64}",
                    "sha256": "d" * 64,
                },
                "id": "bottle-contract",
            },
            {
                "artifact": {
                    "bytes": 1,
                    "immutable_reference": f"{repository}@sha256:{'e' * 64}",
                    "sha256": "e" * 64,
                },
                "id": "source-custody",
            },
        ],
        "producer": {"head": "b" * 40, "request_sha256": "a" * 64, "run_id": 707},
        "source_custody_sha256": "e" * 64,
    },
    "common": {
        "artifact": bottle_identity,
        "artifact_class": "candidate",
        "blockers": [],
        "guard_codes": [],
        "outcome": "success",
        "promotion_state": "unknown",
        "request_sha256": "a" * 64,
        "retry_state": {"attempts": 1, "eligible": False, "exhausted": False, "next_action": "none"},
        "run": {
            "job": "publish-candidate",
            "repository": "kandelo-dev/homebrew-tap-core",
            "run_attempt": 1,
            "run_id": 707,
            "workflow_ref": ".github/workflows/abi-staging-reconcile.yml@refs/heads/main",
        },
        "source": {"commit": "b" * 40, "repository": "Automattic/kandelo", "tree": "c" * 40},
        "subject": {"identity": f"kandelo-dev/homebrew-tap-core/mini-tool@sha256:{digest(bottle)}", "kind": "candidate"},
        "work_state": "complete",
    },
    "kind": "kandelo-abi-staging-candidate",
    "schema": 1,
}
record_body = canonical(record)
(root / "candidate-record.json").write_bytes(record_body)
contract = b"contract\n"
attempt = b"attempt\n"
custody = b"custody\n"
manifest = {
    "annotations": {},
    "artifactType": "application/vnd.kandelo.abi-staging.candidate.record.v1+json",
    "config": descriptor(
        "candidate-record",
        "candidate-record.json",
        "application/vnd.kandelo.abi-staging.candidate.record.v1+json",
        record_body,
    ),
    "layers": [
        descriptor("bottle-layer", "mini-tool.tar.gz", "application/vnd.oci.image.layer.v1.tar+gzip", bottle),
        descriptor("bottle-metadata", "bottle-metadata.json", "application/json", metadata),
        descriptor("bottle-contract", "bottle-contract.json", "application/json", contract),
        descriptor("attempt-record", "attempt-record.json", "application/json", attempt),
        descriptor("source-custody-record", "source-custody-record.json", "application/json", custody),
    ],
    "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "schemaVersion": 2,
}
manifest_body = canonical(manifest)
(root / "candidate-manifest.json").write_bytes(manifest_body)
locator = {
    "digest": "sha256:" + digest(manifest_body),
    "immutable_reference": f"{repository}@sha256:{digest(manifest_body)}",
    "repository": repository,
}
(root / "candidate-locator.json").write_bytes(canonical(locator))
(root / "fixture.json").write_bytes(canonical({
    "bottle_bytes": len(bottle),
    "bottle_sha256": digest(bottle),
    "config_sha256": digest(record_body),
    "metadata_sha256": digest(metadata),
}))
PY

cat >"$MOCK_BIN/oras" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for secret in GITHUB_TOKEN GH_TOKEN GHCR_PAT HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN; do
  [ -z "${!secret:-}" ] || exit 90
done
printf '%q ' "$@" >>"${FAKE_ORAS_LOG:?}"
printf '\n' >>"$FAKE_ORAS_LOG"
kind="${1:-} ${2:-}"
shift 2
out=""
reference=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --registry-config) [ "$(cat "$2")" = '{"auths":{}}' ]; shift 2 ;;
    --output) out="$2"; shift 2 ;;
    *) reference="$1"; shift ;;
  esac
done
[ -n "$out" ] && [ -n "$reference" ]
case "$kind" in
  'manifest fetch') source="$FAKE_CANDIDATE_MANIFEST" ;;
  'blob fetch')
    case "$reference" in
      *@sha256:"$FAKE_CONFIG_SHA256") source="$FAKE_CANDIDATE_RECORD" ;;
      *@sha256:"$FAKE_METADATA_SHA256") source="$FAKE_BOTTLE_METADATA" ;;
      *) echo "unexpected blob $reference" >&2; exit 91 ;;
    esac
    ;;
  *) exit 92 ;;
esac
cp "$source" "$out"
EOF

cat >"$MOCK_BIN/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for secret in GITHUB_TOKEN GH_TOKEN GHCR_PAT HOMEBREW_GITHUB_API_TOKEN; do
  [ -z "${!secret:-}" ] || exit 90
done
printf '%q ' "$@" >"${FAKE_NODE_LOG:?}"
printf '\n' >>"$FAKE_NODE_LOG"
out=""; sha=""; bytes=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --sha256) sha="$2"; shift 2 ;;
    --bytes) bytes="$2"; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$sha" = "$FAKE_BOTTLE_SHA256" ]
[ "$bytes" = "$FAKE_BOTTLE_BYTES" ]
[ "$url" = "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-8-candidates/mini-tool/blobs/sha256:$FAKE_BOTTLE_SHA256" ]
mkdir -p "$(dirname "$out")"
if [ "${FAKE_CHANGED_BOTTLE:-0}" = 1 ]; then
  printf 'changed public bytes\n' >"$out"
else
  cp "$FAKE_BOTTLE" "$out"
fi
EOF

cat >"$MOCK_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = 21600s ]
printf '%s\n' "$1" >"${FAKE_TIMEOUT_LOG:?}"
shift
if [ "${FAKE_TIMEOUT_RESULT:-0}" = 1 ]; then
  exit 124
fi
exec "$@"
EOF

cat >"$MOCK_BIN/record-validator" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" = 1 ] && [ -f "$1" ]
cmp "$1" "$FAKE_CANDIDATE_RECORD"
printf '%s\n' "$1" >"${FAKE_RECORD_LOG:?}"
EOF

cat >"$MOCK_BIN/inspector" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >"${FAKE_INSPECTOR_LOG:?}"
printf '\n' >>"$FAKE_INSPECTOR_LOG"
out=""; abi=""; arch=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --expected-abi) abi="$2"; shift 2 ;;
    --expected-arch) arch="$2"; shift 2 ;;
    *) shift 2 ;;
  esac
done
[ "$abi" = 8 ] && [ "$arch" = wasm32 ] && [ -n "$out" ]
printf '{"inspection":"success"}\n' >"$out"
EOF

cat >"$MOCK_BIN/normal-verifier" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for secret in GITHUB_TOKEN GH_TOKEN GHCR_PAT HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN; do
  [ -z "${!secret:-}" ] || exit 90
done
printf '%q ' "$@" >"${FAKE_NORMAL_LOG:?}"
printf '\n' >>"$FAKE_NORMAL_LOG"
[ -d "$HOME" ] && [ -z "$(find "$HOME" -mindepth 1 -print -quit)" ]
[ -d "$HOMEBREW_CACHE" ] && [ -z "$(find "$HOMEBREW_CACHE" -mindepth 1 -print -quit)" ]
[ -d "$HOMEBREW_TEMP" ] && [ -z "$(find "$HOMEBREW_TEMP" -mindepth 1 -print -quit)" ]
out=""; abi=""; arch=""; root=""; staging_abi=""; staged_dependencies=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --abi) abi="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --bottle-root-url) root="$2"; shift 2 ;;
    --staging-candidate-abi) staging_abi="$2"; shift 2 ;;
    --staged-dependency-formula) staged_dependencies+=("$2"); shift 2 ;;
    *) shift 2 ;;
  esac
done
[ "$abi" = 8 ] && [ "$arch" = wasm32 ]
[ "$staging_abi" = 8 ]
[ "$root" = "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-8-candidates" ]
[ "${staged_dependencies[*]}" = "mini-base" ]
if [ "${FAKE_NORMAL_STATUS:-0}" != 0 ]; then
  echo 'deterministic verification failure'
  exit "$FAKE_NORMAL_STATUS"
fi
if [ "${FAKE_OVERSIZED_EVIDENCE:-0}" = 1 ]; then
  head -c 16777217 /dev/zero >"$out"
  exit 0
fi
printf '{"runtime":"verified"}\n' >"$out"
echo 'normal verifier succeeded'
EOF
chmod 0755 "$MOCK_BIN"/*

export KANDELO_ABI_STAGING_TESTING=1
export KANDELO_ABI_STAGING_ORAS="$MOCK_BIN/oras"
export KANDELO_ABI_STAGING_NODE="$MOCK_BIN/node"
export KANDELO_ABI_STAGING_TIMEOUT="$MOCK_BIN/timeout"
export KANDELO_ABI_STAGING_RECORD_VALIDATOR="$MOCK_BIN/record-validator"
export KANDELO_ABI_STAGING_BOTTLE_INSPECTOR="$MOCK_BIN/inspector"
export KANDELO_ABI_STAGING_NORMAL_VERIFIER="$MOCK_BIN/normal-verifier"
export FAKE_CANDIDATE_MANIFEST="$FIXTURE/candidate-manifest.json"
export FAKE_CANDIDATE_RECORD="$FIXTURE/candidate-record.json"
export FAKE_BOTTLE_METADATA="$FIXTURE/bottle-metadata.json"
export FAKE_BOTTLE="$FIXTURE/bottle.tar.gz"
export FAKE_CONFIG_SHA256="$(jq -r .config_sha256 "$FIXTURE/fixture.json")"
export FAKE_METADATA_SHA256="$(jq -r .metadata_sha256 "$FIXTURE/fixture.json")"
export FAKE_BOTTLE_SHA256="$(jq -r .bottle_sha256 "$FIXTURE/fixture.json")"
export FAKE_BOTTLE_BYTES="$(jq -r .bottle_bytes "$FIXTURE/fixture.json")"
export FAKE_ORAS_LOG="$TMP_ROOT/oras.log"
export FAKE_NODE_LOG="$TMP_ROOT/node.log"
export FAKE_TIMEOUT_LOG="$TMP_ROOT/timeout.log"
export FAKE_RECORD_LOG="$TMP_ROOT/record.log"
export FAKE_INSPECTOR_LOG="$TMP_ROOT/inspector.log"
export FAKE_NORMAL_LOG="$TMP_ROOT/normal.log"

run_verifier() {
  local out="$1"
  "$VERIFIER" \
    --candidate-locator "$FIXTURE/candidate-locator.json" \
    --test-definition "$FIXTURE/test-definition.json" \
    --test-definition-sha256 "$TEST_DEFINITION_SHA256" \
    --host build \
    --attempt-ordinal 0 \
    --run "$FIXTURE/run.json" \
    --tap-root "$TAP_ROOT" \
    --tap-commit "$TAP_COMMIT" \
    --dependency-provenance "$FIXTURE/dependencies.json" \
    --sysroot-build-root "$SYSROOT" \
    --forbidden-root /opt/homebrew \
    --out "$out"
}

SUCCESS="$TMP_ROOT/success"
run_verifier "$SUCCESS"
jq -e --arg digest "$FAKE_BOTTLE_SHA256" --arg test "$TEST_DEFINITION_SHA256" '
  .schema == 1 and .outcome == "success" and .exit_code == 0 and
  .attempt_ordinal == 0 and .candidate_layer.sha256 == $digest and
  .test_definition == {host: "build", id: "bottle-structure", sha256: $test}
' "$SUCCESS/result.json" >/dev/null || fail "success result differs"
jq -e '
  .schema == 1 and .kind == "kandelo-abi-staging-verification-inventory" and
  [.files[].path] == [
    "diagnostics/inspection.json",
    "diagnostics/runtime-evidence.json",
    "diagnostics/summary.txt",
    "result.json"
  ] and ([.files[].sha256] | all(test("^[0-9a-f]{64}$")))
' "$SUCCESS/inventory.json" >/dev/null || fail "success inventory differs"
grep -F '@sha256:' "$FAKE_ORAS_LOG" >/dev/null || fail "OCI fetch was mutable"
if grep -E ':[A-Za-z0-9._-]+([[:space:]]|$)' "$FAKE_ORAS_LOG" | grep -v '@sha256:'; then
  fail "OCI fetch used a mutable tag"
fi
grep -F -- '--expected-abi 8' "$FAKE_INSPECTOR_LOG" >/dev/null || \
  fail "inspector did not receive exact ABI"
grep -F -- '--abi 8' "$FAKE_NORMAL_LOG" >/dev/null || \
  fail "normal verifier did not receive exact ABI"
grep -F -- '--arch wasm32' "$FAKE_NORMAL_LOG" >/dev/null || \
  fail "normal verifier did not receive exact architecture"
grep -F -- '--staging-candidate-abi 8' "$FAKE_NORMAL_LOG" >/dev/null || \
  fail "normal verifier did not receive candidate namespace authority"
grep -F -- '--staged-dependency-formula mini-base' "$FAKE_NORMAL_LOG" >/dev/null || \
  fail "normal verifier did not receive the exact staged dependency Formula"
[ "$(cat "$FAKE_TIMEOUT_LOG")" = 21600s ] || fail "timeout changed"
if rg -n 'homebrew-bottle-build|source build|brew bottle' \
  "$FAKE_INSPECTOR_LOG" "$FAKE_NORMAL_LOG" "$VERIFIER"; then
  fail "verification exposed a fallback source-build path"
fi

if GITHUB_TOKEN=secret run_verifier "$TMP_ROOT/credential" \
  >"$TMP_ROOT/credential.stdout" 2>"$TMP_ROOT/credential.stderr"; then
  fail "credentialed verification succeeded"
fi
grep -F 'verifier received GITHUB_TOKEN' "$TMP_ROOT/credential.stderr" >/dev/null || \
  fail "credential rejection was not explicit"

jq -cS '.immutable_reference = (.repository + ":latest")' \
  "$FIXTURE/candidate-locator.json" >"$FIXTURE/mutable-locator.json"
mv "$FIXTURE/candidate-locator.json" "$FIXTURE/exact-locator.json"
mv "$FIXTURE/mutable-locator.json" "$FIXTURE/candidate-locator.json"
if run_verifier "$TMP_ROOT/mutable" >"$TMP_ROOT/mutable.stdout" \
  2>"$TMP_ROOT/mutable.stderr"; then
  fail "mutable candidate locator succeeded"
fi
grep -F 'not an immutable GHCR digest' "$TMP_ROOT/mutable.stderr" >/dev/null || \
  fail "mutable locator rejection was not explicit"
mv "$FIXTURE/exact-locator.json" "$FIXTURE/candidate-locator.json"

cp "$FIXTURE/dependencies.json" "$FIXTURE/exact-dependencies.json"
jq -cS '.dependency_layers = []' "$FIXTURE/exact-dependencies.json" \
  >"$FIXTURE/dependencies.json"
if run_verifier "$TMP_ROOT/missing-dependency" \
  >"$TMP_ROOT/missing-dependency.stdout" \
  2>"$TMP_ROOT/missing-dependency.stderr"; then
  fail "candidate verification accepted a missing staged dependency layer"
fi
grep -F 'dependency layer contract differs from candidate dependencies' \
  "$TMP_ROOT/missing-dependency.stderr" >/dev/null || \
  fail "missing staged dependency rejection was not explicit"
mv "$FIXTURE/exact-dependencies.json" "$FIXTURE/dependencies.json"

if FAKE_CHANGED_BOTTLE=1 run_verifier "$TMP_ROOT/changed" \
  >"$TMP_ROOT/changed.stdout" 2>"$TMP_ROOT/changed.stderr"; then
  fail "changed public bottle bytes succeeded"
fi
grep -F 'downloaded bottle differs from exact layer' "$TMP_ROOT/changed.stderr" >/dev/null || \
  fail "changed bottle rejection was not explicit"

cp "$FIXTURE/bottle-metadata.json" "$FIXTURE/exact-metadata.json"
jq -cS '.["mini-tool"].formula.pkg_version = "9.9"' \
  "$FIXTURE/exact-metadata.json" >"$FIXTURE/bottle-metadata.json"
if run_verifier "$TMP_ROOT/metadata" >"$TMP_ROOT/metadata.stdout" \
  2>"$TMP_ROOT/metadata.stderr"; then
  fail "changed metadata succeeded"
fi
grep -E 'candidate metadata blob differs|bottle metadata differs' \
  "$TMP_ROOT/metadata.stderr" >/dev/null || fail "metadata mismatch was not explicit"
mv "$FIXTURE/exact-metadata.json" "$FIXTURE/bottle-metadata.json"

set +e
FAKE_NORMAL_STATUS=7 run_verifier "$TMP_ROOT/failure" \
  >"$TMP_ROOT/failure.stdout" 2>"$TMP_ROOT/failure.stderr"
failure_status="$?"
set -e
[ "$failure_status" = 7 ] || fail "verification failure status changed"
jq -e '.outcome == "failure" and .exit_code == 7' \
  "$TMP_ROOT/failure/result.json" >/dev/null || fail "failure result was not retained"

set +e
FAKE_TIMEOUT_RESULT=1 run_verifier "$TMP_ROOT/timeout" \
  >"$TMP_ROOT/timeout.stdout" 2>"$TMP_ROOT/timeout.stderr"
timeout_status="$?"
set -e
[ "$timeout_status" = 124 ] || fail "verification timeout status changed"
jq -e '.outcome == "timeout" and .exit_code == 124' \
  "$TMP_ROOT/timeout/result.json" >/dev/null || fail "timeout result was not retained"

set +e
FAKE_OVERSIZED_EVIDENCE=1 run_verifier "$TMP_ROOT/oversized" \
  >"$TMP_ROOT/oversized.stdout" 2>"$TMP_ROOT/oversized.stderr"
oversized_status="$?"
set -e
[ "$oversized_status" = 1 ] || fail "oversized evidence status changed"
jq -e '.outcome == "failure" and .exit_code == 1' \
  "$TMP_ROOT/oversized/result.json" >/dev/null || \
  fail "oversized evidence did not produce a bounded failure"
[ ! -e "$TMP_ROOT/oversized/diagnostics/runtime-evidence.json" ] || \
  fail "oversized evidence escaped into the handoff"

echo "ABI staging candidate verifier: PASS"
