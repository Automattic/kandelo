#!/usr/bin/env bash
# Download selected package artifacts from the current workflow run.
#
# The output layout is always:
#
#   <output-dir>/<artifact-name>/*.tar.zst
#
# That shape is the contract consumed by scripts/materialize-pr-overlays.sh.
# Use exact-list mode when downstream packages need to wait for named
# dependencies that may still be building. Use pattern mode when all producer
# jobs are already workflow dependencies and we need a bulk package-artifact
# download with stable layout.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  download-dependency-artifacts.sh <artifact-list-file> <output-dir>
  download-dependency-artifacts.sh --list <artifact-list-file> --output <output-dir>
  download-dependency-artifacts.sh --pattern <artifact-glob> --output <output-dir>

Environment:
  DEPENDENCY_ARTIFACT_ATTEMPTS       attempts for exact-list mode (default: 120)
  DEPENDENCY_ARTIFACT_POLL_SECONDS   delay for exact-list mode (default: 30)
  ARTIFACT_ATTEMPTS                  attempts for pattern mode (default: 4)
  ARTIFACT_POLL_SECONDS              base delay for pattern mode (default: 10)
EOF
}

MODE=""
ARTIFACT_FILE=""
ARTIFACT_PATTERN=""
ARCHIVE_ROOT=""
ALLOW_MISSING_COMPLETED=""

if [ "$#" -eq 2 ] && [ "${1#--}" = "$1" ]; then
  MODE="list"
  ARTIFACT_FILE="$1"
  ARCHIVE_ROOT="$2"
  ALLOW_MISSING_COMPLETED="true"
else
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --list)
        [ "$#" -ge 2 ] || { usage; exit 2; }
        MODE="list"
        ARTIFACT_FILE="$2"
        shift 2
        ;;
      --pattern)
        [ "$#" -ge 2 ] || { usage; exit 2; }
        MODE="pattern"
        ARTIFACT_PATTERN="$2"
        shift 2
        ;;
      --output|--path)
        [ "$#" -ge 2 ] || { usage; exit 2; }
        ARCHIVE_ROOT="$2"
        shift 2
        ;;
      --allow-missing-completed)
        ALLOW_MISSING_COMPLETED="true"
        shift
        ;;
      --no-allow-missing-completed)
        ALLOW_MISSING_COMPLETED="false"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage
        exit 2
        ;;
    esac
  done
fi

case "$MODE" in
  list)
    [ -n "$ARTIFACT_FILE" ] || { usage; exit 2; }
    if [ ! -f "$ARTIFACT_FILE" ]; then
      echo "download-dependency-artifacts: artifact list not found: $ARTIFACT_FILE" >&2
      exit 2
    fi
    [ -n "$ALLOW_MISSING_COMPLETED" ] || ALLOW_MISSING_COMPLETED="true"
    ATTEMPTS="${DEPENDENCY_ARTIFACT_ATTEMPTS:-${ARTIFACT_ATTEMPTS:-120}}"
    POLL_SECONDS="${DEPENDENCY_ARTIFACT_POLL_SECONDS:-${ARTIFACT_POLL_SECONDS:-30}}"
    CHECK_AVAILABILITY="true"
    ;;
  pattern)
    [ -n "$ARTIFACT_PATTERN" ] || { usage; exit 2; }
    [ -n "$ALLOW_MISSING_COMPLETED" ] || ALLOW_MISSING_COMPLETED="false"
    ATTEMPTS="${ARTIFACT_ATTEMPTS:-${DEPENDENCY_ARTIFACT_ATTEMPTS:-4}}"
    POLL_SECONDS="${ARTIFACT_POLL_SECONDS:-${DEPENDENCY_ARTIFACT_POLL_SECONDS:-10}}"
    CHECK_AVAILABILITY="false"
    ;;
  *)
    usage
    exit 2
    ;;
esac

[ -n "$ARCHIVE_ROOT" ] || { usage; exit 2; }
if [ "$ARCHIVE_ROOT" = "/" ]; then
  echo "::error::refusing to download artifacts to unsafe path: '$ARCHIVE_ROOT'" >&2
  exit 2
fi

