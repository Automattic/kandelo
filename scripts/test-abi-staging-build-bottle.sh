#!/usr/bin/env bash
# Focused contract tests for the uncredentialed ABI-staging build adapter.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TAP_ROOT="${KANDELO_TAP_ROOT:-}"
if [ -z "$TAP_ROOT" ] || [ ! -d "$TAP_ROOT/scripts/abi_staging" ]; then
  echo "test-abi-staging-build-bottle.sh: KANDELO_TAP_ROOT must name the tap checkout" >&2
  exit 2
fi
TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"
TMP_ROOT="$(mktemp -d)"
cleanup() {
  local status="$?"
  if [ "${KANDELO_KEEP_ABI_STAGING_TEST_TMP:-0}" = "1" ] && [ "$status" -ne 0 ]; then
    printf 'test-abi-staging-build-bottle.sh: preserved failure root: %s\n' "$TMP_ROOT" >&2
    return
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
INPUT_ROOT="$TMP_ROOT/inputs"
mkdir -p "$INPUT_ROOT"

fail() {
  echo "test-abi-staging-build-bottle.sh: $*" >&2
  exit 1
}

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" python3 - \
  "$REPO_ROOT" "$TAP_ROOT" "$INPUT_ROOT" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

from scripts.abi_staging.canonical import canonical_bytes
from scripts.abi_staging.contract import build_bottle_contract, build_miniature_bottle_contract_fixture
from scripts.abi_staging.plan import exact_formula_subject, validate_tap_plan

kandelo, tap, output = map(Path, sys.argv[1:])

def git(root: Path, value: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", value], text=True
    ).strip()

request = json.loads(
    (kandelo / "tools/xtask/tests/fixtures/abi-staging/request/current-request.json").read_bytes()
)
request["build_source"] = {
    "repository": "Automattic/kandelo",
    "commit": git(kandelo, "HEAD"),
    "tree": git(kandelo, "HEAD^{tree}"),
}
authorization = request["issuance"]["authorization"]
if "head" in authorization:
    authorization["head"] = request["build_source"]["commit"]
request_body = canonical_bytes(request)
(output / "request.json").write_bytes(request_body)
request_digest = hashlib.sha256(request_body).hexdigest()

plan = json.loads((tap / "Kandelo/staging/fixtures/tap-plan.json").read_bytes())
plan["request_digest"] = request_digest
plan["request_asset_url"] = (
    "https://github.com/Automattic/kandelo/releases/download/abi-staging-pr-19/"
    f"candidate-request-{request['build_source']['commit']}-sha256-{request_digest}.json"
)
plan["tap_source"] = {
    "repository": "kandelo-dev/homebrew-tap-core",
    "commit": git(tap, "HEAD"),
    "tree": git(tap, "HEAD^{tree}"),
}
formula = next(
    item
    for item in plan["formulae"]
    if item["identity"]["name"] == "libcurl"
    and item["identity"]["architecture"] == "wasm32"
)
contract = build_miniature_bottle_contract_fixture()
identity = formula["identity"]
contract["target"] = {
    "abi": plan["target_abi"]["version"],
    "snapshot_sha256": plan["target_abi"]["snapshot_sha256"],
    "architecture": identity["architecture"],
}
contract["formula"] = {
    "name": identity["name"],
    "version": identity["version"],
    "revision": identity["revision"],
    "rebuild": identity["rebuild"],
    "normalized_source_sha256": identity["normalized_formula_sha256"],
    "source_components": [
        {"id": "formula", "sha256": identity["normalized_formula_sha256"]}
    ],
}
layers = output / "dependency-inputs/layers"
layers.mkdir(parents=True)
contract_dependencies = []
for index, dependency in enumerate(formula["direct_dependencies"]):
    body = f"exact layer {dependency['formula']}\n".encode()
    digest = hashlib.sha256(body).hexdigest()
    (layers / f"sha256-{digest}.tar.gz").write_bytes(body)
    contract_dependencies.append(
        {
            "formula": dependency["formula"],
            "architecture": dependency["architecture"],
            "bottle_layer_sha256": digest,
            "bottle_layer_bytes": len(body),
            "materialization_policy_sha256": dependency["materialization_policy_sha256"],
        }
    )
contract["direct_dependencies"] = contract_dependencies
contract = build_bottle_contract(contract)
contract_body = canonical_bytes(contract)
contract_digest = hashlib.sha256(contract_body).hexdigest()
contracts = output / "dependency-inputs/contracts"
contracts.mkdir(parents=True)
(contracts / f"sha256-{contract_digest}.json").write_bytes(contract_body)
subject = exact_formula_subject(identity["name"], identity["architecture"])
assessment = {
    "schema": 1,
    "kind": "kandelo-build-input-capture-assessment",
    "subject": subject,
    "complete": True,
    "captured": [],
    "missing": [],
    "ambiguous": [],
    "affected_products": formula["required_by_products"],
    "override_subject": subject,
    "guard_code": "build_input_capture_incomplete",
}
(contracts / f"sha256-{contract_digest}.capture.json").write_bytes(canonical_bytes(assessment))
formula["contract_sha256"] = contract_digest
(output / "formula-plan.json").write_bytes(canonical_bytes(formula))
validate_tap_plan(plan)
(output / "tap-plan.json").write_bytes(canonical_bytes(plan))
(output / "fixture.json").write_bytes(
    canonical_bytes(
        {
            "contract_sha256": contract_digest,
            "dependency_sha256s": [item["bottle_layer_sha256"] for item in contract_dependencies],
            "subject": subject,
        }
    )
)
PY

jq -ncS '{
  job: "build-candidate",
  repository: "kandelo-dev/homebrew-tap-core",
  run_attempt: 2,
  run_id: 808,
  workflow_ref: ".github/workflows/abi-staging-reconcile.yml@refs/heads/main"
}' >"$INPUT_ROOT/run.json"

