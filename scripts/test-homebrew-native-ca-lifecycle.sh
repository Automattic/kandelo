#!/usr/bin/env bash
# Linux proof for Homebrew's signed ca-certificates install-plan lifecycle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
POLICY="$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json"
LOCK="$REPO_ROOT/homebrew/homebrew-native-compatibility-lock.json"
PREFLIGHT="$SCRIPT_DIR/homebrew-native-api-preflight.sh"
SOURCE_CHECK="$SCRIPT_DIR/homebrew-native-check-brew-source.sh"
ORACLE="$SCRIPT_DIR/homebrew-native-api-contract.rb"
. "$SCRIPT_DIR/homebrew-native-bounded-environment.sh"
. "$SCRIPT_DIR/homebrew-patched-launcher.sh"

fail() {
  echo "test-homebrew-native-ca-lifecycle: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  echo "usage: $0 BREW EVIDENCE-OUTPUT" >&2
  exit 2
fi
BREW_SOURCE_BIN="$1"
EVIDENCE_OUTPUT="$2"
SUDO_BIN="${KANDELO_HOMEBREW_SUDO_BIN:-/usr/bin/sudo}"

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] ||
  fail "exact Linux x86_64 is required"
[ -x "$SUDO_BIN" ] || fail "sudo is unavailable"
[ ! -e "$EVIDENCE_OUTPUT" ] && [ ! -L "$EVIDENCE_OUTPUT" ] ||
  fail "evidence output already exists"

BREW_COMMIT="$(jq -er '.homebrew_commit' "$POLICY")"
# Keep the base short enough for the child native prefix to have exactly the
# same byte length as /home/linuxbrew/.linuxbrew. Fixed-prefix bottles can
# otherwise expose NUL padding through compiled runtime search paths.
WORK="$(mktemp -d /tmp/khn.XXXXXX)"
cleanup() {
  local status="$?"
  trap - EXIT
  case "$WORK" in
    /tmp/khn.*)
      "$SUDO_BIN" -n -- /usr/bin/rm -rf -- "$WORK"
      ;;
    *)
      echo "test-homebrew-native-ca-lifecycle: unsafe cleanup root" >&2
      status=2
      ;;
  esac
  exit "$status"
}
trap cleanup EXIT

NATIVE_PREFIX="$(
  homebrew_patched_launcher_native_prefix_path "$WORK"
)"
CACHE="$WORK/cache"
STATE="$WORK/state"
ROOTS="$WORK/roots.txt"
RAW="$WORK/closure.raw"
CLOSURE="$WORK/closure.txt"
ADMISSION="$WORK/admission.json"
CELLAR_EVIDENCE="$WORK/cellar.json"
SOURCE_BEFORE="$WORK/source-before.json"
SOURCE_AFTER="$WORK/source-after.json"
TLS_LOG="$WORK/tls.log"
NATIVE_BREW="$NATIVE_PREFIX/bin/brew"

mkdir -m 0700 -- "$NATIVE_PREFIX"
mkdir -m 0700 -- "$NATIVE_PREFIX/bin"
ln -s "$BREW_SOURCE_BIN" "$NATIVE_BREW"
printf 'ruby\n' >"$ROOTS"

KANDELO_HOMEBREW_SUDO_BIN="$SUDO_BIN" \
  bash "$PREFLIGHT" prepare \
    "$NATIVE_BREW" "$CACHE" "$STATE" "$POLICY" \
    tap_formula_host_dependencies "$ROOTS"
BREW_SOURCE_ROOT="$(
  bash "$SOURCE_CHECK" "$NATIVE_BREW" "$POLICY" "$SOURCE_BEFORE"
)"

reported_prefix="$(
  homebrew_native_bounded_run \
    "$NATIVE_BREW" "$CACHE" "$STATE" api-client --prefix
)"
[ "$reported_prefix" = "$NATIVE_PREFIX" ] ||
  fail "exact Homebrew did not select the isolated native prefix"

homebrew_native_bounded_run \
  "$NATIVE_BREW" "$CACHE" "$STATE" api-client \
  deps --union --include-implicit --full-name --formula \
  homebrew/core/ruby >"$RAW"
LC_ALL=C sort -u "$ROOTS" "$RAW" >"$CLOSURE"
grep -Fx ca-certificates "$CLOSURE" >/dev/null ||
  fail "Ruby's native closure omitted ca-certificates"
grep -Fx openssl@3 "$CLOSURE" >/dev/null ||
  fail "Ruby's native closure omitted openssl@3"

