import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
 * files still render the gallery. This file guards the property that
 * aggregation depends on, now that the app-side `PRESET_LIBRARY` those ids
 * used to be checked against is gone: every curated roster entry names a
 * tracked profile that declares an `identity`. Without one there is nothing
 * truthful to display, and the entry silently disappears from the gallery.
 *
 * There is no ABI assertion here any more, because it no longer has a
 * subject. It checked that every tracked `identity.base` named the current
 * `ABI_VERSION`; `identity.base` has been removed from the schema (nothing
 * verified the declared string, and `live-setup.ts` computes
 * `kandelo:shell@abi${ABI_VERSION}` itself), so the assertion would have had
 * nothing to read. ABI compatibility is enforced where it actually bites:
 * the strict `__abi_version` equality check on every binary.
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
    },
  );
});
