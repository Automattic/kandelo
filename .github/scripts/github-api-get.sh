#!/usr/bin/env bash
# Source-only helper for GET requests whose 404 result has different semantics
# from authentication, rate-limit, transport, and server failures.

github_api_get_json() {
  local endpoint="$1"
  local output="$2"
  local context="${GITHUB_API_CONTEXT:-github-api-get}"
  local delay="${GITHUB_API_RETRY_DELAY_SECONDS:-2}"
  local attempt=1
  local response errors status

  if ! [[ "$delay" =~ ^[0-9]+$ ]]; then
    echo "$context: GITHUB_API_RETRY_DELAY_SECONDS must be non-negative" >&2
    return 2
  fi

  response="$(mktemp)"
  errors="$(mktemp)"
  while true; do
    : > "$response"
    : > "$errors"
    if gh api --include "$endpoint" > "$response" 2> "$errors"; then
      status=$(sed -nE '1s#^HTTP/[0-9.]+ ([0-9]{3}).*#\1#p' "$response")
      if [ "$status" != 200 ]; then
        echo "$context: successful GET $endpoint returned malformed HTTP status ${status:-unset}" >&2
        rm -f "$response" "$errors"
        return 1
      fi
      awk 'body { print } /^\r?$/ { body = 1 }' "$response" > "$output"
      rm -f "$response" "$errors"
      return 0
    fi

    status=$(sed -nE '1s#^HTTP/[0-9.]+ ([0-9]{3}).*#\1#p' "$response")
    if [ "$status" = 404 ]; then
      rm -f "$response" "$errors"
      return 44
    fi
    if [ "$attempt" -ge 4 ]; then
      cat "$errors" >&2
      echo "$context: GET $endpoint failed without a confirmed 404 (HTTP ${status:-unknown})" >&2
      rm -f "$response" "$errors"
      return 1
    fi
    cat "$errors" >&2
    echo "$context: GET $endpoint failed; retrying in ${delay}s (HTTP ${status:-unknown})" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}
