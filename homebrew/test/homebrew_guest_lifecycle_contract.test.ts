import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertHomebrewGuestLifecycleRevisions,
  createHomebrewGuestLifecyclePhaseOneScript,
  createHomebrewGuestLifecyclePhaseTwoScript,
  createHomebrewGuestShippingProofScript,
  HOMEBREW_GUEST_CANARY_SHIPPING_PROOF_MARKER,
  HOMEBREW_GUEST_CORE_SHIPPING_PROOF_MARKER,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
} from "./homebrew_guest_lifecycle_contract";

const revisions = {
  coreRevision: "1".repeat(40),
  canaryRevision: "2".repeat(40),
};

test("requires immutable lower-case tap revisions", () => {
  assert.doesNotThrow(() => assertHomebrewGuestLifecycleRevisions(revisions));
  for (const candidate of [
    "",
    "1".repeat(39),
    "1".repeat(41),
    "A".repeat(40),
    `${"1".repeat(40)}; touch /tmp/injected`,
  ]) {
    assert.throws(
      () => assertHomebrewGuestLifecycleRevisions({
        ...revisions,
        coreRevision: candidate,
      }),
      /exact lowercase 40-character SHA/,
    );
  }
});

test("core shipping scope pours and runs only the first-party bottle", () => {
  const script = createHomebrewGuestShippingProofScript(revisions, "core");
  assertBoundedShippingScript(script, "core shipping proof");
  for (const expected of [
    "starting bounded core bottle shipping proof",
    "brew tap kandelo-dev/tap-core https://github.com/Kandelo-dev/homebrew-tap-core.git",
    "first-party tap command completed",
    "fetching the exact first-party repository revision",
    "first-party repository fetch completed",
    `checkout --detach ${revisions.coreRevision}`,
    "first-party repository revision pinned and clean",
    "brew install --no-ask --force-bottle kandelo-dev/tap-core/bzip2",
    "assert_bzip2_roundtrip \"$bzip2_prefix\"",
    "first-party Bzip2 bottle installation is ready to ship",
    HOMEBREW_GUEST_CORE_SHIPPING_PROOF_MARKER,
  ]) {
    assert.ok(script.includes(expected), `missing core contract: ${expected}`);
  }
  for (const forbidden of [
    "brew tap brandonpayton/kandelo-canary https://github.com/brandonpayton/homebrew-kandelo-canary.git",
    "brandonpayton/kandelo-canary/m4-canary",
    "brew trust --formula kandelo-dev/tap-core/dash",
    HOMEBREW_GUEST_CANARY_SHIPPING_PROOF_MARKER,
  ]) {
    assert.ok(!script.includes(forbidden), `core scope includes: ${forbidden}`);
  }
  assert.equal(
    script.match(/brew install --no-ask --force-bottle/g)?.length,
    1,
  );
  assert.equal(
    script.match(/brew uninstall --ignore-dependencies/g)?.length,
    1,
  );
  assert.equal(script.match(/^assert_poured /gm)?.length, 1);
  assert.equal(script.match(/^assert_runtime_dependency /gm)?.length ?? 0, 0);
});

test("canary shipping scope proves M4's exact first-party dependency", () => {
  const script = createHomebrewGuestShippingProofScript(revisions, "canary");
  assertBoundedShippingScript(script, "canary shipping proof");
  for (const expected of [
    "starting bounded independent-canary bottle shipping proof",
    "brew tap kandelo-dev/tap-core https://github.com/Kandelo-dev/homebrew-tap-core.git",
    `checkout --detach ${revisions.coreRevision}`,
    "brew tap brandonpayton/kandelo-canary https://github.com/brandonpayton/homebrew-kandelo-canary.git",
    `checkout --detach ${revisions.canaryRevision}`,
    "brew trust --formula kandelo-dev/tap-core/dash",
    "brew install --no-ask --force-bottle brandonpayton/kandelo-canary/m4-canary",
    'assert_runtime_dependency "$canary_m4_prefix" kandelo-dev/tap-core/dash',
    'assert_precomposed_bottle "$dash_prefix"',
    'assert_precomposed_bottle "$core_m4_prefix"',
    '"$core_m4_prefix/bin/m4" --version',
    '"$canary_m4_prefix/bin/m4" --version',
    "assert_m4_execution \"$canary_m4_prefix\" cross-tap-ok",
    "assert_formula_trust \"$core_dependency_trust\" kandelo-dev/tap-core kandelo-dev/tap-core/bzip2 absent",
    "assert_formula_trust \"$core_dependency_trust\" kandelo-dev/tap-core kandelo-dev/tap-core/dash present",
    "independent-canary M4 bottle installation is ready to ship",
    HOMEBREW_GUEST_CANARY_SHIPPING_PROOF_MARKER,
  ]) {
    assert.ok(script.includes(expected), `missing canary contract: ${expected}`);
  }
  for (const forbidden of [
    "brew install --no-ask --force-bottle kandelo-dev/tap-core/bzip2",
    "assert_bzip2_roundtrip \"$bzip2_prefix\"",
    HOMEBREW_GUEST_CORE_SHIPPING_PROOF_MARKER,
  ]) {
    assert.ok(!script.includes(forbidden), `canary scope includes: ${forbidden}`);
  }
  assert.equal(
    script.match(/brew install --no-ask --force-bottle/g)?.length,
    1,
  );
  assert.equal(
    script.match(/brew uninstall --ignore-dependencies/g)?.length ?? 0,
    0,
  );
  assert.equal(script.match(/^assert_poured /gm)?.length, 1);
  assert.equal(script.match(/^assert_runtime_dependency /gm)?.length, 1);
});