MOCK_BIN="$TMP_ROOT/mock-bin"
mkdir -p "$MOCK_BIN"
cat >"$MOCK_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >"${FAKE_TIMEOUT_LOG:?}"
shift
exec "$@"
EOF
cat >"$TMP_ROOT/fake-builder" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_BUILDER_LOG:?}"
: "${WASM_POSIX_SDK_ROOT:?}"
: "${KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE:?}"
: "${KANDELO_HOMEBREW_TAP_SOURCE_COMMIT:?}"
: "${KANDELO_HOMEBREW_PREPARED_TAP_COMMIT:?}"
: "${FAKE_ORIGINAL_TAP_ROOT:?}"
for secret in GITHUB_TOKEN GH_TOKEN GHCR_PAT HOMEBREW_GITHUB_API_TOKEN NPM_TOKEN \
  NODE_AUTH_TOKEN SSH_AUTH_SOCK AWS_SECRET_ACCESS_KEY \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
  [ -z "${!secret:-}" ] || {
    echo "credential survived: $secret" >&2
    exit 90
  }
done
[ "$GIT_CONFIG_NOSYSTEM" = "1" ]
[ "$GIT_CONFIG_GLOBAL" = "/dev/null" ]
[ "$GIT_TERMINAL_PROMPT" = "0" ]
[ -d "$WASM_POSIX_SDK_ROOT" ] && [ ! -L "$WASM_POSIX_SDK_ROOT" ]
find "$KANDELO_HOMEBREW_LOCAL_DEPENDENCY_CACHE" -type f -name 'sha256-*.tar.gz' -print \
  | sort >"$FAKE_BUILDER_LOG.dependencies"

OUT=""
ROOT=""
STAGING_ABI=""
FORMULA=""
TAP_REPOSITORY=""
BUILD_TAP_ROOT=""
printf '%q ' "$@" >"$FAKE_BUILDER_LOG"
printf '\n' >>"$FAKE_BUILDER_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --bottle-root-url) ROOT="$2"; shift 2 ;;
    --staging-candidate-abi) STAGING_ABI="$2"; shift 2 ;;
    --formula) FORMULA="$2"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="$2"; shift 2 ;;
    --tap-root) BUILD_TAP_ROOT="$2"; shift 2 ;;
    --arch) shift 2 ;;
    *) echo "unexpected builder flag: $1" >&2; exit 91 ;;
  esac
