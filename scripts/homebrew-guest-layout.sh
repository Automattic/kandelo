#!/usr/bin/env bash

# Select the canonical guest layout and, when requested, bind it to the
# immutable prefix-campaign authority.
#
# WHY: the completed cutover makes the committed contract authoritative for
# ordinary publications, but existing prefix-v1 handoffs still carry its exact
# digest. Keep validating that digest instead of weakening already-sealed
# campaign identities after the path becomes the default.
homebrew_select_guest_layout() {
  local campaign_sha256="${1:-}"
  local helper_root contract actual_sha256 contract_values

  HOMEBREW_GUEST_LAYOUT_MODE="canonical"
  HOMEBREW_GUEST_PREFIX=""
  HOMEBREW_GUEST_CELLAR=""
  HOMEBREW_GUEST_LAYOUT_SHA256=""
  HOMEBREW_GUEST_PATCH_FILE=""

  if [ -n "$campaign_sha256" ] &&
    ! [[ "$campaign_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "homebrew guest layout: invalid prefix-campaign layout SHA-256" >&2
    return 2
  fi

  helper_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || return 2
  # WHY: the layout mode and its Homebrew patch are one authority decision.
  # Returning both keeps bottle building and bottle verification from growing
  # separate mode maps that can drift when the canonical layout changes.
  HOMEBREW_GUEST_PATCH_FILE="$helper_root/homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch"
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
  if [ -n "$campaign_sha256" ] &&
    [ "$actual_sha256" != "$campaign_sha256" ]; then
    echo "homebrew guest layout: target contract differs from campaign authority" >&2
    return 2
  fi

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
        .prefix == "/opt/kandelo/homebrew" and
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
  if [ -n "$campaign_sha256" ]; then
    HOMEBREW_GUEST_LAYOUT_MODE="prefix-campaign"
    HOMEBREW_GUEST_LAYOUT_SHA256="$campaign_sha256"
    HOMEBREW_GUEST_PATCH_FILE="$helper_root/homebrew/patches/0001-add-kandelo-wasm-bottle-tags-prefix-campaign.patch"
  fi
}
