#!/usr/bin/env bash
# Transport a precomposed, validated Homebrew OCI layout to GHCR.
set -euo pipefail

LAYOUT=""
LAYOUT_RECEIPT=""
TAP_REPOSITORY=""
TAP_NAME_INPUT=""
FORMULA=""
OUT_JSON=""
DRY_RUN=0
AUTH_DIR=""
AUTH_CONFIG=""
WORK_DIR=""
REGISTRY_USER=""

cleanup() {
  [ -z "$AUTH_DIR" ] || rm -rf "$AUTH_DIR"
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
}
trap cleanup EXIT

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-ghcr-upload.sh --layout <oci-layout> --layout-receipt <json> --tap-repository <owner/repo> [--tap-name <owner/name>] --formula <name> --out-json <json> [--dry-run]

Validates an explicit local OCI layout, preflights the destination reference,
and uses ORAS only to copy that immutable layout to GHCR. In PAT mode,
GHCR_USER must name the owner of GH_TOKEN. GitHub-token mode uses the Actions
actor. When GHCR hides an absent reference behind an anonymous authorization
failure, write mode uses isolated ORAS credentials only to distinguish missing
from present. It never evaluates Formula Ruby or constructs registry metadata
while credentials are present.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --layout) LAYOUT="${2:-}"; shift 2 ;;
    --layout-receipt) LAYOUT_RECEIPT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --tap-name) TAP_NAME_INPUT="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --out-json) OUT_JSON="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-ghcr-upload.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

for required in \
  'LAYOUT:--layout' \
  'LAYOUT_RECEIPT:--layout-receipt' \
  'TAP_REPOSITORY:--tap-repository' \
  'FORMULA:--formula' \
  'OUT_JSON:--out-json'; do
  name="${required%%:*}"
  flag="${required#*:}"
  if [ -z "${!name}" ]; then
    echo "homebrew-ghcr-upload.sh: $flag is required" >&2
    exit 2
  fi
done
if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
   ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-ghcr-upload.sh: invalid publication identity" >&2
  exit 2
fi
if [ ! -d "$LAYOUT" ] || [ -L "$LAYOUT" ] ||
   [ ! -f "$LAYOUT_RECEIPT" ] || [ -L "$LAYOUT_RECEIPT" ]; then
  echo "homebrew-ghcr-upload.sh: layout and receipt must be real data paths" >&2
  exit 2
fi
if [ "$(wc -c <"$LAYOUT_RECEIPT")" -gt 16777216 ]; then
  echo "homebrew-ghcr-upload.sh: layout receipt exceeds 16777216 bytes" >&2
  exit 2
fi
if [ -L "$OUT_JSON" ]; then
  echo "homebrew-ghcr-upload.sh: output receipt must not be a symlink" >&2
  exit 2
fi
if ! command -v oras >/dev/null 2>&1; then
  echo "homebrew-ghcr-upload.sh: oras is required in PATH" >&2
  exit 2
fi

SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=/dev/null
. "$SCRIPT_ROOT/homebrew-tap-identity.sh"
TAP_NAME="$(homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT")"
KIND="$(jq -er '.kind' "$LAYOUT_RECEIPT")"
case "$KIND" in
  child)
    python3 "$SCRIPT_ROOT/homebrew-oci-layout.py" validate-child \
      --layout "$LAYOUT" --receipt "$LAYOUT_RECEIPT"
    SOURCE_REF="$(jq -er '.oci.transport_tag' "$LAYOUT_RECEIPT")"
    DESTINATION_REF="$SOURCE_REF"
    EXPECTED_DIGEST="$(jq -er '.oci.manifest.digest' "$LAYOUT_RECEIPT")"
    EXPECTED_PREVIOUS=null
    ;;
  index)
    python3 "$SCRIPT_ROOT/homebrew-oci-layout.py" validate-index \
      --layout "$LAYOUT" --receipt "$LAYOUT_RECEIPT"
    SOURCE_REF="$(jq -er '.top.ref' "$LAYOUT_RECEIPT")"
    DESTINATION_REF="$SOURCE_REF"
    EXPECTED_DIGEST="$(jq -er '.top.digest' "$LAYOUT_RECEIPT")"
    EXPECTED_PREVIOUS="$(jq -r '.top.previous_digest // "null"' "$LAYOUT_RECEIPT")"
    ;;
  *) echo "homebrew-ghcr-upload.sh: unsupported layout receipt kind: $KIND" >&2; exit 2 ;;
