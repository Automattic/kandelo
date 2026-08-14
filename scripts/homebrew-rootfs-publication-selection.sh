#!/usr/bin/env bash
# Classify Formula build authority for the exact-main wasm32 recovery lane.
set -euo pipefail
umask 077

KANDELO_ROOT=""
TAP_ROOT=""
TAP_NAME=""
RESOLVED_TAPS=""
FORMULAE=""
ARCHES=""
REQUIRE_VFS_ACCEPTANCE=""
RUBY_BIN=""

# WHY: a registry bridge executes one authenticated main-owned build helper
# until that helper moves into the tap. Admit each temporary Formula-to-helper
# mapping explicitly; the selected Formula remains the sole source and version
# authority.
readonly ROOTFS_WASM32_ALLOWED_BRIDGES=(
  "modeset:modeset"
  "nethack:nethack"
)

fail() {
  echo "::error::homebrew-rootfs-publication-selection: $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kandelo-root)
      [ "$#" -ge 2 ] || fail "--kandelo-root requires a value"
      KANDELO_ROOT="$2"
      shift 2
      ;;
    --tap-root)
      [ "$#" -ge 2 ] || fail "--tap-root requires a value"
      TAP_ROOT="$2"
      shift 2
      ;;
    --tap-name)
      [ "$#" -ge 2 ] || fail "--tap-name requires a value"
      TAP_NAME="$2"
      shift 2
      ;;
    --resolved-taps)
      [ "$#" -ge 2 ] || fail "--resolved-taps requires a value"
      RESOLVED_TAPS="$2"
      shift 2
      ;;
    --formulae)
      [ "$#" -ge 2 ] || fail "--formulae requires a value"
      FORMULAE="$2"
      shift 2
      ;;
    --arches)
      [ "$#" -ge 2 ] || fail "--arches requires a value"
      ARCHES="$2"
      shift 2
      ;;
    --require-vfs-acceptance)
      [ "$#" -ge 2 ] || fail "--require-vfs-acceptance requires a value"
      REQUIRE_VFS_ACCEPTANCE="$2"
      shift 2
      ;;
    --ruby-bin)
      [ "$#" -ge 2 ] || fail "--ruby-bin requires a value"
      RUBY_BIN="$2"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

normalize_selection() {
  printf '%s\n' "$1" |
    tr ',[:space:]' '\n' |
    sed '/^$/d' |
    sort -u |
    paste -sd, -
}

canonical_directory() {
  local path="$1" label="$2" canonical
  [ -n "$path" ] && [ -d "$path" ] && [ ! -L "$path" ] ||
    fail "$label must be a real directory"
  canonical="$(realpath -- "$path")" ||
    fail "$label cannot be resolved"
  [ -d "$canonical" ] && [ ! -L "$canonical" ] ||
    fail "$label resolved to an unsafe directory"
  printf '%s\n' "$canonical"
}

canonical_regular_file() {
  local path="$1" label="$2" canonical
  [ -n "$path" ] && [ -f "$path" ] && [ ! -L "$path" ] ||
    fail "$label must be a regular non-symlink file"
  canonical="$(realpath -- "$path")" ||
    fail "$label cannot be resolved"
  [ -f "$canonical" ] && [ ! -L "$canonical" ] ||
    fail "$label resolved to an unsafe file"
  printf '%s\n' "$canonical"
}

