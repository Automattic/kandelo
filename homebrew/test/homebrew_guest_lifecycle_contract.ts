export const HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER =
  "KANDELO_HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_OK";
export const HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER =
  "KANDELO_HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_OK";
export const HOMEBREW_GUEST_CORE_SHIPPING_PROOF_MARKER =
  "KANDELO_HOMEBREW_GUEST_CORE_SHIPPING_PROOF_OK";
export const HOMEBREW_GUEST_CANARY_SHIPPING_PROOF_MARKER =
  "KANDELO_HOMEBREW_GUEST_CANARY_SHIPPING_PROOF_OK";

export const HOMEBREW_GUEST_LIFECYCLE_CORE_TAP = "kandelo-dev/tap-core";
export const HOMEBREW_GUEST_LIFECYCLE_CORE_REPOSITORY =
  "kandelo-dev/homebrew-tap-core";
const CORE_TAP = HOMEBREW_GUEST_LIFECYCLE_CORE_TAP;
const CORE_ORIGIN =
  "https://github.com/Kandelo-dev/homebrew-tap-core.git";
const CANARY_TAP = "brandonpayton/kandelo-canary";
const CANARY_ORIGIN =
  "https://github.com/brandonpayton/homebrew-kandelo-canary.git";
const CORE_BZIP2 = `${CORE_TAP}/bzip2`;
const CORE_DASH = `${CORE_TAP}/dash`;
const CANARY_M4 = `${CANARY_TAP}/m4`;
const EXACT_GIT_REVISION = /^[0-9a-f]{40}$/;

export interface HomebrewGuestLifecycleRevisions {
  coreRevision: string;
  canaryRevision: string;
}

export type HomebrewGuestShippingProofScope = "core" | "canary";

export function assertHomebrewGuestLifecycleRevisions(
  revisions: HomebrewGuestLifecycleRevisions,
): void {
  for (const [label, revision] of [
    ["core", revisions.coreRevision],
    ["canary", revisions.canaryRevision],
  ] as const) {
    if (!EXACT_GIT_REVISION.test(revision)) {
      throw new Error(
        `Homebrew guest lifecycle ${label} revision must be an exact lowercase 40-character SHA`,
      );
    }
  }
}

/**
 * Exercise stock Homebrew against exact first- and third-party tap revisions.
 *
 * The current lazy shell already contains direct-composed receipts for its
 * complete closure. The two `uninstall --ignore-dependencies` operations
 * below deliberately create empty Bzip2 and M4 targets before asking stock
 * Homebrew to install them. This is a transition proof between composition
 * models, not a package workaround: no Formula, bottle, or Homebrew source is
 * modified.
 */
export function createHomebrewGuestLifecyclePhaseOneScript(
  revisions: HomebrewGuestLifecycleRevisions,
): string {
  return createHomebrewGuestInstallScript(revisions, "comprehensive");
}

/**
 * Prove that users can install and execute public first- and third-party
 * bottles through stock Homebrew.
 *
 * Each bounded scope starts from the exact original image and stops after one
 * first install. Reinstall, upgrade, cleanup, export, and reboot test
 * maintenance and durability rather than the user-facing install capability.
 * The workflow runs the scopes in fresh Node processes, while the
 * comprehensive lifecycle retains the additional assertions separately.
 */
export function createHomebrewGuestShippingProofScript(
  revisions: HomebrewGuestLifecycleRevisions,
  scope: HomebrewGuestShippingProofScope,
): string {
  return createHomebrewGuestInstallScript(
    revisions,
    scope === "core" ? "shipping-core" : "shipping-canary",
  );
}

