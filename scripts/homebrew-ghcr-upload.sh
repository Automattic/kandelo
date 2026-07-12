#!/usr/bin/env bash
# Upload one Homebrew bottle archive to GitHub Packages / GHCR.
set -euo pipefail

TAP_REPOSITORY=""
KANDELO_COMMIT=""
FORMULA=""
ARCH=""
RELEASE_TAG=""
TAP_COMMIT=""
BOTTLE=""
OUT_ENV=""
OUT_JSON=""
DRY_RUN=0
ORAS_AUTH_DIR=""

cleanup() {
  if [ -n "$ORAS_AUTH_DIR" ]; then
    rm -rf "$ORAS_AUTH_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat >&2 <<'EOF'
usage: scripts/homebrew-ghcr-upload.sh --tap-repository <owner/repo> --tap-commit <sha> --kandelo-commit <sha> --formula <name> --arch <wasm32|wasm64> --release-tag <tag> --bottle <path> [--out-env <path>] [--out-json <path>] [--dry-run]

Pushes the bottle bytes as an OCI layer so Homebrew can address them via:
https://ghcr.io/v2/<owner>/<repo>/<formula>/blobs/sha256:<sha256>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-repository) TAP_REPOSITORY="${2:-}"; shift 2 ;;
    --kandelo-commit) KANDELO_COMMIT="${2:-}"; shift 2 ;;
    --formula) FORMULA="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --tap-commit) TAP_COMMIT="${2:-}"; shift 2 ;;
    --bottle) BOTTLE="${2:-}"; shift 2 ;;
    --out-env) OUT_ENV="${2:-}"; shift 2 ;;
    --out-json) OUT_JSON="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "homebrew-ghcr-upload.sh: unknown flag $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "homebrew-ghcr-upload.sh: --$name is required" >&2
    exit 2
  fi
}

require tap-repository "$TAP_REPOSITORY"
require kandelo-commit "$KANDELO_COMMIT"
require formula "$FORMULA"
require arch "$ARCH"
require release-tag "$RELEASE_TAG"
require tap-commit "$TAP_COMMIT"
require bottle "$BOTTLE"
if [ -z "$OUT_ENV" ] && [ -z "$OUT_JSON" ]; then
  echo "homebrew-ghcr-upload.sh: --out-env or --out-json is required" >&2
  exit 2
fi

if ! [[ "$TAP_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "homebrew-ghcr-upload.sh: invalid tap repository: $TAP_REPOSITORY" >&2
  exit 2
fi
if ! [[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "homebrew-ghcr-upload.sh: invalid formula name: $FORMULA" >&2
  exit 2
fi
if ! [[ "$TAP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-ghcr-upload.sh: invalid tap commit: $TAP_COMMIT" >&2
  exit 2
fi
if ! [[ "$KANDELO_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "homebrew-ghcr-upload.sh: invalid Kandelo commit: $KANDELO_COMMIT" >&2
  exit 2
fi
case "$ARCH" in
  wasm32|wasm64) ;;
  *) echo "homebrew-ghcr-upload.sh: invalid arch: $ARCH" >&2; exit 2 ;;
esac
if [ ! -f "$BOTTLE" ]; then
  echo "homebrew-ghcr-upload.sh: bottle file not found: $BOTTLE" >&2
  exit 2
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

OWNER="${TAP_REPOSITORY%%/*}"
REPO="${TAP_REPOSITORY#*/}"
OWNER_LOWER="$(lower "$OWNER")"
REPO_LOWER="$(lower "$REPO")"
BOTTLE_SHA="$(sha256_file "$BOTTLE")"
BOTTLE_BYTES="$(wc -c <"$BOTTLE" | tr -d '[:space:]')"
BOTTLE_DIR="$(cd "$(dirname "$BOTTLE")" && pwd)"
BOTTLE_BASENAME="$(basename "$BOTTLE")"
SHA_PREFIX="${BOTTLE_SHA:0:12}"
IMAGE_REPOSITORY="ghcr.io/${OWNER_LOWER}/${REPO_LOWER}/${FORMULA}"
IMAGE_TAG="${RELEASE_TAG}-${ARCH}-${SHA_PREFIX}"
BOTTLE_URL="https://ghcr.io/v2/${OWNER_LOWER}/${REPO_LOWER}/${FORMULA}/blobs/sha256:${BOTTLE_SHA}"

if [ "$DRY_RUN" != "1" ]; then
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "homebrew-ghcr-upload.sh: GH_TOKEN is required for GHCR upload" >&2
    exit 2
  fi
  if ! command -v oras >/dev/null 2>&1; then
    echo "homebrew-ghcr-upload.sh: oras is required in PATH" >&2
    exit 2
  fi
  auth_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  ORAS_AUTH_DIR="$(mktemp -d "$auth_parent/kandelo-homebrew-oras.XXXXXX")"
  chmod 700 "$ORAS_AUTH_DIR"
  oras_config="$ORAS_AUTH_DIR/config.json"
  printf '%s\n' "$GH_TOKEN" |
    oras login ghcr.io \
      --registry-config "$oras_config" \
      -u "${GITHUB_ACTOR:-github-actions}" \
      --password-stdin >/dev/null
  (
    cd "$BOTTLE_DIR"
    oras push \
      --registry-config "$oras_config" \
      "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
      "${BOTTLE_BASENAME}:application/vnd.homebrew.bottle.layer.v1+gzip" \
      --annotation "org.opencontainers.image.source=https://github.com/${TAP_REPOSITORY}" \
      --annotation "org.opencontainers.image.revision=${TAP_COMMIT}" \
      --annotation "dev.kandelo.homebrew.kandelo_commit=${KANDELO_COMMIT}" \
      --annotation "dev.kandelo.homebrew.formula=${FORMULA}" \
      --annotation "dev.kandelo.homebrew.arch=${ARCH}" \
      --annotation "dev.kandelo.homebrew.release_tag=${RELEASE_TAG}"
  )
else
  echo "homebrew-ghcr-upload.sh: dry-run, not pushing ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
fi

if [ -n "$OUT_ENV" ]; then
  mkdir -p "$(dirname "$OUT_ENV")"
  {
    printf 'BOTTLE_URL=%q\n' "$BOTTLE_URL"
    printf 'BOTTLE_SHA256=%q\n' "$BOTTLE_SHA"
    printf 'BOTTLE_BYTES=%q\n' "$BOTTLE_BYTES"
    printf 'BOTTLE_IMAGE=%q\n' "${IMAGE_REPOSITORY}:${IMAGE_TAG}"
  } >"$OUT_ENV"
fi
if [ -n "$OUT_JSON" ]; then
  mkdir -p "$(dirname "$OUT_JSON")"
  jq -n \
    --arg formula "$FORMULA" \
    --arg arch "$ARCH" \
    --arg release_tag "$RELEASE_TAG" \
    --arg tap_commit "$TAP_COMMIT" \
    --arg kandelo_commit "$KANDELO_COMMIT" \
    --arg url "$BOTTLE_URL" \
    --arg sha256 "$BOTTLE_SHA" \
    --arg bytes "$BOTTLE_BYTES" \
    --arg image "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
    '{
      schema: 1,
      formula: $formula,
      arch: $arch,
      release_tag: $release_tag,
      tap_commit: $tap_commit,
      kandelo_commit: $kandelo_commit,
      bottle: {
        url: $url,
        sha256: $sha256,
        bytes: ($bytes | tonumber),
        image: $image
      }
    }' >"$OUT_JSON"
fi

echo "homebrew-ghcr-upload.sh: $BOTTLE_URL"
