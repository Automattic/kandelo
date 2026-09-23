import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../host/src/binary-resolver.ts";
import { ensureDirRecursive, writeVfsBinary } from "../host/src/vfs/image-helpers.ts";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs.ts";
import { KANDELO_DEMO_CONFIG_PATH } from "../web-libs/kandelo-session/src/demo-config.ts";
import {
  assertValidDemoConfig,
  checkBakedEqualsTracked,
  checkTrackedDemoConfigs,
  COMPOSED_TRACKED_SOURCES,
  nearMissKeys,
  parseTrackedSourcePaths,
  SINGLE_SOURCE_IMAGE_ARTIFACTS,
  trackedSourcePaths,
} from "./check-image-demo-config.ts";

/** Build a real, restorable VFS image whose only content is the given bytes
 *  at /etc/kandelo/demo.json, so tests can exercise the real image-reading
 *  path (MemoryFileSystem.fromImage + lstat/open/read/close) without
 *  needing an actual built product artifact on disk. */
async function buildImageWithDemoJson(bytes) {
  const fs = MemoryFileSystem.createFresh(4 * 1024 * 1024);
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, bytes, 0o644);
  return fs.saveImage();
}

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

describe("baked-equals-tracked", () => {
  const repoRoot = findRepoRoot();

  // Review requirement: every tracked source must be classified as either
  // composed (cannot be byte-compared) or single-source (has exactly one
  // built-image artifact). A gap here is exactly what would let a tenth
  // tracked source silently skip the byte-identity check forever, so this
  // must hold for the REAL tracked-source list, not just a fixture.
  it("classifies every real tracked source as composed XOR single-source", () => {
    for (const relPath of trackedSourcePaths()) {
      const inComposed = COMPOSED_TRACKED_SOURCES.has(relPath);
      const inSingleSource = Object.hasOwn(SINGLE_SOURCE_IMAGE_ARTIFACTS, relPath);
      expect(inComposed, `${relPath} composed`).not.toBe(inSingleSource);
    }
  });

  it("compares every single-source tracked file against a matching synthetic image", async () => {
    const imageByArtifact = new Map();
    for (const [relPath, artifactRelPath] of Object.entries(SINGLE_SOURCE_IMAGE_ARTIFACTS)) {
      const trackedBytes = readFileSync(join(repoRoot, relPath));
      imageByArtifact.set(artifactRelPath, await buildImageWithDemoJson(trackedBytes));
    }
    const report = checkBakedEqualsTracked(
      (artifactRelPath) => imageByArtifact.get(artifactRelPath) ?? null,
    );
    expect(report.skippedNotBuilt).toEqual([]);
    expect([...report.skippedComposed].sort()).toEqual([...COMPOSED_TRACKED_SOURCES].sort());
    expect(report.compared.length).toBe(Object.keys(SINGLE_SOURCE_IMAGE_ARTIFACTS).length);
  });

  it("throws a descriptive error when the baked bytes differ from the tracked source", async () => {
    const relPath = "packages/registry/node/node-demo.json";
    const artifactRelPath = SINGLE_SOURCE_IMAGE_ARTIFACTS[relPath];
    const badImage = await buildImageWithDemoJson(
      new TextEncoder().encode('{"version":1,"profiles":{"node":{}}}'),
    );
    expect(() =>
      checkBakedEqualsTracked((rel) => (rel === artifactRelPath ? badImage : null))
    ).toThrow(new RegExp(`${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} does not match`));
  });

  it("skips cleanly, with no failure, when no image is built (fresh worktree)", () => {
    const report = checkBakedEqualsTracked(() => null);
    expect(report.compared).toEqual([]);
    expect([...report.skippedComposed].sort()).toEqual([...COMPOSED_TRACKED_SOURCES].sort());
    expect(report.skippedNotBuilt.length).toBe(
      Object.keys(SINGLE_SOURCE_IMAGE_ARTIFACTS).length,
    );
  });

  // Review requirement: must not report success for an image it could not
  // compare. The composed shell sources have no entry in
  // SINGLE_SOURCE_IMAGE_ARTIFACTS, so they must be skipped before
  // readArtifact is ever invoked — readArtifact must only ever be asked
  // about single-source artifact paths, never about a composed source.
  it("only asks readArtifact about single-source artifacts, never a composed one", () => {
    const requested = [];
    checkBakedEqualsTracked((artifactRelPath) => {
      requested.push(artifactRelPath);
      return null;
    });
    expect(requested.sort()).toEqual(
      [...Object.values(SINGLE_SOURCE_IMAGE_ARTIFACTS)].sort(),
    );
  });
});
