import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertHomebrewGuestLifecycleRevisions,
  createHomebrewGuestLifecyclePhaseOneScript,
  createHomebrewGuestLifecyclePhaseTwoScript,
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

test("phase one uses only stock Homebrew against clean canonical tap checkouts", () => {
  const script = createHomebrewGuestLifecyclePhaseOneScript(revisions);
  assertShellSyntax(script);
  assertPairedNoApiEnvironment(script, "phase one");
  for (const expected of [
    "brew tap kandelo-dev/tap-core https://github.com/Kandelo-dev/homebrew-tap-core.git",
    `checkout --detach ${revisions.coreRevision}`,
    "brew install --no-ask --force-bottle kandelo-dev/tap-core/bzip2",
    "brew reinstall --force-bottle kandelo-dev/tap-core/bzip2",
    "brew tap brandonpayton/kandelo-canary https://github.com/brandonpayton/homebrew-kandelo-canary.git",
    `checkout --detach ${revisions.canaryRevision}`,
    "brew install --no-ask --force-bottle brandonpayton/kandelo-canary/m4",
    'dependency["full_name"] == ARGV.fetch(1)',
    'receipt.fetch("built_as_bottle") == true',
    'receipt.fetch("poured_from_bottle") == false',
    'assert_precomposed_bottle "$composed_bzip2_prefix"',
    'assert_precomposed_bottle "$composed_m4_prefix"',
    'assert_precomposed_bottle "$dash_prefix"',
    HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  ]) {
    assert.ok(script.includes(expected), `missing lifecycle contract: ${expected}`);
  }
  assert.equal(
    script.match(/brew uninstall --ignore-dependencies/g)?.length,
    2,
    "only the Bzip2 and M4 direct-composer transitions may ignore dependents",
  );
  assert.equal(
    script.match(/^assert_precomposed_bottle /gm)?.length,
    4,
    "initial Bzip2/M4 and the unchanged Dash dependency must retain composed receipts",
  );
  assert.equal(
    script.match(/^assert_poured /gm)?.length,
    3,
    "only stock Bzip2 install/reinstall and independent M4 may claim a pour",
  );
  assert.ok(
    !script.includes('assert_poured "$dash_prefix"'),
    "installing M4 must not make the precomposed Dash receipt claim a pour",
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
  for (const expected of [
    "brew outdated --json=v2",
    "snapshot_package_identity kandelo-dev/tap-core/bzip2 \"$before_bzip2\"",
    "snapshot_package_identity brandonpayton/kandelo-canary/m4 \"$before_m4\"",
    "brew upgrade --force-bottle kandelo-dev/tap-core/bzip2 brandonpayton/kandelo-canary/m4",
    "snapshot_package_identity kandelo-dev/tap-core/bzip2 \"$after_bzip2\"",
    "snapshot_package_identity brandonpayton/kandelo-canary/m4 \"$after_m4\"",
    "receipt_sha256",
    "content_sha256",
    "/usr/bin/cmp \"$before_bzip2\" \"$after_bzip2\"",
    "/usr/bin/cmp \"$before_m4\" \"$after_m4\"",
    "brew uninstall brandonpayton/kandelo-canary/m4",
    "brew uninstall kandelo-dev/tap-core/bzip2",
    "brew untap brandonpayton/kandelo-canary",
    "brew untap --force kandelo-dev/tap-core",
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
  assert.equal(
    script.match(/^assert_precomposed_bottle /gm)?.length,
    1,
    "Dash must retain its direct-composition receipt across reboot",
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
