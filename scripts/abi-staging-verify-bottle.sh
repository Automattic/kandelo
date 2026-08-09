#!/usr/bin/env bash
# Verify one immutable public ABI-staging candidate without credentials or rebuilds.
set -euo pipefail

CANDIDATE_LOCATOR=""
TEST_DEFINITION=""
TEST_DEFINITION_SHA256=""
HOST=""
ATTEMPT_ORDINAL=""
RUN=""
TAP_ROOT=""
TAP_COMMIT=""
TAP_CHECKOUT_COMMIT=""
DEPENDENCY_PROVENANCE=""
SYSROOT_BUILD_ROOT=""
OUT=""
FORBIDDEN_ROOTS=()

usage() {
  cat >&2 <<'EOF'
usage: scripts/abi-staging-verify-bottle.sh --candidate-locator <json> --test-definition <json> --test-definition-sha256 <sha256> --host <build|node|browser> --attempt-ordinal <number> --run <json> --tap-root <dir> --tap-commit <sha> [--tap-checkout-commit <sha>] --dependency-provenance <json> --sysroot-build-root <dir> --forbidden-root <absolute-path> [--forbidden-root ...] --out <dir>

The locator must be an immutable public GHCR @sha256 reference. The verifier
downloads the exact candidate manifest, record, metadata, and bottle layer,
checks every descriptor, uses a fresh cache/home, and invokes Kandelo's normal
structural and force-pour verification paths. It never rebuilds or publishes.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate-locator) CANDIDATE_LOCATOR="${2:-}"; shift 2 ;;
    --test-definition) TEST_DEFINITION="${2:-}"; shift 2 ;;
    --test-definition-sha256) TEST_DEFINITION_SHA256="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --attempt-ordinal) ATTEMPT_ORDINAL="${2:-}"; shift 2 ;;
    --run) RUN="${2:-}"; shift 2 ;;
    --tap-root) TAP_ROOT="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --tap-checkout-commit) TAP_CHECKOUT_COMMIT="${2:-}"; shift 2 ;;
    --dependency-provenance) DEPENDENCY_PROVENANCE="${2:-}"; shift 2 ;;
    --sysroot-build-root) SYSROOT_BUILD_ROOT="${2:-}"; shift 2 ;;
    --forbidden-root) FORBIDDEN_ROOTS+=("${2:-}"); shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "abi-staging-verify-bottle.sh: unknown flag: $1" >&2
      usage
      exit 2
      ;;
  esac
done

for requirement in \
  "candidate-locator:$CANDIDATE_LOCATOR" \
  "test-definition:$TEST_DEFINITION" \
  "test-definition-sha256:$TEST_DEFINITION_SHA256" \
  "host:$HOST" \
  "attempt-ordinal:$ATTEMPT_ORDINAL" \
  "run:$RUN" \
  "tap-root:$TAP_ROOT" \
  "tap-commit:$TAP_COMMIT" \
  "dependency-provenance:$DEPENDENCY_PROVENANCE" \
  "sysroot-build-root:$SYSROOT_BUILD_ROOT" \
  "out:$OUT"; do
  [ -n "${requirement#*:}" ] || {
    echo "abi-staging-verify-bottle.sh: --${requirement%%:*} is required" >&2
    exit 2
  }
done
[ "${#FORBIDDEN_ROOTS[@]}" -gt 0 ] || {
  echo "abi-staging-verify-bottle.sh: at least one --forbidden-root is required" >&2
  exit 2
}

for secret_name in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN GHCR_PAT \
  NPM_TOKEN NODE_AUTH_TOKEN SSH_AUTH_SOCK SSH_AGENT_PID \
  AWS_SECRET_ACCESS_KEY ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
  [ -z "${!secret_name:-}" ] || {
    echo "abi-staging-verify-bottle.sh: verifier received $secret_name" >&2
    exit 2
  }
done

[[ "$TEST_DEFINITION_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "abi-staging-verify-bottle.sh: invalid test-definition digest" >&2
  exit 2
}
case "$HOST" in build|node|browser) ;; *)
  echo "abi-staging-verify-bottle.sh: invalid verification host" >&2
  exit 2
