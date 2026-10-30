import { describe, expect, it } from "vitest";

import {
  assertPersistentFixtureUnchanged,
  inspectPersistentFixture,
} from "../../examples/run-example-persistence-verification";
import type { VfsDirEntrySnapshot, VfsPathStat } from "../src/vfs/vfs";

const root = "/run/kandelo-run";
const directory: VfsPathStat = { mode: 0o040755, size: 0, uid: 0, gid: 0 };

function fixture() {
  const children: VfsDirEntrySnapshot[] = [
    { name: "work", ...directory },
    { name: "link", mode: 0o120777, size: 4, uid: 1, gid: 2, target: "work" },
  ];
  const work: VfsDirEntrySnapshot[] = [
    { name: "state", mode: 0o100640, size: 4, uid: 3, gid: 4 },
    { name: "large", mode: 0o100600, size: 2 * 1024 * 1024 + 7, uid: 0, gid: 0 },
  ];
  let state = new TextEncoder().encode("data");
  let largeTail = 0;
  let largestRead = 0;
  let highestOffset = 0;
  const host = {
    async statVfsPath(path: string) { return path === root ? directory : null; },
    async readDirFromVfs(path: string) {
      return path === root ? children : path === `${root}/work` ? work : null;
    },
    async readFileRangeFromVfs(path: string, offset: number, length: number) {
      largestRead = Math.max(largestRead, length);
      highestOffset = Math.max(highestOffset, offset);
      if (path === `${root}/work/large`) {
        const bytes = new Uint8Array(length);
        if (offset + length === work[1].size) bytes[bytes.length - 1] = largeTail;
        return bytes;
      }
      if (path === `${root}/work/state`) return state.subarray(offset, offset + length);
      return path === `${root}/new-file` ? new Uint8Array() : null;
    },
  };
  return {
    host, children, work,
    getLargestRead: () => largestRead,
    getHighestOffset: () => highestOffset,
    setState: (bytes: string) => { state = new TextEncoder().encode(bytes); },
    setLargeTail: (value: number) => { largeTail = value; },
  };
}

describe("persistent runner fixture inspection", () => {
  it("compares namespace, metadata, links, and bounded file content across boots", async () => {
    const first = fixture();
    const before = await inspectPersistentFixture(first.host);
    const second = fixture();
    assertPersistentFixtureUnchanged(before, await inspectPersistentFixture(second.host));
    expect(first.getLargestRead()).toBe(1024 * 1024);
    second.setState("edit");
    const afterState = await inspectPersistentFixture(second.host);
    expect(() => assertPersistentFixtureUnchanged(before, afterState)).toThrow(/state/);
  });

  it("detects changed content and namespace without following symlinks", async () => {
    const machine = fixture();
    const before = await inspectPersistentFixture(machine.host);
    machine.setState("edit");
    const changedState = await inspectPersistentFixture(machine.host);
    expect(() => assertPersistentFixtureUnchanged(before, changedState)).toThrow(/state/);
    machine.setState("data");
    machine.setLargeTail(1);
    const changedLargeFile = await inspectPersistentFixture(machine.host);
    expect(() => assertPersistentFixtureUnchanged(before, changedLargeFile)).toThrow(/large/);
    machine.setLargeTail(0);
    machine.work[0].mode = 0o100600;
    const changedMetadata = await inspectPersistentFixture(machine.host);
    expect(() => assertPersistentFixtureUnchanged(before, changedMetadata)).toThrow(/state/);
    machine.children[1].target = "gone";
    const changedLink = await inspectPersistentFixture(machine.host);
    expect(() => assertPersistentFixtureUnchanged(before, changedLink)).toThrow(/link/);
    const extraEntry = fixture();
    extraEntry.children.push({ name: "new-file", mode: 0o100644, size: 0, uid: 0, gid: 0 });
    const changedNamespace = await inspectPersistentFixture(extraEntry.host);
    expect(() => assertPersistentFixtureUnchanged(before, changedNamespace)).toThrow(/new-file/);
  });

  it("fails closed on an invalid fixture tree", async () => {
    const machine = fixture();
    machine.children.push({ name: "..", ...directory });
    await expect(inspectPersistentFixture(machine.host)).rejects.toThrow(/invalid persistent fixture entry/);
    machine.children.pop();
    machine.work[0].size = 5;
    await expect(inspectPersistentFixture(machine.host)).rejects.toThrow(/changed during inspection/);
  });

  it("samples the head, middle, and tail of oversized files without materializing them", async () => {
    const machine = fixture();
    machine.work[1].size = 8 * 1024 * 1024 * 1024 + 7;
    const before = await inspectPersistentFixture(machine.host);
    expect(before.find((entry) => entry.path === `${root}/work/large`)).toMatchObject({
      size: 8 * 1024 * 1024 * 1024 + 7,
      sampleSha256: expect.any(String),
    });
    expect(before.find((entry) => entry.path === `${root}/work/large`)).not.toHaveProperty("sha256");
    expect(machine.getLargestRead()).toBe(4096);
    expect(machine.getHighestOffset()).toBe(machine.work[1].size - 4096);
    machine.setLargeTail(1);
    const after = await inspectPersistentFixture(machine.host);
    expect(() => assertPersistentFixtureUnchanged(before, after)).toThrow(/large/);
  });
});
