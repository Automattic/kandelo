#!/usr/bin/env bash
# Shared signed-API admission and receipt audit for native Homebrew tools.

homebrew_native_contract_fail() {
  echo "${HOMEBREW_NATIVE_CONTRACT_COMPONENT:-homebrew-native-contract}: $*" >&2
  return 2
}

homebrew_native_contract_select_api_source() {
  if [ "$#" -ne 4 ]; then
    homebrew_native_contract_fail \
      "select_api_source expects COMPONENT BUILD-USER PLAN ROOTS"
    return
  fi
  local component="$1" build_user="$2" plan="$3" roots="$4"
  local mode_file
  HOMEBREW_NATIVE_CONTRACT_COMPONENT="$component"
  HOMEBREW_NATIVE_CONTRACT_ENABLED=0

  if [ -z "$build_user" ]; then
    return
  fi
  if [ "${GITHUB_ACTIONS:-}" != "true" ] &&
     [ -z "${KANDELO_HOMEBREW_EARLY_HOST_PLAN:-}" ] &&
     [ -z "${KANDELO_HOMEBREW_EARLY_HOST_ROOTS:-}" ] &&
     [ -z "${KANDELO_HOMEBREW_NATIVE_API_CACHE:-}" ] &&
     [ -z "${KANDELO_HOMEBREW_NATIVE_API_STATE:-}" ] &&
     [ -z "${KANDELO_HOMEBREW_NATIVE_API_SOURCE:-}" ]; then
    # Local isolated fixtures do not have a workflow-owned network preflight.
    # GitHub Actions can never take this development-only compatibility path.
    return
  fi
  HOMEBREW_NATIVE_CONTRACT_ENABLED=1

  [ -f "${KANDELO_HOMEBREW_EARLY_HOST_PLAN:-}" ] &&
    [ ! -L "$KANDELO_HOMEBREW_EARLY_HOST_PLAN" ] &&
    [ -f "${KANDELO_HOMEBREW_EARLY_HOST_ROOTS:-}" ] &&
    [ ! -L "$KANDELO_HOMEBREW_EARLY_HOST_ROOTS" ] &&
    cmp -s "$plan" "$KANDELO_HOMEBREW_EARLY_HOST_PLAN" &&
    cmp -s "$roots" "$KANDELO_HOMEBREW_EARLY_HOST_ROOTS" || {
    homebrew_native_contract_fail \
      "native host plan changed after signed-API preflight"
    return
  }
  [ -d "${KANDELO_HOMEBREW_NATIVE_API_STATE:-}" ] &&
    [ ! -L "$KANDELO_HOMEBREW_NATIVE_API_STATE" ] || {
    homebrew_native_contract_fail "signed native API state is unavailable"
    return
  }
  mode_file="$KANDELO_HOMEBREW_NATIVE_API_STATE/mode"
  [ -f "$mode_file" ] && [ ! -L "$mode_file" ] || {
    homebrew_native_contract_fail "signed native API mode is unavailable"
    return
  }

  if [ -s "$roots" ]; then
    [ "$(cat "$mode_file")" = "populated" ] &&
      [ -d "${KANDELO_HOMEBREW_NATIVE_API_SOURCE:-}" ] &&
      [ ! -L "$KANDELO_HOMEBREW_NATIVE_API_SOURCE" ] &&
      [ "$KANDELO_HOMEBREW_NATIVE_API_SOURCE" = \
        "${KANDELO_HOMEBREW_NATIVE_API_CACHE:-}/api" ] &&
      [ -f "$KANDELO_HOMEBREW_NATIVE_API_STATE/prime.json" ] &&
      [ ! -L "$KANDELO_HOMEBREW_NATIVE_API_STATE/prime.json" ] || {
      homebrew_native_contract_fail \
        "signed native API preflight is unavailable"
      return
    }
    homebrew_patched_launcher_set_native_api_source \
      "$KANDELO_HOMEBREW_NATIVE_API_SOURCE"
  else
    [ "$(cat "$mode_file")" = "empty" ] &&
      [ -z "${KANDELO_HOMEBREW_NATIVE_API_SOURCE:-}" ] || {
      homebrew_native_contract_fail \
        "zero-root job received populated native API state"
      return
    }
  fi
}

homebrew_native_contract_validate_names() {
  if [ "$#" -ne 2 ]; then
    homebrew_native_contract_fail "validate_names expects PATH LABEL"
    return
  fi
  local path="$1" label="$2" bytes
  bytes="$(wc -c <"$path" | tr -d '[:space:]')" || return
  [ "$bytes" -le 65536 ] &&
    awk '
      NF && $0 !~ /^[a-z0-9][a-z0-9+@._-]{0,254}$/ { exit 1 }
      NF { count++; print }
      END { if (count > 256) exit 1 }
    ' "$path" >/dev/null &&
    cmp -s "$path" <(LC_ALL=C sort -u "$path") || {
    homebrew_native_contract_fail "$label is not a bounded canonical name set"
    return
  }
}

