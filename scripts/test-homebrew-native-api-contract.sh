#!/usr/bin/env bash
# Adversarial fixtures for the signed native Homebrew API contract.
set -euo pipefail

# WHY: this process owns user-written fixture caches, not a production
# publisher cache. CI's inherited marker must not make ordinary fixtures
# pretend to be root-owned; the dedicated adversarial case below restores the
# marker and proves that production cannot use the fixture-owner exception.
unset GITHUB_ACTIONS

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
ORACLE="$SCRIPT_DIR/homebrew-native-api-contract.rb"
PREFLIGHT="$SCRIPT_DIR/homebrew-native-api-preflight.sh"
SOURCE_CHECK="$SCRIPT_DIR/homebrew-native-check-brew-source.sh"
BOUNDED_ENV="$SCRIPT_DIR/homebrew-native-bounded-environment.sh"
TMP_ROOT="$(mktemp -d)"
cleanup() {
  chmod -R u+rwX "$TMP_ROOT" 2>/dev/null || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "test-homebrew-native-api-contract: $*" >&2
  exit 1
}

expect_failure() {
  local label="$1" message="$2" stderr="$TMP_ROOT/failure.err"
  shift 2
  if "$@" >"$TMP_ROOT/failure.out" 2>"$stderr"; then
    fail "$label unexpectedly succeeded"
  fi
  grep -F "$message" "$stderr" >/dev/null ||
    fail "$label did not explain its rejection: $(cat "$stderr")"
}

STUB_ROOT="$TMP_ROOT/ruby-stubs"
mkdir -p "$STUB_ROOT/api/formula" "$STUB_ROOT/api" "$STUB_ROOT/utils"

cat >"$STUB_ROOT/api.rb" <<'RUBY'
require "json"
require "pathname"

HOMEBREW_REPOSITORY = Pathname(
  ENV.fetch("KANDELO_TEST_BREW_REPOSITORY")
) unless defined?(HOMEBREW_REPOSITORY)
HOMEBREW_CELLAR = Pathname(ENV.fetch("KANDELO_TEST_CELLAR"))

module Homebrew
  module API
    HOMEBREW_CACHE_API = Pathname(ENV.fetch("KANDELO_TEST_API_ROOT"))

    def self.fetch_api_files!
      true
    end
  end
end
RUBY

cat >"$STUB_ROOT/api/formula.rb" <<'RUBY'
require "api"

module Homebrew
  module API
    module Formula
      def self.all_formulae
        JSON.parse(
          File.read(HOMEBREW_CACHE_API/"formula.jws.json")
        ).fetch("formulae")
      end

      def self.write_names_and_aliases(regenerate:)
        raise "regeneration was not requested" unless regenerate
      end
    end
  end
end
RUBY

cat >"$STUB_ROOT/api/internal.rb" <<'RUBY'
require "api"

module Homebrew
  module API
    module Internal
      def self.document
        JSON.parse(
          File.read(
            HOMEBREW_CACHE_API/"internal/packages.x86_64_linux.jws.json"
          )
        )
      end

      def self.formula_hashes
        document.fetch("formulae")
      end

      def self.formula_tap_git_head
        document.fetch("tap_git_head")
      end

      def self.write_formula_names_and_aliases(regenerate:)
        raise "regeneration was not requested" unless regenerate
      end
    end
  end
end
RUBY

cat >"$STUB_ROOT/api/formula/formula_struct_generator.rb" <<'RUBY'
require "api/formula"

module Homebrew
  module API
    module Formula
      module FormulaStructGenerator
        Projection = Struct.new(:record) do
          def serialize(bottle_tag:)
            raise "bottle tag is absent" if bottle_tag.nil?
            projection = JSON.parse(JSON.generate(record))
            # Homebrew's FormulaStruct projection does not carry the rolling
            # source-feed head or the source tap inside each Formula record.
            projection.delete("tap_git_head")
            projection.delete("tap")
            projection
          end
        end

        def self.generate_formula_struct_hash(record, bottle_tag:)
          raise "bottle tag is absent" if bottle_tag.nil?
          Projection.new(record)
        end
      end
    end
  end
end
RUBY

cat >"$STUB_ROOT/utils/bottles.rb" <<'RUBY'
module Utils
  module Bottles
    module Tag
      def self.from_symbol(value)
        value
      end
    end
  end
end
RUBY

cat >"$STUB_ROOT/env_config.rb" <<'RUBY'
require "pathname"

HOMEBREW_REPOSITORY = Pathname(ENV.fetch("KANDELO_TEST_BREW_REPOSITORY")) unless
  defined?(HOMEBREW_REPOSITORY)

module Homebrew
  module EnvConfig
    def self.git_path
      "git"
    end
  end
end
RUBY

cat >"$STUB_ROOT/utils/popen.rb" <<'RUBY'
module Utils
  def self.popen_read(*_arguments)
    "#{ENV.fetch("KANDELO_TEST_BREW_COMMIT")}\n"
  end
end
RUBY

cat >"$STUB_ROOT/simulate_system.rb" <<'RUBY'
module Homebrew
  module SimulateSystem
    def self.with(os:, arch:)
      raise "wrong simulated OS" unless os == :linux
      raise "wrong simulated architecture" unless arch == :intel
      yield
    end
  end
end
RUBY

COMMIT="1111111111111111111111111111111111111111"
CORE_HEAD="2222222222222222222222222222222222222222"
OTHER_HEAD="3333333333333333333333333333333333333333"
ADVANCED_HEAD="4444444444444444444444444444444444444444"
BREW_REPOSITORY="$TMP_ROOT/oracle-brew"
CELLAR="$TMP_ROOT/cellar"
mkdir -p "$BREW_REPOSITORY" "$CELLAR"