homebrew_native_bounded_run \
  "$NATIVE_BREW" "$CACHE" "$STATE" api-oracle \
  ruby "$ORACLE" admit \
  "$BREW_COMMIT" "$POLICY" tap_formula_host_dependencies \
  "$ROOTS" "$CLOSURE" "$STATE/prime.json" "$LOCK" "$ADMISSION"

# WHY: Ruby is the smallest reviewed direct publisher root whose poured
# runtime closure includes both openssl@3 and ca-certificates. Installing the
# admitted root proves Homebrew executes the signed internal `run` step that
# creates cert.pem; merely parsing that record would not prove compatibility.
if ! homebrew_native_bounded_run \
    "$NATIVE_BREW" "$CACHE" "$STATE" api-client \
    install --force-bottle --as-dependency --formula homebrew/core/ruby; then
  fail "admitted native bottle installation failed"
fi

homebrew_native_bounded_run \
  "$NATIVE_BREW" "$CACHE" "$STATE" api-oracle \
  ruby "$ORACLE" audit-cellar \
  "$BREW_COMMIT" "$STATE/prime.json" "$CLOSURE" "$ROOTS" \
  "$CELLAR_EVIDENCE"

CERT_PEM="$NATIVE_PREFIX/etc/ca-certificates/cert.pem"
OPENSSL_CERT="$NATIVE_PREFIX/etc/openssl@3/cert.pem"
OPENSSL_BIN="$NATIVE_PREFIX/opt/openssl@3/bin/openssl"
[ -f "$CERT_PEM" ] && [ ! -L "$CERT_PEM" ] && [ -s "$CERT_PEM" ] &&
  case "$(readlink -f -- "$CERT_PEM")" in
    "$NATIVE_PREFIX"/*) true ;;
    *) false ;;
  esac &&
  grep -F 'BEGIN CERTIFICATE' "$CERT_PEM" >/dev/null ||
  fail "ca-certificates postinstall did not create a usable cert.pem"
[ -L "$OPENSSL_CERT" ] ||
  fail "OpenSSL did not install its ca-certificates cert.pem link"
[ "$(readlink -f -- "$OPENSSL_CERT")" = "$(readlink -f -- "$CERT_PEM")" ] ||
  fail "OpenSSL cert.pem does not resolve to ca-certificates"
[ -x "$OPENSSL_BIN" ] || fail "the admitted OpenSSL executable is unavailable"

if ! /usr/bin/timeout 30 "$OPENSSL_BIN" s_client \
    -connect github.com:443 \
    -servername github.com \
    -verify_hostname github.com \
    -verify_return_error \
    -CAfile "$OPENSSL_CERT" </dev/null >"$TLS_LOG" 2>&1; then
  cat "$TLS_LOG" >&2
  fail "OpenSSL could not complete verified TLS with the installed CA bundle"
fi
grep -F 'Verify return code: 0 (ok)' "$TLS_LOG" >/dev/null ||
  fail "OpenSSL TLS evidence did not report successful verification"

[ "$(
  bash "$SOURCE_CHECK" "$NATIVE_BREW" "$POLICY" "$SOURCE_AFTER"
)" = "$BREW_SOURCE_ROOT" ] &&
  cmp -s "$SOURCE_BEFORE" "$SOURCE_AFTER" ||
  fail "reviewed Homebrew source changed during the CA lifecycle"

CERT_SHA256="$(sha256sum "$CERT_PEM" | awk '{print $1}')"
OPENSSL_VERSION="$("$OPENSSL_BIN" version)"
EVIDENCE_TMP="$WORK/evidence.json"
jq -S -n \
  --arg cert_sha256 "$CERT_SHA256" \
  --arg homebrew_commit "$BREW_COMMIT" \
  --arg openssl_version "$OPENSSL_VERSION" \
  --slurpfile admission "$ADMISSION" \
  --slurpfile cellar "$CELLAR_EVIDENCE" \
  '{
    schema: 1,
    kind: "kandelo-homebrew-native-ca-lifecycle",
    homebrew_commit: $homebrew_commit,
    root: "ruby",
    admission: $admission[0],
    cellar: $cellar[0],
    ca_certificates: {
      cert_pem_sha256: $cert_sha256,
      openssl_cert_link: true
    },
    openssl: {
      version: $openssl_version,
      verified_tls_host: "github.com"
    }
  }' >"$EVIDENCE_TMP"
install -m 0644 "$EVIDENCE_TMP" "$EVIDENCE_OUTPUT"

echo "test-homebrew-native-ca-lifecycle: ok"
