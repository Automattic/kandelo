#!/usr/bin/env bash
# Shared signed-API admission and receipt audit for native Homebrew tools.

homebrew_native_contract_fail() {
  echo "${HOMEBREW_NATIVE_CONTRACT_COMPONENT:-homebrew-native-contract}: $*" >&2
  return 2
}

homebrew_native_contract_stage_marker() {
  if [ "$#" -ne 2 ] ||
     ! [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
     ! [[ "$2" =~ ^(starting|completed)$ ]]; then
    homebrew_native_contract_fail "invalid publisher-stage marker"
    return
  fi
  local stage="$1" state="$2" component
  component="${HOMEBREW_NATIVE_CONTRACT_COMPONENT:-homebrew-native-contract}"
  if ! [[ "$component" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]]; then
    component=homebrew-native-contract
  fi
  # WHY: this helper only prints markers. Calling a stateful shell function
  # through `if` or `||` would suppress errexit inside that function; direct
  # calls between these markers preserve both failure semantics and state.
  printf '%s: %s %s stage\n' "$component" "$state" "$stage" >&2
}

homebrew_native_contract_diagnostic_tool() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || return
  ruby "$script_dir/homebrew-native-command-diagnostic.rb" "$@"
}

homebrew_native_contract_report_command_failure() {
  if [ "$#" -ne 3 ]; then
    homebrew_native_contract_fail \
      "report_command_failure expects STAGE STATUS LOG"
    return
  fi
  local stage="$1" status="$2" log="$3" component
  component="${HOMEBREW_NATIVE_CONTRACT_COMPONENT:-homebrew-native-contract}"
  if ! [[ "$component" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]]; then
    component=homebrew-native-contract
  fi
  printf '%s: native Homebrew %s failed with status %s; bounded diagnostic follows\n' \
    "$component" "$stage" "$status" >&2
  if [ "$log" = - ]; then
    # This explicit sentinel never reaches the path-reading diagnostic tool.
    printf '| diagnostic unavailable: log is not a private regular file\n' >&2
  elif homebrew_native_contract_diagnostic_tool render "$log" >&2; then
    :
  else
    # WHY: the command's status is the failure authority. A missing or replaced
    # log must not hide that status, and following an unsafe path could disclose
    # unrelated runner data while GitHub workflow commands are disabled.
    printf '| diagnostic unavailable: log is not a private regular file\n' >&2
  fi
}

