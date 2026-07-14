#!/usr/bin/env bash
# Transport a precomposed, validated Homebrew OCI layout to GHCR.
set -euo pipefail

LAYOUT=""
LAYOUT_RECEIPT=""
TAP_REPOSITORY=""
FORMULA=""
OUT_JSON=""
DRY_RUN=0
AUTH_DIR=""
WORK_DIR=""

cleanup() {
  [ -z "$AUTH_DIR" ] || rm -rf "$AUTH_DIR"
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
}
trap cleanup EXIT

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-ghcr-upload.sh --layout <oci-layout> --layout-receipt <json> --tap-repository <owner/repo> --formula <name> --out-json <json> [--dry-run]

Validates an explicit local OCI layout, preflights the destination reference,
and uses ORAS only to copy that immutable layout to GHCR. It never evaluates
Formula Ruby or constructs registry metadata while credentials are present.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --layout) LAYOUT="${2:-}"; shift 2 ;;
    --layout-receipt) LAYOUT_RECEIPT="${2:-}"; shift 2 ;;
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
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
     "$(printf '%s' "$TAP_REPOSITORY" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "homebrew-ghcr-upload.sh: layout receipt publication identity mismatch" >&2
  exit 2
fi
if ! [[ "$EXPECTED_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
   ! [[ "$SOURCE_REF" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "homebrew-ghcr-upload.sh: invalid OCI receipt descriptor" >&2
  exit 2
fi

OWNER_LOWER="$(printf '%s' "${TAP_REPOSITORY%%/*}" | tr '[:upper:]' '[:lower:]')"
REPO_LOWER="$(printf '%s' "${TAP_REPOSITORY#*/}" | tr '[:upper:]' '[:lower:]')"
REMOTE="ghcr.io/${OWNER_LOWER}/${REPO_LOWER}/${FORMULA}"
auth_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
WORK_DIR="$(mktemp -d "$auth_parent/kandelo-homebrew-preflight.XXXXXX")"
anonymous_config="$WORK_DIR/anonymous.json"
printf '{"auths":{}}\n' >"$anonymous_config"

remote_descriptor="$WORK_DIR/remote-descriptor.json"
remote_error="$WORK_DIR/remote-error.txt"

anonymous_fetch() {
  local phase="$1"
  : >"$remote_descriptor"
  : >"$remote_error"
  set +e
  env -u GH_TOKEN -u GITHUB_TOKEN -u HOMEBREW_GITHUB_API_TOKEN \
    -u HOMEBREW_GITHUB_PACKAGES_TOKEN -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
    oras manifest fetch --descriptor --registry-config "$anonymous_config" \
      "$REMOTE:$DESTINATION_REF" >"$remote_descriptor" 2>"$remote_error"
  fetch_status="$?"
  set -e
  if [ "$fetch_status" -eq 0 ]; then
    if [ "$(wc -c <"$remote_descriptor")" -gt 65536 ]; then
      echo "homebrew-ghcr-upload.sh: anonymous $phase descriptor exceeds 65536 bytes" >&2
      exit 1
    fi
    remote_status=present
    REMOTE_DIGEST="$(jq -er '.digest' "$remote_descriptor")"
    [[ "$REMOTE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || {
      echo "homebrew-ghcr-upload.sh: registry returned an invalid descriptor during $phase" >&2
      exit 1
    }
  elif grep -Eiq \
    'manifest[_ -]+unknown|name[_ -]+unknown|404[[:space:]]+not[[:space:]]+found|status([_ -]*code)?["=:[:space:]]+404' \
    "$remote_error"; then
    remote_status=missing
    REMOTE_DIGEST=null
  elif grep -Eiq \
    'unauthorized|authentication[[:space:]]+required|denied|forbidden|(^|[^0-9])(401|403)([^0-9]|$)' \
    "$remote_error"; then
    remote_status=private
    REMOTE_DIGEST=null
  else
    echo "homebrew-ghcr-upload.sh: could not classify anonymous destination $phase" >&2
    sed -n '1,8p' "$remote_error" >&2
    exit 1
  fi
}

visibility_boundary() {
  echo "homebrew-ghcr-upload.sh: $REMOTE:$DESTINATION_REF is not anonymously readable" >&2
  echo "homebrew-ghcr-upload.sh: an authorized owner must make the GHCR package public; refusing to change package visibility automatically" >&2
  exit 1
}

anonymous_fetch preflight
[ "$remote_status" != private ] || visibility_boundary

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
    if [ -z "${GH_TOKEN:-}" ]; then
      echo "homebrew-ghcr-upload.sh: GH_TOKEN is required for GHCR transport" >&2
      exit 2
    fi
    AUTH_DIR="$(mktemp -d "$auth_parent/kandelo-homebrew-oras.XXXXXX")"
    chmod 700 "$AUTH_DIR"
    auth_config="$AUTH_DIR/config.json"
    printf '%s\n' "$GH_TOKEN" | oras login ghcr.io \
      --registry-config "$auth_config" \
      -u "${GITHUB_ACTOR:-github-actions}" --password-stdin >/dev/null
    oras cp --from-oci-layout --to-registry-config "$auth_config" \
      "$LAYOUT:$SOURCE_REF" "$REMOTE:$DESTINATION_REF"
    rm -rf "$AUTH_DIR"
    AUTH_DIR=""
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
    [ "$remote_status" != private ] || visibility_boundary
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
  --arg remote "$REMOTE" \
  --arg reference "$DESTINATION_REF" \
  --arg digest "$EXPECTED_DIGEST" \
  --arg previous_digest "$EXPECTED_PREVIOUS" \
  --arg layout_receipt_sha256 "$layout_receipt_sha256" \
  --arg public_readback_digest "$public_readback_digest" \
  --arg status "$status" \
  --slurpfile layout "$LAYOUT_RECEIPT" '{
    schema: 2,
    kind: $kind,
    formula: $formula,
    tap_repository: $tap_repository,
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