canonical_executable() {
  local path="$1" label="$2" canonical owner mode
  [ -n "$path" ] && [ -f "$path" ] && [ ! -L "$path" ] && [ -x "$path" ] ||
    fail "$label must be a regular non-symlink executable"
  canonical="$(realpath -- "$path")" ||
    fail "$label cannot be resolved"
  [ -f "$canonical" ] && [ ! -L "$canonical" ] && [ -x "$canonical" ] ||
    fail "$label resolved to an unsafe executable"
  case "$canonical" in
    /nix/store/*/bin/ruby) ;;
    *) fail "$label must come from the immutable Nix store" ;;
  esac
  if stat -c '%u %a' "$canonical" >/dev/null 2>&1; then
    read -r owner mode < <(stat -c '%u %a' "$canonical")
  else
    owner="$(stat -f '%u' "$canonical")"
    mode="$(stat -f '%Lp' "$canonical")"
  fi
  [ "$owner" = "0" ] && [[ "$mode" =~ ^[0-7]{3,4}$ ]] &&
    [ $((8#$mode & 0022)) -eq 0 ] ||
    fail "$label must be root-owned and not group- or world-writable"
  printf '%s\n' "$canonical"
}

normalized_formulae="$(normalize_selection "$FORMULAE")"
normalized_arches="$(normalize_selection "$ARCHES")"
normalized_tap_name="$(printf '%s' "$TAP_NAME" | tr '[:upper:]' '[:lower:]')"

[ -n "$normalized_formulae" ] ||
  fail "the rootfs-wasm32 publication lane requires at least one Formula"
[ "$normalized_arches" = "wasm32" ] ||
  fail "the rootfs-wasm32 publication lane supports exactly wasm32"
[[ "$normalized_tap_name" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] ||
  fail "the rootfs-wasm32 publication lane requires a canonical tap name"

# WHY: this generation predates dependency-bearing VFS acceptance inputs. A
# successful bottle build is valid, but claiming that newer acceptance graph
# from these older package inputs would manufacture evidence they do not carry.
[ "$REQUIRE_VFS_ACCEPTANCE" = "false" ] ||
  fail "the rootfs-wasm32 publication lane cannot materialize dependency-bearing VFS acceptance"

KANDELO_ROOT="$(canonical_directory "$KANDELO_ROOT" "Kandelo root")"
TAP_ROOT="$(canonical_directory "$TAP_ROOT" "tap root")"
RESOLVED_TAPS="$(canonical_regular_file "$RESOLVED_TAPS" "resolved tap map")"
if [ "$normalized_formulae" = "all" ]; then
  normalized_formulae="$(
    find "$TAP_ROOT/Formula" -maxdepth 1 -type f -name '*.rb' -print |
      sed -E 's|.*/([^/]+)\.rb$|\1|' |
      sort |
      paste -sd, -
  )"
  [ -n "$normalized_formulae" ] ||
    fail "the rootfs-wasm32 publication lane found no Formulae"
fi
resolver="$KANDELO_ROOT/scripts/homebrew-formula-runtime-closure.rb"
resolver="$(canonical_regular_file "$resolver" "Formula authority parser")"
host_plan_validator="$KANDELO_ROOT/scripts/homebrew-validate-host-dependency-plan.sh"
host_plan_validator="$(
  canonical_regular_file "$host_plan_validator" "host dependency plan validator"
)"
native_roots_policy="$KANDELO_ROOT/homebrew/homebrew-native-compatibility-roots.json"
native_roots_policy="$(
  canonical_regular_file "$native_roots_policy" "native host-tool policy"
)"
RUBY_BIN="$(canonical_executable "$RUBY_BIN" "pinned Formula authority Ruby")"

tmp_root="$(mktemp -d)"
trap 'rm -rf -- "$tmp_root"' EXIT
records="$tmp_root/records.jsonl"
allowed_host_roots="$tmp_root/allowed-host-roots.txt"
missing_host_roots="$tmp_root/missing-host-roots.txt"
: >"$records"
: >"$missing_host_roots"

if ! jq -er '
    select(
      type == "object" and
      keys == ["architecture", "homebrew_commit", "kind", "roots", "schema"] and
      .schema == 1 and
      .kind == "kandelo-homebrew-native-roots" and
      .architecture == "x86_64_linux" and
      (.homebrew_commit |
        type == "string" and test("^[0-9a-f]{40}$")) and
      (.roots | keys == ["tap_formula_host_dependencies"]) and
      (.roots.tap_formula_host_dependencies |
        type == "array" and length > 0 and length <= 128 and
        . == (sort | unique) and
        all(.[];
          type == "string" and test("^[a-z0-9][a-z0-9@+_.-]*$")))
    ) |
    .roots.tap_formula_host_dependencies[]
  ' "$native_roots_policy" >"$allowed_host_roots"; then
  fail "native host-tool policy has an invalid or unexpected schema"
fi

bridge_allowed() {
  local formula="$1" package="$2" mapping
  for mapping in "${ROOTFS_WASM32_ALLOWED_BRIDGES[@]}"; do
    [ "$mapping" = "$formula:$package" ] && return 0
  done
  return 1
}

IFS=, read -r -a selected_formulae <<<"$normalized_formulae"
[ "${#selected_formulae[@]}" -le 256 ] ||
  fail "the rootfs-wasm32 publication lane accepts at most 256 Formulae"
