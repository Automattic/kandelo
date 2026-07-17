#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

TAP_ROOT="$TMP_ROOT/tap"
MARKER="$TMP_ROOT/formula-executed"
mkdir -p "$TAP_ROOT/Formula"

cat >"$TAP_ROOT/Formula/required.rb" <<'RUBY'
class Required < Formula
end
RUBY
cat >"$TAP_ROOT/Formula/recommended.rb" <<'RUBY'
class Recommended < Formula
  depends_on "kandelo-dev/tap-core/transitive"
end
RUBY
cat >"$TAP_ROOT/Formula/transitive.rb" <<'RUBY'
class Transitive < Formula
end
RUBY
cat >"$TAP_ROOT/Formula/root.rb" <<'RUBY'
class Root < Formula
  depends_on "pkgconf" => :build
  depends_on "wabt" => [:build, :test]
  depends_on "kandelo-dev/tap-core/required"
  depends_on "kandelo-dev/tap-core/recommended" => :recommended
  depends_on "kandelo-dev/tap-core/optional" => :optional
  depends_on "external-required"
  depends_on "third-party/tools/recommended" => :recommended
  depends_on "external-optional" => :optional
end
RUBY

resolver="$REPO_ROOT/scripts/homebrew-formula-runtime-closure.rb"
declarations="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root --declarations-json)"
jq -e '
  keys == ["dependencies", "formula", "full_name", "schema", "tap"] and
  .schema == 1 and
  .tap == "kandelo-dev/tap-core" and
  .formula == "root" and
  .full_name == "kandelo-dev/tap-core/root" and
  .dependencies == [
    {kind: "optional", name: "external-optional", same_tap: false},
    {kind: "required", name: "external-required", same_tap: false},
    {kind: "optional", name: "kandelo-dev/tap-core/optional", same_tap: true},
    {kind: "recommended", name: "kandelo-dev/tap-core/recommended", same_tap: true},
    {kind: "required", name: "kandelo-dev/tap-core/required", same_tap: true},
    {kind: "recommended", name: "third-party/tools/recommended", same_tap: false}
  ]
' <<<"$declarations" >/dev/null

cat >"$TAP_ROOT/Formula/host-plan.rb" <<'RUBY'
class HostPlan < Formula
  depends_on "python@3.14" => :build
  depends_on "kandelo-dev/tap-core/required"
  depends_on "wabt" => [:build, :test]
  depends_on "kandelo-dev/tap-core/same-build" => :build
  depends_on "check" => :test
  depends_on "kandelo-dev/tap-core/recommended" => :recommended
  depends_on "third-party/tools/optional-tool" => :optional
  depends_on "external-optional" => :optional
  depends_on "kandelo-dev/tap-core/optional" => :optional
end
RUBY
host_plan="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core host-plan --host-dependencies-json)"
jq -e '
  keys == ["build", "build_and_test", "formula", "full_name", "runtime_and_test", "schema", "tap"] and
  .schema == 2 and
  .tap == "kandelo-dev/tap-core" and
  .formula == "host-plan" and
  .full_name == "kandelo-dev/tap-core/host-plan" and
  .build == ["python@3.14", "wabt"] and
  .build_and_test == ["check", "python@3.14", "wabt"] and
  .runtime_and_test == ["check", "wabt"]
' <<<"$host_plan" >/dev/null
[ "$host_plan" = "$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core host-plan --host-dependencies-json)" ]

cat >"$TAP_ROOT/Formula/third-party-plan.rb" <<'RUBY'
class ThirdPartyPlan < Formula
  depends_on "acme/tools/required"
  depends_on "wabt" => [:build, :test]
end
RUBY
third_party_plan="$(ruby "$resolver" "$TAP_ROOT" Acme/tools third-party-plan --host-dependencies-json)"
jq -e '
  .tap == "acme/tools" and
  .full_name == "acme/tools/third-party-plan" and
  .build == ["wabt"] and
  .build_and_test == ["wabt"] and
  .runtime_and_test == ["wabt"]
' <<<"$third_party_plan" >/dev/null

cat >"$TAP_ROOT/Formula/external-runtime.rb" <<'RUBY'
class ExternalRuntime < Formula
  depends_on "zstd"
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-runtime \
  --host-dependencies-json >"$TMP_ROOT/external-runtime.out" 2>"$TMP_ROOT/external-runtime.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: treated external runtime dependency as a host dependency" >&2
  exit 1
fi
grep -F 'external runtime dependency must be same-tap, not a host Formula: "zstd"' \
  "$TMP_ROOT/external-runtime.err" >/dev/null

cat >"$TAP_ROOT/Formula/external-recommended.rb" <<'RUBY'
class ExternalRecommended < Formula
  depends_on "pkgconf" => :recommended
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-recommended \
  --host-dependencies-json >"$TMP_ROOT/external-recommended.out" \
  2>"$TMP_ROOT/external-recommended.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: treated recommended runtime dependency as a host dependency" >&2
  exit 1