create_api() {
  local root="$1" public_head="$2" internal_head="$3"
  local public_selected="$4" public_unused="$5"
  local internal_selected="$6" internal_unused="$7" prefix="$8"
  mkdir -p "$root/internal"
  ruby -rjson - "$root" "$public_head" "$internal_head" \
    "$public_selected" "$public_unused" \
    "$internal_selected" "$internal_unused" "$prefix" <<'RUBY'
root, public_head, internal_head, public_selected, public_unused,
  internal_selected, internal_unused, prefix = ARGV
formulae = {
  "dep" => {
    "tap" => "homebrew/core",
    "tap_git_head" => public_head,
    "versions" => { "stable" => "1.0" },
    "caveats" => "installed under #{prefix}",
    "service_args" => ["#{prefix}/bin/dep"],
  },
  "root" => {
    "tap" => "homebrew/core",
    "tap_git_head" => public_head,
    "versions" => { "stable" => public_selected },
    "caveats" => "root is under #{prefix}",
    "service_run_args" => ["#{prefix}/bin/root"],
  },
  "unused" => {
    "tap" => "homebrew/core",
    "tap_git_head" => public_head,
    "versions" => { "stable" => public_unused },
  },
}
internal = {
  "tap_git_head" => internal_head,
  "formulae" => {
    "dep" => {
      "bottle" => "dep-bottle",
      "install" => [{ "type" => "link", "path" => "bin/dep" }],
    },
    "root" => {
      "bottle" => "root-bottle",
      "install" => [{ "type" => "run", "command" => internal_selected }],
    },
    "unused" => {
      "bottle" => "unused-bottle",
      "install" => [{ "type" => "run", "command" => internal_unused }],
    },
  },
}
File.write(File.join(root, "formula.jws.json"),
           "#{JSON.generate({ "formulae" => formulae })}\n")
File.write(File.join(root, "formula_aliases.txt"), "")
File.write(File.join(root, "formula_names.txt"), "dep\nroot\nunused\n")
File.write(File.join(root, "internal", "executables.txt"), "")
File.write(
  File.join(root, "internal", "packages.x86_64_linux.jws.json"),
  "#{JSON.generate(internal)}\n"
)
RUBY
}

oracle() {
  # The production contract deliberately ignores the fixture-owner exception
  # in GitHub Actions. This test process is not a publisher realm, so remove
  # the inherited CI marker explicitly instead of weakening the oracle.
  env -u GITHUB_ACTIONS \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$KANDELO_TEST_API_ROOT" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" "$@"
}

prime_and_seal() {
  local api_root="$1" prime="$2"
  KANDELO_TEST_API_ROOT="$api_root" oracle prime "$COMMIT" "$prime"
  find "$api_root" -type d -exec chmod 0555 {} +
  find "$api_root" -type f -exec chmod 0444 {} +
  KANDELO_TEST_API_ROOT="$api_root" oracle recheck "$COMMIT" "$prime"
}

POLICY="$TMP_ROOT/policy.json"
ROOTS="$TMP_ROOT/roots.txt"
CLOSURE="$TMP_ROOT/closure.txt"
printf 'root\n' >"$ROOTS"
printf 'dep\nroot\n' >"$CLOSURE"
ruby -rjson - "$POLICY" "$COMMIT" <<'RUBY'
path, commit = ARGV
File.write(path, "#{JSON.pretty_generate({
  "schema" => 1,
  "kind" => "kandelo-homebrew-native-roots",
  "architecture" => "x86_64_linux",
  "homebrew_commit" => commit,
  "roots" => { "test" => ["root"] },
})}\n")
RUBY

API_A="$TMP_ROOT/api-a"
PRIME_A="$TMP_ROOT/prime-a.json"
LOCK_A="$TMP_ROOT/lock-a.json"
create_api \
  "$API_A" "$CORE_HEAD" "$CORE_HEAD" \
  public-stable public-unused-a internal-stable internal-unused-a /prefix/a
prime_and_seal "$API_A" "$PRIME_A"
expect_failure "CI test-owner exception" \
  "sealed API path is not owned by the trusted identity" \
  env \
    GITHUB_ACTIONS=true \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_A" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" recheck "$COMMIT" "$PRIME_A"
KANDELO_TEST_API_ROOT="$API_A" oracle generate-lock \
  "$COMMIT" "$POLICY" "$ROOTS" "$CLOSURE" "$PRIME_A" "$LOCK_A"
jq -e '
  keys == ["architecture", "formulae", "homebrew_commit", "kind", "schema"] and
  .formulae.root.internal.install[0].type == "run"
' "$LOCK_A" >/dev/null ||
  fail "generated lock lost its exact envelope or run install step"

ADMISSION_A="$TMP_ROOT/admission-a.json"
KANDELO_TEST_API_ROOT="$API_A" oracle admit \
  "$COMMIT" "$POLICY" test "$ROOTS" "$CLOSURE" "$PRIME_A" "$LOCK_A" \
  "$ADMISSION_A"

API_PUBLIC_UNUSED="$TMP_ROOT/api-public-unused"
PRIME_PUBLIC_UNUSED="$TMP_ROOT/prime-public-unused.json"
create_api \
  "$API_PUBLIC_UNUSED" "$CORE_HEAD" "$CORE_HEAD" \
  public-stable public-unused-b internal-stable internal-unused-a \
  /prefix/other
prime_and_seal "$API_PUBLIC_UNUSED" "$PRIME_PUBLIC_UNUSED"
KANDELO_TEST_API_ROOT="$API_PUBLIC_UNUSED" oracle admit \
  "$COMMIT" "$POLICY" test "$ROOTS" "$CLOSURE" \
  "$PRIME_PUBLIC_UNUSED" "$LOCK_A" \
  "$TMP_ROOT/admission-public-unused.json"
