import { describe, expect, it } from "vitest";

import { HomeTracker, RECENT_CHANGE_MS } from "../src/home-tracker";
import type { VfsTreeEntry } from "../src/kernel-host";

const NOW = 1_700_000_100_000;
const OLD = NOW - 60_000;
const OWNER = { uid: 1000, gid: 1000 };

function file(path: string, text: string | null, fingerprint: string, mtimeMs = OLD): VfsTreeEntry {
  return {
    path,
    kind: "file",
    mode: 0o644,
    ...OWNER,
    mtimeMs,
    fingerprint,
    bytes: text === null ? null : new TextEncoder().encode(text),
  };
}

const LISTING: VfsTreeEntry[] = [
  { path: "foo", kind: "directory", mode: 0o755, ...OWNER },
  file("foo/bar", "bar", "f1"),
  { path: "foo/baz", kind: "symlink", mode: 0o777, ...OWNER, target: "bar" },
  { path: "qux", kind: "other", mode: 0o600, ...OWNER },
];

async function savedTracker(): Promise<HomeTracker> {
  const tracker = await HomeTracker.from([]);
  await tracker.commit(await tracker.diff(LISTING));
  return tracker;
}

describe("HomeTracker", () => {
  it("puts every entry of a first read and skips what a saved home cannot hold", async () => {
    const tracker = await HomeTracker.from([]);
    const diff = await tracker.diff(LISTING);
    expect(diff.put.map((entry) => entry.path)).toEqual(["foo", "foo/bar", "foo/baz"]);
    expect(diff.remove).toEqual([]);
    expect(diff.skipped).toEqual(["qux"]);
  });

  it("finds nothing to save when every file comes back at a known fingerprint", async () => {
    const tracker = await savedTracker();
    expect(tracker.known(NOW)).toEqual({ "foo/bar": "f1" });
    const diff = await tracker.diff([LISTING[0]!, file("foo/bar", null, "f1"), LISTING[2]!]);
    expect(diff.put).toEqual([]);
    expect(diff.remove).toEqual([]);
  });

  it("does not trust the fingerprint of a file modified within the recent window", async () => {
    const tracker = await HomeTracker.from([]);
    const recent = NOW - RECENT_CHANGE_MS + 1;
    await tracker.commit(await tracker.diff([file("foo", "foo", "f1", recent)]));
    expect(tracker.known(NOW)).toEqual({});
    expect(tracker.known(recent + RECENT_CHANGE_MS)).toEqual({ foo: "f1" });
  });

  it("does not save a file read again whose content, time, and owner are unchanged", async () => {
    const tracker = await savedTracker();
    const diff = await tracker.diff([LISTING[0]!, file("foo/bar", "bar", "f2"), LISTING[2]!]);
    expect(diff.put).toEqual([]);
    expect(diff.fingerprints.get("foo/bar")?.fingerprint).toBe("f2");
  });

  it("saves what changed and removes what is gone", async () => {
    const tracker = await savedTracker();
    const diff = await tracker.diff([
      { path: "foo", kind: "directory", mode: 0o700, ...OWNER },
      file("foo/bar", "bar, longer", "f2"),
      file("corge", "corge", "f3"),
    ]);
    expect(diff.put.map((entry) => entry.path)).toEqual(["foo", "foo/bar", "corge"]);
    expect(diff.remove).toEqual(["foo/baz"]);

    await tracker.commit(diff);
    const again = await tracker.diff([
      { path: "foo", kind: "directory", mode: 0o700, ...OWNER },
      file("foo/bar", null, "f2"),
      file("corge", null, "f3"),
    ]);
    expect(again.put).toEqual([]);
    expect(again.remove).toEqual([]);
  });

  it("saves a file read again with the same bytes but a new owner or time", async () => {
    const tracker = await savedTracker();
    const owned = { ...file("foo/bar", "bar", "f2"), uid: 0 };
    expect((await tracker.diff([LISTING[0]!, owned, LISTING[2]!])).put).toEqual([
      { path: "foo/bar", kind: "file", mode: 0o644, uid: 0, gid: 1000, mtimeMs: OLD, bytes: owned.bytes },
    ]);
    const touched = file("foo/bar", "bar", "f2", OLD + 1);
    expect((await tracker.diff([LISTING[0]!, touched, LISTING[2]!])).put.map((entry) => entry.path))
      .toEqual(["foo/bar"]);
  });

  it("saves a path whose kind changed", async () => {
    const tracker = await savedTracker();
    const diff = await tracker.diff([
      LISTING[0]!,
      { path: "foo/bar", kind: "directory", mode: 0o644, ...OWNER },
      LISTING[2]!,
    ]);
    expect(diff.put).toEqual([{ path: "foo/bar", kind: "directory", mode: 0o644, ...OWNER }]);
  });

  it("trusts no fingerprint after a commit that carries none", async () => {
    const tracker = await savedTracker();
    await tracker.commit({ put: [], remove: [], skipped: [], fingerprints: new Map() });
    expect(tracker.known(NOW)).toEqual({});
  });

  it("saves a symlink whose target changed", async () => {
    const tracker = await savedTracker();
    const diff = await tracker.diff([
      LISTING[0]!,
      file("foo/bar", null, "f1"),
      { path: "foo/baz", kind: "symlink", mode: 0o777, ...OWNER, target: "../garply" },
    ]);
    expect(diff.put).toEqual([
      { path: "foo/baz", kind: "symlink", mode: 0o777, ...OWNER, target: "../garply" },
    ]);
  });

  it("starts from a saved home, so a seeded boot's first read saves nothing", async () => {
    const tracker = await HomeTracker.from([
      { path: "foo", kind: "directory", mode: 0o755, ...OWNER },
      { path: "foo/bar", kind: "file", mode: 0o644, ...OWNER, mtimeMs: OLD, bytes: new TextEncoder().encode("bar") },
    ]);
    const diff = await tracker.diff([LISTING[0]!, file("foo/bar", "bar", "f9")]);
    expect(diff.put).toEqual([]);
    expect(diff.remove).toEqual([]);
  });

  it("rebuilds from its states without bytes or fingerprints, and diffs as the original does", async () => {
    const original = await savedTracker();
    const states = original.states();
    expect(JSON.stringify(states)).not.toContain("bytes");
    const rebuilt = HomeTracker.fromStates(states);
    expect(rebuilt.known(NOW)).toEqual({});
    const listing = [LISTING[0]!, file("foo/bar", "baz", "f2"), file("quux", "quux", "f3")];
    const diff = await rebuilt.diff(listing);
    expect(diff.put.map((entry) => entry.path)).toEqual(["foo/bar", "quux"]);
    expect(diff.remove).toEqual(["foo/baz"]);
    expect(diff).toEqual(await original.diff(listing));
  });
});
