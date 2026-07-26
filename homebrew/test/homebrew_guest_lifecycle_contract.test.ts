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
  for (const expected of [
    "brew tap kandelo-dev/tap-core https://github.com/Kandelo-dev/homebrew-tap-core.git",
    `checkout --detach ${revisions.coreRevision}`,
    "brew install --no-ask --force-bottle kandelo-dev/tap-core/bzip2",
    "brew reinstall --force-bottle kandelo-dev/tap-core/bzip2",
    "brew tap brandonpayton/kandelo-canary https://github.com/brandonpayton/homebrew-kandelo-canary.git",
    `checkout --detach ${revisions.canaryRevision}`,
    "brew install --no-ask --force-bottle brandonpayton/kandelo-canary/m4",
    'dependency["full_name"] == ARGV.fetch(1)',
    HOMEBREW_GUEST_LIFECYCLE_PHASE_ONE_MARKER,
  ]) {
    assert.ok(script.includes(expected), `missing lifecycle contract: ${expected}`);
  }
  assert.equal(
    script.match(/brew uninstall --ignore-dependencies/g)?.length,
    2,
    "only the Bzip2 and M4 direct-composer transitions may ignore dependents",
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