jq -e --arg head "$CORE_HEAD" '.source.tap_git_head == $head' \
  "$TMP_ROOT/admission-public-unused.json" >/dev/null ||
  fail "public-only unused drift did not retain current-run source evidence"

API_INTERNAL_UNUSED="$TMP_ROOT/api-internal-unused"
PRIME_INTERNAL_UNUSED="$TMP_ROOT/prime-internal-unused.json"
create_api \
  "$API_INTERNAL_UNUSED" "$CORE_HEAD" "$CORE_HEAD" \
  public-stable public-unused-a internal-stable internal-unused-b \
  /prefix/other
prime_and_seal "$API_INTERNAL_UNUSED" "$PRIME_INTERNAL_UNUSED"
KANDELO_TEST_API_ROOT="$API_INTERNAL_UNUSED" oracle admit \
  "$COMMIT" "$POLICY" test "$ROOTS" "$CLOSURE" \
  "$PRIME_INTERNAL_UNUSED" "$LOCK_A" \
  "$TMP_ROOT/admission-internal-unused.json"
jq -e --arg head "$CORE_HEAD" '.source.tap_git_head == $head' \
  "$TMP_ROOT/admission-internal-unused.json" >/dev/null ||
  fail "internal-only unused drift did not retain current-run source evidence"

API_ADVANCED="$TMP_ROOT/api-advanced-head"
PRIME_ADVANCED="$TMP_ROOT/prime-advanced-head.json"
ADMISSION_ADVANCED="$TMP_ROOT/admission-advanced-head.json"
create_api \
  "$API_ADVANCED" "$ADVANCED_HEAD" "$ADVANCED_HEAD" \
  public-stable public-unused-c internal-stable internal-unused-c \
  /prefix/advanced
prime_and_seal "$API_ADVANCED" "$PRIME_ADVANCED"
KANDELO_TEST_API_ROOT="$API_ADVANCED" oracle admit \
  "$COMMIT" "$POLICY" test "$ROOTS" "$CLOSURE" \
  "$PRIME_ADVANCED" "$LOCK_A" "$ADMISSION_ADVANCED"
jq -e --arg head "$ADVANCED_HEAD" '
  .source == {
    "tap": "homebrew/core",
    "tap_git_head": $head
  }
' "$ADMISSION_ADVANCED" >/dev/null ||
  fail "same-head unrelated drift did not record its new per-run source head"

LOCK_PREFIX="$TMP_ROOT/lock-prefix.json"
KANDELO_TEST_API_ROOT="$API_PUBLIC_UNUSED" oracle generate-lock \
  "$COMMIT" "$POLICY" "$ROOTS" "$CLOSURE" \
  "$PRIME_PUBLIC_UNUSED" "$LOCK_PREFIX"
cmp -s "$LOCK_A" "$LOCK_PREFIX" ||
  fail "prefix-expanded caveat or service presentation changed the lock"

API_PUBLIC_SELECTED="$TMP_ROOT/api-public-selected"
PRIME_PUBLIC_SELECTED="$TMP_ROOT/prime-public-selected.json"
create_api \
  "$API_PUBLIC_SELECTED" "$CORE_HEAD" "$CORE_HEAD" \
  public-changed public-unused-a internal-stable internal-unused-a /prefix/b
prime_and_seal "$API_PUBLIC_SELECTED" "$PRIME_PUBLIC_SELECTED"
expect_failure "public-only selected Formula drift" \
  "signed API changed selected Formula root" \
  env \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_PUBLIC_SELECTED" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" admit \
      "$COMMIT" "$POLICY" test "$ROOTS" "$CLOSURE" \
      "$PRIME_PUBLIC_SELECTED" "$LOCK_A" \
      "$TMP_ROOT/admission-public-selected.json"

API_INTERNAL_SELECTED="$TMP_ROOT/api-internal-selected"
PRIME_INTERNAL_SELECTED="$TMP_ROOT/prime-internal-selected.json"
create_api \
  "$API_INTERNAL_SELECTED" "$CORE_HEAD" "$CORE_HEAD" \
  public-stable public-unused-a internal-changed internal-unused-a /prefix/b
prime_and_seal "$API_INTERNAL_SELECTED" "$PRIME_INTERNAL_SELECTED"
expect_failure "internal-only selected Formula drift" \
  "signed API changed selected Formula root" \
  env \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_INTERNAL_SELECTED" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" admit \
      "$COMMIT" "$POLICY" test "$ROOTS" "$CLOSURE" \
      "$PRIME_INTERNAL_SELECTED" "$LOCK_A" \
      "$TMP_ROOT/admission-internal-selected.json"

API_MISMATCH="$TMP_ROOT/api-mismatch"
create_api \
  "$API_MISMATCH" "$CORE_HEAD" "$OTHER_HEAD" \
  public-stable public-unused-a internal-stable internal-unused-a /prefix/a
expect_failure "signed source disagreement" \
  "signed Homebrew API sources disagree on the core revision" \
  env \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_MISMATCH" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" prime \
      "$COMMIT" "$TMP_ROOT/prime-mismatch.json"

BAD_ROOTS="$TMP_ROOT/bad-roots.txt"
printf 'root\nbad/name\n' >"$BAD_ROOTS"
expect_failure "malformed native roots" "contains an invalid Formula name" \
  env \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_A" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" admit \
      "$COMMIT" "$POLICY" test "$BAD_ROOTS" "$CLOSURE" "$PRIME_A" \
      "$LOCK_A" "$TMP_ROOT/admission-bad-roots.json"

API_SYMLINK="$TMP_ROOT/api-symlink"
create_api \
  "$API_SYMLINK" "$CORE_HEAD" "$CORE_HEAD" \
  public-stable public-unused-a internal-stable internal-unused-a /prefix/a
ln -s formula_names.txt "$API_SYMLINK/alias-link"
expect_failure "API symlink" "API cache contains a non-regular file" \
  env \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_SYMLINK" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" prime \
      "$COMMIT" "$TMP_ROOT/prime-symlink.json"