function assertBoundedShippingScript(script: string, label: string): void {
  assertShellSyntax(script);
  assertPairedNoApiEnvironment(script, label);
  assertRequiresTapTrust(script, label);
  assertSelectedHomebrewRuntimeCommands(script, label);
  for (const forbidden of [
    "brew reinstall",
    "brew upgrade",
    "brew untap",
    "kandelo-guest-lifecycle-state",
    HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
    HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
    "File.binwrite",
    "sed -i",
  ]) {
    assert.ok(
      !script.includes(forbidden),
      `shipping proof includes non-shipping work: ${forbidden}`,
    );
  }
}

test("phase one uses only stock Homebrew against clean canonical tap checkouts", () => {
  const script = createHomebrewGuestLifecyclePhaseOneScript(revisions);
  assertShellSyntax(script);
  assertPairedNoApiEnvironment(script, "phase one");
  assertRequiresTapTrust(script, "phase one");
  assertSelectedHomebrewRuntimeCommands(script, "phase one");
  for (const expected of [
    "brew tap kandelo-dev/tap-core https://github.com/Kandelo-dev/homebrew-tap-core.git",
    `checkout --detach ${revisions.coreRevision}`,
    "brew install --no-ask --force-bottle kandelo-dev/tap-core/bzip2",
    "brew reinstall --force-bottle kandelo-dev/tap-core/bzip2",
    "brew trust --formula kandelo-dev/tap-core/dash",
    "brew tap brandonpayton/kandelo-canary https://github.com/brandonpayton/homebrew-kandelo-canary.git",
    `checkout --detach ${revisions.canaryRevision}`,
    "brew install --no-ask --force-bottle brandonpayton/kandelo-canary/m4-canary",
    "brew reinstall --force-bottle brandonpayton/kandelo-canary/m4-canary",
    'assert_runtime_dependency "$canary_m4_prefix" kandelo-dev/tap-core/dash',
    'assert_runtime_dependency "$reinstalled_canary_m4_prefix" kandelo-dev/tap-core/dash',
    "cross-tap-reinstall-ok",
    "brew untrust --tap",
    "brew trust --json=v1",
    "assert_formula_trust \"$canary_trust_before\" brandonpayton/kandelo-canary brandonpayton/kandelo-canary/m4-canary absent",
    "assert_formula_trust \"$canary_trust_after\" brandonpayton/kandelo-canary brandonpayton/kandelo-canary/m4-canary present",
    "assert_formula_trust \"$core_dependency_trust\" kandelo-dev/tap-core kandelo-dev/tap-core/dash present",
    "assert_untrusted_tap_discovery kandelo-dev/tap-core \"$core_untrusted\"",
    "assert_untrusted_tap_discovery brandonpayton/kandelo-canary \"$canary_untrusted\"",
    'dependency["full_name"] == ARGV.fetch(1)',
    'receipt.fetch("built_as_bottle") == true',
    'receipt.fetch("poured_from_bottle") == false',
    'assert_precomposed_bottle "$composed_bzip2_prefix"',
    'assert_precomposed_bottle "$core_m4_prefix"',
    'assert_precomposed_bottle "$dash_prefix"',
    HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  ]) {
    assert.ok(script.includes(expected), `missing lifecycle contract: ${expected}`);
  }
  assert.equal(
    script.match(/brew uninstall --ignore-dependencies/g)?.length,
    1,
    "only the Bzip2 direct-composer transition may ignore dependents",
  );
  assert.equal(
    script.match(/^assert_precomposed_bottle /gm)?.length,
    7,
    "Bzip2, core M4, and Dash must retain direct-composed receipts",
  );
  assert.equal(
    script.match(/^assert_poured /gm)?.length,
    4,
    "only stock Bzip2 and independent M4 install/reinstall may claim a pour",
  );
  assert.ok(
    !script.includes('assert_poured "$dash_prefix"'),
    "installing M4 must not make the precomposed Dash receipt claim a pour",
  );
  assert.equal(
    script.match(/brew reinstall --force-bottle brandonpayton\/kandelo-canary\/m4-canary/g)?.length,
    1,
    "the independent M4 bottle must be reinstalled exactly once",
  );
  const canaryInstall = script.indexOf(
    "brew install --no-ask --force-bottle brandonpayton/kandelo-canary/m4-canary",
  );
  const dependencyTrust = script.indexOf(
    "brew trust --formula kandelo-dev/tap-core/dash",
  );
  const canaryReinstall = script.indexOf(
    "brew reinstall --force-bottle brandonpayton/kandelo-canary/m4-canary",
  );
  const canaryTrust = script.indexOf(
    "assert_formula_trust \"$canary_trust_after\"",
  );
  assert.ok(
    dependencyTrust < canaryInstall &&
      canaryInstall < canaryReinstall &&
      canaryReinstall < canaryTrust,
    "M4 receipt, dependency, execution, and trust checks must follow reinstall",
  );
  assert.ok(
    script.includes("tapping alone must remain"),
    "the Formula-level trust boundary needs its maintenance rationale inline",
  );
  assert.ok(
    script.includes("payload deliberately still provides bin/m4"),
    "the distinct Formula and unchanged program name need a WHY comment",
  );
  for (const forbidden of [
    "File.binwrite",
    "Formula/",
    "Kandelo/formula_support",
    "sed -i",
    "homebrew/core/",
  ]) {
    assert.ok(
      !script.includes(forbidden),
      `phase one must not mutate or substitute package inputs: ${forbidden}`,
    );
  }
});