done
[ -n "$OUT" ]
[ -n "$BUILD_TAP_ROOT" ]
[ "$BUILD_TAP_ROOT" != "$FAKE_ORIGINAL_TAP_ROOT" ]
[ "$(git -C "$FAKE_ORIGINAL_TAP_ROOT" rev-parse HEAD)" = "$KANDELO_HOMEBREW_TAP_SOURCE_COMMIT" ]
[ "$(git -C "$BUILD_TAP_ROOT" rev-parse HEAD)" = "$KANDELO_HOMEBREW_PREPARED_TAP_COMMIT" ]
[ "$(git -C "$BUILD_TAP_ROOT" rev-parse HEAD^)" = "$KANDELO_HOMEBREW_TAP_SOURCE_COMMIT" ]
[ -z "$(git -C "$BUILD_TAP_ROOT" status --short --untracked-files=all)" ]
[ "$TAP_REPOSITORY" = "kandelo-dev/homebrew-tap-core" ]
[[ "$STAGING_ABI" =~ ^[1-9][0-9]*$ ]]
[[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]
[ "$ROOT" = "https://ghcr.io/v2/${TAP_REPOSITORY}-abi-${STAGING_ABI}-candidates/${FORMULA}" ]
PAYLOAD_ROOT="$OUT/tar-root/libcurl/8.11.1_1"
mkdir -p "$OUT/bottles" "$PAYLOAD_ROOT/.brew" "$PAYLOAD_ROOT/bin"
printf 'class Libcurl < Formula\nend\n' >"$PAYLOAD_ROOT/.brew/libcurl.rb"
printf '{}\n' >"$PAYLOAD_ROOT/INSTALL_RECEIPT.json"
printf 'tool\n' >"$PAYLOAD_ROOT/bin/tool"
chmod 0755 "$PAYLOAD_ROOT/bin/tool"
if [ "${FAKE_BUILDER_MUTATE_CUSTODY:-0}" = "1" ]; then
  printf 'candidate mutation\n' >>"$(dirname "$OUT")/source-custody/kandelo.bundle"
fi
if [ "${FAKE_BUILDER_FAIL:-0}" = "1" ]; then
  echo "fixture deterministic failure"
  exit 7
fi
BOTTLE_NAME="libcurl--8.11.1_1.wasm32_kandelo.bottle.4.tar.gz"
tar -czf "$OUT/bottles/$BOTTLE_NAME" \
  -C "$OUT/tar-root" libcurl/8.11.1_1
BOTTLE_SHA256="$(sha256sum "$OUT/bottles/$BOTTLE_NAME" | awk '{print $1}')"
jq -n \
  --arg name "$BOTTLE_NAME" \
  --arg root "${ROOT%/$FORMULA}" \
  --arg sha256 "$BOTTLE_SHA256" \
  '{
    "kandelo-dev/tap-core/libcurl": {
      formula: {
        name: "libcurl",
        path: "Library/Taps/kandelo-dev/homebrew-tap-core/Formula/libcurl.rb",
        pkg_version: "8.11.1_1"
      },
      bottle: {
        root_url: $root,
        cellar: ":any_skip_relocation",
        rebuild: 4,
        tags: {
          wasm32_kandelo: {
            local_filename: $name,
            sha256: $sha256
          }
        }
      }
    }
  }' >"$OUT/bottles/libcurl.bottle.json"
echo "fixture build succeeded"
EOF
chmod 0755 "$MOCK_BIN/timeout" "$TMP_ROOT/fake-builder"

export PATH="$MOCK_BIN:$PATH"
export FAKE_TIMEOUT_LOG="$TMP_ROOT/timeout.log"
export FAKE_BUILDER_LOG="$TMP_ROOT/builder.log"
export FAKE_ORIGINAL_TAP_ROOT="$TAP_ROOT"
export KANDELO_ABI_STAGING_TESTING=1
export KANDELO_ABI_STAGING_NORMAL_BUILDER="$TMP_ROOT/fake-builder"
export GITHUB_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789"
export GH_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789"
export GHCR_PAT="github_pat_abcdefghijklmnopqrstuvwxyz0123456789"
export HOMEBREW_GITHUB_API_TOKEN="secret"
export NPM_TOKEN="secret"
export NODE_AUTH_TOKEN="secret"
export SSH_AUTH_SOCK="/tmp/not-an-agent"
export AWS_SECRET_ACCESS_KEY="secret"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="secret"

