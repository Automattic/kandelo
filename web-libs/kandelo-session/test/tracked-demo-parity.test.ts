import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import {
  parseKandeloDemoConfig,
  resolveDemoIdentity,
  type DemoIdentityConfig,
} from "../src/demo-config";
import { parseGalleryRoster } from "../src/gallery-roster";
import { TRACKED_DEMO_CONFIG_SOURCES } from "../../../images/vfs/scripts/tracked-demo-config";

/**
 * The gallery listing is aggregated from the TRACKED demo-config sources, not
 * from built images — that is what lets a fresh worktree with zero `.vfs.zst`
 * files still render the gallery. This file guards the two properties that
 * aggregation depends on, now that the app-side `PRESET_LIBRARY` those ids
 * used to be checked against is gone:
 *
 * 1. Every curated roster entry names a tracked profile that declares an
 *    `identity`. Without one there is nothing truthful to display, and the
 *    entry silently disappears from the gallery.
 * 2. Every tracked `identity.base` names the CURRENT ABI. `base` embeds
 *    `ABI_VERSION`, and Kandelo enforces strict `__abi_version` equality, so
 *    an ABI bump that leaves these strings behind would ship a gallery
 *    advertising a base no built image can match. This assertion is what
 *    makes that fail here rather than in a browser.
 */
function identityByProfile(): Map<string, DemoIdentityConfig> {
  const out = new Map<string, DemoIdentityConfig>();
  for (const relPath of TRACKED_DEMO_CONFIG_SOURCES) {
    const config = parseKandeloDemoConfig(
      readFileSync(join(findRepoRoot(), relPath), "utf8"),
    );
    if (!config?.profiles) continue;
    for (const profileId of Object.keys(config.profiles)) {
      const identity = resolveDemoIdentity(config, profileId);
      if (identity) out.set(profileId, identity);
    }
  }
  return out;
}

describe("tracked demo-config identity backs the gallery roster", () => {
  const tracked = identityByProfile();
  const roster = parseGalleryRoster(
    readFileSync(
      join(
        findRepoRoot(),
        "apps/browser-demos/pages/kandelo/gallery-roster.json",
      ),
      "utf8",
    ),
  );

  it.each(roster.entries.map((entry) => [entry.profile, entry] as const))(
    "%s has tracked identity content to display",
    (profileId) => {
      const identity = tracked.get(profileId);
      expect(identity, `no tracked identity for profile ${profileId}`)
        .toBeDefined();
      expect(identity!.title.length).toBeGreaterThan(0);
      expect(identity!.summary.length).toBeGreaterThan(0);
      expect(identity!.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(identity!.glyph.length).toBeGreaterThan(0);
      // A listed machine must say which base it is built on, or the gallery
      // has no honest answer for the ABI it needs.
      expect(identity!.base, `profile ${profileId} declares no base`)
        .toBeDefined();
    },
  );

  // `base` is optional in the schema (python-demo.json declares none, and it
  // is not on the roster), but every tracked file that DOES declare one must
  // name the current ABI.
  it("declares the current ABI in every tracked identity base", () => {
    const expected = `kandelo:shell@abi${ABI_VERSION}`;
    const declared = [...tracked].filter(([, identity]) =>
      identity.base !== undefined
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const [profileId, identity] of declared) {
      expect(identity.base, `profile ${profileId}`).toBe(expected);
    }
  });
});