chmod 0644 "$API_A/formula_aliases.txt"
printf 'changed\n' >"$API_A/formula_aliases.txt"
chmod 0444 "$API_A/formula_aliases.txt"
expect_failure "sealed API mutation" \
  "Homebrew API cache changed after verification" \
  env \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_A" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" recheck "$COMMIT" "$PRIME_A"

OCCUPIED="$TMP_ROOT/occupied-output.json"
ln -s "$TMP_ROOT/elsewhere" "$OCCUPIED"
expect_failure "occupied attestation output" "refusing to replace" \
  env \
    HOMEBREW_KANDELO_NATIVE_CONTRACT_TESTING=1 \
    KANDELO_TEST_API_ROOT="$API_PUBLIC_UNUSED" \
    KANDELO_TEST_BREW_COMMIT="$COMMIT" \
    KANDELO_TEST_BREW_REPOSITORY="$BREW_REPOSITORY" \
    KANDELO_TEST_CELLAR="$CELLAR" \
    ruby -I"$STUB_ROOT" "$ORACLE" admit \
      "$COMMIT" "$POLICY" test "$ROOTS" "$CLOSURE" \
      "$PRIME_PUBLIC_UNUSED" \
      "$LOCK_A" "$OCCUPIED"

mkdir -p "$CELLAR/root/1.0"
cat >"$CELLAR/root/1.0/INSTALL_RECEIPT.json" <<'JSON'
{
  "loaded_from_internal_api": true,
  "poured_from_bottle": true,
  "source": {
    "tap": "homebrew/core"
  }
}
JSON
KANDELO_TEST_API_ROOT="$API_PUBLIC_UNUSED" oracle audit-cellar \
  "$COMMIT" "$PRIME_PUBLIC_UNUSED" "$CLOSURE" "$ROOTS" \
  "$TMP_ROOT/cellar-attestation.json"
jq -e '.kegs | map(.name) == ["root"]' \
  "$TMP_ROOT/cellar-attestation.json" >/dev/null ||
  fail "Cellar audit did not record the admitted poured keg"

EMPTY_ROOTS="$TMP_ROOT/empty-roots.txt"
: >"$EMPTY_ROOTS"
FAKE_BREW="$TMP_ROOT/must-not-run-brew"
cat >"$FAKE_BREW" <<'EOF'
#!/usr/bin/env bash
exit 99
EOF
chmod 0755 "$FAKE_BREW"
EMPTY_CACHE="$TMP_ROOT/empty-cache"
EMPTY_STATE="$TMP_ROOT/empty-state"
bash "$PREFLIGHT" prepare \
  "$FAKE_BREW" "$EMPTY_CACHE" "$EMPTY_STATE" \
  "$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json" \
  tap_formula_host_dependencies "$EMPTY_ROOTS"
[ "$(cat "$EMPTY_STATE/mode")" = "empty" ] &&
  [ ! -e "$EMPTY_CACHE/api" ] ||
  fail "zero-root preflight fetched or invented signed API state"

NATIVE_MISSING_CALLS="$TMP_ROOT/native-missing-calls.txt"
: >"$NATIVE_MISSING_CALLS"
run_native_brew_logged() {
  printf '%s\n' "$*" >>"$NATIVE_MISSING_CALLS"
  [ "${KANDELO_TEST_NATIVE_MISSING_STATUS:-0}" -eq 0 ]
}
. "$SCRIPT_DIR/homebrew-native-install-contract.sh"
homebrew_native_contract_verify_no_missing_dependencies "$EMPTY_ROOTS"
[ ! -s "$NATIVE_MISSING_CALLS" ] ||
  fail "zero-root native closure invoked brew missing"
printf 'git\n' >"$TMP_ROOT/nonempty-native-roots.txt"
homebrew_native_contract_verify_no_missing_dependencies \
  "$TMP_ROOT/nonempty-native-roots.txt"
[ "$(cat "$NATIVE_MISSING_CALLS")" = "missing" ] ||
  fail "non-empty native closure skipped brew missing"
KANDELO_TEST_NATIVE_MISSING_STATUS=1
expect_failure "incomplete native closure" \
  "native Homebrew reports missing dependencies" \
  homebrew_native_contract_verify_no_missing_dependencies \
    "$TMP_ROOT/nonempty-native-roots.txt"
unset KANDELO_TEST_NATIVE_MISSING_STATUS
expect_failure "missing native roots file" \
  "native dependency roots are unavailable" \
  homebrew_native_contract_verify_no_missing_dependencies \
    "$TMP_ROOT/absent-native-roots.txt"

POPULATED_CACHE="$TMP_ROOT/populated-cache"
POPULATED_STATE="$TMP_ROOT/populated-state"
POPULATED_ROOTS="$TMP_ROOT/populated-roots.txt"
POPULATED_BREW="$TMP_ROOT/populated-brew"
jq -er '.roots.tap_formula_host_dependencies[0]' \
  "$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json" \
  >"$POPULATED_ROOTS"
cat >"$POPULATED_BREW" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = ruby ] && [ "$3" = prime ] || {
  [ "$1" = ruby ] && [ "$3" = recheck ]
  exit
}
mkdir -p "$HOMEBREW_CACHE/api/internal"
printf '{}\n' >"$HOMEBREW_CACHE/api/formula.jws.json"
printf '{}\n' >"$5"
EOF
chmod 0755 "$POPULATED_BREW"
bash "$PREFLIGHT" prepare \
  "$POPULATED_BREW" "$POPULATED_CACHE" "$POPULATED_STATE" \
  "$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json" \
  tap_formula_host_dependencies "$POPULATED_ROOTS"