homebrew_native_contract_install_root() {
  if [ "$#" -ne 1 ]; then
    homebrew_native_contract_fail "install_root expects one Formula name"
    return
  fi
  run_native_brew_logged install --as-dependency --formula \
    "homebrew/core/$1"
}

homebrew_native_contract_install() {
  if [ "$#" -ne 7 ]; then
    homebrew_native_contract_fail \
      "install expects ROOTS CONTROL LOG TEMP COMMIT KANDELO-ROOT PURPOSE"
    return
  fi
  local roots="$1" control="$2" log="$3" native_temp="$4"
  local brew_commit="$5" kandelo_root="$6" purpose="$7"
  local raw="$control/native-dependencies.raw"
  local closure="$control/native-closure.txt"
  local cumulative_roots="$control/native-cumulative-roots.txt"
  local oracle policy staged_roots prime lock staged_closure
  local dependency staged_cumulative_roots install_index=0
  local -a formula_refs native_dependencies

  mapfile -t native_dependencies <"$roots"
  if [ "${HOMEBREW_NATIVE_CONTRACT_ENABLED:-0}" != "1" ]; then
    for dependency in "${native_dependencies[@]}"; do
      homebrew_native_contract_install_root "$dependency"
    done
    return
  fi
  [[ "$brew_commit" =~ ^[0-9a-f]{40}$ ]] || {
    homebrew_native_contract_fail \
      "enabled native contract requires an exact lowercase Homebrew commit"
    return
  }
  [ -s "$roots" ] || return

  : >"$raw"
  : >"$closure"
  : >"$cumulative_roots"
  chmod 0600 "$raw" "$closure" "$cumulative_roots"
  oracle="$(
    homebrew_patched_launcher_stage_native_contract_file \
      "$kandelo_root/scripts/homebrew-native-api-contract.rb" \
      native-api-contract.rb 1048576
  )"
  policy="$(
    homebrew_patched_launcher_stage_native_contract_file \
      "$kandelo_root/homebrew/homebrew-native-compatibility-roots.json" \
      native-api-roots.json 65536
  )"
  staged_roots="$(
    homebrew_patched_launcher_stage_native_contract_file \
      "$roots" native-direct-roots.txt 65536
  )"
  prime="$(
    homebrew_patched_launcher_stage_native_contract_file \
      "$KANDELO_HOMEBREW_NATIVE_API_STATE/prime.json" \
      native-api-prime.json 65536
  )"
  lock="$(
    homebrew_patched_launcher_stage_native_contract_file \
      "$kandelo_root/homebrew/homebrew-native-compatibility-lock.json" \
      native-api-lock.json 16777216
  )"

  for dependency in "${native_dependencies[@]}"; do
    formula_refs+=("homebrew/core/$dependency")
  done
  homebrew_patched_launcher_run_native deps --union --include-implicit \
    --full-name --formula "${formula_refs[@]}" \
    >"$raw" 2>>"$log"
  LC_ALL=C sort -u "$roots" "$raw" >"$closure"
  homebrew_native_contract_validate_names \
    "$closure" "native dependency closure" || return
  staged_closure="$(
    homebrew_patched_launcher_stage_native_contract_file \
      "$closure" native-closure.txt 65536
  )"

  # WHY: this oracle runs through the same systemd-isolated cf5 realm as the
  # installs. Homebrew therefore owns aliases, implicit host requirements,
  # Linux variations, and selected bottle semantics; Kandelo only admits its
  # exact result against reviewed records from the signed API.
  homebrew_patched_launcher_run_native ruby "$oracle" \
    admit "$brew_commit" "$policy" "$purpose" "$staged_roots" \
    "$staged_closure" "$prime" "$lock" \
    "$native_temp/native-api-admission.json" >>"$log" 2>&1

  for dependency in "${native_dependencies[@]}"; do
    install_index=$((install_index + 1))
    homebrew_native_contract_install_root "$dependency"
    printf '%s\n' "$dependency" >>"$cumulative_roots"
    staged_cumulative_roots="$(
      homebrew_patched_launcher_stage_native_contract_file \
        "$cumulative_roots" "native-roots-${install_index}.txt" 65536
    )"
    # WHY: Homebrew may satisfy an implicit host requirement without pouring
    # every possible dependency. Audit what it actually installed after each
    # root: every keg must be admitted, every requested root must exist, and
    # every receipt must identify a signed homebrew/core bottle.
    homebrew_patched_launcher_run_native ruby "$oracle" \
      audit-cellar "$brew_commit" "$prime" "$staged_closure" \
      "$staged_cumulative_roots" \
      "$native_temp/native-cellar-${install_index}.json" >>"$log" 2>&1
  done
}
