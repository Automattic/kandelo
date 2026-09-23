import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import {
  parseKandeloDemoConfig,
  resolveDemoIdentity,
} from "../src/demo-config";
import { TRACKED_DEMO_CONFIG_SOURCES } from "../../../images/vfs/scripts/tracked-demo-config";
import { PRESET_LIBRARY } from "../../../apps/browser-demos/pages/kandelo/presets";

/**
 * TEMPORARY. Plan 1 ships image-owned identity data the app does not read
 * yet, so a transcription slip would otherwise surface as a regression during
 * the Plan 3 cutover. Delete this file in Plan 3 together with PRESET_LIBRARY.
 */
interface TrackedIdentity {
  title: string;
  summary: string;
  accent: string;
  glyph: string;
  base?: string;
  packages?: string[];
}

function identityFromTrackedSources(): Map<string, TrackedIdentity> {
  const out = new Map<string, TrackedIdentity>();
  for (const relPath of TRACKED_DEMO_CONFIG_SOURCES) {
    const config = parseKandeloDemoConfig(
      readFileSync(join(findRepoRoot(), relPath), "utf8"),
    );
    if (!config?.profiles) continue;
    for (const profileId of Object.keys(config.profiles)) {
      const identity = resolveDemoIdentity(config, profileId);
      if (identity) {
        out.set(profileId, {
          title: identity.title,
          summary: identity.summary,
          accent: identity.accent,
          glyph: identity.glyph,
          base: identity.base,
          packages: identity.packages,
        });
      }
    }
  }
  return out;
}

describe("tracked identity matches the app's preset table", () => {
  const tracked = identityFromTrackedSources();

  it.each(PRESET_LIBRARY.map((p) => [p.id, p] as const))(
    "%s identity round-trips",
    (id, preset) => {
      const entry = tracked.get(id);
      expect(entry, `no tracked identity for profile ${id}`).toBeDefined();
      // `base` embeds ABI_VERSION, so this assertion is also what makes an
      // ABI bump fail loudly here instead of shipping a stale base string in
      // every tracked image config.
      expect(entry).toEqual({
        title: preset.title,
        summary: preset.summary,
        accent: preset.accent.toLowerCase(),
        glyph: preset.glyph,
        base: preset.base,
        packages: preset.packages,
      });
    },
  );
});