[ "$(cat "$POPULATED_STATE/mode")" = "populated" ] &&
  [ "$(stat -c '%u:%a' "$POPULATED_CACHE")" = "$(id -u):755" ] &&
  [ -x "$POPULATED_CACHE" ] &&
  [ -w "$POPULATED_CACHE" ] ||
  fail "populated preflight did not preserve its trusted cache coordinator"

for occupied_kind in directory symlink dangling-symlink; do
  occupied_cache="$TMP_ROOT/occupied-cache-$occupied_kind"
  case "$occupied_kind" in
    directory)
      mkdir "$occupied_cache"
      ;;
    symlink)
      mkdir "$TMP_ROOT/cache-target"
      ln -s "$TMP_ROOT/cache-target" "$occupied_cache"
      ;;
    dangling-symlink)
      ln -s "$TMP_ROOT/missing-cache-target" "$occupied_cache"
      ;;
  esac
  expect_failure "$occupied_kind cache root" \
    "cache directory must not already exist" \
    bash "$PREFLIGHT" prepare \
      "$FAKE_BREW" "$occupied_cache" \
      "$TMP_ROOT/state-for-cache-$occupied_kind" \
      "$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json" \
      tap_formula_host_dependencies "$EMPTY_ROOTS"
done

for occupied_kind in directory symlink dangling-symlink; do
  occupied_state="$TMP_ROOT/occupied-state-$occupied_kind"
  case "$occupied_kind" in
    directory)
      mkdir "$occupied_state"
      ;;
    symlink)
      mkdir "$TMP_ROOT/state-target"
      ln -s "$TMP_ROOT/state-target" "$occupied_state"
      ;;
    dangling-symlink)
      ln -s "$TMP_ROOT/missing-state-target" "$occupied_state"
      ;;
  esac
  expect_failure "$occupied_kind state root" \
    "state directory must not already exist" \
    bash "$PREFLIGHT" prepare \
      "$FAKE_BREW" "$TMP_ROOT/cache-for-state-$occupied_kind" \
      "$occupied_state" \
      "$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json" \
      tap_formula_host_dependencies "$EMPTY_ROOTS"
done

BOUNDED_CACHE="$TMP_ROOT/bounded-cache"
BOUNDED_STATE="$TMP_ROOT/bounded-state"
BOUNDED_BREW="$TMP_ROOT/bounded-brew"
BOUNDED_RECORD="$TMP_ROOT/bounded-record"
mkdir -p \
  "$BOUNDED_CACHE" "$BOUNDED_STATE/home" \
  "$BOUNDED_STATE/tmp" "$BOUNDED_STATE/config"
BOUNDED_STATE_REAL="$(cd "$BOUNDED_STATE" && pwd -P)"
cat >"$BOUNDED_BREW" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
record="$1"
expected_api_mode="$2"
shift 2
case "$expected_api_mode" in
  client)
    [ -z "${HOMEBREW_NO_INSTALL_FROM_API+x}" ] || exit 91
    [ -z "${HOMEBREW_FORCE_LIBC_FORMULA+x}" ] || exit 89
    [ -z "${HOMEBREW_FORCE_COMPILER_FORMULA+x}" ] || exit 88
    [ "${HOMEBREW_RELOCATE_BUILD_PREFIX:-}" = 1 ] || exit 87
    ;;
  compatibility-lock)
    [ -z "${HOMEBREW_NO_INSTALL_FROM_API+x}" ] || exit 91
    [ "${HOMEBREW_FORCE_LIBC_FORMULA:-}" = 1 ] || exit 89
    [ "${HOMEBREW_FORCE_COMPILER_FORMULA:-}" = 1 ] || exit 88
    [ -z "${HOMEBREW_RELOCATE_BUILD_PREFIX+x}" ] || exit 87
    ;;
  oracle)
    [ "${HOMEBREW_NO_INSTALL_FROM_API:-}" = 1 ] || exit 91
    [ -z "${HOMEBREW_FORCE_LIBC_FORMULA+x}" ] || exit 89
    [ -z "${HOMEBREW_FORCE_COMPILER_FORMULA+x}" ] || exit 88
    [ -z "${HOMEBREW_RELOCATE_BUILD_PREFIX+x}" ] || exit 87
    ;;
  *) exit 90 ;;
esac
[ -z "${HOMEBREW_API_DOMAIN+x}" ] || exit 92
[ -z "${KANDELO_NATIVE_ENV_POISON+x}" ] || exit 93
[ -z "${HOMEBREW_BOTTLE_DOMAIN+x}" ] || exit 94
[ -z "${HOMEBREW_CURL_PATH+x}" ] || exit 95
[ -z "${RUBYOPT+x}" ] || exit 96
[ -z "${BUNDLE_GEMFILE+x}" ] || exit 97
[ "$HOMEBREW_GIT_PATH" = /usr/bin/git ] || exit 98
{
  printf 'home=%s\n' "$HOME"
  printf 'cache=%s\n' "$HOMEBREW_CACHE"
  printf 'temp=%s\n' "$HOMEBREW_TEMP"
  printf 'updated=%s\n' "$HOMEBREW_API_UPDATED"
  printf 'pwd=%s\n' "$PWD"
  printf 'args=%s\n' "$*"
} >"$record"
EOF
chmod 0755 "$BOUNDED_BREW"
env \
  HOMEBREW_NO_INSTALL_FROM_API=1 \
  HOMEBREW_API_DOMAIN=https://poison.invalid \
  HOMEBREW_BOTTLE_DOMAIN=https://bottles.poison.invalid \
  HOMEBREW_CURL_PATH=/bin/false \
  HOMEBREW_GIT_PATH=/bin/false \
  HOMEBREW_FORCE_LIBC_FORMULA=caller-poison \
  HOMEBREW_FORCE_COMPILER_FORMULA=caller-poison \
  HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
  RUBYOPT=-rdoes-not-exist \
  BUNDLE_GEMFILE=/does/not/exist \
  KANDELO_NATIVE_ENV_POISON=present \
  bash -c '
    set -euo pipefail
    . "$1"
    homebrew_native_bounded_run \
      "$2" "$3" "$4" api-client "$5" client \
      deps homebrew/core/root
  ' bash "$BOUNDED_ENV" "$BOUNDED_BREW" \
    "$BOUNDED_CACHE" "$BOUNDED_STATE" \
    "$BOUNDED_RECORD"