test("phase two proves durable state and labels the pinned upgrade as a no-op", () => {
  const script = createHomebrewGuestLifecyclePhaseTwoScript(revisions);
  assertShellSyntax(script);
  assertPairedNoApiEnvironment(script, "phase two");
  assertRequiresTapTrust(script, "phase two");
  assertSelectedHomebrewRuntimeCommands(script, "phase two");
  for (const expected of [
    "brew outdated --json=v2 kandelo-dev/tap-core/bzip2 brandonpayton/kandelo-canary/m4-canary",
    "snapshot_package_identity kandelo-dev/tap-core/bzip2 \"$before_bzip2\"",
    "snapshot_package_identity brandonpayton/kandelo-canary/m4-canary \"$before_m4\"",
    "brew upgrade --force-bottle kandelo-dev/tap-core/bzip2 brandonpayton/kandelo-canary/m4-canary",
    "snapshot_package_identity kandelo-dev/tap-core/bzip2 \"$after_bzip2\"",
    "snapshot_package_identity brandonpayton/kandelo-canary/m4-canary \"$after_m4\"",
    "receipt_sha256",
    "content_sha256",
    "/usr/bin/cmp \"$before_bzip2\" \"$after_bzip2\"",
    "/usr/bin/cmp \"$before_m4\" \"$after_m4\"",
    "brew uninstall brandonpayton/kandelo-canary/m4-canary",
    "brew uninstall kandelo-dev/tap-core/bzip2",
    "brew untrust brandonpayton/kandelo-canary",
    "brew untap brandonpayton/kandelo-canary",
    "brew untrust kandelo-dev/tap-core",
    "brew untap --force kandelo-dev/tap-core",
    "assert_formula_trust \"$reboot_trust\" kandelo-dev/tap-core kandelo-dev/tap-core/bzip2 present",
    "assert_formula_trust \"$reboot_trust\" kandelo-dev/tap-core kandelo-dev/tap-core/dash present",
    "assert_formula_trust \"$reboot_trust\" brandonpayton/kandelo-canary brandonpayton/kandelo-canary/m4-canary present",
    "assert_no_tap_trust \"$cleanup_trust\" brandonpayton/kandelo-canary",
    "assert_no_tap_trust \"$cleanup_trust\" kandelo-dev/tap-core",
    'assert_precomposed_bottle "$dash_prefix"',
    HOMEBREW_GUEST_LIFECYCLE_PHASE_TWO_MARKER,
  ]) {
    assert.ok(script.includes(expected), `missing reboot contract: ${expected}`);
  }
  assert.ok(!script.includes("brew update"));
  assert.ok(
    script.includes("base shell has receipts for the rest of the direct-composed core"),
    "the forced temporary untap needs its maintenance rationale inline",
  );
  assert.ok(
    script.includes("successful brew upgrade does not prove it was a no-op"),
    "the exact package snapshots need their maintenance rationale inline",
  );
  assert.ok(
    script.includes("exported rootfs carried trust state across the"),
    "the rebooted Formula trust assertion needs its durability rationale inline",
  );
  assert.ok(
    script.includes("without deleting its"),
    "the explicit trust cleanup before untap needs its upstream-boundary rationale inline",
  );
  for (const tap of [
    "brandonpayton/kandelo-canary",
    "kandelo-dev/tap-core",
  ]) {
    const untrust = script.indexOf(`brew untrust ${tap}`);
    const untap = script.indexOf(
      tap === "kandelo-dev/tap-core"
        ? `brew untap --force ${tap}`
        : `brew untap ${tap}`,
    );
    assert.ok(
      untrust < untap,
      `${tap} item trust must be revoked while stock Homebrew can still resolve the tap`,
    );
  }
  assert.equal(
    script.match(/^assert_precomposed_bottle /gm)?.length,
    3,
    "core M4 and Dash must retain direct-composition receipts across reboot",
  );
  assert.equal(
    script.match(/^assert_poured /gm)?.length,
    4,
    "only guest-installed Bzip2 and M4 may claim pours before and after upgrade",
  );
  assert.ok(
    !script.includes('assert_poured "$dash_prefix"'),
    "reboot must not relabel Dash as guest-poured",
  );
  const before = script.indexOf(
    "snapshot_package_identity kandelo-dev/tap-core/bzip2 \"$before_bzip2\"",
  );
  const upgrade = script.indexOf(
    "brew upgrade --force-bottle kandelo-dev/tap-core/bzip2",
  );
  const after = script.indexOf(
    "snapshot_package_identity kandelo-dev/tap-core/bzip2 \"$after_bzip2\"",
  );
  const comparison = script.indexOf(
    "/usr/bin/cmp \"$before_bzip2\" \"$after_bzip2\"",
  );
  assert.ok(
    before < upgrade && upgrade < after && after < comparison,
    "the exact installed identity must bracket and verify brew upgrade",
  );
});