esac
[[ "$ATTEMPT_ORDINAL" =~ ^(0|[1-9][0-9]*)$ ]] || {
  echo "abi-staging-verify-bottle.sh: invalid attempt ordinal" >&2
  exit 2
}
[[ "$TAP_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "abi-staging-verify-bottle.sh: invalid tap commit" >&2
  exit 2
}
TAP_CHECKOUT_COMMIT="${TAP_CHECKOUT_COMMIT:-$TAP_COMMIT}"
[[ "$TAP_CHECKOUT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "abi-staging-verify-bottle.sh: invalid tap checkout commit" >&2
  exit 2
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"
for file in "$CANDIDATE_LOCATOR" "$TEST_DEFINITION" "$RUN" \
  "$DEPENDENCY_PROVENANCE"; do
  [ -f "$file" ] && [ ! -L "$file" ] || {
    echo "abi-staging-verify-bottle.sh: required input is not a regular file: $file" >&2
    exit 2
  }
done
for directory in "$TAP_ROOT" "$SYSROOT_BUILD_ROOT"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || {
    echo "abi-staging-verify-bottle.sh: required input is not a real directory: $directory" >&2
    exit 2
  }
done
TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"
SYSROOT_BUILD_ROOT="$(cd "$SYSROOT_BUILD_ROOT" && pwd -P)"
[ "$(git -C "$TAP_ROOT" rev-parse HEAD)" = "$TAP_CHECKOUT_COMMIT" ] || {
  echo "abi-staging-verify-bottle.sh: tap checkout differs from its exact commit" >&2
  exit 2
}
for root in "${FORBIDDEN_ROOTS[@]}"; do
  case "$root" in
    /*) ;;
    *) echo "abi-staging-verify-bottle.sh: forbidden roots must be absolute" >&2; exit 2 ;;
  esac
done

if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  if [ -L "$OUT" ] || [ ! -d "$OUT" ] || find "$OUT" -mindepth 1 -print -quit | grep -q .; then
    echo "abi-staging-verify-bottle.sh: output must be a new or empty real directory" >&2
    exit 2
  fi
fi

TESTING="${KANDELO_ABI_STAGING_TESTING:-0}"
if [ "$TESTING" = "1" ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "abi-staging-verify-bottle.sh: test replacement mode is forbidden in Actions" >&2
  exit 2
fi
ORAS_BIN="$(command -v oras || true)"
NODE_BIN="$(command -v node || true)"
TIMEOUT_BIN="$(command -v timeout || true)"
INSPECTOR="$REPO_ROOT/scripts/homebrew-inspect-bottle.py"
NORMAL_VERIFIER="$REPO_ROOT/scripts/homebrew-verify-poured-bottle.sh"
RECORD_VALIDATOR=""
if [ "$TESTING" = "1" ]; then
  ORAS_BIN="${KANDELO_ABI_STAGING_ORAS:-$ORAS_BIN}"
  NODE_BIN="${KANDELO_ABI_STAGING_NODE:-$NODE_BIN}"
  TIMEOUT_BIN="${KANDELO_ABI_STAGING_TIMEOUT:-$TIMEOUT_BIN}"
  INSPECTOR="${KANDELO_ABI_STAGING_BOTTLE_INSPECTOR:-$INSPECTOR}"
  NORMAL_VERIFIER="${KANDELO_ABI_STAGING_NORMAL_VERIFIER:-$NORMAL_VERIFIER}"
  RECORD_VALIDATOR="${KANDELO_ABI_STAGING_RECORD_VALIDATOR:-}"
elif [ -n "${KANDELO_ABI_STAGING_ORAS:-}${KANDELO_ABI_STAGING_NODE:-}${KANDELO_ABI_STAGING_TIMEOUT:-}${KANDELO_ABI_STAGING_BOTTLE_INSPECTOR:-}${KANDELO_ABI_STAGING_NORMAL_VERIFIER:-}${KANDELO_ABI_STAGING_RECORD_VALIDATOR:-}" ]; then
  echo "abi-staging-verify-bottle.sh: verifier replacements are local-test-only" >&2
  exit 2
fi
for executable in "$ORAS_BIN" "$NODE_BIN" "$TIMEOUT_BIN" "$INSPECTOR" \
  "$NORMAL_VERIFIER"; do
  [ -n "$executable" ] && [ -f "$executable" ] && [ -x "$executable" ] || {
    echo "abi-staging-verify-bottle.sh: required verifier executable is unavailable" >&2
    exit 2
  }
done
if [ -n "$RECORD_VALIDATOR" ]; then
  [ -f "$RECORD_VALIDATOR" ] && [ ! -L "$RECORD_VALIDATOR" ] && \
    [ -x "$RECORD_VALIDATOR" ] || {
    echo "abi-staging-verify-bottle.sh: test record validator is unavailable" >&2
    exit 2
  }
fi

WORK_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT
chmod 0700 "$WORK_ROOT"
CANONICAL="$WORK_ROOT/canonical.json"

canonical_json() {
  local input="$1" label="$2"
  jq -cS . "$input" >"$CANONICAL" || {
    echo "abi-staging-verify-bottle.sh: $label is invalid JSON" >&2
    exit 2
  }
  cmp -s "$input" "$CANONICAL" || {
    echo "abi-staging-verify-bottle.sh: $label is not canonical JSON" >&2
    exit 2
  }
}

canonical_json "$CANDIDATE_LOCATOR" "candidate locator"
canonical_json "$TEST_DEFINITION" "test definition"
canonical_json "$RUN" "verification run"
canonical_json "$DEPENDENCY_PROVENANCE" "staged dependency layer contract"
[ "$(sha256sum "$TEST_DEFINITION" | awk '{print $1}')" = \
  "$TEST_DEFINITION_SHA256" ] || {
  echo "abi-staging-verify-bottle.sh: test definition digest differs" >&2
  exit 2
}

jq -e \
  --arg host "$HOST" '
    type == "object" and
    keys == ["hosts", "id", "kandelo_paths", "policy"] and
    (.id | type == "string" and test("^[a-z0-9][a-z0-9@+._-]{0,255}$")) and
    (.hosts | type == "array" and length > 0 and index($host) != null and
      . == (sort | unique) and all(.[]; . == "build" or . == "node" or . == "browser")) and
    (.kandelo_paths | type == "array" and length > 0 and . == (sort | unique) and
      all(.[]; type == "string" and test("^[A-Za-z0-9@+._/-]+$") and
        (startswith("/") | not) and (contains("..") | not))) and
    (.policy | type == "string" and test("^[a-z0-9][a-z0-9@+._-]{0,255}$"))
  ' "$TEST_DEFINITION" >/dev/null || {
  echo "abi-staging-verify-bottle.sh: test definition is unsupported" >&2
  exit 2
}
TEST_ID="$(jq -er '.id' "$TEST_DEFINITION")"
TEST_POLICY="$(jq -er '.policy' "$TEST_DEFINITION")"
case "$TEST_POLICY:$HOST" in
  kandelo-bottle-structure-v1:build)
    jq -e '.kandelo_paths == [
      "scripts/homebrew-inspect-bottle.py",
      "scripts/test-homebrew-inspect-bottle.sh"
    ]' "$TEST_DEFINITION" >/dev/null
    ;;
  kandelo-public-candidate-node-v1:node)
    jq -e '.kandelo_paths == [
      "host/test/homebrew-public-bottle-verifier.test.ts"
    ]' "$TEST_DEFINITION" >/dev/null
    ;;
  kandelo-public-candidate-browser-v1:browser)
    jq -e '.kandelo_paths == [
      "apps/browser-demos/test/homebrew-flat-vfs-shipping.spec.ts"
    ]' "$TEST_DEFINITION" >/dev/null
    ;;
  *)
    echo "abi-staging-verify-bottle.sh: test policy and host differ" >&2
    exit 2
    ;;
esac
jq -e '
  type == "object" and
  keys == ["job", "repository", "run_attempt", "run_id", "workflow_ref"] and
  (.repository | type == "string" and test("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")) and
  (.workflow_ref | type == "string" and length > 0 and length <= 2048) and
  (.run_id | type == "number" and . >= 1 and floor == .) and
  (.run_attempt | type == "number" and . >= 1 and floor == .) and
  (.job | type == "string" and test("^[a-z0-9][a-z0-9@+._-]{0,255}$"))
' "$RUN" >/dev/null || {
  echo "abi-staging-verify-bottle.sh: verification run is unsupported" >&2
  exit 2
}

LOCATOR_REPOSITORY="$(jq -er '.repository' "$CANDIDATE_LOCATOR")"
LOCATOR_DIGEST="$(jq -er '.digest' "$CANDIDATE_LOCATOR")"
LOCATOR_REFERENCE="$(jq -er '.immutable_reference' "$CANDIDATE_LOCATOR")"
jq -e 'type == "object" and keys == [
  "digest", "immutable_reference", "repository"
]' "$CANDIDATE_LOCATOR" >/dev/null &&
  [[ "$LOCATOR_REPOSITORY" =~ ^ghcr\.io/[a-z0-9._-]+(/[a-z0-9._-]+)+$ ]] &&
  [[ "$LOCATOR_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] &&
  [ "$LOCATOR_REFERENCE" = "$LOCATOR_REPOSITORY@$LOCATOR_DIGEST" ] || {
  echo "abi-staging-verify-bottle.sh: candidate locator is not an immutable GHCR digest" >&2
  exit 2
}
REMOTE="${LOCATOR_REPOSITORY#ghcr.io/}"
MANIFEST="$WORK_ROOT/candidate-manifest.json"
CONFIG="$WORK_ROOT/candidate-record.json"
METADATA="$WORK_ROOT/bottle-metadata.json"
BOTTLE_DIR="$WORK_ROOT/bottle-cache"
mkdir -p "$BOTTLE_DIR" "$WORK_ROOT/home" "$WORK_ROOT/homebrew-cache" \
  "$WORK_ROOT/homebrew-temp" "$WORK_ROOT/diagnostics"
ANONYMOUS_CONFIG="$WORK_ROOT/anonymous-oras.json"
printf '{"auths":{}}\n' >"$ANONYMOUS_CONFIG"
env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  "$ORAS_BIN" manifest fetch --registry-config "$ANONYMOUS_CONFIG" \
    --output "$MANIFEST" "$LOCATOR_REFERENCE"
[ "$(sha256sum "$MANIFEST" | awk '{print $1}')" = "${LOCATOR_DIGEST#sha256:}" ] || {
  echo "abi-staging-verify-bottle.sh: candidate manifest digest differs" >&2
  exit 1
}
canonical_json "$MANIFEST" "candidate manifest"
jq -e '
  type == "object" and
  keys == ["annotations", "artifactType", "config", "layers", "mediaType", "schemaVersion"] and
  .schemaVersion == 2 and
  .mediaType == "application/vnd.oci.image.manifest.v1+json" and
  .artifactType == "application/vnd.kandelo.abi-staging.candidate.record.v1+json" and
  (.config.annotations["dev.kandelo.abi-staging.role"] == "candidate-record") and
  ([.layers[].annotations["dev.kandelo.abi-staging.role"]] == [
    "bottle-layer", "bottle-metadata", "bottle-contract",
    "attempt-record", "source-custody-record"
  ]) and
  ([.config, .layers[]] | all(.[];
    (keys == ["annotations", "digest", "mediaType", "size"]) and
    (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
    (.size | type == "number" and . >= 1 and floor == .) and
    (.annotations | keys == [
      "dev.kandelo.abi-staging.role", "org.opencontainers.image.title"
    ])
  ))
' "$MANIFEST" >/dev/null || {
  echo "abi-staging-verify-bottle.sh: candidate manifest structure is invalid" >&2
  exit 1
}

CONFIG_DIGEST="$(jq -er '.config.digest' "$MANIFEST")"
CONFIG_BYTES="$(jq -er '.config.size' "$MANIFEST")"
METADATA_DIGEST="$(jq -er '.layers[] | select(.annotations["dev.kandelo.abi-staging.role"] == "bottle-metadata") | .digest' "$MANIFEST")"
METADATA_BYTES="$(jq -er '.layers[] | select(.annotations["dev.kandelo.abi-staging.role"] == "bottle-metadata") | .size' "$MANIFEST")"
BOTTLE_DIGEST="$(jq -er '.layers[] | select(.annotations["dev.kandelo.abi-staging.role"] == "bottle-layer") | .digest' "$MANIFEST")"
BOTTLE_BYTES="$(jq -er '.layers[] | select(.annotations["dev.kandelo.abi-staging.role"] == "bottle-layer") | .size' "$MANIFEST")"
for item in "config:$CONFIG_DIGEST:$CONFIG_BYTES:$CONFIG" \
  "metadata:$METADATA_DIGEST:$METADATA_BYTES:$METADATA"; do
  IFS=: read -r label algorithm digest bytes destination <<<"$item"
  [ "$algorithm" = "sha256" ] || exit 2
  env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    "$ORAS_BIN" blob fetch --registry-config "$ANONYMOUS_CONFIG" \
      --output "$destination" "$LOCATOR_REPOSITORY@$algorithm:$digest"
  [ "$(sha256sum "$destination" | awk '{print $1}')" = "$digest" ] &&
    [ "$(wc -c <"$destination" | tr -d '[:space:]')" = "$bytes" ] || {
    echo "abi-staging-verify-bottle.sh: candidate $label blob differs" >&2
    exit 1
  }
done
canonical_json "$CONFIG" "candidate record"
canonical_json "$METADATA" "candidate bottle metadata"
if [ -n "$RECORD_VALIDATOR" ]; then
  "$RECORD_VALIDATOR" "$CONFIG"
else
  HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
  cargo run --quiet -p xtask --target "$HOST_TARGET" -- \
    abi-staging records validate --record "$CONFIG"
fi

FORMULA="$(jq -er '.candidate.formula.formula' "$CONFIG")"
VERSION="$(jq -er '.candidate.formula.version' "$CONFIG")"
REVISION="$(jq -er '.candidate.formula.revision' "$CONFIG")"
REBUILD="$(jq -er '.candidate.formula.bottle_rebuild' "$CONFIG")"
ARCHITECTURE="$(jq -er '.candidate.formula.architecture' "$CONFIG")"
TARGET_ABI="$(jq -er '.candidate.formula.target_abi' "$CONFIG")"
TAP_REPOSITORY="$(jq -er '.candidate.formula.tap' "$CONFIG")"
LAYER_SHA256="${BOTTLE_DIGEST#sha256:}"
jq -e \
  --arg sha256 "$LAYER_SHA256" \
  --argjson bytes "$BOTTLE_BYTES" \
  --arg metadata_sha "${METADATA_DIGEST#sha256:}" \
  --argjson metadata_bytes "$METADATA_BYTES" \
  --arg reference "$LOCATOR_REPOSITORY@$BOTTLE_DIGEST" '
    .candidate.nonendorsed == true and
    .common.outcome == "success" and
    .common.artifact_class == "candidate" and
    .candidate.bottle_layer.sha256 == $sha256 and
    .candidate.bottle_layer.bytes == $bytes and
    .candidate.bottle_layer.immutable_reference == $reference and
    .common.artifact == .candidate.bottle_layer and
    ([.candidate.normalized_components[] | select(.id == "bottle-metadata") |
      select(.artifact.sha256 == $metadata_sha and .artifact.bytes == $metadata_bytes)] |
      length) == 1
  ' "$CONFIG" >/dev/null || {
  echo "abi-staging-verify-bottle.sh: candidate record differs from manifest layers" >&2
  exit 1
}
case "$ARCHITECTURE" in wasm32|wasm64) ;; *) exit 2 ;; esac
[[ "$TARGET_ABI" =~ ^[1-9][0-9]*$ ]] || exit 2
EXPECTED_REMOTE="${TAP_REPOSITORY,,}-abi-${TARGET_ABI}-candidates/$FORMULA"
[ "$REMOTE" = "$EXPECTED_REMOTE" ] || {
  echo "abi-staging-verify-bottle.sh: candidate namespace differs from Formula tap" >&2
  exit 1
}
[ -f "$TAP_ROOT/Formula/$FORMULA.rb" ] && [ ! -L "$TAP_ROOT/Formula/$FORMULA.rb" ] || {
  echo "abi-staging-verify-bottle.sh: selected Formula source is unavailable" >&2
  exit 2
}
STAGED_DEPENDENCY_FORMULAE="$WORK_ROOT/staged-dependency-formulae.txt"
jq -e \
  --slurpfile candidate "$CONFIG" \
  --arg formula "$FORMULA" \
  --arg architecture "$ARCHITECTURE" \
  --arg tap_repository "${TAP_REPOSITORY,,}" \
  --argjson target_abi "$TARGET_ABI" \
  --arg candidate_base "ghcr.io/${TAP_REPOSITORY,,}-abi-${TARGET_ABI}-candidates" '
    type == "object" and
    keys == ["architecture", "dependency_layers", "kind", "schema",
      "tap_repository", "target_abi"] and
    .schema == 1 and
    .kind == "kandelo-abi-staging-dependency-layers" and
    .architecture == $architecture and
    .tap_repository == $tap_repository and
    .target_abi == $target_abi and
    (.dependency_layers | type == "array" and length <= 128 and
      . == (sort_by(.formula)) and
      ([.[].formula] | length == (unique | length)) and
      all(.[];
        keys == ["artifact", "formula"] and
        (.formula | type == "string" and
          test("^[a-z0-9][a-z0-9._-]*$") and . != $formula) and
        (.artifact | keys == ["bytes", "immutable_reference", "sha256"]) and
        (.artifact.bytes | type == "number" and . >= 1 and floor == .) and
        (.artifact.sha256 | type == "string" and
          test("^[0-9a-f]{64}$")) and
        .artifact.immutable_reference ==
          ($candidate_base + "/" + .formula + "@sha256:" +
            .artifact.sha256))) and
    ([ $candidate[0].candidate.direct_dependency_layers[] as $direct |
       .dependency_layers[] |
       select($direct.id == (.formula + "-" + $architecture) and
         $direct.artifact == .artifact) ] | length) ==
      ($candidate[0].candidate.direct_dependency_layers | length)
  ' "$DEPENDENCY_PROVENANCE" >/dev/null || {
  echo "abi-staging-verify-bottle.sh: dependency layer contract differs from candidate dependencies" >&2
  exit 1
}
jq -r '.dependency_layers[].formula' "$DEPENDENCY_PROVENANCE" \
  >"$STAGED_DEPENDENCY_FORMULAE"
while IFS= read -r dependency; do
  [ -f "$TAP_ROOT/Formula/$dependency.rb" ] && \
    [ ! -L "$TAP_ROOT/Formula/$dependency.rb" ] || {
    echo "abi-staging-verify-bottle.sh: staged dependency Formula is unavailable: $dependency" >&2
    exit 2
  }
done <"$STAGED_DEPENDENCY_FORMULAE"

PKG_VERSION="$VERSION"
if [ "$REVISION" != "0" ]; then
  PKG_VERSION="${VERSION}_${REVISION}"
fi
BOTTLE_TAG="${ARCHITECTURE}_kandelo"
REBUILD_SUFFIX=""
if [ "$REBUILD" != "0" ]; then
  REBUILD_SUFFIX=".$REBUILD"
fi
BOTTLE_FILENAME="${FORMULA}--${PKG_VERSION}.${BOTTLE_TAG}.bottle${REBUILD_SUFFIX}.tar.gz"
BOTTLE="$BOTTLE_DIR/$BOTTLE_FILENAME"
CANDIDATE_BASE="${REMOTE%/$FORMULA}"
[ "$CANDIDATE_BASE/$FORMULA" = "$REMOTE" ] || {
  echo "abi-staging-verify-bottle.sh: candidate repository lacks Formula suffix" >&2
  exit 1
}
BOTTLE_ROOT_URL="https://ghcr.io/v2/$CANDIDATE_BASE"
FORMULA_BOTTLE_ROOT_URL="$BOTTLE_ROOT_URL/$FORMULA"
BOTTLE_URL="$FORMULA_BOTTLE_ROOT_URL/blobs/$BOTTLE_DIGEST"
"$NODE_BIN" --experimental-strip-types \
  "$REPO_ROOT/scripts/homebrew-verify-public-bottle.ts" \
  --url "$BOTTLE_URL" --sha256 "$LAYER_SHA256" --bytes "$BOTTLE_BYTES" \
  --out "$BOTTLE"
[ "$(sha256sum "$BOTTLE" | awk '{print $1}')" = "$LAYER_SHA256" ] &&
  [ "$(wc -c <"$BOTTLE" | tr -d '[:space:]')" = "$BOTTLE_BYTES" ] || {
  echo "abi-staging-verify-bottle.sh: downloaded bottle differs from exact layer" >&2
  exit 1
}

jq -e \
  --arg formula "$FORMULA" --arg pkg_version "$PKG_VERSION" \
  --arg root "$FORMULA_BOTTLE_ROOT_URL" --arg tag "$BOTTLE_TAG" \
  --arg sha256 "$LAYER_SHA256" --argjson rebuild "$REBUILD" '
    type == "object" and keys == [$formula] and
    .[$formula].formula.name == $formula and
    .[$formula].formula.pkg_version == $pkg_version and
    .[$formula].bottle.root_url == $root and
    .[$formula].bottle.rebuild == $rebuild and
    (.[$formula].bottle.tags | keys == [$tag]) and
    .[$formula].bottle.tags[$tag].sha256 == $sha256
  ' "$METADATA" >/dev/null || {
  echo "abi-staging-verify-bottle.sh: bottle metadata differs from candidate identity" >&2
  exit 1
}

SELECTION_RECEIPT="$WORK_ROOT/selection-receipt.json"
jq -ncS \
  --arg url "$BOTTLE_URL" --arg sha256 "$LAYER_SHA256" \
  --argjson bytes "$BOTTLE_BYTES" '
    {bottle: {bytes: $bytes, mode: "anonymous-public-readback",
      sha256: $sha256, url: $url}, fetch: ["exact immutable candidate layer"],
      schema: 1, status: "success"}
  ' >"$SELECTION_RECEIPT"

SUMMARY="$WORK_ROOT/diagnostics/summary.txt"
INSPECTION="$WORK_ROOT/diagnostics/inspection.json"
RUNTIME_EVIDENCE="$WORK_ROOT/diagnostics/runtime-evidence.json"
DRIVER="$WORK_ROOT/run-verification.sh"
cat >"$DRIVER" <<'DRIVER'
#!/usr/bin/env bash
set -euo pipefail
inspector_args=(
  --archive "$ABI_VERIFY_BOTTLE"
  --formula "$ABI_VERIFY_FORMULA"
  --version "$ABI_VERIFY_PKG_VERSION"
  --expected-abi "$ABI_VERIFY_TARGET_ABI"
  --expected-arch "$ABI_VERIFY_ARCHITECTURE"
  --selected-formula "$ABI_VERIFY_TAP_ROOT/Formula/$ABI_VERIFY_FORMULA.rb"
  --out "$ABI_VERIFY_INSPECTION"
)
while IFS= read -r forbidden_root; do
  inspector_args+=(--forbidden-root "$forbidden_root")
done <"$ABI_VERIFY_FORBIDDEN_ROOTS"
"$ABI_VERIFY_INSPECTOR" "${inspector_args[@]}"
normal_verifier_args=(
  --tap-root "$ABI_VERIFY_TAP_ROOT" \
  --tap-repository "$ABI_VERIFY_TAP_REPOSITORY" \
  --tap-commit "$ABI_VERIFY_TAP_COMMIT" \
  --tap-checkout-commit "$ABI_VERIFY_TAP_CHECKOUT_COMMIT" \
  --formula "$ABI_VERIFY_FORMULA" \
  --arch "$ABI_VERIFY_ARCHITECTURE" \
  --abi "$ABI_VERIFY_TARGET_ABI" \
  --bottle "$ABI_VERIFY_BOTTLE" \
  --bottle-json "$ABI_VERIFY_METADATA" \
  --bottle-url "$ABI_VERIFY_BOTTLE_URL" \
  --bottle-sha256 "$ABI_VERIFY_LAYER_SHA256" \
  --bottle-bytes "$ABI_VERIFY_BOTTLE_BYTES" \
  --bottle-root-url "$ABI_VERIFY_BOTTLE_ROOT_URL" \
  --staging-candidate-abi "$ABI_VERIFY_TARGET_ABI" \
  --dependency-provenance "$ABI_VERIFY_DEPENDENCY_PROVENANCE" \
  --selection-receipt "$ABI_VERIFY_SELECTION_RECEIPT" \
  --sysroot-build-root "$ABI_VERIFY_SYSROOT_BUILD_ROOT" \
  --out "$ABI_VERIFY_RUNTIME_EVIDENCE"
)
while IFS= read -r dependency; do
  normal_verifier_args+=(--staged-dependency-formula "$dependency")
done <"$ABI_VERIFY_STAGED_DEPENDENCY_FORMULAE"
HOME="$ABI_VERIFY_HOME" \
HOMEBREW_CACHE="$ABI_VERIFY_CACHE" \
HOMEBREW_TEMP="$ABI_VERIFY_TEMP" \
"$ABI_VERIFY_NORMAL_VERIFIER" "${normal_verifier_args[@]}"
case "$ABI_VERIFY_TEST_POLICY" in
  kandelo-bottle-structure-v1) ;;
  kandelo-public-candidate-node-v1)
    (cd "$ABI_VERIFY_REPO_ROOT/host" &&
      npx vitest run test/homebrew-public-bottle-verifier.test.ts)
    ;;
  kandelo-public-candidate-browser-v1)
    (cd "$ABI_VERIFY_REPO_ROOT/apps/browser-demos" &&
      npx playwright test test/homebrew-flat-vfs-shipping.spec.ts)
    ;;
esac
DRIVER
chmod 0700 "$DRIVER"
FORBIDDEN_FILE="$WORK_ROOT/forbidden-roots.txt"
printf '%s\n' "${FORBIDDEN_ROOTS[@]}" >"$FORBIDDEN_FILE"
export ABI_VERIFY_BOTTLE="$BOTTLE"
export ABI_VERIFY_FORMULA="$FORMULA"
export ABI_VERIFY_PKG_VERSION="$PKG_VERSION"
export ABI_VERIFY_TARGET_ABI="$TARGET_ABI"
export ABI_VERIFY_ARCHITECTURE="$ARCHITECTURE"
export ABI_VERIFY_TAP_ROOT="$TAP_ROOT"
export ABI_VERIFY_INSPECTION="$INSPECTION"
export ABI_VERIFY_FORBIDDEN_ROOTS="$FORBIDDEN_FILE"
export ABI_VERIFY_INSPECTOR="$INSPECTOR"
export ABI_VERIFY_HOME="$WORK_ROOT/home"
export ABI_VERIFY_CACHE="$WORK_ROOT/homebrew-cache"
export ABI_VERIFY_TEMP="$WORK_ROOT/homebrew-temp"
export ABI_VERIFY_NORMAL_VERIFIER="$NORMAL_VERIFIER"
export ABI_VERIFY_TAP_REPOSITORY="$TAP_REPOSITORY"
export ABI_VERIFY_TAP_COMMIT="$TAP_COMMIT"
export ABI_VERIFY_TAP_CHECKOUT_COMMIT="$TAP_CHECKOUT_COMMIT"
export ABI_VERIFY_METADATA="$METADATA"
export ABI_VERIFY_BOTTLE_URL="$BOTTLE_URL"
export ABI_VERIFY_LAYER_SHA256="$LAYER_SHA256"
export ABI_VERIFY_BOTTLE_BYTES="$BOTTLE_BYTES"
export ABI_VERIFY_BOTTLE_ROOT_URL="$BOTTLE_ROOT_URL"
export ABI_VERIFY_DEPENDENCY_PROVENANCE="$DEPENDENCY_PROVENANCE"
export ABI_VERIFY_STAGED_DEPENDENCY_FORMULAE="$STAGED_DEPENDENCY_FORMULAE"
export ABI_VERIFY_SELECTION_RECEIPT="$SELECTION_RECEIPT"
export ABI_VERIFY_SYSROOT_BUILD_ROOT="$SYSROOT_BUILD_ROOT"
export ABI_VERIFY_RUNTIME_EVIDENCE="$RUNTIME_EVIDENCE"
export ABI_VERIFY_TEST_POLICY="$TEST_POLICY"
export ABI_VERIFY_REPO_ROOT="$REPO_ROOT"

set +e
"$TIMEOUT_BIN" 21600s "$DRIVER" 2>&1 | head -c 16777217 >"$SUMMARY"
PIPE_STATUSES=("${PIPESTATUS[@]}")
VERIFY_STATUS="${PIPE_STATUSES[0]}"
set -e
[ -s "$SUMMARY" ] || printf 'verification exited with status %s\n' "$VERIFY_STATUS" >"$SUMMARY"
if [ "$(wc -c <"$SUMMARY" | tr -d '[:space:]')" -gt 16777216 ]; then
  VERIFY_STATUS=1
  printf 'verification diagnostic exceeded 16777216 bytes\n' >"$SUMMARY"
fi
for evidence in "$INSPECTION" "$RUNTIME_EVIDENCE"; do
  if [ -e "$evidence" ] || [ -L "$evidence" ]; then
    if [ -L "$evidence" ] || [ ! -f "$evidence" ] || \
      [ "$(wc -c <"$evidence" | tr -d '[:space:]')" -gt 16777216 ]; then
      VERIFY_STATUS=1
      printf 'verification produced unsafe or oversized evidence\n' >"$SUMMARY"
      rm -f "$INSPECTION" "$RUNTIME_EVIDENCE"
      break
    fi
  fi
done
if [ "$VERIFY_STATUS" -eq 0 ] && \
  { [ ! -s "$INSPECTION" ] || [ ! -s "$RUNTIME_EVIDENCE" ]; }; then
  VERIFY_STATUS=1
  printf 'successful verification omitted required evidence\n' >"$SUMMARY"
fi
case "$VERIFY_STATUS" in
  0) OUTCOME="success" ;;
  124) OUTCOME="timeout" ;;
  *) OUTCOME="failure" ;;
esac
if [ "$VERIFY_STATUS" -gt 255 ]; then
  VERIFY_STATUS=255
fi

mkdir -p "$OUT/diagnostics"
chmod 0700 "$OUT" "$OUT/diagnostics"
cp "$SUMMARY" "$OUT/diagnostics/summary.txt"
if [ -f "$INSPECTION" ] && [ ! -L "$INSPECTION" ]; then
  cp "$INSPECTION" "$OUT/diagnostics/inspection.json"
fi
if [ -f "$RUNTIME_EVIDENCE" ] && [ ! -L "$RUNTIME_EVIDENCE" ]; then
  cp "$RUNTIME_EVIDENCE" "$OUT/diagnostics/runtime-evidence.json"
fi

diagnostics='[]'
while IFS= read -r path; do
  sha="$(sha256sum "$OUT/$path" | awk '{print $1}')"
  bytes="$(wc -c <"$OUT/$path" | tr -d '[:space:]')"
  diagnostics="$(jq -ncS --argjson current "$diagnostics" --arg path "$path" \
    --arg sha256 "$sha" --argjson bytes "$bytes" \
    '$current + [{bytes: $bytes, path: $path, sha256: $sha256}]')"
done < <(find "$OUT/diagnostics" -type f -print | sed "s#^$OUT/##" | LC_ALL=C sort)

jq -ncS \
  --slurpfile locator "$CANDIDATE_LOCATOR" \
  --slurpfile candidate "$CONFIG" \
  --slurpfile run "$RUN" \
  --arg test_id "$TEST_ID" --arg test_sha "$TEST_DEFINITION_SHA256" \
  --arg host "$HOST" --arg outcome "$OUTCOME" \
  --argjson exit_code "$VERIFY_STATUS" --argjson ordinal "$ATTEMPT_ORDINAL" \
  --argjson diagnostics "$diagnostics" '
    {attempt_ordinal: $ordinal,
      candidate_layer: $candidate[0].candidate.bottle_layer,
      candidate_record: $locator[0], diagnostics: $diagnostics,
      exit_code: $exit_code, kind: "kandelo-abi-staging-verification-result",
      outcome: $outcome, request_sha256: $candidate[0].common.request_sha256,
      run: $run[0], runtime_artifacts: {host_runtime: null, kernel: null, vfs: null},
      schema: 1, source: $candidate[0].common.source,
      test_definition: {host: $host, id: $test_id, sha256: $test_sha}}
  ' >"$OUT/result.json"

files='[]'
while IFS= read -r path; do
  sha="$(sha256sum "$OUT/$path" | awk '{print $1}')"
  bytes="$(wc -c <"$OUT/$path" | tr -d '[:space:]')"
  role="diagnostic"
  [ "$path" = "result.json" ] && role="result"
  files="$(jq -ncS --argjson current "$files" --arg path "$path" \
    --arg role "$role" --arg sha256 "$sha" --argjson bytes "$bytes" \
    '$current + [{bytes: $bytes, path: $path, role: $role, sha256: $sha256}]')"
done < <(find "$OUT" -type f ! -name inventory.json -print | \
  sed "s#^$OUT/##" | LC_ALL=C sort)
jq -ncS --argjson files "$files" '
  {files: $files, kind: "kandelo-abi-staging-verification-inventory", schema: 1}
' >"$OUT/inventory.json"

if [ "$VERIFY_STATUS" -eq 0 ]; then
  echo "abi-staging-verify-bottle.sh: verified exact public candidate"
else
  echo "abi-staging-verify-bottle.sh: recorded $OUTCOME verification" >&2
fi
exit "$VERIFY_STATUS"
