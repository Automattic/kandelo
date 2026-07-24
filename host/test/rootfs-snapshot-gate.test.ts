import { describe, expect, it, vi } from "vitest";

import { RootfsSnapshotGate } from "../src/rootfs-snapshot-gate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("RootfsSnapshotGate", () => {
  it("waits for an earlier mutation and excludes every later mutation", async () => {
    const gate = new RootfsSnapshotGate();
    const releaseMutation = gate.beginMutation("finish an earlier write");
    const snapshotEntered = vi.fn();

    const snapshot = gate.runSnapshot(async () => {
      snapshotEntered();
      return new Uint8Array([1, 2, 3]);
    });
    await Promise.resolve();

    expect(snapshotEntered).not.toHaveBeenCalled();
    expect(() => gate.beginMutation("spawn a process")).toThrow(
      "rootfs export is in progress; cannot spawn a process",
    );
    await expect(gate.runSnapshot(async () => new Uint8Array())).rejects.toThrow(
      "rootfs export is already in progress",
    );

    releaseMutation();
    await expect(snapshot).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(snapshotEntered).toHaveBeenCalledOnce();

    const releaseAfterSnapshot = gate.beginMutation("write after export");
    expect(() => releaseAfterSnapshot()).not.toThrow();
  });

  it("holds the gate until an asynchronous snapshot settles", async () => {
    const gate = new RootfsSnapshotGate();
    const save = deferred<Uint8Array>();
    const snapshot = gate.runSnapshot(() => save.promise);

    expect(() => gate.beginMutation("unlink a rootfs file")).toThrow(
      "rootfs export is in progress; cannot unlink a rootfs file",
    );
    save.resolve(new Uint8Array([9]));
    await expect(snapshot).resolves.toEqual(new Uint8Array([9]));
  });

  it("reopens after a failed snapshot without swallowing the failure", async () => {
    const gate = new RootfsSnapshotGate();
    await expect(
      gate.runSnapshot(async () => {
        throw new Error("saveImage failed");
      }),
    ).rejects.toThrow("saveImage failed");

    const release = gate.beginMutation("retry a write");
    release();
    await expect(
      gate.runSnapshot(async () => "retry succeeded"),
    ).resolves.toBe("retry succeeded");
  });

  it("detects a duplicate mutation release", () => {
    const gate = new RootfsSnapshotGate();
    const release = gate.beginMutation("one write");
    release();
    expect(() => release()).toThrow(
      "rootfs snapshot mutation released twice: one write",
    );
  });
});