function createHomebrewGuestInstallScript(
  revisions: HomebrewGuestLifecycleRevisions,
  mode: "shipping-core" | "shipping-canary" | "comprehensive",
): string {
  assertHomebrewGuestLifecycleRevisions(revisions);
  // WHY: a hosted Node process may retain collectible Wasm backing stores
  // longer than this fork-heavy workload can tolerate. Keep the release gate
  // focused on first installation; the comprehensive contract still owns
  // reinstall and durable-state assertions.
  const coreReinstall = mode === "comprehensive"
    ? String.raw`
progress "reinstalling and executing the first-party Bzip2 bottle"
/usr/bin/brew reinstall --force-bottle ${CORE_TAP}/bzip2
reinstalled_bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
[ "$reinstalled_bzip2_prefix" = "$bzip2_prefix" ] ||
  fail "Bzip2 reinstall changed its versioned prefix"
assert_poured "$reinstalled_bzip2_prefix"
assert_bzip2_roundtrip "$reinstalled_bzip2_prefix"
`
    : "";
  const canaryReinstall = mode === "comprehensive"
    ? String.raw`
progress "reinstalling independent M4 with the same first-party dependency"
/usr/bin/brew reinstall --force-bottle ${CANARY_TAP}/m4
reinstalled_m4_prefix="$(/usr/bin/brew --prefix ${CANARY_TAP}/m4)"
[ "$reinstalled_m4_prefix" = "$m4_prefix" ] ||
  fail "M4 reinstall changed its versioned prefix"
assert_poured "$reinstalled_m4_prefix"
assert_precomposed_bottle "$dash_prefix"
assert_runtime_dependency "$reinstalled_m4_prefix" ${CORE_TAP}/dash
assert_m4_execution "$reinstalled_m4_prefix" cross-tap-reinstall-ok
`
    : "";
  const coreInstall = mode === "shipping-canary"
    ? ""
    : String.raw`
# WHY: the base shell is already composed from this bottle closure. Remove the
# existing receipt through stock Homebrew so the following command proves a
# genuine install rather than accepting Homebrew's "already installed" path.
composed_bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
# WHY: the VFS composer placed exact bottle bytes directly; it did not execute
# Homebrew's pour operation. Preserve that distinction in the receipt contract.
assert_precomposed_bottle "$composed_bzip2_prefix"
/usr/bin/brew uninstall --ignore-dependencies ${CORE_TAP}/bzip2
[ ! -e "$composed_bzip2_prefix" ] ||
  fail "direct-composed Bzip2 prefix remains after transition uninstall"

progress "installing and executing the first-party Bzip2 bottle"
/usr/bin/brew install --no-ask --force-bottle ${CORE_TAP}/bzip2
bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
assert_poured "$bzip2_prefix"
assert_bzip2_roundtrip "$bzip2_prefix"

${coreReinstall}
snapshot_trust "$core_trust_after"
assert_formula_trust "$core_trust_after" ${CORE_TAP} ${CORE_BZIP2} present
/usr/bin/brew untrust --tap >"$core_untrusted"
assert_untrusted_tap_discovery ${CORE_TAP} "$core_untrusted"
`;
  const expectedBzip2Trust = mode === "comprehensive" ? "present" : "absent";
  const canaryInstall = mode === "shipping-core"
    ? ""
    : String.raw`
progress "tapping the exact independent third-party repository"
/usr/bin/brew tap ${CANARY_TAP} ${CANARY_ORIGIN}
canary_tap="$(/usr/bin/brew --repository ${CANARY_TAP})"
/usr/bin/git -C "$canary_tap" fetch --no-tags origin ${revisions.canaryRevision}
/usr/bin/git -C "$canary_tap" checkout --detach ${revisions.canaryRevision}
assert_clean_tap "$canary_tap" ${CANARY_ORIGIN} ${revisions.canaryRevision}
[ ! -e "$core_repository" ] || fail "third-party tap created homebrew/core"

# WHY: keep third-party authority at Formula granularity. The fully qualified
# M4 install below may create item trust, but tapping alone must remain
# discoverable as untrusted and must not create either tap or Formula trust.
/usr/bin/brew untrust --tap >"$canary_untrusted"
assert_untrusted_tap_discovery ${CANARY_TAP} "$canary_untrusted"
snapshot_trust "$canary_trust_before"
assert_formula_trust "$canary_trust_before" ${CANARY_TAP} ${CANARY_M4} absent

# WHY: core M4 and canary M4 have the same conventional Cellar identity. Use
# stock uninstall to create one truthful target before the independent tap
# pours its own bottle; do not rewrite either Formula to avoid the collision.
composed_m4_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/m4)"
assert_precomposed_bottle "$composed_m4_prefix"
/usr/bin/brew uninstall --ignore-dependencies ${CORE_TAP}/m4
[ ! -e "$composed_m4_prefix" ] ||
  fail "direct-composed M4 prefix remains after transition uninstall"

dash_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/dash)"
assert_precomposed_bottle "$dash_prefix"
# WHY: the fully qualified canary argument grants authority only to M4.
# Homebrew independently evaluates its fully qualified Dash dependency, so
# grant that one already-pinned first-party Formula without trusting the tap.
/usr/bin/brew trust --formula ${CORE_DASH}
snapshot_trust "$core_dependency_trust"
assert_formula_trust "$core_dependency_trust" ${CORE_TAP} ${CORE_BZIP2} ${expectedBzip2Trust}
assert_formula_trust "$core_dependency_trust" ${CORE_TAP} ${CORE_DASH} present
/usr/bin/brew untrust --tap >"$core_untrusted"
assert_untrusted_tap_discovery ${CORE_TAP} "$core_untrusted"
progress "installing independent M4 with its first-party Dash dependency"
/usr/bin/brew install --no-ask --force-bottle ${CANARY_TAP}/m4
m4_prefix="$(/usr/bin/brew --prefix ${CANARY_TAP}/m4)"
assert_poured "$m4_prefix"
assert_precomposed_bottle "$dash_prefix"
assert_runtime_dependency "$m4_prefix" ${CORE_TAP}/dash
"$m4_prefix/bin/m4" --version >/dev/null
assert_m4_execution "$m4_prefix" cross-tap-ok

${canaryReinstall}
snapshot_trust "$canary_trust_after"
assert_formula_trust "$canary_trust_after" ${CANARY_TAP} ${CANARY_M4} present
/usr/bin/brew untrust --tap >"$canary_untrusted"
assert_untrusted_tap_discovery ${CANARY_TAP} "$canary_untrusted"
`;
  const canaryFinalAssertion = mode === "shipping-core"
    ? ""
    : String.raw`
assert_clean_tap "$canary_tap" ${CANARY_ORIGIN} ${revisions.canaryRevision}
`;
  const durableState = mode === "comprehensive"
    ? String.raw`
state="$repository/var/homebrew/kandelo-guest-lifecycle-state"
{
  /usr/bin/printf '%s\n' ${revisions.coreRevision}
  /usr/bin/printf '%s\n' ${revisions.canaryRevision}
} >"$state"
`
    : "";
  const startMessage = mode === "comprehensive"
    ? "starting comprehensive install and durability phase"
    : mode === "shipping-core"
    ? "starting bounded core bottle shipping proof"
    : "starting bounded independent-canary bottle shipping proof";
  const completionMessage = mode === "comprehensive"
    ? "phase one is durable and ready for rootfs export"
    : mode === "shipping-core"
    ? "first-party Bzip2 bottle installation is ready to ship"
    : "independent-canary M4 bottle installation is ready to ship";
  const completionMarker = mode === "comprehensive"
    ? HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER
    : mode === "shipping-core"
    ? HOMEBREW_GUEST_CORE_SHIPPING_PROOF_MARKER
    : HOMEBREW_GUEST_CANARY_SHIPPING_PROOF_MARKER;
  return String.raw`
set -euo pipefail
fail() { printf 'homebrew-guest-lifecycle: %s\n' "$*" >&2; exit 1; }
progress() { printf 'homebrew-guest-lifecycle: %s\n' "$*"; }
assert_precomposed_bottle() {
  /usr/bin/ruby -rjson -e '
    receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
    abort "precomposed package was not built as a bottle" unless
      receipt.fetch("built_as_bottle") == true
    abort "precomposed package falsely claims a Homebrew pour" unless
      receipt.fetch("poured_from_bottle") == false
  ' "$1"
}
assert_poured() {
  /usr/bin/ruby -rjson -e '
    receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
    abort "bottle was not poured" unless receipt.fetch("poured_from_bottle") == true
  ' "$1"
}
assert_runtime_dependency() {
  /usr/bin/ruby -rjson -e '
    receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
    dependencies = receipt.fetch("runtime_dependencies")
    abort "receipt does not bind expected runtime dependency" unless
      dependencies.any? { |dependency| dependency["full_name"] == ARGV.fetch(1) }
  ' "$1" "$2"
}
snapshot_trust() {
  /usr/bin/brew trust --json=v1 >"$1"
}
assert_formula_trust() {
  /usr/bin/ruby -rjson -e '
    document = JSON.parse(File.binread(ARGV.fetch(0)))
    tap = ARGV.fetch(1)
    formula = ARGV.fetch(2)
    expected = ARGV.fetch(3) == "present"
    taps = document.fetch("taps")
    formulae = document.fetch("formulae")
    abort "trust JSON has invalid tap or Formula entries" unless
      taps.is_a?(Array) && formulae.is_a?(Array)
    abort "lifecycle granted whole-tap trust" if taps.include?(tap)
    present = formulae.include?(formula)
    abort "Formula trust state differs from lifecycle phase" unless present == expected
  ' "$1" "$2" "$3" "$4"
}
assert_untrusted_tap_discovery() {
  tap="$1"
  output="$2"
  /usr/bin/grep -Fqx "  $tap" "$output" ||
    fail "stock Homebrew did not report the installed tap as untrusted"
}
assert_clean_tap() {
  tap_root="$1"
  expected_origin="$2"
  expected_revision="$3"
  [ "$(/usr/bin/git -C "$tap_root" remote get-url origin)" = "$expected_origin" ] ||
    fail "tap origin differs from the canonical public repository"
  [ "$(/usr/bin/git -C "$tap_root" rev-parse HEAD)" = "$expected_revision" ] ||
    fail "tap checkout differs from the reviewed revision"
  [ -z "$(/usr/bin/git -C "$tap_root" status --porcelain=v1 --untracked-files=all)" ] ||
    fail "tap checkout is dirty"
}
assert_bzip2_roundtrip() {
  prefix="$1"
  input=/tmp/kandelo-homebrew-bzip2.input
  archive=/tmp/kandelo-homebrew-bzip2.bz2
  output=/tmp/kandelo-homebrew-bzip2.output
  /usr/bin/printf 'Kandelo stock Homebrew lifecycle\n' >"$input"
  "$prefix/bin/bzip2" -c "$input" >"$archive"
  "$prefix/bin/bzip2" -dc "$archive" >"$output"
  /usr/bin/cmp "$input" "$output"
  /usr/bin/rm -f "$input" "$archive" "$output"
}
assert_m4_execution() {
  prefix="$1"
  expected="$2"
  actual="$(/usr/bin/printf '%s\n' \
    'changequote([,])dnl' \
    "define([KANDELO_LIFECYCLE_VALUE],[$expected])dnl" \
    'KANDELO_LIFECYCLE_VALUE' |
    "$prefix/bin/m4")"
  [ "$actual" = "$expected" ] || fail "third-party M4 did not execute"
}

export HOMEBREW_NO_ANALYTICS=1
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1
# WHY: Kandelo has no upstream internal package API. Use the same paired flags
# as Homebrew.with_no_api_env so fully qualified taps resolve from Git without
# making no-API mode clone the complete homebrew/core repository.
export HOMEBREW_NO_INSTALL_FROM_API=1
export HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1
export HOMEBREW_REQUIRE_TAP_TRUST=1
export GIT_TERMINAL_PROMPT=0

progress "${startMessage}"
repository="$(/usr/bin/brew --repository)"
core_repository="$repository/Library/Taps/homebrew/homebrew-core"
[ ! -e "$core_repository" ] || fail "homebrew/core existed before the lifecycle proof"

progress "tapping the exact first-party repository"
/usr/bin/brew tap ${CORE_TAP} ${CORE_ORIGIN}
core_tap="$(/usr/bin/brew --repository ${CORE_TAP})"
/usr/bin/git -C "$core_tap" fetch --no-tags origin ${revisions.coreRevision}
/usr/bin/git -C "$core_tap" checkout --detach ${revisions.coreRevision}
assert_clean_tap "$core_tap" ${CORE_ORIGIN} ${revisions.coreRevision}
[ ! -e "$core_repository" ] || fail "first-party tap created homebrew/core"

# WHY: cloning a tap must not grant authority to all of its current and future
# Formulae. Prove stock Homebrew discovers the tap as untrusted before any
# fully qualified package operation creates narrower item trust.
core_untrusted=/tmp/kandelo-homebrew-core.untrusted
core_trust_before=/tmp/kandelo-homebrew-core.trust-before.json
core_trust_after=/tmp/kandelo-homebrew-core.trust-after.json
core_dependency_trust=/tmp/kandelo-homebrew-core.dependency-trust.json
canary_untrusted=/tmp/kandelo-homebrew-canary.untrusted
canary_trust_before=/tmp/kandelo-homebrew-canary.trust-before.json
canary_trust_after=/tmp/kandelo-homebrew-canary.trust-after.json
/usr/bin/brew untrust --tap >"$core_untrusted"
assert_untrusted_tap_discovery ${CORE_TAP} "$core_untrusted"
snapshot_trust "$core_trust_before"
assert_formula_trust "$core_trust_before" ${CORE_TAP} ${CORE_BZIP2} absent
assert_formula_trust "$core_trust_before" ${CORE_TAP} ${CORE_DASH} absent

${coreInstall}
${canaryInstall}
${durableState}
assert_clean_tap "$core_tap" ${CORE_ORIGIN} ${revisions.coreRevision}
${canaryFinalAssertion}
[ ! -e "$core_repository" ] || fail "lifecycle install created homebrew/core"
/usr/bin/rm -f \
  "$core_untrusted" "$core_trust_before" "$core_trust_after" \
  "$core_dependency_trust" \
  "$canary_untrusted" "$canary_trust_before" "$canary_trust_after"
progress "${completionMessage}"
/usr/bin/printf '%s\n' ${completionMarker}
`.trim();
}