run_adapter() {
  local handoff="$1" run="${2:-$INPUT_ROOT/run.json}"
  local retry_ordinal="${3:-2}"
  (
    cd "$TAP_ROOT"
    bash "$REPO_ROOT/scripts/abi-staging-build-bottle.sh" \
      --request "$INPUT_ROOT/request.json" \
      --tap-plan "$INPUT_ROOT/tap-plan.json" \
      --formula-plan "$INPUT_ROOT/formula-plan.json" \
      --dependency-root "$INPUT_ROOT/dependency-inputs" \
      --run "$run" \
      --retry-ordinal "$retry_ordinal" \
      --handoff "$handoff"
  )
}

SUCCESS_HANDOFF="$TMP_ROOT/success-handoff"
run_adapter "$SUCCESS_HANDOFF"
[ "$(cat "$FAKE_TIMEOUT_LOG")" = "21600s" ] || fail "external timeout is not six hours"
[ -s "$FAKE_BUILDER_LOG" ] || fail "normal builder was not invoked"
TARGET_ABI="$(jq -r '.target_abi.version' "$INPUT_ROOT/tap-plan.json")"
FORMULA="$(jq -r '.identity.name' "$INPUT_ROOT/formula-plan.json")"
EXPECTED_CANDIDATE_ROOT="https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-${TARGET_ABI}-candidates/${FORMULA}"
grep -Fq -- "--bottle-root-url $EXPECTED_CANDIDATE_ROOT" "$FAKE_BUILDER_LOG" ||
  fail "normal builder did not receive the visibly nonendorsed ABI-qualified candidate root"
grep -Fq -- "--staging-candidate-abi $TARGET_ABI" "$FAKE_BUILDER_LOG" ||
  fail "normal builder did not receive the exact target ABI candidate authority"
EXPECTED_DEPENDENCIES="$(jq '.dependency_sha256s | length' "$INPUT_ROOT/fixture.json")"
ACTUAL_DEPENDENCIES="$(wc -l <"$FAKE_BUILDER_LOG.dependencies" | tr -d '[:space:]')"
[ "$ACTUAL_DEPENDENCIES" = "$EXPECTED_DEPENDENCIES" ] ||
  fail "normal builder did not receive exactly the declared dependency layers"
[ -f "$SUCCESS_HANDOFF/bottle.tar.gz" ] || fail "successful handoff omitted bottle"
[ -f "$SUCCESS_HANDOFF/attempt-record.json" ] || fail "successful handoff omitted attempt"
[ -f "$SUCCESS_HANDOFF/build-result.json" ] || fail "successful handoff omitted result"
jq -e --slurpfile run "$INPUT_ROOT/run.json" '
  .common.run == $run[0] and
  .common.retry_state.attempts == 3 and
  .attempt.retry_ordinal == 2
' "$SUCCESS_HANDOFF/attempt-record.json" >/dev/null ||
  fail "attempt record did not bind the exact run and retry ordinal"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
cargo run --quiet -p xtask --target "$HOST_TARGET" -- \
  abi-staging records validate \
  --record "$SUCCESS_HANDOFF/attempt-record.json"

PREPOPULATED="$TMP_ROOT/prepopulated"
mkdir -p "$PREPOPULATED"
printf 'keep\n' >"$PREPOPULATED/user-file"
rm -f "$FAKE_BUILDER_LOG"
if run_adapter "$PREPOPULATED" >/dev/null 2>&1; then
  fail "adapter accepted a nonempty handoff output"
fi
[ ! -e "$FAKE_BUILDER_LOG" ] || fail "invalid output reached the normal builder"
[ "$(cat "$PREPOPULATED/user-file")" = "keep" ] || fail "adapter changed existing output"

BAD_RUN="$TMP_ROOT/bad-run.json"
jq -cS '.run_id = 0' "$INPUT_ROOT/run.json" >"$BAD_RUN"
rm -f "$FAKE_BUILDER_LOG"
if run_adapter "$TMP_ROOT/bad-run-handoff" "$BAD_RUN" >/dev/null 2>&1; then
  fail "adapter accepted a malformed protected run identity"
fi
[ ! -e "$FAKE_BUILDER_LOG" ] || fail "malformed run identity reached the normal builder"
if run_adapter "$TMP_ROOT/bad-ordinal-handoff" "$INPUT_ROOT/run.json" -1 \
    >/dev/null 2>&1; then
  fail "adapter accepted a negative retry ordinal"