esac
if [ "$(jq -er '.formula' "$LAYOUT_RECEIPT")" != "$FORMULA" ] ||
   [ "$(jq -er '.tap_repository | ascii_downcase' "$LAYOUT_RECEIPT")" != \
     "$(printf '%s' "$TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')" ] ||
   [ "$(jq -er '.tap_name | ascii_downcase' "$LAYOUT_RECEIPT")" != "$TAP_NAME" ]; then
  echo "homebrew-ghcr-upload.sh: layout receipt publication identity mismatch" >&2
  exit 2
fi
if ! [[ "$EXPECTED_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
   ! [[ "$SOURCE_REF" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "homebrew-ghcr-upload.sh: invalid OCI receipt descriptor" >&2
  exit 2
fi

REMOTE="ghcr.io/${TAP_NAME}/${FORMULA}"
auth_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

validate_auth_contract() {
  local auth_mode="${GHCR_AUTH_MODE:-automatic}"
  local require_pat="${GHCR_REQUIRE_PAT:-false}"

  case "$auth_mode" in
    pat|github-token|automatic) ;;
    *)
      echo "homebrew-ghcr-upload.sh: GHCR auth mode is invalid" >&2
      exit 2
      ;;
  esac
  case "$require_pat" in
    true)
      if [ "$auth_mode" != pat ]; then
        echo "homebrew-ghcr-upload.sh: required GitHub Packages PAT is unavailable" >&2
        exit 2
      fi
      ;;
    false) ;;
    *)
      echo "homebrew-ghcr-upload.sh: GHCR PAT requirement is invalid" >&2
      exit 2
      ;;
  esac

  case "$auth_mode" in
    pat)
      if [ -z "${GH_TOKEN:-}" ]; then
        echo "homebrew-ghcr-upload.sh: selected GitHub Packages PAT is unavailable" >&2
        exit 2
      fi
      REGISTRY_USER="${GHCR_USER:-}"
      ;;
    github-token)
      REGISTRY_USER="${GITHUB_ACTOR:-github-actions}"
      ;;
    automatic)
      REGISTRY_USER="${GHCR_USER:-${GITHUB_ACTOR:-github-actions}}"
      ;;
  esac
  if [ -z "$REGISTRY_USER" ] || [ "${#REGISTRY_USER}" -gt 255 ] ||
     [[ "$REGISTRY_USER" == *$'\n'* ]] || [[ "$REGISTRY_USER" == *$'\r'* ]]; then
    echo "homebrew-ghcr-upload.sh: GHCR registry user is invalid" >&2
    exit 2
  fi
}

validate_auth_contract

WORK_DIR="$(mktemp -d "$auth_parent/kandelo-homebrew-preflight.XXXXXX")"
anonymous_config="$WORK_DIR/anonymous.json"
printf '{"auths":{}}\n' >"$anonymous_config"

remote_probe="$WORK_DIR/remote-probe.json"

ensure_authenticated_config() {
  [ -z "$AUTH_DIR" ] || return 0
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "homebrew-ghcr-upload.sh: GH_TOKEN is required for GHCR transport" >&2
    exit 2
  fi
  AUTH_DIR="$(mktemp -d "$auth_parent/kandelo-homebrew-oras.XXXXXX")"
  chmod 700 "$AUTH_DIR"
  AUTH_CONFIG="$AUTH_DIR/config.json"
  printf '%s\n' "$GH_TOKEN" | \
    env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      oras login ghcr.io --registry-config "$AUTH_CONFIG" \
        -u "$REGISTRY_USER" --password-stdin >/dev/null
}