homebrew_native_contract_run_logged() {
  if [ "$#" -lt 5 ]; then
    homebrew_native_contract_fail \
      "run_logged expects STAGE CONTROL LOG OUTPUT COMMAND..."
    return
  fi
  local stage="$1" control="$2" aggregate_log="$3" output="$4"
  shift 4
  local diagnostic_log command_status capture_status append_status=0
  local restore_errexit=0
  local -a pipeline_status

  [[ "$stage" =~ ^[a-z0-9][a-z0-9+@._-]{0,126}$ ]] &&
    [ -d "$control" ] && [ ! -L "$control" ] || {
    homebrew_native_contract_fail "native command diagnostic inputs are invalid"
    return
  }
  if [ "$output" != - ]; then
    [ -f "$output" ] && [ ! -L "$output" ] || {
      homebrew_native_contract_fail \
        "native command output is not a regular control file"
      return
    }
  fi
  HOMEBREW_NATIVE_DIAGNOSTIC_SEQUENCE="${HOMEBREW_NATIVE_DIAGNOSTIC_SEQUENCE:-0}"
  [[ "$HOMEBREW_NATIVE_DIAGNOSTIC_SEQUENCE" =~ ^[0-9]{1,4}$ ]] || {
    homebrew_native_contract_fail "native command diagnostic sequence is invalid"
    return
  }
  HOMEBREW_NATIVE_DIAGNOSTIC_SEQUENCE=$((
    10#$HOMEBREW_NATIVE_DIAGNOSTIC_SEQUENCE + 1
  ))
  diagnostic_log="$control/native-command-${HOMEBREW_NATIVE_DIAGNOSTIC_SEQUENCE}.log"

  # WHY: the command may emit an unbounded or terminal-active upstream error.
  # Let the capture process atomically create and retain its no-follow file
  # descriptor. Reopening the path with shell `>` would create a symlink race.
  # PIPESTATUS keeps the native command's result separate from capture.
  case "$-" in
    *e*) restore_errexit=1; set +e ;;
  esac
  if [ "$output" = - ]; then
    "$@" 2>&1 |
      homebrew_native_contract_diagnostic_tool capture "$diagnostic_log"
    pipeline_status=("${PIPESTATUS[@]}")
  else
    { "$@" >"$output"; } 2>&1 |
      homebrew_native_contract_diagnostic_tool capture "$diagnostic_log"
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  [ "$restore_errexit" -eq 0 ] || set -e
  command_status="${pipeline_status[0]:-2}"
  capture_status="${pipeline_status[1]:-2}"

  if [ "$capture_status" -eq 0 ]; then
    if homebrew_native_contract_diagnostic_tool append \
      "$diagnostic_log" "$aggregate_log" >/dev/null 2>&1; then
      :
    else
      append_status="$?"
    fi
  fi
  if [ "$command_status" -ne 0 ]; then
    if [ "$capture_status" -eq 0 ]; then
      homebrew_native_contract_report_command_failure \
        "$stage" "$command_status" "$diagnostic_log"
    else
      # WHY: a pre-existing or unsafe path cannot be evidence for this command.
      # Do not append or render stale bytes; retain the native command's status.
      homebrew_native_contract_report_command_failure \
        "$stage" "$command_status" -
    fi
    return "$command_status"
  fi
  if [ "$capture_status" -ne 0 ] || [ "$append_status" -ne 0 ]; then
    homebrew_native_contract_fail \
      "could not retain the native command diagnostic safely"
    return
  fi
  return 0
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
    "homebrew/core/$1" || return
  # Native tools are executed from their sealed Cellar/opt roots. Remove only
  # their global prefix links after installation so reviewed roots with an
  # overlapping command (Binaryen and WABT both ship wasm2c) can coexist.
  # `brew unlink` preserves the opt link that the publisher projects into the
  # target Formula environment.
  run_native_brew_logged unlink "homebrew/core/$1"
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
  local overlay_attestation
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
  # WHY: a Formula may need no native host tools. A bare `return` here would
  # preserve the failed `-s` test's status and silently reject that valid empty
  # closure before the target Formula can run.
  [ -s "$roots" ] || return 0
  overlay_attestation="${HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION:-}"
  [ -f "$overlay_attestation" ] && [ ! -L "$overlay_attestation" ] || {
    homebrew_native_contract_fail \
      "sealed native Homebrew identity is unavailable"
    return
  }

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
  homebrew_native_contract_run_logged \
    signed-api-dependency-resolution "$control" "$log" "$raw" \
    homebrew_patched_launcher_run_native deps --union --include-implicit \
      --full-name --formula "${formula_refs[@]}" || return
  LC_ALL=C sort -u "$roots" "$raw" >"$closure"
  homebrew_native_contract_validate_names \
    "$closure" "native dependency closure" || return
  staged_closure="$(
    homebrew_patched_launcher_stage_native_contract_file \
      "$closure" native-closure.txt 65536
  )"

  # WHY: this oracle runs through the same systemd-isolated Homebrew realm as
  # the installs. Homebrew therefore owns aliases, implicit host requirements,
  # Linux variations, and selected bottle semantics; Kandelo only admits its
  # exact result against reviewed records from the signed API.
  homebrew_native_contract_run_logged \
    signed-api-admission "$control" "$log" - \
    homebrew_patched_launcher_run_native ruby "$oracle" \
      admit "$brew_commit" "$overlay_attestation" "$policy" "$purpose" \
      "$staged_roots" \
      "$staged_closure" "$prime" "$lock" \
      "$native_temp/native-api-admission.json" || return

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
    homebrew_native_contract_run_logged \
      "installed-cellar-audit-$install_index" "$control" "$log" - \
      homebrew_patched_launcher_run_native ruby "$oracle" \
        audit-cellar "$brew_commit" "$overlay_attestation" "$prime" \
        "$staged_closure" "$staged_cumulative_roots" \
        "$native_temp/native-cellar-${install_index}.json" || return
  done
}

homebrew_native_contract_verify_no_missing_dependencies() {
  if [ "$#" -ne 1 ]; then
    homebrew_native_contract_fail \
      "verify_no_missing_dependencies expects ROOTS"
    return
  fi
  local roots="$1"
  [ -f "$roots" ] && [ ! -L "$roots" ] || {
    homebrew_native_contract_fail \
      "native dependency roots are unavailable"
    return
  }

  # WHY: `brew missing` exits unsuccessfully when its isolated prefix has no
  # Formulae at all. An empty reviewed root set is already a complete native
  # closure, so invoking Brew here would turn that valid state into a false
  # build failure. Non-empty closures still receive Brew's normal audit.
  [ -s "$roots" ] || return 0
  if run_native_brew_logged missing; then
    return 0
  fi
  echo "${HOMEBREW_NATIVE_CONTRACT_COMPONENT:-homebrew-native-contract}:" \
    "native Homebrew reports missing dependencies" >&2
  return 1
}
