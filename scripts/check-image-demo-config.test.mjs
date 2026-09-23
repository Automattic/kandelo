import { describe, expect, it } from "vitest";
import {
  assertValidDemoConfig,
  checkTrackedDemoConfigs,
  nearMissKeys,
  parseTrackedSourcePaths,
} from "./check-image-demo-config.mjs";

describe("tracked demo-config checker", () => {
  it("accepts the repository's tracked sources", () => {
    expect(() => checkTrackedDemoConfigs()).not.toThrow();
  });

  // Review Focus 3: a typo'd block is tolerated as an unknown key, so the
  // machine would boot with defaults and no diagnostic. This is the only
  // place that can catch it.
  it("flags a near-miss key", () => {
    expect(nearMissKeys({ runtimee: {}, init: {} }))
      .toEqual([{ found: "runtimee", meant: "runtime" }]);
  });

  it("allows a genuinely unknown key", () => {
    expect(nearMissKeys({ futureThing: {} })).toEqual([]);
  });

  it("is case-insensitive about near misses", () => {
    expect(nearMissKeys({ Runtime: {} }))
      .toEqual([{ found: "Runtime", meant: "runtime" }]);
  });

  // Review finding: KandeloDemoConfig declares the same block-key set at
  // the top level as inside profiles.<id>, and every resolveDemoX falls
  // back from the profile value to the top-level config.X. A top-level
  // near-miss is exactly as dangerous as a profile-nested one, so it must
  // be checked too, not just nearMissKeys() on each profile.
  it("flags a near-miss key at the top level of the demo config", () => {
    expect(() => assertValidDemoConfig({ version: 1, runtimee: {} }, "fixture.json"))
      .toThrow(/fixture\.json demo config has key "runtimee" — did you mean "runtime"/);
  });

  it("still flags a near-miss nested under a profile", () => {
    expect(() =>
      assertValidDemoConfig(
        { version: 1, profiles: { node: { runtimee: {} } } },
        "fixture.json",
      )
    ).toThrow(/fixture\.json profiles\.node has key "runtimee" — did you mean "runtime"/);
  });

  // Review finding: the old regex was a non-greedy match up to the first
  // bare `]`. A comment placed between array entries that happens to
  // contain a `]` would make it stop early and return a short, non-empty
  // list — silently skipping every source declared after the comment
  // instead of failing loudly.
  it("does not truncate the tracked-source list at a `]` inside a comment", () => {
    const fixture = `
      export const TRACKED_DEMO_CONFIG_SOURCES = [
        "packages/registry/shell/source-rootfs-shell-demo.json",
        // note: an array literal like [a, b] should not truncate this match
        "packages/registry/node/node-demo.json",
      ] as const;
    `;
    expect(parseTrackedSourcePaths(fixture)).toEqual([
      "packages/registry/shell/source-rootfs-shell-demo.json",
      "packages/registry/node/node-demo.json",
    ]);
  });

  // Review finding: the comment stripper is not string-literal aware, so a
  // smarter stripper would only close one extraction failure mode. Asserting
  // the SHAPE of every extracted value closes the whole class: anything the
  // regex picked up that is not a repository-relative path fails loudly
  // instead of being checked as if it were a tracked source.
  it("rejects an extracted value that is not a repo-relative path", () => {
    // A `//` INSIDE a quoted path is the string-literal-awareness gap: the
    // line-comment stripper truncates that entry mid-string, so the next
    // line's opening quote closes it and the extracted "path" spans a
    // newline. The shape assertion catches that; a smarter stripper would
    // only have closed this one case.
    const fixture = `
      export const TRACKED_DEMO_CONFIG_SOURCES = [
        "packages/registry/node//node-demo.json",
        "packages/registry/nginx/nginx-demo.json",
      ] as const;
    `;
    expect(() => parseTrackedSourcePaths(fixture))
      .toThrow(/not a repository-relative path/);
  });

  it("rejects an absolute extracted path", () => {
    const fixture = `
      export const TRACKED_DEMO_CONFIG_SOURCES = [
        "/etc/kandelo/demo.json",
      ] as const;
    `;
    expect(() => parseTrackedSourcePaths(fixture))
      .toThrow(/not a repository-relative path/);
  });
});