grep -Fx "home=$BOUNDED_STATE/home" "$BOUNDED_RECORD" >/dev/null &&
  grep -Fx "cache=$BOUNDED_CACHE" "$BOUNDED_RECORD" >/dev/null &&
  grep -Fx "temp=$BOUNDED_STATE/tmp" "$BOUNDED_RECORD" >/dev/null &&
  grep -Fx 'updated=1' "$BOUNDED_RECORD" >/dev/null &&
  grep -Fx "pwd=$BOUNDED_STATE_REAL/tmp" "$BOUNDED_RECORD" >/dev/null &&
  grep -Fx 'args=deps homebrew/core/root' "$BOUNDED_RECORD" >/dev/null ||
  fail "updater did not run Brew through its bounded signed-API environment"
env \
  HOMEBREW_FORCE_LIBC_FORMULA=caller-poison \
  HOMEBREW_FORCE_COMPILER_FORMULA=caller-poison \
  HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
  bash -c '
    set -euo pipefail
    . "$1"
    homebrew_native_bounded_run \
      "$2" "$3" "$4" api-compatibility-lock \
      "$5" compatibility-lock deps homebrew/core/root
  ' bash "$BOUNDED_ENV" "$BOUNDED_BREW" \
    "$BOUNDED_CACHE" "$BOUNDED_STATE" \
    "$BOUNDED_RECORD"
grep -Fx 'args=deps homebrew/core/root' "$BOUNDED_RECORD" >/dev/null ||
  fail "compatibility lock did not force its conservative host closure"
env \
  HOMEBREW_NO_INSTALL_FROM_API=caller-poison \
  HOMEBREW_API_DOMAIN=https://poison.invalid \
  HOMEBREW_BOTTLE_DOMAIN=https://bottles.poison.invalid \
  HOMEBREW_CURL_PATH=/bin/false \
  HOMEBREW_GIT_PATH=/bin/false \
  HOMEBREW_FORCE_LIBC_FORMULA=caller-poison \
  HOMEBREW_FORCE_COMPILER_FORMULA=caller-poison \
  HOMEBREW_RELOCATE_BUILD_PREFIX=caller-poison \
  RUBYOPT=-rdoes-not-exist \
  BUNDLE_GEMFILE=/does/not/exist \
  KANDELO_NATIVE_ENV_POISON=present \
  bash -c '
    set -euo pipefail
    . "$1"
    homebrew_native_bounded_run \
      "$2" "$3" "$4" api-oracle "$5" oracle ruby contract.rb
  ' bash "$BOUNDED_ENV" "$BOUNDED_BREW" \
    "$BOUNDED_CACHE" "$BOUNDED_STATE" \
    "$BOUNDED_RECORD"
grep -Fx 'args=ruby contract.rb' "$BOUNDED_RECORD" >/dev/null ||
  fail "oracle did not run Brew through its bounded signed-API environment"

PLAN="$TMP_ROOT/plan.json"
printf '{}\n' >"$PLAN"
expect_failure "CI fallback without signed API state" \
  "signed native API state is unavailable" \
  bash -c '
    set -euo pipefail
    . "$1"
    export GITHUB_ACTIONS=true
    export KANDELO_HOMEBREW_EARLY_HOST_PLAN="$2"
    export KANDELO_HOMEBREW_EARLY_HOST_ROOTS="$3"
    homebrew_native_contract_select_api_source \
      fixture build-user "$2" "$3"
  ' bash "$SCRIPT_DIR/homebrew-native-install-contract.sh" "$PLAN" "$ROOTS"

SOURCE_REPO="$TMP_ROOT/source-repo"
git init -q "$SOURCE_REPO"
git -C "$SOURCE_REPO" config user.name "Kandelo Test"
git -C "$SOURCE_REPO" config user.email "kandelo-test@example.invalid"
# macOS initializes these local compatibility settings automatically.
# The production source proof is Linux-only and forbids them explicitly.
git -C "$SOURCE_REPO" config --unset-all core.ignorecase || true
git -C "$SOURCE_REPO" config --unset-all core.precomposeunicode || true
mkdir -p "$SOURCE_REPO/bin"
mkdir -p "$SOURCE_REPO/Library/Homebrew/vendor"
printf 'reviewed\n' >"$SOURCE_REPO/source.rb"
ln -s source.rb "$SOURCE_REPO/source-link.rb"
printf '4.0.6\n' \
  >"$SOURCE_REPO/Library/Homebrew/vendor/portable-ruby-version"
cat >"$SOURCE_REPO/.gitignore" <<'EOF'
/ignored-state
/Library/Homebrew/vendor/portable-ruby
/var
EOF
cat >"$SOURCE_REPO/bin/brew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "create-prefix-lock" ]; then
  prefix="$(cd "$(dirname "$0")/.." && pwd -P)"
  mkdir -p "$prefix/var/homebrew/locks"
  : >"$prefix/var/homebrew/locks/vendor-install-ruby"
fi
exit 0
EOF
chmod 0755 "$SOURCE_REPO/bin/brew"
git -C "$SOURCE_REPO" add .gitignore source.rb source-link.rb bin/brew \
  Library/Homebrew/vendor/portable-ruby-version