fi
[ ! -e "$FAKE_BUILDER_LOG" ] || fail "invalid retry ordinal reached the normal builder"

export FAKE_BUILDER_MUTATE_CUSTODY=1
if run_adapter "$TMP_ROOT/mutated-custody-handoff" >/dev/null 2>&1; then
  fail "adapter accepted source custody changed by candidate execution"
fi
unset FAKE_BUILDER_MUTATE_CUSTODY

BAD_REQUEST="$TMP_ROOT/bad-request.json"
BAD_PLAN="$TMP_ROOT/bad-plan.json"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" python3 - \
  "$INPUT_ROOT/request.json" "$INPUT_ROOT/tap-plan.json" "$BAD_REQUEST" "$BAD_PLAN" <<'PY'
import hashlib, json, sys
from pathlib import Path
from scripts.abi_staging.canonical import canonical_bytes
request = json.loads(Path(sys.argv[1]).read_bytes())
request["build_source"]["commit"] = "f" * 40
body = canonical_bytes(request)
Path(sys.argv[3]).write_bytes(body)
plan = json.loads(Path(sys.argv[2]).read_bytes())
plan["request_digest"] = hashlib.sha256(body).hexdigest()
Path(sys.argv[4]).write_bytes(canonical_bytes(plan))
PY
rm -f "$FAKE_BUILDER_LOG"
if (
  cd "$TAP_ROOT"
  bash "$REPO_ROOT/scripts/abi-staging-build-bottle.sh" \
    --request "$BAD_REQUEST" --tap-plan "$BAD_PLAN" \
    --formula-plan "$INPUT_ROOT/formula-plan.json" \
    --dependency-root "$INPUT_ROOT/dependency-inputs" \
    --handoff "$TMP_ROOT/bad-source-handoff"
) >/dev/null 2>&1; then
  fail "adapter accepted a checkout different from the exact PR head"
fi
[ ! -e "$FAKE_BUILDER_LOG" ] || fail "wrong exact source reached the normal builder"

CONTRACT_DIGEST="$(jq -r '.contract_sha256' "$INPUT_ROOT/fixture.json")"
CAPTURE="$INPUT_ROOT/dependency-inputs/contracts/sha256-$CONTRACT_DIGEST.capture.json"
AUTHORIZATION="$INPUT_ROOT/dependency-inputs/contracts/sha256-$CONTRACT_DIGEST.authorization.json"
cp "$CAPTURE" "$TMP_ROOT/capture.backup"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" python3 - "$CAPTURE" <<'PY'
import json, sys
from pathlib import Path
from scripts.abi_staging.canonical import canonical_bytes
path = Path(sys.argv[1])
value = json.loads(path.read_bytes())
value["complete"] = False
value["missing"] = [{"path": "sdk", "reason": "missing", "repository": "kandelo"}]
path.write_bytes(canonical_bytes(value))
PY
rm -f "$FAKE_BUILDER_LOG"
if run_adapter "$TMP_ROOT/incomplete-capture-handoff" >/dev/null 2>&1; then
  fail "adapter accepted incomplete capture without authorization"
fi
[ ! -e "$FAKE_BUILDER_LOG" ] || fail "incomplete capture reached the normal builder"

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" python3 - \
  "$INPUT_ROOT" "$CONTRACT_DIGEST" "$AUTHORIZATION" wrong <<'PY'