registry_probe() {
  local kind="$1"
  local registry_config="$2"
  rm -f "$remote_probe"
  if ! env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    python3 "$SCRIPT_ROOT/homebrew-oci-layout.py" probe-registry \
      --kind "$kind" \
      --remote "$REMOTE" \
      --reference "$DESTINATION_REF" \
      --registry-config "$registry_config" \
      --out-result "$remote_probe"; then
    return 1
  fi
  jq -e --arg kind "$kind" '
    keys == ["digest", "kind", "schema", "status"] and
    .schema == 1 and .kind == $kind and
    (.status == "present" or .status == "missing" or .status == "auth-required") and
    (if $kind == "manifest" and .status == "present"
     then (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
     else .digest == null
     end)
  ' "$remote_probe" >/dev/null || {
    echo "homebrew-ghcr-upload.sh: registry probe returned an invalid result" >&2
    return 1
  }
  probe_status="$(jq -r '.status' "$remote_probe")"
  probe_digest="$(jq -r '.digest // "null"' "$remote_probe")"
}

anonymous_fetch() {
  local phase="$1"
  if ! registry_probe manifest "$anonymous_config"; then
    echo "homebrew-ghcr-upload.sh: anonymous destination $phase failed" >&2
    exit 1
  fi
  remote_status="$probe_status"
  REMOTE_DIGEST="$probe_digest"
}

authenticated_fetch() {
  local phase="$1"
  ensure_authenticated_config
  if ! registry_probe manifest "$AUTH_CONFIG"; then
    echo "homebrew-ghcr-upload.sh: authenticated destination $phase failed" >&2
    exit 1
  fi
  remote_status="$probe_status"
  REMOTE_DIGEST="$probe_digest"
  if [ "$remote_status" = auth-required ]; then
    echo "homebrew-ghcr-upload.sh: authenticated credentials cannot inspect destination $phase" >&2
    exit 1
  fi
}

authenticated_repository_fetch() {
  local phase="$1"
  if ! registry_probe repository "$AUTH_CONFIG"; then
    echo "homebrew-ghcr-upload.sh: authenticated repository $phase failed" >&2
    exit 1
  fi
  repository_status="$probe_status"
  if [ "$repository_status" = auth-required ]; then
    echo "homebrew-ghcr-upload.sh: authenticated credentials cannot inspect repository $phase" >&2
    exit 1
  fi
}

visibility_boundary() {
  echo "homebrew-ghcr-upload.sh: $REMOTE:$DESTINATION_REF is not anonymously readable" >&2
  echo "homebrew-ghcr-upload.sh: an authorized owner must make the GHCR package public; refusing to change package visibility automatically" >&2
  exit 1
}

anonymous_fetch preflight
if [ "$remote_status" = auth-required ] && [ "$DRY_RUN" != 1 ]; then
  authenticated_fetch preflight
  if [ "$remote_status" = present ]; then
    visibility_boundary
  fi
  authenticated_repository_fetch preflight
  [ "$repository_status" = missing ] || visibility_boundary
fi
if [ "$remote_status" = auth-required ] && [ "$DRY_RUN" = 1 ] && [ "$KIND" = child ]; then
  echo "homebrew-ghcr-upload.sh: anonymous preflight cannot distinguish a missing package from a private reference; keeping the dry-run receipt non-public" >&2
fi
if [ "$remote_status" = auth-required ] && [ "$KIND" = index ]; then
  echo "homebrew-ghcr-upload.sh: anonymous index preflight cannot establish the current top reference" >&2
  exit 1
fi

case "$KIND" in
  child)
    if [ "$remote_status" = present ] && [ "$REMOTE_DIGEST" != "$EXPECTED_DIGEST" ]; then
      echo "homebrew-ghcr-upload.sh: content-derived child tag resolves to different bytes" >&2
      exit 1
    fi
    ;;
  index)
    if [ "$EXPECTED_PREVIOUS" = null ]; then
      if [ "$remote_status" = present ] && [ "$REMOTE_DIGEST" != "$EXPECTED_DIGEST" ]; then
        echo "homebrew-ghcr-upload.sh: top ref appeared after anonymous aggregation; retry from a fresh import" >&2
        exit 1
      fi
    elif [ "$remote_status" != present ] ||
         { [ "$REMOTE_DIGEST" != "$EXPECTED_PREVIOUS" ] && [ "$REMOTE_DIGEST" != "$EXPECTED_DIGEST" ]; }; then
      echo "homebrew-ghcr-upload.sh: top ref changed after anonymous aggregation" >&2
      exit 1
    fi
    ;;
