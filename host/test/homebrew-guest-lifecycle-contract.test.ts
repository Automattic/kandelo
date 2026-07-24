import { describe, expect, it } from "vitest";

import {
  createHomebrewGuestLifecycleScript,
  HOMEBREW_GUEST_LIFECYCLE_ABI,
  HOMEBREW_GUEST_LIFECYCLE_CORE,
  HOMEBREW_GUEST_LIFECYCLE_HOMEBREW_REVISION,
  HOMEBREW_GUEST_LIFECYCLE_MARKER,
  type HomebrewGuestCanaryIdentity,
} from "../../scripts/homebrew-guest-lifecycle-contract";

const finalizedCanary: HomebrewGuestCanaryIdentity = {
  revision: "a".repeat(40),
  formulaSha256: "b".repeat(64),
  bottleSha256: "c".repeat(64),
  bottleRebuild: 4,
};

describe("stock Homebrew guest lifecycle contract", () => {
  it("binds anonymous first- and third-party installs to exact public identities", () => {
    const script = createHomebrewGuestLifecycleScript(finalizedCanary);

    expect(script).toContain(
      `metadata.fetch("kandelo_abi") == ${HOMEBREW_GUEST_LIFECYCLE_ABI}`,
    );
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_HOMEBREW_REVISION);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.revision);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.supportSha256);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.bzip2.formulaSha256);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.bzip2.sourceFormulaSha256);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.bzip2.bottleSha256);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.dash.formulaSha256);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.dash.sourceFormulaSha256);
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_CORE.dash.bottleSha256);
    expect(script).toContain(finalizedCanary.revision);
    expect(script).toContain(finalizedCanary.formulaSha256);
    expect(script).toContain(finalizedCanary.bottleSha256);
    expect(script).toContain(
      "/usr/bin/brew install --no-ask --force-bottle " +
        `'${HOMEBREW_GUEST_LIFECYCLE_CORE.bzip2.fullName}'`,
    );
    expect(script).toContain(
      "/usr/bin/brew install --no-ask --force-bottle " +
        "'brandonpayton/kandelo-canary/m4'",
    );
    expect(script.match(/\/usr\/bin\/brew install --no-ask --force-bottle/g)).toHaveLength(2);
    expect(script).toContain("receipt does not prove a bottle pour");
    expect(script).toContain("cached bottle digest");
    expect(script).toContain("bottle ABI mismatch");
    expect(script).toContain("Kandelo Bzip2 bottle round trip");
    expect(script).toContain("KANDELO_DASH_BOTTLE_OK");
    expect(script).toContain("child-process:child-ok");
    expect(script).toContain(HOMEBREW_GUEST_LIFECYCLE_MARKER);
  });

  it("proves public stock behavior without credentials or tap mutation", () => {
    const script = createHomebrewGuestLifecycleScript(finalizedCanary);

    expect(script).toContain("unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN");
    expect(script).toContain(
      "unset HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN",
    );
    expect(script).toContain("export HOMEBREW_NO_AUTO_UPDATE=1");
    expect(script).toContain("export HOMEBREW_NO_INSTALL_FROM_API=1");
    expect(script).toContain(
      `/usr/bin/brew tap '${HOMEBREW_GUEST_LIFECYCLE_CORE.tapName}'`,
    );
    expect(script).toContain("/usr/bin/brew tap 'brandonpayton/kandelo-canary'");
    expect(script).toContain("git -C \"$core_tap\" checkout --quiet --detach FETCH_HEAD");
    expect(script).toContain("git -C \"$canary_tap\" checkout --quiet --detach FETCH_HEAD");
    expect(script.match(/assert_clean_tap "\$core_tap"/g)).toHaveLength(2);
    expect(script.match(/assert_clean_tap "\$canary_tap"/g)).toHaveLength(2);
    expect(script).toContain("homebrew/core was installed unexpectedly");
    expect(script).not.toMatch(/\bsed\s+-i\b/);
    expect(script).not.toMatch(/\bcp\s+.*Formula\/m4\.rb/);
    expect(script).not.toMatch(/>\s*"\$canary_tap\//);
  });

  it.each([
    [{ ...finalizedCanary, revision: "A".repeat(40) }, "canary revision"],
    [{ ...finalizedCanary, formulaSha256: "b".repeat(63) }, "Formula SHA-256"],
    [{ ...finalizedCanary, bottleSha256: "not-a-digest" }, "bottle SHA-256"],
    [{ ...finalizedCanary, bottleRebuild: -1 }, "bottle rebuild"],
    [{ ...finalizedCanary, bottleRebuild: 1.5 }, "bottle rebuild"],
  ])("rejects an uncanonical final canary identity", (identity, message) => {
    expect(() =>
      createHomebrewGuestLifecycleScript(identity as HomebrewGuestCanaryIdentity),
    ).toThrow(message);
  });
});