git -C "$SOURCE_REPO" commit -q -m "reviewed source"
SOURCE_COMMIT="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
SOURCE_POLICY="$TMP_ROOT/source-policy.json"
ruby -rjson - "$SOURCE_POLICY" "$SOURCE_COMMIT" <<'RUBY'
path, commit = ARGV
File.write(path, "#{JSON.generate({
  "schema" => 1,
  "kind" => "kandelo-homebrew-native-roots",
  "architecture" => "x86_64_linux",
  "homebrew_commit" => commit,
  "roots" => { "test" => [] },
})}\n")
RUBY
SOURCE_BREW="$TMP_ROOT/source-brew"
ln -s "$SOURCE_REPO/bin/brew" "$SOURCE_BREW"
SOURCE_WRAPPER="$TMP_ROOT/source-wrapper"
cat >"$SOURCE_WRAPPER" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 0755 "$SOURCE_WRAPPER"
SOURCE_RESULT="$(bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY")"
[ "$SOURCE_RESULT" = "$(cd "$SOURCE_REPO" && pwd -P)" ] ||
  fail "clean reviewed Brew checkout did not bind to its canonical root"

"$SOURCE_REPO/bin/brew" create-prefix-lock
expect_failure "direct Brew prefix lock leakage" \
  "brew checkout has unreviewed ignored state: var/homebrew/locks/vendor-install-ruby" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
rm -rf "$SOURCE_REPO/var"

ISOLATED_PREFIX="$TMP_ROOT/isolated-native-prefix"
mkdir -p "$ISOLATED_PREFIX/bin"
ln -s "$SOURCE_REPO/bin/brew" "$ISOLATED_PREFIX/bin/brew"
"$ISOLATED_PREFIX/bin/brew" create-prefix-lock
[ -f "$ISOLATED_PREFIX/var/homebrew/locks/vendor-install-ruby" ] &&
  [ ! -e "$SOURCE_REPO/var" ] ||
  fail "isolated Brew prefix did not contain its mutable lock state"
[ "$(
  bash "$SOURCE_CHECK" \
    "$ISOLATED_PREFIX/bin/brew" "$SOURCE_POLICY"
)" = "$SOURCE_RESULT" ] ||
  fail "isolated Brew prefix no longer resolved to reviewed source"

expect_failure "wrapped Brew executable" \
  "brew executable is outside the reviewed checkout" \
  bash "$SOURCE_CHECK" "$SOURCE_WRAPPER" "$SOURCE_POLICY"

SOURCE_TREE_MANIFEST="$TMP_ROOT/source-tree.manifest"
GIT_NO_REPLACE_OBJECTS=1 \
  git -C "$SOURCE_REPO" ls-tree -r -t -z --full-tree \
    "$SOURCE_COMMIT" >"$SOURCE_TREE_MANIFEST"
rm "$SOURCE_REPO/source-link.rb"
ln -s bin/brew "$SOURCE_REPO/source-link.rb"
expect_failure "raw tracked symlink target" \
  "tracked Homebrew source symlink target changed" \
  ruby --disable=gems,rubyopt "$ORACLE" attest-source \
    "$SOURCE_COMMIT" "$SOURCE_RESULT" "$SOURCE_TREE_MANIFEST" \
    "$TMP_ROOT/symlink-attestation.json"
git -C "$SOURCE_REPO" checkout -q -- source-link.rb
chmod 0644 "$SOURCE_REPO/bin/brew"
expect_failure "raw tracked executable mode" \
  "tracked Homebrew source executable mode changed" \
  ruby --disable=gems,rubyopt "$ORACLE" attest-source \
    "$SOURCE_COMMIT" "$SOURCE_RESULT" "$SOURCE_TREE_MANIFEST" \
    "$TMP_ROOT/mode-attestation.json"
chmod 0755 "$SOURCE_REPO/bin/brew"

# A replacement ref can make HEAD keep the reviewed object name while
# checkout and status use a different commit's tree. The source guard must
# disable replacement resolution and reject the hidden authority itself.
printf 'replacement source\n' >"$SOURCE_REPO/source.rb"
git -C "$SOURCE_REPO" add source.rb
git -C "$SOURCE_REPO" commit -q -m "replacement source"
REPLACEMENT_COMMIT="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
git -C "$SOURCE_REPO" replace "$SOURCE_COMMIT" "$REPLACEMENT_COMMIT"
git -C "$SOURCE_REPO" checkout -q -f "$SOURCE_COMMIT"
[ "$(git -C "$SOURCE_REPO" rev-parse HEAD)" = "$SOURCE_COMMIT" ] &&
  [ -z "$(git -C "$SOURCE_REPO" status --porcelain)" ] &&
  grep -Fx "replacement source" "$SOURCE_REPO/source.rb" >/dev/null ||
  fail "replacement-ref fixture did not hide substituted source"
expect_failure "Git replacement refs" \
  "brew checkout has Git replacement refs" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
git -C "$SOURCE_REPO" replace -d "$SOURCE_COMMIT" >/dev/null
git -C "$SOURCE_REPO" reset -q --hard "$SOURCE_COMMIT"

GRAFTS_PATH="$(
  git -C "$SOURCE_REPO" rev-parse \
    --path-format=absolute --git-path info/grafts
)"
mkdir -p "$(dirname "$GRAFTS_PATH")"
: >"$GRAFTS_PATH"
expect_failure "legacy Git grafts" \
  "brew checkout has legacy Git grafts" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
rm "$GRAFTS_PATH"

while IFS="=" read -r config_key config_value; do
  git -C "$SOURCE_REPO" config "$config_key" "$config_value"
  expect_failure "checkout-transforming Git config $config_key" \
    "brew checkout has source-affecting local Git configuration" \
    bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
  git -C "$SOURCE_REPO" config --unset-all "$config_key"
done <<'EOF'
core.autocrlf=true
core.checkstat=minimal
core.eol=crlf
core.ignorecase=true
core.precomposeunicode=true
core.symlinks=false
core.trustctime=false
EOF