esac

status=already-present
if [ "$REMOTE_DIGEST" != "$EXPECTED_DIGEST" ]; then
  status=dry-run
  if [ "$DRY_RUN" != 1 ]; then
    ensure_authenticated_config
    env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
      -u HOMEBREW_GITHUB_PACKAGES_TOKEN -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
      oras cp --from-oci-layout --to-registry-config "$AUTH_CONFIG" \
        "$LAYOUT:$SOURCE_REF" "$REMOTE:$DESTINATION_REF"
    rm -rf "$AUTH_DIR"
    AUTH_DIR=""
    AUTH_CONFIG=""
    status=uploaded
  fi
fi

public_readback_digest=null
if [ "$status" = already-present ]; then
  public_readback_digest="$REMOTE_DIGEST"
elif [ "$status" = uploaded ]; then
  attempts="${KANDELO_GHCR_PUBLIC_READ_ATTEMPTS:-6}"
  delay="${KANDELO_GHCR_PUBLIC_READ_DELAY_SECONDS:-2}"
  if ! [[ "$attempts" =~ ^[1-9][0-9]?$ ]] || ! [[ "$delay" =~ ^[0-9]$ ]]; then
    echo "homebrew-ghcr-upload.sh: invalid public readback retry configuration" >&2
    exit 2
  fi
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    anonymous_fetch post-upload-readback
    [ "$remote_status" != auth-required ] || visibility_boundary
    if [ "$remote_status" = present ]; then
      if [ "$REMOTE_DIGEST" != "$EXPECTED_DIGEST" ]; then
        echo "homebrew-ghcr-upload.sh: public reference resolves to a different digest after upload" >&2
        exit 1
      fi
      public_readback_digest="$REMOTE_DIGEST"
      break
    fi
    [ "$attempt" -eq "$attempts" ] || sleep "$delay"
  done
  if [ "$public_readback_digest" = null ]; then
    echo "homebrew-ghcr-upload.sh: uploaded reference did not become anonymously readable" >&2
    exit 1
  fi
fi

if command -v sha256sum >/dev/null 2>&1; then
  layout_receipt_sha256="$(jq -cS . "$LAYOUT_RECEIPT" | sha256sum | awk '{print $1}')"
else
  layout_receipt_sha256="$(jq -cS . "$LAYOUT_RECEIPT" | shasum -a 256 | awk '{print $1}')"
fi
mkdir -p "$(dirname "$OUT_JSON")"
jq -nS \
  --arg kind "$KIND" \
  --arg formula "$FORMULA" \
  --arg tap_repository "$TAP_REPOSITORY" \
  --arg tap_name "$TAP_NAME" \
  --arg remote "$REMOTE" \
  --arg reference "$DESTINATION_REF" \
  --arg digest "$EXPECTED_DIGEST" \
  --arg previous_digest "$EXPECTED_PREVIOUS" \
  --arg layout_receipt_sha256 "$layout_receipt_sha256" \
  --arg public_readback_digest "$public_readback_digest" \
  --arg status "$status" \
  --slurpfile layout "$LAYOUT_RECEIPT" '{
    schema: 3,
    kind: $kind,
    formula: $formula,
    tap_repository: $tap_repository,
    tap_name: $tap_name,
    layout: $layout[0],
    layout_receipt_sha256: $layout_receipt_sha256,
    publication: {
      remote: $remote,
      reference: $reference,
      digest: $digest,
      previous_digest: (if $previous_digest == "null" then null else $previous_digest end),
      public_readback_digest: (
        if $public_readback_digest == "null" then null else $public_readback_digest end
      ),
      status: $status
    }
  }' >"$OUT_JSON"

echo "homebrew-ghcr-upload.sh: $REMOTE:$DESTINATION_REF -> $EXPECTED_DIGEST ($status)"
