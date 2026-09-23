// The gallery LISTING's view of every first-party machine, aggregated from
// the tracked `*-demo.json` sources rather than from built images.
//
// Two rules this module exists to keep:
//
// 1. **Listing only, never boot.** `bootProfile` reads the machine it is
//    about to run from that image's own baked `/etc/kandelo/demo.json` and
//    from nothing else. This aggregate feeds the gallery's title/summary/
//    accent/glyph and nothing that decides what runs, so the two cannot
//    disagree in a way that changes behavior.
// 2. **A fresh worktree has zero `.vfs.zst` files.** Aggregating the tracked
//    SOURCES is what lets the gallery list a machine whose image has not
//    been built yet (see gallery-roster.ts's availability model), instead of
//    silently dropping the entry or throwing at boot time.
//
// Sources are imported with `?raw` so the bytes travel through the same
// `parseKandeloDemoConfig` + `validateKandeloDemoConfig` pair the image
// builders and the boot path use. A malformed tracked file fails at module
// evaluation, loudly, rather than producing a half-populated gallery.

import {
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";

import shellDemoSource
  from "../../../../../packages/registry/shell/source-rootfs-shell-demo.json?raw";
import shellDemoProfilesSource
  from "../../../../../packages/registry/shell/source-rootfs-shell-demo-profiles.json?raw";
import nodeDemoSource
  from "../../../../../packages/registry/node/node-demo.json?raw";
import nginxDemoSource
  from "../../../../../packages/registry/nginx/nginx-demo.json?raw";
import nginxPhpDemoSource
  from "../../../../../packages/registry/nginx/nginx-php-demo.json?raw";
import nginxPythonDemoSource
  from "../../../../../packages/registry/nginx-python-vfs/nginx-python-demo.json?raw";
import wordpressDemoSource
  from "../../../../../packages/registry/wordpress/wordpress-demo.json?raw";
import lampDemoSource
  from "../../../../../packages/registry/wordpress/lamp-demo.json?raw";
import rubyTodoDemoSource
  from "../../../../../packages/registry/ruby/ruby-todo-demo.json?raw";

function parseTracked(source: string, label: string): KandeloDemoConfig {
  const config = parseKandeloDemoConfig(source);
  if (config === null) {
    throw new Error(`${label} has an unsupported demo-config version`);
  }
  validateKandeloDemoConfig(config);
  return config;
}

/**
 * Mirror of `composeSourceRootfsDemoConfig`
 * (images/vfs/scripts/build-source-rootfs-shell-image.ts): the shell image is
 * the one COMPOSED image, so no single tracked file's bytes are its
 * `/etc/kandelo/demo.json`. The property that holds instead is deterministic
 * re-derivation — the overlay may only declare `version` and `profiles`, and
 * a profile it shares with the base must match the base structurally.
 *
 * The builder is the authority; this is the listing's copy of the same pure
 * function, and it applies the same two rules so a drifting overlay fails
 * here as well as there.
 */
function composeShellDemoConfig(
  base: KandeloDemoConfig,
  overlay: KandeloDemoConfig,
): KandeloDemoConfig {
  const strayOverlayKeys = Object.keys(overlay)
    .filter((key) => key !== "version" && key !== "profiles")
    .sort();
  if (strayOverlayKeys.length > 0) {
    throw new Error(
      "source-rootfs demo profile overlay must contain only named profiles, "
        + `but declares: ${strayOverlayKeys.join(", ")}`,
    );
  }
  const baseProfiles = base.profiles ?? {};
  const overlayProfiles = overlay.profiles ?? {};
  const profiles = { ...baseProfiles };
  for (const [profileId, overlayProfile] of Object.entries(overlayProfiles)) {
    const existing = baseProfiles[profileId];
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(overlayProfile)) {
        throw new Error(
          `source-rootfs demo profile overlay drifts from base profile ${profileId}`,
        );
      }
      continue;
    }
    profiles[profileId] = overlayProfile;
  }
  const composed: KandeloDemoConfig = { ...base, profiles };
  validateKandeloDemoConfig(composed);
  return composed;
}

/**
 * Tracked machine metadata by VFS product id — the same ids the gallery
 * roster names. A product missing from this map simply has no tracked
 * listing content; `resolveEntryAvailability` reports that as an
 * unresolvable product rather than the caller inventing a machine.
 */
export const TRACKED_DEMO_CONFIG_BY_PRODUCT: Readonly<
  Record<string, KandeloDemoConfig>
> = Object.freeze({
  "browser-main-shell": composeShellDemoConfig(
    parseTracked(shellDemoSource, "source-rootfs-shell-demo.json"),
    parseTracked(
      shellDemoProfilesSource,
      "source-rootfs-shell-demo-profiles.json",
    ),
  ),
  "browser-node": parseTracked(nodeDemoSource, "node-demo.json"),
  "browser-nginx": parseTracked(nginxDemoSource, "nginx-demo.json"),
  "browser-nginx-php": parseTracked(nginxPhpDemoSource, "nginx-php-demo.json"),
  "browser-nginx-python": parseTracked(
    nginxPythonDemoSource,
    "nginx-python-demo.json",
  ),
  "browser-wordpress": parseTracked(wordpressDemoSource, "wordpress-demo.json"),
  "browser-lamp": parseTracked(lampDemoSource, "lamp-demo.json"),
  "browser-ruby-todo": parseTracked(rubyTodoDemoSource, "ruby-todo-demo.json"),
});