function assertShellSyntax(script: string): void {
  const result = spawnSync("/bin/bash", ["-n"], {
    input: script,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `generated lifecycle shell is invalid: ${result.stderr}`,
  );
}

function assertPairedNoApiEnvironment(script: string, label: string): void {
  const primary = "export HOMEBREW_NO_INSTALL_FROM_API=1";
  const companion =
    "export HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1";
  assert.equal(
    script.split(primary).length - 1,
    1,
    `${label} must set the primary no-API flag exactly once`,
  );
  assert.equal(
    script.split(companion).length - 1,
    1,
    `${label} must set the no-API companion exactly once`,
  );
  assert.equal(
    script.indexOf(companion),
    script.indexOf(primary) + primary.length + 1,
    `${label} must keep Homebrew's no-API flags adjacent`,
  );
}

function assertRequiresTapTrust(script: string, label: string): void {
  assert.equal(
    script.split("export HOMEBREW_REQUIRE_TAP_TRUST=1").length - 1,
    1,
    `${label} must require stock Homebrew tap trust exactly once`,
  );
}

function assertSelectedHomebrewRuntimeCommands(
  script: string,
  label: string,
): void {
  for (const expected of [
    "homebrew_git=/opt/kandelo/homebrew/bin/git",
    "homebrew_ruby=/opt/kandelo/homebrew/bin/ruby",
    '[ -x "$homebrew_git" ]',
    '[ -x "$homebrew_ruby" ]',
    '"$homebrew_git" -C',
    '"$homebrew_ruby" -rjson',
  ]) {
    assert.ok(script.includes(expected), `${label} omits ${expected}`);
  }
  for (const forbidden of ["/usr/bin/git", "/usr/bin/ruby"]) {
    assert.ok(!script.includes(forbidden), `${label} still uses ${forbidden}`);
  }
}