/**
 * Reboot the phase-one filesystem, execute its installed bottles, exercise the
 * no-op upgrade path at the same pinned versions, and remove only the packages
 * installed by the lifecycle proof.
 *
 * A real old-to-new bottle transition needs two immutable published versions
 * and is intentionally a later live fixture. This phase does not call
 * `brew update`: the guest bootstrap is a patched immutable source archive,
 * so replacing that source through an ambient update would lose its reviewed
 * Kandelo boundary.
 */
export function createHomebrewGuestLifecyclePhaseTwoScript(
  revisions: HomebrewGuestLifecycleRevisions,
): string {
  assertHomebrewGuestLifecycleRevisions(revisions);
  return String.raw`
set -euo pipefail
fail() { printf 'homebrew-guest-lifecycle-reboot: %s\n' "$*" >&2; exit 1; }
progress() { printf 'homebrew-guest-lifecycle-reboot: %s\n' "$*"; }
assert_precomposed_bottle() {
  /usr/bin/ruby -rjson -e '
    receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
    abort "precomposed package was not built as a bottle" unless
      receipt.fetch("built_as_bottle") == true
    abort "precomposed package falsely claims a Homebrew pour" unless
      receipt.fetch("poured_from_bottle") == false
  ' "$1"
}
assert_poured() {
  /usr/bin/ruby -rjson -e '
    receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
    abort "bottle was not poured" unless receipt.fetch("poured_from_bottle") == true
  ' "$1"
}
snapshot_trust() {
  /usr/bin/brew trust --json=v1 >"$1"
}
assert_formula_trust() {
  /usr/bin/ruby -rjson -e '
    document = JSON.parse(File.binread(ARGV.fetch(0)))
    tap = ARGV.fetch(1)
    formula = ARGV.fetch(2)
    expected = ARGV.fetch(3) == "present"
    taps = document.fetch("taps")
    formulae = document.fetch("formulae")
    abort "trust JSON has invalid tap or Formula entries" unless
      taps.is_a?(Array) && formulae.is_a?(Array)
    abort "lifecycle granted whole-tap trust" if taps.include?(tap)
    present = formulae.include?(formula)
    abort "Formula trust state differs from lifecycle phase" unless present == expected
  ' "$1" "$2" "$3" "$4"
}
assert_no_tap_trust() {
  /usr/bin/ruby -rjson -e '
    document = JSON.parse(File.binread(ARGV.fetch(0)))
    tap = ARGV.fetch(1)
    prefix = "#{tap}/"
    abort "whole-tap trust remains after lifecycle cleanup" if
      document.fetch("taps").include?(tap)
    %w[formulae casks commands].each do |key|
      abort "#{key} trust remains after lifecycle cleanup" if
        document.fetch(key).any? { |entry| entry.start_with?(prefix) }
    end
  ' "$1" "$2"
}
assert_clean_tap() {
  tap_root="$1"
  expected_origin="$2"
  expected_revision="$3"
  [ "$(/usr/bin/git -C "$tap_root" remote get-url origin)" = "$expected_origin" ] ||
    fail "tap origin changed across reboot"
  [ "$(/usr/bin/git -C "$tap_root" rev-parse HEAD)" = "$expected_revision" ] ||
    fail "tap revision changed across reboot"
  [ -z "$(/usr/bin/git -C "$tap_root" status --porcelain=v1 --untracked-files=all)" ] ||
    fail "tap checkout became dirty"
}
assert_bzip2_roundtrip() {
  prefix="$1"
  input=/tmp/kandelo-homebrew-bzip2-reboot.input
  archive=/tmp/kandelo-homebrew-bzip2-reboot.bz2
  output=/tmp/kandelo-homebrew-bzip2-reboot.output
  /usr/bin/printf 'Kandelo durable Homebrew state\n' >"$input"
  "$prefix/bin/bzip2" -c "$input" >"$archive"
  "$prefix/bin/bzip2" -dc "$archive" >"$output"
  /usr/bin/cmp "$input" "$output"
  /usr/bin/rm -f "$input" "$archive" "$output"
}
snapshot_package_identity() {
  formula="$1"
  destination="$2"
  prefix="$(/usr/bin/brew --prefix "$formula")"
  versions="$(/usr/bin/brew list --versions --full-name "$formula")"
  [ -n "$versions" ] || fail "brew list omitted installed identity for $formula"
  # WHY: a successful brew upgrade does not prove it was a no-op. Bind the
  # exact Cellar path, reported version, receipt bytes, and complete keg tree
  # so replacement, relinking, or receipt mutation cannot masquerade as one.
  /usr/bin/ruby -rdigest -rjson -e '
    root = ARGV.fetch(0)
    formula = ARGV.fetch(1)
    versions = ARGV.fetch(2)
    receipt_path = File.join(root, "INSTALL_RECEIPT.json")
    receipt = File.binread(receipt_path)
    entries = Dir.glob(
      File.join(root, "**", "*"),
      File::FNM_DOTMATCH,
    ).reject { |path| [".", ".."].include?(File.basename(path)) }.sort.map do |path|
      relative = path.delete_prefix("#{root}/")
      stat = File.lstat(path)
      payload = case stat.ftype
                when "file"
                  Digest::SHA256.file(path).hexdigest
                when "link"
                  File.readlink(path)
                when "directory"
                  nil
                else
                  abort "unsupported keg entry type #{stat.ftype}: #{relative}"
                end
      [relative, stat.ftype, stat.mode & 0o7777, stat.nlink, stat.size, payload]
    end
    identity = {
      "full_name" => formula,
      "prefix" => root,
      "versions" => versions,
      "receipt_sha256" => Digest::SHA256.hexdigest(receipt),
      "content_sha256" => Digest::SHA256.hexdigest(JSON.generate(entries)),
    }
    STDOUT.write(JSON.generate(identity))
    STDOUT.write("\n")
  ' "$prefix" "$formula" "$versions" >"$destination"
}

export HOMEBREW_NO_ANALYTICS=1
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1
# WHY: preserve Homebrew's paired no-API mode after reboot. The internal
# companion flag keeps core metadata unavailable instead of cloning core.
export HOMEBREW_NO_INSTALL_FROM_API=1
export HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1
export HOMEBREW_REQUIRE_TAP_TRUST=1
export GIT_TERMINAL_PROMPT=0

repository="$(/usr/bin/brew --repository)"
state="$repository/var/homebrew/kandelo-guest-lifecycle-state"
[ -f "$state" ] || fail "durable lifecycle state is missing after reboot"
{
  IFS= read -r saved_core_revision
  IFS= read -r saved_canary_revision
} <"$state"
[ "$saved_core_revision" = "${revisions.coreRevision}" ] ||
  fail "first-party tap revision state changed across reboot"
[ "$saved_canary_revision" = "${revisions.canaryRevision}" ] ||
  fail "third-party tap revision state changed across reboot"

core_tap="$(/usr/bin/brew --repository ${CORE_TAP})"
canary_tap="$(/usr/bin/brew --repository ${CANARY_TAP})"
assert_clean_tap "$core_tap" ${CORE_ORIGIN} ${revisions.coreRevision}
assert_clean_tap "$canary_tap" ${CANARY_ORIGIN} ${revisions.canaryRevision}

# WHY: no Formula-evaluating operation has run in this boot yet. Observing the
# narrow entries now proves the exported rootfs carried trust state across the
# real reboot instead of the second phase silently recreating it.
reboot_trust=/tmp/kandelo-homebrew-reboot.trust.json
snapshot_trust "$reboot_trust"
assert_formula_trust "$reboot_trust" ${CORE_TAP} ${CORE_BZIP2} present
assert_formula_trust "$reboot_trust" ${CORE_TAP} ${CORE_DASH} present
assert_formula_trust "$reboot_trust" ${CANARY_TAP} ${CANARY_M4} present

bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
m4_prefix="$(/usr/bin/brew --prefix ${CANARY_TAP}/m4)"
dash_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/dash)"
assert_poured "$bzip2_prefix"
assert_poured "$m4_prefix"
# Dash remains the base image's direct-composed dependency; the lifecycle did
# not uninstall or repour it merely because the independently tapped M4 uses it.
assert_precomposed_bottle "$dash_prefix"

progress "executing persisted bottles after rootfs reboot"
assert_bzip2_roundtrip "$bzip2_prefix"
"$m4_prefix/bin/m4" --version >/dev/null
m4_output="$(/usr/bin/printf '%s\n' \
  'changequote([,])dnl' \
  'define([KANDELO_LIFECYCLE_VALUE],[reboot-ok])dnl' \
  'KANDELO_LIFECYCLE_VALUE' |
  "$m4_prefix/bin/m4")"
[ "$m4_output" = reboot-ok ] || fail "M4 did not execute after reboot"

progress "checking pinned upgrade state through stock Homebrew"
outdated=/tmp/kandelo-homebrew-outdated.json
before_bzip2=/tmp/kandelo-homebrew-bzip2.before.json
after_bzip2=/tmp/kandelo-homebrew-bzip2.after.json
before_m4=/tmp/kandelo-homebrew-m4.before.json
after_m4=/tmp/kandelo-homebrew-m4.after.json
/usr/bin/brew outdated --json=v2 ${CORE_BZIP2} ${CANARY_M4} >"$outdated"
/usr/bin/ruby -rjson -e '
  document = JSON.parse(File.binread(ARGV.fetch(0)))
  abort "brew outdated omitted formulae" unless document["formulae"].is_a?(Array)
  selected = document["formulae"].filter_map { |entry| entry["name"] }
  forbidden = ARGV.drop(1)
  abort "newly installed pinned Formula is unexpectedly outdated" unless
    (selected & forbidden).empty?
' "$outdated" ${CORE_BZIP2} ${CANARY_M4}
snapshot_package_identity ${CORE_TAP}/bzip2 "$before_bzip2"
snapshot_package_identity ${CANARY_TAP}/m4 "$before_m4"
/usr/bin/brew upgrade --force-bottle ${CORE_TAP}/bzip2 ${CANARY_TAP}/m4
snapshot_package_identity ${CORE_TAP}/bzip2 "$after_bzip2"
snapshot_package_identity ${CANARY_TAP}/m4 "$after_m4"
/usr/bin/cmp "$before_bzip2" "$after_bzip2" ||
  fail "pinned Bzip2 upgrade changed its exact installed identity"
/usr/bin/cmp "$before_m4" "$after_m4" ||
  fail "pinned M4 upgrade changed its exact installed identity"
assert_poured "$bzip2_prefix"
assert_poured "$m4_prefix"
assert_bzip2_roundtrip "$bzip2_prefix"
"$m4_prefix/bin/m4" --version >/dev/null
/usr/bin/rm -f \
  "$outdated" \
  "$before_bzip2" "$after_bzip2" \
  "$before_m4" "$after_m4"

progress "uninstalling lifecycle bottles and untapping both repositories"
/usr/bin/brew uninstall ${CANARY_TAP}/m4
[ ! -e "$m4_prefix" ] || fail "M4 prefix remains after uninstall"
[ -x "$dash_prefix/bin/dash" ] ||
  fail "uninstalling M4 removed its pre-existing first-party dependency"
/usr/bin/brew uninstall ${CORE_TAP}/bzip2
[ ! -e "$bzip2_prefix" ] || fail "Bzip2 prefix remains after uninstall"

# WHY: pinned stock Homebrew removes a tap checkout without deleting its
# formula-level trust entries. Revoke that narrow authority through the stock
# command while the tap still exists, then prove the untap leaves no stale
# authority that could apply if the same name is tapped again.
/usr/bin/brew untrust ${CANARY_TAP}
/usr/bin/brew untap ${CANARY_TAP}
/usr/bin/brew untrust ${CORE_TAP}
# WHY: the base shell has receipts for the rest of the direct-composed core
# closure. Force removes only this temporary tap checkout; it does not remove
# those packages or alter their receipts.
/usr/bin/brew untap --force ${CORE_TAP}
[ ! -e "$repository/Library/Taps/brandonpayton/homebrew-kandelo-canary" ] ||
  fail "third-party tap remains after untap"
[ ! -e "$repository/Library/Taps/kandelo-dev/homebrew-tap-core" ] ||
  fail "first-party tap remains after untap"
[ ! -e "$repository/Library/Taps/homebrew/homebrew-core" ] ||
  fail "lifecycle created homebrew/core"

cleanup_trust=/tmp/kandelo-homebrew-cleanup.trust.json
snapshot_trust "$cleanup_trust"
assert_no_tap_trust "$cleanup_trust" ${CANARY_TAP}
assert_no_tap_trust "$cleanup_trust" ${CORE_TAP}

/usr/bin/rm -f "$state" "$reboot_trust" "$cleanup_trust"
/usr/bin/printf '%s\n' ${HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER}
`.trim();
}