formula_index=0
for formula in "${selected_formulae[@]}"; do
  formula_index=$((formula_index + 1))
  [[ "$formula" =~ ^[a-z0-9][a-z0-9._-]{0,254}$ ]] ||
    fail "invalid Formula name: $formula"
  plan="$tmp_root/formula-$formula_index-authority.json"
  if ! KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
      "$RUBY_BIN" "$resolver" \
        "$TAP_ROOT" "$normalized_tap_name" "$formula" \
        --tier2-bridge-json >"$plan"; then
    fail "could not classify Formula authority: $formula"
  fi
  [ "$(wc -c <"$plan" | tr -d '[:space:]')" -le 65536 ] ||
    fail "Formula authority plan exceeds 65536 bytes: $formula"
  jq -e --arg formula "$formula" --arg tap "$normalized_tap_name" '
    def canonical_env_keys:
      type == "array" and length <= 64 and
      ((map(length) | add) // 0) <= 4096 and
      . == (sort | unique) and
      all(.[]; type == "string" and test("^[A-Z][A-Z0-9_]{0,254}$"));
    def canonical_source:
      (.source_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.source_url | type == "string" and
        test("^https://[A-Za-z0-9][A-Za-z0-9._~:/?#\\[\\]@!$&'\''()*+,;=%-]{0,2039}$")) and
      (.version | type == "string" and
        test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,254}$"));
    def canonical_bridge:
      type == "object" and
      keys == ["package", "script_env_keys", "source_sha256", "source_url", "version"] and
      (.package | type == "string" and
        test("^[a-z0-9][a-z0-9._-]{0,254}$")) and
      (.script_env_keys | canonical_env_keys) and canonical_source;
    def canonical_recipe:
      type == "object" and
      keys == [
        "declared_dependencies", "manifest_sha256", "pkg_version",
        "resources", "script_env_keys", "source_sha256", "source_url",
        "version"
      ] and
      (.declared_dependencies |
        type == "array" and length <= 128 and . == (sort | unique) and
        all(.[];
          type == "string" and
          test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[a-z0-9][a-z0-9._-]{0,254}$"))) and
      (.manifest_sha256 |
        type == "string" and test("^[0-9a-f]{64}$")) and
      (.resources |
        type == "array" and length <= 32 and
        (map(.name) == (map(.name) | sort | unique)) and
        all(.[];
          type == "object" and
          keys == ["name", "source_sha256", "source_url"] and
          (.name | type == "string" and
            test("^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")) and
          (.source_sha256 |
            type == "string" and test("^[0-9a-f]{64}$")) and
          (.source_url | type == "string" and
            test("^https://[A-Za-z0-9][A-Za-z0-9._~:/?#\\[\\]@!$&'\''()*+,;=%-]{0,1015}$")))) and
      (.pkg_version | type == "string" and
        test("^[A-Za-z0-9][A-Za-z0-9._+,-]{0,254}$")) and
      (.version as $version |
        .pkg_version == $version or
        (.pkg_version |
          startswith($version + "_") and
          (ltrimstr($version + "_") | test("^[1-9][0-9]*$")))) and
      (.script_env_keys | canonical_env_keys) and canonical_source;
    type == "object" and
    .formula == $formula and .tap == $tap and
    .full_name == ($tap + "/" + $formula) and
    (.formula_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.support_sha256 == null or
      (.support_sha256 | type == "string" and test("^[0-9a-f]{64}$"))) and
    (.support_runtime_sha256 == null or
      (.support_runtime_sha256 | type == "string" and test("^[0-9a-f]{64}$"))) and
    ((.support_sha256 == null) == (.support_runtime_sha256 == null)) and
    (
      (.schema == 4 and
       keys == [
         "formula", "formula_sha256", "full_name", "schema",
         "support_runtime_sha256", "support_sha256", "tap", "tier2_bridge"
       ] and
       (
         .tier2_bridge == null or
         (
           .support_sha256 != null and
           .support_runtime_sha256 != null and
           (.tier2_bridge | canonical_bridge)
         )
       )) or
      (.schema == 3 and
       keys == [
         "formula", "formula_sha256", "full_name", "schema",
         "support_runtime_sha256", "support_sha256", "tap", "tap_recipe",
         "tier2_bridge"
       ] and
       .tier2_bridge == null and
       .support_sha256 != null and
       .support_runtime_sha256 != null and
       (.tap_recipe | canonical_recipe))
    )
  ' "$plan" >/dev/null ||
    fail "Formula authority plan has an invalid or unexpected schema: $formula"

  host_plan="$tmp_root/formula-$formula_index-host.json"
  if ! KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS" \
      "$RUBY_BIN" "$resolver" \
        "$TAP_ROOT" "$normalized_tap_name" "$formula" \
        --host-dependencies-json >"$host_plan"; then
    fail "could not classify native host tools: $formula"
  fi
  [ "$(wc -c <"$host_plan" | tr -d '[:space:]')" -le 65536 ] ||
    fail "native host-tool plan exceeds 65536 bytes: $formula"
  if ! bash "$host_plan_validator" \
      "$host_plan" "$normalized_tap_name" "$formula" "$RESOLVED_TAPS"; then
    fail "native host-tool plan has an invalid or unexpected schema: $formula"
  fi
  # WHY: the signed native API can install only roots admitted by this exact
  # Kandelo commit. Check every Formula selected to build in this publisher
  # run so a missing host tool stops the run before any bottle build starts.
  comm -23 \
    <(jq -r '.build_and_test[]' "$host_plan") \
    "$allowed_host_roots" >>"$missing_host_roots"

  authority_class=""
  tap_recipe_manifest="null"
  tier2_package="null"
  tier2_version="null"
  if jq -e '
      .schema == 3 and .tier2_bridge == null and
      (.tap_recipe | type == "object") and
      (.tap_recipe.manifest_sha256 | type == "string" and
        test("^[0-9a-f]{64}$"))
    ' "$plan" >/dev/null; then
    authority_class="tap-recipe"
    tap_recipe_manifest="$(jq -c '.tap_recipe.manifest_sha256' "$plan")"
  elif jq -e '
      .schema == 4 and
      (has("tap_recipe") | not) and
      .tier2_bridge == null
    ' "$plan" >/dev/null; then
    authority_class="direct"
  elif jq -e '
      .schema == 4 and
      (has("tap_recipe") | not) and
      (.tier2_bridge | type == "object") and
      (.tier2_bridge.package | type == "string") and
      (.tier2_bridge.version | type == "string")
    ' "$plan" >/dev/null; then
    authority_class="registry-bridge"
    package="$(jq -er '.tier2_bridge.package' "$plan")"
    version="$(jq -er '.tier2_bridge.version' "$plan")"
    bridge_allowed "$formula" "$package" ||
      fail "registry bridge is not admitted by the rootfs-wasm32 lane: $formula=$package"
    tier2_package="$(jq -cn --arg value "$package" '$value')"
    tier2_version="$(jq -cn --arg value "$version" '$value')"
  else
    fail "Formula authority plan has an unsupported or ambiguous schema: $formula"
  fi

  jq -cS -n \
    --arg formula "$formula" \
    --arg authority_class "$authority_class" \
    --arg formula_sha256 "$(jq -er '.formula_sha256' "$plan")" \
    --argjson support_sha256 "$(jq -c '.support_sha256' "$plan")" \
    --argjson support_runtime_sha256 "$(jq -c '.support_runtime_sha256' "$plan")" \
    --argjson tap_recipe_manifest_sha256 "$tap_recipe_manifest" \
    --argjson tier2_package "$tier2_package" \
    --argjson tier2_version "$tier2_version" '{
      formula: $formula,
      authority_class: $authority_class,
      formula_sha256: $formula_sha256,
      support_sha256: $support_sha256,
      support_runtime_sha256: $support_runtime_sha256,
      tap_recipe_manifest_sha256: $tap_recipe_manifest_sha256,
      tier2_package: $tier2_package,
      tier2_version: $tier2_version
    }' >>"$records"
done

if [ -s "$missing_host_roots" ]; then
  LC_ALL=C sort -u -o "$missing_host_roots" "$missing_host_roots"
  fail "native host-tool policy omits selected Formula requirements: $(
    paste -sd, "$missing_host_roots"
  )"
fi

result="$tmp_root/selection.json"
jq -cSs 'sort_by(.formula)' "$records" >"$result"
[ "$(wc -l <"$result" | tr -d '[:space:]')" = 1 ] ||
  fail "rootfs Formula authority selection must be one compact JSON line"
# WHY: the complete selection is carried through both a GitHub job output and
# one Linux environment entry. Stay below the tighter per-entry transport
# boundary instead of relying on GitHub's larger aggregate output allowance.
[ "$(wc -c <"$result" | tr -d '[:space:]')" -le 65536 ] ||
  fail "rootfs Formula authority selection exceeds the 65536-byte workflow transport limit"
cat "$result"