import hashlib, json, sys
from pathlib import Path
from scripts.abi_staging.canonical import canonical_bytes
root = Path(sys.argv[1])
digest = sys.argv[2]
destination = Path(sys.argv[3])
wrong = sys.argv[4] == "wrong"
request_body = (root / "request.json").read_bytes()
request = json.loads(request_body)
plan = json.loads((root / "tap-plan.json").read_bytes())
formula = json.loads((root / "formula-plan.json").read_bytes())
subject = json.loads((root / "fixture.json").read_bytes())["subject"]
parsed = json.loads(subject)
contract = json.loads(
    (root / "dependency-inputs/contracts" / f"sha256-{digest}.json").read_bytes()
)
common_identity = "kandelo-dev/homebrew-tap-core/other" if wrong else (
    f"kandelo-dev/homebrew-tap-core/{parsed['identity']}"
)
authorization = {
    "schema": 1,
    "kind": "kandelo-abi-staging-capture-override-authorization",
    "common": {
        "request_sha256": hashlib.sha256(request_body).hexdigest(),
        "subject": {
            "kind": "formula",
            "identity": common_identity,
            "architecture": parsed["architecture"],
        },
        "source": request["build_source"],
        "run": {
            "repository": "kandelo-dev/homebrew-tap-core",
            "workflow_ref": ".github/workflows/abi-staging-maintenance.yml@refs/heads/main",
            "run_id": 1,
            "run_attempt": 1,
            "job": "authorize-capture",
        },
        "guard_codes": ["build_input_capture_incomplete"],
        "work_state": "complete",
        "outcome": "success",
        "artifact_class": "none",
        "promotion_state": "eligible",
        "retry_state": {
            "attempts": 1,
            "eligible": False,
            "exhausted": False,
            "next_action": "none",
        },
        "blockers": [],
    },
    "capture_authorization": {
        "formula": {
            "tap": "kandelo-dev/homebrew-tap-core",
            "formula": parsed["identity"],
            "architecture": parsed["architecture"],
            "target_abi": contract["target"]["abi"],
            "bottle_contract_sha256": digest,
        },
        "guard_code": "build_input_capture_incomplete",
        "maintainer": {
            "login": "maintainer",
            "permission": "maintain",
            "authorization_reference": "https://github.com/kandelo-dev/homebrew-tap-core/issues/1#issuecomment-1",
        },
        "justification": "Authorize this exact incompletely captured Formula subject.",
        "policy": {
            "policy_version": 1,
            "policy_sha256": "a" * 64,
            "guard_registry_version": 1,
            "guard_registry_sha256": "b" * 64,
        },
    },
}
destination.write_bytes(canonical_bytes(authorization))
PY
if run_adapter "$TMP_ROOT/wrong-authorization-handoff" >/dev/null 2>&1; then
  fail "adapter accepted capture authorization for another exact subject"
fi
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$TAP_ROOT" python3 - \
  "$INPUT_ROOT" "$CONTRACT_DIGEST" "$AUTHORIZATION" exact <<'PY'
import json, sys
from pathlib import Path
from scripts.abi_staging.canonical import canonical_bytes
path = Path(sys.argv[3])
value = json.loads(path.read_bytes())
subject = json.loads((Path(sys.argv[1]) / "fixture.json").read_bytes())["subject"]
parsed = json.loads(subject)
value["common"]["subject"]["identity"] = (
    f"kandelo-dev/homebrew-tap-core/{parsed['identity']}"
)
path.write_bytes(canonical_bytes(value))
PY
run_adapter "$TMP_ROOT/authorized-capture-handoff"
cp "$TMP_ROOT/capture.backup" "$CAPTURE"
rm -f "$AUTHORIZATION"

FIRST_LAYER="$(find "$INPUT_ROOT/dependency-inputs/layers" -type f | sort | head -1)"
cp "$FIRST_LAYER" "$TMP_ROOT/layer.backup"
printf 'changed\n' >"$FIRST_LAYER"
if run_adapter "$TMP_ROOT/bad-layer-handoff" >/dev/null 2>&1; then
  fail "adapter accepted a changed dependency layer"
fi
cp "$TMP_ROOT/layer.backup" "$FIRST_LAYER"

FAILURE_HANDOFF="$TMP_ROOT/failure-handoff"
export FAKE_BUILDER_FAIL=1
set +e
run_adapter "$FAILURE_HANDOFF"
status="$?"
set -e
unset FAKE_BUILDER_FAIL
[ "$status" -eq 7 ] || fail "adapter did not preserve normal builder failure status"
[ ! -e "$FAILURE_HANDOFF/bottle.tar.gz" ] || fail "failed handoff claimed bottle bytes"
jq -e '.outcome == "failure" and .candidate == null and .exit_code == 7' \
  "$FAILURE_HANDOFF/build-result.json" >/dev/null ||
  fail "failed handoff result is contradictory"
cargo run --quiet -p xtask --target "$HOST_TARGET" -- \
  abi-staging records validate \
  --record "$FAILURE_HANDOFF/attempt-record.json"

echo "test-abi-staging-build-bottle.sh: PASS"