if ! [[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "download-dependency-artifacts: attempts must be positive, got $ATTEMPTS" >&2
  exit 2
fi
if ! [[ "$POLL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "download-dependency-artifacts: poll seconds must be non-negative, got $POLL_SECONDS" >&2
  exit 2
fi

mkdir -p "$ARCHIVE_ROOT"
SELECTED_ARTIFACTS="$(mktemp)"
trap 'rm -f "$SELECTED_ARTIFACTS"' EXIT

artifact_package() {
  local artifact="$1"
  printf '%s\n' "${artifact%-wasm32}" | sed 's/-wasm64$//'
}

artifact_arch() {
  local artifact="$1"
  case "$artifact" in
    *-wasm32) printf 'wasm32\n' ;;
    *-wasm64) printf 'wasm64\n' ;;
    *) return 1 ;;
  esac
}

refresh_artifacts() {
  local out="$1"
  gh api "/repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}/actions/runs/${GITHUB_RUN_ID:?GITHUB_RUN_ID required}/artifacts" \
    --paginate \
    --jq '.artifacts[].name' >"$out"
}

dependency_job_status() {
  local artifact="$1"
  local pkg arch needle

  arch="$(artifact_arch "$artifact")" || return 1
  pkg="$(artifact_package "$artifact")"
  needle="(${arch}, ${pkg},"

  gh api "/repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}/actions/runs/${GITHUB_RUN_ID:?GITHUB_RUN_ID required}/jobs" \
    --paginate \
    --jq '.jobs[] | [.name, .status] | @tsv' \
    | awk -F '\t' -v needle="$needle" 'index($1, needle) > 0 { print $2; exit }'
}

retry_delay() {
  local attempt="$1"
  if [ "$MODE" = "pattern" ]; then
    printf '%s\n' $((POLL_SECONDS * attempt))
  else
    printf '%s\n' "$POLL_SECONDS"
  fi
}

select_pattern_artifacts() {
  local attempt available_file delay

  for attempt in $(seq 1 "$ATTEMPTS"); do
    available_file="$(mktemp)"
    if refresh_artifacts "$available_file"; then
      : > "$SELECTED_ARTIFACTS"
      while IFS= read -r artifact; do
        case "$artifact" in
          $ARTIFACT_PATTERN) printf '%s\n' "$artifact" ;;
        esac
      done < "$available_file" | sort -u > "$SELECTED_ARTIFACTS"
      rm -f "$available_file"

      if [ -s "$SELECTED_ARTIFACTS" ]; then
        return 0
      fi

      if [ "$attempt" -eq "$ATTEMPTS" ]; then
        echo "::error::no workflow artifacts matched pattern '$ARTIFACT_PATTERN' after $ATTEMPTS attempts" >&2
        return 1
      fi

      delay="$(retry_delay "$attempt")"
      echo "no workflow artifacts matched pattern '$ARTIFACT_PATTERN'; retrying in ${delay}s (attempt $attempt/$ATTEMPTS)"
      sleep "$delay"
      continue
    fi

    rm -f "$available_file"
    if [ "$attempt" -eq "$ATTEMPTS" ]; then
      echo "::error::could not list workflow artifacts after $ATTEMPTS attempts" >&2
      return 1
    fi

    delay="$(retry_delay "$attempt")"
    echo "::warning::could not list workflow artifacts; retrying in ${delay}s (attempt $attempt/$ATTEMPTS)"
    sleep "$delay"
  done
}

prepare_selected_artifacts() {
  if [ "$MODE" = "list" ]; then
    sed '/^[[:space:]]*$/d' "$ARTIFACT_FILE" | sort -u > "$SELECTED_ARTIFACTS"
  else
    select_pattern_artifacts
  fi
}

validate_artifact_name() {
  local artifact="$1"
  if ! [[ "$artifact" =~ ^[A-Za-z0-9._-]+-wasm(32|64)$ ]]; then
    echo "::error::invalid package artifact name: '$artifact'" >&2
    exit 1
  fi
}

download_artifact() {
  local artifact="$1"
  local artifact_dir attempt available_file status delay

  artifact_dir="$ARCHIVE_ROOT/$artifact"
  if find "$artifact_dir" -maxdepth 1 -name '*.tar.zst' -print -quit 2>/dev/null | grep -q .; then
    echo "dependency artifact $artifact already downloaded"
    return 0
  fi

  for attempt in $(seq 1 "$ATTEMPTS"); do
    if [ "$CHECK_AVAILABILITY" = "true" ]; then
      available_file="$(mktemp)"
      if refresh_artifacts "$available_file"; then
        if ! grep -Fxq "$artifact" "$available_file"; then
          rm -f "$available_file"
          if [ "$ALLOW_MISSING_COMPLETED" = "true" ]; then
            status="$(dependency_job_status "$artifact" 2>/dev/null || true)"
            if [ "$status" = "completed" ]; then
              echo "::warning::dependency artifact $artifact is absent and its matrix job is completed; continuing without overlay"
              return 0
            fi
            if [ -z "$status" ]; then
              echo "::warning::dependency artifact $artifact is absent and no matching matrix job was found; continuing without overlay"
              return 0
            fi
          fi
          if [ "$attempt" -eq "$ATTEMPTS" ]; then
            echo "::error::dependency artifact $artifact was not available after $ATTEMPTS attempts" >&2
            return 1
          fi
          delay="$(retry_delay "$attempt")"
          echo "dependency artifact $artifact is not available yet; retrying in ${delay}s (attempt $attempt/$ATTEMPTS)"
          sleep "$delay"
          continue
        fi
        rm -f "$available_file"
      else
        rm -f "$available_file"
        echo "::warning::could not list workflow artifacts; trying direct download for $artifact"
      fi
    fi

    mkdir -p "$artifact_dir"
    if gh run download "$GITHUB_RUN_ID" \
      --repo "$GITHUB_REPOSITORY" \
      --name "$artifact" \
      --dir "$artifact_dir"; then
      if ! find "$artifact_dir" -maxdepth 1 -name '*.tar.zst' -print -quit 2>/dev/null | grep -q .; then
        echo "::error::downloaded package artifact $artifact, but no .tar.zst was extracted under $artifact_dir" >&2
        return 1
      fi
      echo "downloaded dependency artifact $artifact"
      return 0
    fi

    if [ "$attempt" -eq "$ATTEMPTS" ]; then
      echo "::error::dependency artifact $artifact was not downloadable after $ATTEMPTS attempts" >&2
      return 1
    fi
    delay="$(retry_delay "$attempt")"
    echo "dependency artifact $artifact download failed; retrying in ${delay}s (attempt $attempt/$ATTEMPTS)"
    sleep "$delay"
  done
}

prepare_selected_artifacts

while IFS= read -r artifact; do
  [ -n "$artifact" ] || continue
  validate_artifact_name "$artifact"
done < "$SELECTED_ARTIFACTS"

if [ ! -s "$SELECTED_ARTIFACTS" ]; then
  echo "dependency artifacts to download: none"
  exit 0
fi

while IFS= read -r artifact; do
  [ -n "$artifact" ] || continue
  download_artifact "$artifact"
done < "$SELECTED_ARTIFACTS"
