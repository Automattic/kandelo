export const HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER =
  "KANDELO_HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_OK";
export const HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER =
  "KANDELO_HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_OK";

export const HOMEBREW_GUEST_LIFECYCLE_CORE_TAP = "kandelo-dev/tap-core";
export const HOMEBREW_GUEST_LIFECYCLE_CORE_REPOSITORY =
  "kandelo-dev/homebrew-tap-core";
const CORE_TAP = HOMEBREW_GUEST_LIFECYCLE_CORE_TAP;
const CORE_ORIGIN =
  "https://github.com/Kandelo-dev/homebrew-tap-core.git";
const CANARY_TAP = "brandonpayton/kandelo-canary";
const CANARY_ORIGIN =
  "https://github.com/brandonpayton/homebrew-kandelo-canary.git";
const EXACT_GIT_REVISION = /^[0-9a-f]{40}$/;

export interface HomebrewGuestLifecycleRevisions {
  coreRevision: string;
  canaryRevision: string;
}

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
  assertHomebrewGuestLifecycleRevisions(revisions);
  return String.raw`
set -euo pipefail
fail() { printf 'homebrew-guest-lifecycle: %s\n' "$*" >&2; exit 1; }
progress() { printf 'homebrew-guest-lifecycle: %s\n' "$*"; }
assert_poured() {
  /usr/bin/ruby -rjson -e '
    receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
    abort "bottle was not poured" unless receipt.fetch("poured_from_bottle") == true
  ' "$1"
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
export HOMEBREW_NO_INSTALL_FROM_API=1
export GIT_TERMINAL_PROMPT=0

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

# WHY: the base shell is already composed from this bottle closure. Remove the
# existing receipt through stock Homebrew so the following command proves a
# genuine install rather than accepting Homebrew's "already installed" path.
composed_bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
assert_poured "$composed_bzip2_prefix"
/usr/bin/brew uninstall --ignore-dependencies ${CORE_TAP}/bzip2
[ ! -e "$composed_bzip2_prefix" ] ||
  fail "direct-composed Bzip2 prefix remains after transition uninstall"

progress "installing and executing the first-party Bzip2 bottle"
/usr/bin/brew install --no-ask --force-bottle ${CORE_TAP}/bzip2
bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
assert_poured "$bzip2_prefix"
assert_bzip2_roundtrip "$bzip2_prefix"

progress "reinstalling and executing the first-party Bzip2 bottle"
/usr/bin/brew reinstall --force-bottle ${CORE_TAP}/bzip2
reinstalled_bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
[ "$reinstalled_bzip2_prefix" = "$bzip2_prefix" ] ||
  fail "Bzip2 reinstall changed its versioned prefix"
assert_poured "$reinstalled_bzip2_prefix"
assert_bzip2_roundtrip "$reinstalled_bzip2_prefix"

progress "tapping the exact independent third-party repository"
/usr/bin/brew tap ${CANARY_TAP} ${CANARY_ORIGIN}
canary_tap="$(/usr/bin/brew --repository ${CANARY_TAP})"
/usr/bin/git -C "$canary_tap" fetch --no-tags origin ${revisions.canaryRevision}
/usr/bin/git -C "$canary_tap" checkout --detach ${revisions.canaryRevision}
assert_clean_tap "$canary_tap" ${CANARY_ORIGIN} ${revisions.canaryRevision}
[ ! -e "$core_repository" ] || fail "third-party tap created homebrew/core"

# WHY: core M4 and canary M4 have the same conventional Cellar identity. Use
# stock uninstall to create one truthful target before the independent tap
# pours its own bottle; do not rewrite either Formula to avoid the collision.
composed_m4_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/m4)"
assert_poured "$composed_m4_prefix"
/usr/bin/brew uninstall --ignore-dependencies ${CORE_TAP}/m4
[ ! -e "$composed_m4_prefix" ] ||
  fail "direct-composed M4 prefix remains after transition uninstall"

dash_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/dash)"
assert_poured "$dash_prefix"
progress "installing independent M4 with its first-party Dash dependency"
/usr/bin/brew install --no-ask --force-bottle ${CANARY_TAP}/m4
m4_prefix="$(/usr/bin/brew --prefix ${CANARY_TAP}/m4)"
assert_poured "$m4_prefix"
assert_poured "$dash_prefix"
/usr/bin/ruby -rjson -e '
  receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
  dependencies = receipt.fetch("runtime_dependencies")
  abort "M4 receipt does not bind first-party Dash" unless
    dependencies.any? { |dependency| dependency["full_name"] == ARGV.fetch(1) }
' "$m4_prefix" ${CORE_TAP}/dash
"$m4_prefix/bin/m4" --version >/dev/null
assert_m4_execution "$m4_prefix" cross-tap-ok

state="$repository/var/homebrew/kandelo-guest-lifecycle-state"
{
  /usr/bin/printf '%s\n' ${revisions.coreRevision}
  /usr/bin/printf '%s\n' ${revisions.canaryRevision}
} >"$state"

assert_clean_tap "$core_tap" ${CORE_ORIGIN} ${revisions.coreRevision}
assert_clean_tap "$canary_tap" ${CANARY_ORIGIN} ${revisions.canaryRevision}
[ ! -e "$core_repository" ] || fail "lifecycle install created homebrew/core"
progress "phase one is durable and ready for rootfs export"
/usr/bin/printf '%s\n' ${HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER}
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
assert_poured() {
  /usr/bin/ruby -rjson -e '
    receipt = JSON.parse(File.binread(File.join(ARGV.fetch(0), "INSTALL_RECEIPT.json")))
    abort "bottle was not poured" unless receipt.fetch("poured_from_bottle") == true
  ' "$1"
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
export HOMEBREW_NO_INSTALL_FROM_API=1
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

bzip2_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/bzip2)"
m4_prefix="$(/usr/bin/brew --prefix ${CANARY_TAP}/m4)"
dash_prefix="$(/usr/bin/brew --prefix ${CORE_TAP}/dash)"
assert_poured "$bzip2_prefix"
assert_poured "$m4_prefix"
assert_poured "$dash_prefix"

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
/usr/bin/brew outdated --json=v2 >"$outdated"
/usr/bin/ruby -rjson -e '
  document = JSON.parse(File.binread(ARGV.fetch(0)))
  abort "brew outdated omitted formulae" unless document["formulae"].is_a?(Array)
  selected = document["formulae"].filter_map { |entry| entry["name"] }
  forbidden = ARGV.drop(1)
  abort "newly installed pinned Formula is unexpectedly outdated" unless
    (selected & forbidden).empty?
' "$outdated" bzip2 m4
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

/usr/bin/brew untap ${CANARY_TAP}
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

/usr/bin/rm -f "$state"
/usr/bin/printf '%s\n' ${HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER}
`.trim();
}
