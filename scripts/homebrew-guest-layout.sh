#!/usr/bin/env bash

# Select the still-active guest layout or the reviewed prefix-campaign target.
#
# Callers pass no digest for the active layout. The target layout is available
# only when the caller supplies the exact SHA-256 recorded by the campaign
# manifest. This helper selects bytes; workflow authorization remains the
# responsibility of the protected publisher lane.
homebrew_select_guest_layout() {
  local campaign_sha256="${1:-}"
  local helper_root contract actual_sha256 contract_values

  HOMEBREW_GUEST_LAYOUT_MODE="current"
  HOMEBREW_GUEST_PREFIX="/home/linuxbrew/.linuxbrew"
  HOMEBREW_GUEST_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
  HOMEBREW_GUEST_LAYOUT_SHA256=""

  [ -n "$campaign_sha256" ] || return 0
  [[ "$campaign_sha256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "homebrew guest layout: invalid prefix-campaign layout SHA-256" >&2
    return 2
  }

  helper_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || return 2
  contract="$helper_root/homebrew/kandelo-guest-layout.json"
  [ -f "$contract" ] && [ ! -L "$contract" ] || {
    echo "homebrew guest layout: target contract is not a regular file" >&2
    return 2
  }
  [ "$(wc -c <"$contract")" -le 65536 ] || {
    echo "homebrew guest layout: target contract exceeds 65536 bytes" >&2
    return 2
  }
  actual_sha256="$(sha256sum "$contract" | awk '{print $1}')" || return 2
  [ "$actual_sha256" = "$campaign_sha256" ] || {
    echo "homebrew guest layout: target contract differs from campaign authority" >&2
    return 2
  }

  contract_values="$(
    jq -er '
      def normalized:
        type == "string" and
        startswith("/") and
        (startswith("//") | not) and
        (endswith("/") | not) and
        (contains("\\") | not) and
        (test("(^|/)\\.\\.?(/|$)") | not) and
        (contains("//") | not);
      select(
        type == "object" and
        keys == [
          "cellar", "kind", "prefix", "repository",
          "retired_prefixes", "schema", "stable_entrypoint"
        ] and
        .schema == 1 and
        .kind == "kandelo-homebrew-guest-layout" and
        (.prefix | normalized) and
        (.cellar | normalized) and
        (.repository | normalized) and
        (.stable_entrypoint | normalized) and
        .repository == .prefix and
        .cellar == (.prefix + "/Cellar") and
        .stable_entrypoint == "/usr/bin/brew" and
        .prefix != "/home/linuxbrew/.linuxbrew" and
        .prefix as $prefix |
        (.retired_prefixes | type == "array" and length > 0 and
          all(.[]; normalized) and
          (index("/home/linuxbrew/.linuxbrew") != null) and
          (unique | length) == length) and
        (.retired_prefixes | index($prefix) == null)
      )
      | [.prefix, .cellar] | @tsv
    ' "$contract"
  )" || {
    echo "homebrew guest layout: target contract is invalid" >&2
    return 2
  }

  IFS=$'\t' read -r HOMEBREW_GUEST_PREFIX HOMEBREW_GUEST_CELLAR \
    <<<"$contract_values"
  [ -n "$HOMEBREW_GUEST_PREFIX" ] && [ -n "$HOMEBREW_GUEST_CELLAR" ] || {
    echo "homebrew guest layout: target contract has empty paths" >&2
    return 2
  }
  HOMEBREW_GUEST_LAYOUT_MODE="prefix-campaign"
  HOMEBREW_GUEST_LAYOUT_SHA256="$campaign_sha256"
}
