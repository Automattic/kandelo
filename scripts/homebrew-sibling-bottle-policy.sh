#!/usr/bin/env bash
# Decide whether a refreshed Formula may retain the other Kandelo architecture.

homebrew_assert_published_abi_not_newer() {
  local metadata="$1" planned_abi="$2"
  local caller="${3:-homebrew-sibling-bottle-policy}" published_abi

  if [ ! -e "$metadata" ]; then
    return 0
  fi
  if [ ! -f "$metadata" ] || [ -L "$metadata" ]; then
    echo "$caller: tap metadata is not a regular file" >&2
    return 1
  fi
  if ! [[ "$planned_abi" =~ ^[1-9][0-9]*$ ]] || [ "$planned_abi" -gt 4294967295 ]; then
    echo "$caller: planned Kandelo ABI is invalid" >&2
    return 1
  fi
  if ! published_abi="$(jq -er \
    '.kandelo_abi | select(type == "number" and floor == . and . >= 1 and . <= 4294967295)' \
    "$metadata")"; then
    echo "$caller: tap metadata has an invalid Kandelo ABI" >&2
    return 1
  fi
  if [ "$published_abi" -gt "$planned_abi" ]; then
    echo "$caller: refusing stale ABI $planned_abi publication after ABI $published_abi" >&2
    return 1
  fi
}

homebrew_assert_published_bottle_not_newer() {
  local metadata="$1" name="$2" version="$3" formula_revision="$4"
  local rebuild="$5" abi="$6" caller="${7:-homebrew-sibling-bottle-policy}"
  local published_rebuild

  if [ ! -e "$metadata" ]; then
    return 0
  fi
  if [ ! -f "$metadata" ] || [ -L "$metadata" ]; then
    echo "$caller: tap metadata is not a regular file" >&2
    return 1
  fi
  if ! [[ "$name" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
     ! [[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$ ]] ||
     ! [[ "$formula_revision" =~ ^(0|[1-9][0-9]*)$ ]] ||
     ! [[ "$rebuild" =~ ^(0|[1-9][0-9]*)$ ]] ||
     ! [[ "$abi" =~ ^[1-9][0-9]*$ ]] || [ "$abi" -gt 4294967295 ]; then
    echo "$caller: invalid bottle identity for monotonic publication" >&2
    return 1
  fi

  if ! published_rebuild="$(jq -er \
    --arg name "$name" \
    --arg version "$version" \
    --argjson formula_revision "$formula_revision" \
    --argjson abi "$abi" '
      if type != "object" or (.packages | type) != "array" then
        error("tap metadata lacks a packages array")
      else
        [.packages[] | select(.name == $name)] as $matches |
        if ($matches | length) > 1 then
          error("tap metadata contains duplicate package identities")
        elif .kandelo_abi == $abi and ($matches | length) == 1 and
             $matches[0].version == $version and
             $matches[0].formula_revision == $formula_revision then
          ($matches[0].bottle_rebuild |
            select(type == "number" and floor == . and . >= 0))
        else
          -1
        end
      end
    ' "$metadata")"; then
    echo "$caller: tap metadata cannot determine monotonic bottle identity" >&2
    return 1
  fi
  if [ "$published_rebuild" -gt "$rebuild" ]; then
    echo "$caller: refusing stale $name bottle rebuild $rebuild after rebuild $published_rebuild" >&2
    return 1
  fi
}

homebrew_sibling_bottle_policy() {
  local metadata="$1" name="$2" version="$3" formula_revision="$4"
  local rebuild="$5" abi="$6" expected_root="$7" formula_path="$8"
  local caller="${9:-homebrew-sibling-bottle-policy}" formula_roots policy

  if [ ! -e "$metadata" ]; then
    printf '%s\n' discard
    return 0
  fi
  if [ ! -f "$metadata" ] || [ -L "$metadata" ]; then
    echo "$caller: tap metadata is not a regular file" >&2
    return 1
  fi
  if ! [[ "$name" =~ ^[a-z0-9][a-z0-9._-]*$ ]] ||
     ! [[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$ ]] ||
     ! [[ "$formula_revision" =~ ^(0|[1-9][0-9]*)$ ]] ||
     ! [[ "$rebuild" =~ ^(0|[1-9][0-9]*)$ ]] ||
     ! [[ "$abi" =~ ^(0|[1-9][0-9]*)$ ]] ||
     ! [[ "$expected_root" =~ ^https://ghcr\.io/v2/[a-z0-9._-]+/[a-z0-9._/-]+$ ]] ||
     [[ "$expected_root" == */ ]]; then
    echo "$caller: invalid bottle identity for sibling preservation" >&2
    return 1
  fi
  if [ ! -f "$formula_path" ] || [ -L "$formula_path" ]; then
    echo "$caller: current Formula is not a regular file" >&2
    return 1
  fi
  formula_roots="$(sed -nE 's/^    root_url "([^"]+)"$/\1/p' "$formula_path")"
  if [[ "$formula_roots" == *$'\n'* ]]; then
    echo "$caller: current Formula has multiple bottle roots" >&2
    return 1
  fi
  if [ -z "$formula_roots" ] || [ "$formula_roots" != "$expected_root" ]; then
    printf '%s\n' discard
    return 0
  fi

  if ! policy="$(jq -er \
    --arg name "$name" \
    --arg version "$version" \
    --argjson formula_revision "$formula_revision" \
    --argjson rebuild "$rebuild" \
    --argjson abi "$abi" '
      if type != "object" or (.packages | type) != "array" then
        error("tap metadata lacks a packages array")
      else
        [.packages[] | select(.name == $name)] as $matches |
        if ($matches | length) > 1 then
          error("tap metadata contains duplicate package identities")
        elif .kandelo_abi == $abi and ($matches | length) == 1 and
             $matches[0].version == $version and
             $matches[0].formula_revision == $formula_revision and
             $matches[0].bottle_rebuild == $rebuild then
          "preserve"
        else
          "discard"
        end
      end
    ' "$metadata")"; then
    echo "$caller: tap metadata cannot determine the sibling bottle policy" >&2
    return 1
  fi
  printf '%s\n' "$policy"
}
