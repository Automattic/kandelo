import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import {
  parseGalleryRoster,
  resolveEntryAvailability,
  type GalleryRoster,
  type ProductAvailabilityFacts,
} from "../src/gallery-roster";

const GALLERY_ROSTER_PATH =
  "apps/browser-demos/pages/kandelo/gallery-roster.json";

function readTrackedRoster(): string {
  return readFileSync(join(findRepoRoot(), GALLERY_ROSTER_PATH), "utf8");
}

function validRosterText(
  entries: unknown[] = [{ product: "browser-main-shell", profile: "shell" }],
): string {
  return JSON.stringify({ schema: 1, entries });
}

describe("parseGalleryRoster", () => {
  it("parses a well-formed roster and preserves entry order", () => {
    const roster = parseGalleryRoster(validRosterText([
      { product: "browser-main-shell", profile: "shell" },
      { product: "browser-main-shell", profile: "doom" },
    ]));
    expect(roster).toEqual<GalleryRoster>({
      schema: 1,
      entries: [
        { product: "browser-main-shell", profile: "shell" },
        { product: "browser-main-shell", profile: "doom" },
      ],
    });
  });

  it("rejects a non-object payload", () => {
    expect(() => parseGalleryRoster("[]")).toThrow(/must be an object/);
  });

  it("rejects an unrecognized top-level key", () => {
    expect(() => parseGalleryRoster(
      JSON.stringify({ schema: 1, entries: [], extra: true }),
    )).toThrow(/must have exactly these keys/);
  });

  // Untrusted-ish input: reject a malformed schema version, naming the
  // problem rather than silently coercing or dropping it.
  it("rejects a malformed schema version", () => {
    expect(() => parseGalleryRoster(validRosterText().replace('"schema":1', '"schema":2')))
      .toThrow(/schema must be 1, got 2/);
  });

  it("rejects a missing schema", () => {
    expect(() => parseGalleryRoster(JSON.stringify({ entries: [] })))
      .toThrow(/must have exactly these keys/);
  });

  // Untrusted-ish input: an empty roster is malformed, not "no gallery".
  it("rejects an empty entries array", () => {
    expect(() => parseGalleryRoster(validRosterText([])))
      .toThrow(/entries must not be empty/);
  });

  it("rejects entries that is not an array", () => {
    expect(() => parseGalleryRoster(JSON.stringify({ schema: 1, entries: {} })))
      .toThrow(/entries must be an array/);
  });

  it("rejects an entry that is not an object", () => {
    expect(() => parseGalleryRoster(validRosterText(["shell"])))
      .toThrow(/entries\[0\] must be an object/);
  });

  it("rejects an entry with an extra key", () => {
    expect(() => parseGalleryRoster(validRosterText([
      { product: "browser-main-shell", profile: "shell", extra: 1 },
    ]))).toThrow(/entries\[0\] must have exactly these keys/);
  });

  it("rejects an entry missing profile", () => {
    expect(() => parseGalleryRoster(
      JSON.stringify({ schema: 1, entries: [{ product: "browser-main-shell" }] }),
    )).toThrow(/entries\[0\] must have exactly these keys/);
  });

  it("rejects a non-string product", () => {
    expect(() => parseGalleryRoster(validRosterText([
      { product: 1, profile: "shell" },
    ]))).toThrow(/entries\[0\]\.product must be a lowercase identifier/);
  });

  it("rejects an uppercase identifier", () => {
    expect(() => parseGalleryRoster(validRosterText([
      { product: "Browser-Main-Shell", profile: "shell" },
    ]))).toThrow(/entries\[0\]\.product must be a lowercase identifier/);
  });

  // Untrusted-ish input: a duplicate (product, profile) pair is malformed,
  // naming which pair repeats.
  it("rejects a duplicate (product, profile) pair", () => {
    expect(() => parseGalleryRoster(validRosterText([
      { product: "browser-main-shell", profile: "shell" },
      { product: "browser-main-shell", profile: "shell" },
    ]))).toThrow(/entries\[1\] duplicates an earlier entry.*browser-main-shell.*shell/s);
  });

  it("allows the same product with different profiles", () => {
    expect(() => parseGalleryRoster(validRosterText([
      { product: "browser-main-shell", profile: "shell" },
      { product: "browser-main-shell", profile: "doom" },
    ]))).not.toThrow();
  });

  // The roster is now the ONLY authority for gallery membership and display
  // order — the app's PRESET_LIBRARY it was seeded from is deleted. Pin the
  // order here so a reordering or a dropped machine is a reviewed change.
  it("parses the tracked gallery-roster.json in its curated order", () => {
    const roster = parseGalleryRoster(readTrackedRoster());
    expect(roster.entries.map((e) => e.profile)).toEqual([
      "shell",
      "node",
      "nginx",
      "nginx-php",
      "nginx-python",
      "ruby-todo",
      "wordpress-sqlite",
      "wordpress-mariadb",
      "doom",
      "quake",
      "modeset",
      "sdl2",
      "evdev",
      "espeak",
    ]);
    // sdl2 is deliberately in the gallery even though its omission from
    // pages-vfs-product-gallery.json was known drift, not intent.
    expect(roster.entries).toContainEqual({
      product: "browser-main-shell",
      profile: "sdl2",
    });
  });
});

describe("resolveEntryAvailability", () => {
  const entry = { product: "browser-nginx", profile: "nginx" };

  it("reports available when the product is known, served, and built", () => {
    expect(resolveEntryAvailability(entry, {
      known: true,
      servedHere: true,
      built: true,
    })).toEqual({ state: "available" });
  });

  // Review Focus: a roster entry whose product cannot be resolved must
  // render disabled with a truthful, SPECIFIC reason — never silently
  // dropped from the list, and never a generic "unavailable".
  it("renders a truthful, specific reason when the product cannot be resolved", () => {
    const facts: ProductAvailabilityFacts = {
      known: false,
      servedHere: false,
      built: false,
    };
    const availability = resolveEntryAvailability(entry, facts);
    expect(availability.state).toBe("unavailable-here");
    expect(availability.reason).toBeDefined();
    expect(availability.reason).not.toMatch(/^unavailable$/i);
    expect(availability.reason).toContain("browser-nginx");
    expect(availability.reason).toMatch(/could not be resolved/);
  });

  it("reports unavailable-here with a deployment-specific reason when known but not served here", () => {
    const availability = resolveEntryAvailability(entry, {
      known: true,
      servedHere: false,
      built: false,
    });
    expect(availability.state).toBe("unavailable-here");
    expect(availability.reason).toContain("browser-nginx");
    expect(availability.reason).toMatch(/not served by this deployment/);
  });

  it("reports not-built with the build command when known, served, but absent", () => {
    const availability = resolveEntryAvailability(entry, {
      known: true,
      servedHere: true,
      built: false,
      buildCommand: "scripts/build-programs.sh browser-nginx",
    });
    expect(availability.state).toBe("not-built");
    expect(availability.reason).toContain("scripts/build-programs.sh browser-nginx");
  });

  it("reports not-built with a reason even when no build command is given", () => {
    const availability = resolveEntryAvailability(entry, {
      known: true,
      servedHere: true,
      built: false,
    });
    expect(availability.state).toBe("not-built");
    expect(availability.reason).toBeDefined();
    expect(availability.reason).toContain("browser-nginx");
  });
});