# Reviewed attributes can also canonicalize bytes without local Git config.
# A clean status is therefore insufficient; raw checked-out bytes must match
# the blob object named by the exact commit.
printf '*.txt text eol=crlf\n' >"$SOURCE_REPO/.gitattributes"
printf 'line one\nline two\n' >"$SOURCE_REPO/transformed.txt"
git -C "$SOURCE_REPO" add .gitattributes transformed.txt
git -C "$SOURCE_REPO" commit -q -m "source with checkout transformation"
TRANSFORM_COMMIT="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
TRANSFORM_POLICY="$TMP_ROOT/transform-policy.json"
jq --arg commit "$TRANSFORM_COMMIT" \
  '.homebrew_commit = $commit' "$SOURCE_POLICY" >"$TRANSFORM_POLICY"
rm "$SOURCE_REPO/transformed.txt"
git -C "$SOURCE_REPO" checkout -q -- transformed.txt
[ -z "$(git -C "$SOURCE_REPO" status --porcelain)" ] ||
  fail "checkout-transformation fixture is not Git-clean"
expect_failure "raw tracked source transformation" \
  "tracked Homebrew source bytes differ from Git tree" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$TRANSFORM_POLICY"
git -C "$SOURCE_REPO" reset -q --hard "$SOURCE_COMMIT"

printf 'dirty\n' >>"$SOURCE_REPO/source.rb"
expect_failure "dirty Brew worktree" "brew checkout is not clean" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
git -C "$SOURCE_REPO" restore source.rb
printf 'staged\n' >>"$SOURCE_REPO/source.rb"
git -C "$SOURCE_REPO" add source.rb
expect_failure "staged Brew worktree" "brew checkout is not clean" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
git -C "$SOURCE_REPO" restore --staged source.rb
git -C "$SOURCE_REPO" restore source.rb
printf 'untracked\n' >"$SOURCE_REPO/untracked.rb"
expect_failure "untracked Brew worktree" "brew checkout is not clean" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
rm "$SOURCE_REPO/untracked.rb"
git -C "$SOURCE_REPO" update-index --assume-unchanged source.rb
expect_failure "assume-unchanged Brew index" \
  "brew checkout index has nonordinary entries" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
git -C "$SOURCE_REPO" update-index --no-assume-unchanged source.rb
git -C "$SOURCE_REPO" update-index --skip-worktree source.rb
expect_failure "skip-worktree Brew index" \
  "brew checkout index has nonordinary entries" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
git -C "$SOURCE_REPO" update-index --no-skip-worktree source.rb
git -C "$SOURCE_REPO" config core.fsmonitor /bin/false
expect_failure "source-affecting local Git config" \
  "brew checkout has source-affecting local Git configuration" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
git -C "$SOURCE_REPO" config --unset core.fsmonitor

mkdir "$SOURCE_REPO/ignored-state"
printf 'ignored executable state\n' >"$SOURCE_REPO/ignored-state/tool"
expect_failure "unreviewed ignored Brew state" \
  "brew checkout has unreviewed ignored state: ignored-state/tool" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
rm -r "$SOURCE_REPO/ignored-state"
mkdir "$SOURCE_REPO/ignored-state"
expect_failure "unreviewed empty ignored Brew directory" \
  "brew checkout has an unreviewed ignored directory: ignored-state/" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
rm -r "$SOURCE_REPO/ignored-state"

SOURCE_RUNTIME="$SOURCE_REPO/Library/Homebrew/vendor/portable-ruby"
mkdir -p "$SOURCE_RUNTIME/4.0.6/bin"
printf '#!/usr/bin/env ruby\n' >"$SOURCE_RUNTIME/4.0.6/bin/ruby"
chmod 0755 "$SOURCE_RUNTIME/4.0.6/bin/ruby"
ln -s 4.0.6 "$SOURCE_RUNTIME/current"
SOURCE_ATTESTATION_BEFORE="$TMP_ROOT/source-before.json"
SOURCE_ATTESTATION_AFTER="$TMP_ROOT/source-after.json"
bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY" \
  "$SOURCE_ATTESTATION_BEFORE" >/dev/null
jq -e '
  .kind == "kandelo-homebrew-native-source-attestation" and
  .tracked_source.entries >= 6 and
  .tracked_source.bytes > 0 and
  (.tracked_source.sha256 | test("^[0-9a-f]{64}$")) and
  .ignored_runtime.present == true and
  .ignored_runtime.entries == 5 and
  (.ignored_runtime.sha256 | test("^[0-9a-f]{64}$"))
' "$SOURCE_ATTESTATION_BEFORE" >/dev/null ||
  fail "portable Ruby attestation did not bind its complete ignored runtime"
printf '# changed\n' >>"$SOURCE_RUNTIME/4.0.6/bin/ruby"
bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY" \
  "$SOURCE_ATTESTATION_AFTER" >/dev/null
if cmp -s "$SOURCE_ATTESTATION_BEFORE" "$SOURCE_ATTESTATION_AFTER"; then
  fail "portable Ruby content drift did not change source attestation"
fi
ln -s /bin/sh "$SOURCE_RUNTIME/escaping-link"
expect_failure "escaping portable Ruby symlink" \
  "ignored portable Ruby symlink escapes its runtime" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"
rm "$SOURCE_RUNTIME/escaping-link"

printf 'new commit\n' >>"$SOURCE_REPO/source.rb"
git -C "$SOURCE_REPO" add source.rb
git -C "$SOURCE_REPO" commit -q -m "unreviewed source"
expect_failure "wrong Brew commit" "brew is not the reviewed checkout" \
  bash "$SOURCE_CHECK" "$SOURCE_BREW" "$SOURCE_POLICY"

echo "test-homebrew-native-api-contract: ok"
