import { describe, expect, it } from "vitest";
import {
  RecordingRandomProvider,
  ReplayingRandomProvider,
} from "../../src/replication/random";
import {
  ReplicationDivergence,
  ReplicationLogReader,
  ReplicationLogRecorder,
} from "../../src/replication/log";
import type { RandomProvider } from "../../src/vfs/types";

/** The one process every test below draws for, unless it names another. */
const GUEST = () => 102;

/** A host source that never repeats a draw, the way a real one does not. */
function countingRandom(): RandomProvider {
  let next = 1;
  return {
    getRandomBytes: (length) => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (next + i) & 0xff;
      next += length;
      return bytes;
    },
  };
}

describe("recording random provider", () => {
  it("returns the host draw and records exactly what the guest was handed", () => {
    const recorder = new ReplicationLogRecorder();
    const provider = new RecordingRandomProvider(
      countingRandom(),
      recorder,
      GUEST,
      GUEST,
    );

    expect(provider.getRandomBytes(3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(provider.getRandomBytes(2)).toEqual(new Uint8Array([4, 5]));
    expect(recorder.entries.map((entry) => entry.decision)).toEqual([
      { kind: "random", pid: 102, tid: 102, bytes: new Uint8Array([1, 2, 3]) },
      { kind: "random", pid: 102, tid: 102, bytes: new Uint8Array([4, 5]) },
    ]);
  });

  it("records a copy, so a caller writing into its draw rewrites nothing", () => {
    const recorder = new ReplicationLogRecorder();
    const provider = new RecordingRandomProvider(
      countingRandom(),
      recorder,
      GUEST,
      GUEST,
    );

    const drawn = provider.getRandomBytes(2);
    drawn[0] = 0xff;
    const recorded = recorder.entries[0]!.decision;
    expect(recorded.kind).toBe("random");
    if (recorded.kind !== "random") return;
    expect(recorded.bytes).toEqual(new Uint8Array([1, 2]));
  });
});

describe("replaying random provider", () => {
  it("hands a second machine the bytes the first one drew", () => {
    const recorder = new ReplicationLogRecorder();
    const primary = new RecordingRandomProvider(
      countingRandom(),
      recorder,
      GUEST,
      GUEST,
    );
    const first = primary.getRandomBytes(4);
    const second = primary.getRandomBytes(4);

    // A fresh host source, as a second computer has. Its own draws differ.
    const replica = new ReplayingRandomProvider(
      new ReplicationLogReader(recorder.entries),
      GUEST,
      GUEST,
    );
    expect(replica.getRandomBytes(4)).toEqual(first);
    expect(replica.getRandomBytes(4)).toEqual(second);
  });

  it("refuses to invent a draw the primary never made", () => {
    const recorder = new ReplicationLogRecorder();
    new RecordingRandomProvider(countingRandom(), recorder, GUEST, GUEST)
      .getRandomBytes(4);
    const replica = new ReplayingRandomProvider(
      new ReplicationLogReader(recorder.entries),
      GUEST,
      GUEST,
    );
    replica.getRandomBytes(4);

    expect(() => replica.getRandomBytes(4)).toThrow(ReplicationDivergence);
  });

  it("refuses a draw of a different size than the primary's", () => {
    const recorder = new ReplicationLogRecorder();
    new RecordingRandomProvider(countingRandom(), recorder, GUEST, GUEST)
      .getRandomBytes(4);
    const replica = new ReplayingRandomProvider(
      new ReplicationLogReader(recorder.entries),
      GUEST,
      GUEST,
    );

    expect(() => replica.getRandomBytes(8)).toThrow(
      "the replica asked for 8 random bytes where the primary drew 4",
    );
  });

  it("serves a copy, so a caller writing into its draw rewrites nothing", () => {
    const recorder = new ReplicationLogRecorder();
    new RecordingRandomProvider(countingRandom(), recorder, GUEST, GUEST)
      .getRandomBytes(2);
    const reader = new ReplicationLogReader(recorder.entries);
    const replica = new ReplayingRandomProvider(reader, GUEST, GUEST);

    const served = replica.getRandomBytes(2);
    served[0] = 0xff;
    const recorded = recorder.entries[0]!.decision;
    expect(recorded.kind).toBe("random");
    if (recorded.kind !== "random") return;
    expect(recorded.bytes).toEqual(new Uint8Array([1, 2]));
  });
});