fi
grep -F 'external runtime dependency must be same-tap, not a host Formula: "pkgconf"' \
  "$TMP_ROOT/external-recommended.err" >/dev/null

cat >"$TAP_ROOT/Formula/external-tap.rb" <<'RUBY'
class ExternalTap < Formula
  depends_on "third-party/tools/cmake" => :build
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-tap \
  --host-dependencies-json >"$TMP_ROOT/external-tap.out" 2>"$TMP_ROOT/external-tap.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted external tap-qualified host dependency" >&2
  exit 1
fi
grep -F 'external tap-qualified host dependency is unsupported: "third-party/tools/cmake"' \
  "$TMP_ROOT/external-tap.err" >/dev/null
ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core external-tap \
  --declarations-json >/dev/null

cat >"$TAP_ROOT/Formula/invalid-host.rb" <<'RUBY'
class InvalidHost < Formula
  depends_on "InvalidHost" => :test
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core invalid-host \
  --host-dependencies-json >"$TMP_ROOT/invalid-host.out" 2>"$TMP_ROOT/invalid-host.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted malformed host dependency" >&2
  exit 1
fi
grep -F 'invalid host Formula dependency: "InvalidHost"' \
  "$TMP_ROOT/invalid-host.err" >/dev/null

if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root \
  >"$TMP_ROOT/external.out" 2>"$TMP_ROOT/external.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted selected external dependency" >&2
  exit 1
fi
grep -F "required external Formula dependencies are unsupported" \
  "$TMP_ROOT/external.err" >/dev/null

cat >"$TAP_ROOT/Formula/root.rb" <<'RUBY'
class Root < Formula
  depends_on "pkgconf" => :build
  depends_on "wabt" => [:build, :test]
  depends_on "kandelo-dev/tap-core/required"
  depends_on "kandelo-dev/tap-core/recommended" => :recommended
  depends_on "kandelo-dev/tap-core/optional" => :optional
  depends_on "external-optional" => :optional
end
RUBY
closure="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root)"
[ "$closure" = $'kandelo-dev/tap-core/recommended\nkandelo-dev/tap-core/required\nkandelo-dev/tap-core/transitive' ]
direct="$(ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root --direct)"
[ "$direct" = $'kandelo-dev/tap-core/recommended\nkandelo-dev/tap-core/required' ]

cat >"$TAP_ROOT/Formula/recommended.rb" <<'RUBY'
class Recommended < Formula
  depends_on "kandelo-dev/tap-core/transitive"
  depends_on "transitive-external"
end
RUBY
if ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core root \
  >"$TMP_ROOT/transitive-external.out" 2>"$TMP_ROOT/transitive-external.err"; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted transitive external dependency" >&2
  exit 1
fi
grep -F 'recommended:transitive-external' "$TMP_ROOT/transitive-external.err" >/dev/null
cat >"$TAP_ROOT/Formula/recommended.rb" <<'RUBY'
class Recommended < Formula
  depends_on "kandelo-dev/tap-core/transitive"
end
RUBY

cat >"$TAP_ROOT/Formula/execute.rb" <<'RUBY'
File.write(ENV.fetch("KANDELO_FORMULA_EXECUTION_MARKER"), "executed")

class Execute < Formula
  depends_on "external-required"
end
RUBY
if KANDELO_FORMULA_EXECUTION_MARKER="$MARKER" \
  ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core execute \
    --declarations-json >/dev/null 2>&1; then
  echo "test-homebrew-formula-runtime-closure.sh: executable top-level Formula was accepted" >&2
  exit 1
fi
if [ -e "$MARKER" ]; then
  echo "test-homebrew-formula-runtime-closure.sh: Formula source was executed" >&2
  exit 1
fi

cat >"$TAP_ROOT/Formula/inert.rb" <<'RUBY'
class Inert < Formula
  depends_on "external-required"

  def install
    File.write(ENV.fetch("KANDELO_FORMULA_EXECUTION_MARKER"), "install executed")
  end

  test do
    File.write(ENV.fetch("KANDELO_FORMULA_EXECUTION_MARKER"), "test executed")
  end
end
RUBY
KANDELO_FORMULA_EXECUTION_MARKER="$MARKER" \
  ruby "$resolver" "$TAP_ROOT" kandelo-dev/tap-core inert \
    --declarations-json | jq -e '
      .dependencies == [
        {kind: "required", name: "external-required", same_tap: false}
      ]
    ' >/dev/null
if [ -e "$MARKER" ]; then
  echo "test-homebrew-formula-runtime-closure.sh: accepted Formula methods were executed" >&2
  exit 1
fi

echo "test-homebrew-formula-runtime-closure.sh: passed"
