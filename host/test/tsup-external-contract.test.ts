import { describe, expect, it } from "vitest";

import { browserVirtualModuleCapabilities } from "../../apps/browser-demos/browser-module-contract.mjs";
import tsupConfig from "../tsup.config";

/**
 * The host package's build must externalize every specifier its *consumer's*
 * bundler resolves.
 *
 * # Why this test exists
 *
 * `host/tsup.config.ts` carried two `external:` properties on one object
 * literal — an enumerated list of browser virtual modules, and a pair of
 * patterns for suffix-shaped imports. They arrived from two different changes
 * and were merged by keeping both, which in JavaScript is not a merge: an
 * object literal keeps the LAST duplicate key, so the patterns were silently
 * discarded and `?worker&url` imports were not externalized by anything.
 *
 * Nothing failed. `npm run build` still succeeded, because no reachable entry
 * happened to import a `?worker&url` specifier at the time. The next one to do
 * so would have broken the whole `host/dist` build with `Could not resolve`,
 * which is the failure that already cost this repository its `host/dist` once
 * and sent every Node process worker through a temp-directory bundle instead.
 *
 * So this asserts the config's *resolved* external list, not its source text:
 * both halves have to survive, however the file is edited or re-merged.
 */

function resolvedExternals(): readonly (string | RegExp)[] {
  const config = tsupConfig as unknown;
  const options = Array.isArray(config) ? config[0] : config;
  const external = (options as { external?: unknown }).external;
  expect(Array.isArray(external), "tsup config `external` must be an array")
    .toBe(true);
  return external as readonly (string | RegExp)[];
}

function isExternalized(
  externals: readonly (string | RegExp)[],
  specifier: string,
): boolean {
  return externals.some((entry) =>
    typeof entry === "string" ? entry === specifier : entry.test(specifier)
  );
}

describe("host build external contract", () => {
  it("externalizes every browser virtual module and its ?url form", () => {
    const externals = resolvedExternals();
    const specifiers = Object.keys(browserVirtualModuleCapabilities);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(
        isExternalized(externals, specifier),
        `virtual module ${specifier} must be external`,
      ).toBe(true);
      expect(
        isExternalized(externals, `${specifier}?url`),
        `virtual module ${specifier}?url must be external`,
      ).toBe(true);
    }
  });

  it("externalizes suffix-shaped imports no enumerated list covers", () => {
    const externals = resolvedExternals();

    // The half a duplicate `external:` key silently deleted. `?worker&url` is
    // the case with no enumerated specifier behind it: a worker entry is a
    // path, not a virtual module, so `browserVirtualModules` can never cover
    // it and only a pattern can.
    expect(
      isExternalized(externals, "./some-worker.ts?worker&url"),
      "`?worker&url` imports must be external",
    ).toBe(true);
    expect(
      isExternalized(externals, "./some-asset.bin?url"),
      "`?url` imports must be external",
    ).toBe(true);
  });

  it("does not externalize ordinary module specifiers", () => {
    const externals = resolvedExternals();

    // Guards the patterns against being widened into "externalize everything",
    // which would turn a build error into a broken published package.
    expect(isExternalized(externals, "./kernel-worker")).toBe(false);
    expect(isExternalized(externals, "node:fs")).toBe(false);
  });
});
