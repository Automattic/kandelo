/**
 * The decision log on a wire.
 *
 * The claim these tests hold is narrow and exact: a peer receives the log, and
 * its entry count matches the sender's. Everything else here exists to make
 * that claim mean something — a late joiner must get the entries recorded
 * before it arrived, a congested wire must delay rather than drop, and a hole
 * in the sequence must be reported instead of passed on.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "Core model" and § "How a replica joins a GL machine".
 */
import { describe, expect, it, vi } from "vitest";
import { ChunkedMessageChannel } from "../../src/migration/channel-chunked";
import {
  LocalReplicationLog,
  ReplicationHistory,
  type ReplicationLogSink,
  type ReplicationWatchPosition,
  type SuspendedRecording,
} from "../../src/replication/log-local";
import {
  ReplicationDivergence,
  ReplicationLogRecorder,
  type ReplicationLogEntry,
} from "../../src/replication/log";
import { encodeMessage } from "../../src/migration/codec";
import {
  MACHINE_STATE_HASH_FORMAT,
  type MachineStateHash,
} from "../../src/replication/state-hash";
import { FakeDataChannel } from "../support/data-channel-pair";

function fakeSink(): {
  sink: ReplicationLogSink;
  taken: () => ReplicationLogEntry[];
  ended: () => number;
  divergences: () => ReplicationDivergence[];
  position: () => ReplicationWatchPosition | null;
} {
  const taken: ReplicationLogEntry[] = [];
  const divergences: ReplicationDivergence[] = [];
  let ended = 0;
  let position: ReplicationWatchPosition | null = null;
  return {
    sink: {
      entries: (batch) => void taken.push(...batch),
      ended: () => void (ended += 1),
      diverged: (error) => void divergences.push(error),
      advanced: (at) => void (position = at),
    },
    taken: () => taken,
    ended: () => ended,
    divergences: () => divergences,
    position: () => position,
  };
}

/** A recorder driven the way a machine's clock drives one. */
function recordClocks(recorder: ReplicationLogRecorder, count: number): void {
  for (let at = 0; at < count; at++) {
    recorder.record({ kind: "clock", pid: 102, tid: 102, clockId: 0, sec: 1_700_000 + at, nsec: 0 });
  }
}

describe("local replication log", () => {
  it("gives a peer the whole log, and the counts match", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      recordClocks(recorder, 5);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(5));
      expect(sink.taken()).toHaveLength(recorder.entries.length);
      expect(sink.taken()).toEqual([...recorder.entries]);
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("seeds a peer that joins after the recording started", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    // A replica joins at boot and replays from the machine's first decision,
    // so what was recorded before it arrived is exactly what it needs most.
    recordClocks(recorder, 3);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(3));
      recordClocks(recorder, 2);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(5));
      expect(sink.taken().map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4]);
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("gives a peer that joins mid-recording each entry exactly once", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    recordClocks(recorder, 2);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    // The seeding backlog and this decision cross on the wire: the machine
    // goes on recording while the watcher's hello is still travelling. A
    // replica that took the overlap twice would consume the log at a position
    // the primary never reached.
    recordClocks(recorder, 1);
    try {
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(3));
      expect(sink.taken().map((entry) => entry.seq)).toEqual([0, 1, 2]);
      expect(sink.divergences()).toEqual([]);
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("tells a peer the recording ended when the publisher stops", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      recordClocks(recorder, 1);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(1));
      expect(sink.ended()).toBe(0);
      // A machine that stopped recording will not continue, and a replica
      // waiting on a log that has ended would sit there.
      stopPublish();
      await vi.waitFor(() => expect(sink.ended()).toBe(1));
    } finally {
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("reports a hole in the sequence rather than passing it on", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const watcher = new LocalReplicationLog(channel);
    const injector = new BroadcastChannel(channel);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      const clock = { kind: "clock", pid: 102, tid: 102, clockId: 0, sec: 1, nsec: 0 } as const;
      injector.postMessage({ kind: "entries", entries: [{ seq: 0, decision: clock }] });
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(1));
      // Seq 1 never arrives. Handing seq 2 to a replica would advance it past
      // a decision the primary made, which is the silent drift this module
      // exists to prevent.
      injector.postMessage({ kind: "entries", entries: [{ seq: 2, decision: clock }] });
      await vi.waitFor(() => expect(sink.divergences()).toHaveLength(1));
      expect(sink.divergences()[0]).toBeInstanceOf(ReplicationDivergence);
      expect(sink.divergences()[0]!.seq).toBe(2);
      expect(sink.taken()).toHaveLength(1);
    } finally {
      stopWatch();
      injector.close();
      watcher.close();
    }
  });

  it("ends one machine's recording, and serves the next one to the same peer", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const computer = new LocalReplicationLog<string>(channel);
    const replica = new LocalReplicationLog<string>(channel);
    const first = new ReplicationLogRecorder();
    const second = new ReplicationLogRecorder();
    const serveFrom = (recorder: ReplicationLogRecorder, name: string) =>
      computer.serve(async (publish) => {
        const stopRecord = recorder.onRecord((entry) => publish([entry]));
        return { machine: name, stop: async () => stopRecord() };
      });

    const stale = fakeSink();
    const stopStale = replica.watch(stale.sink);
    let serving = serveFrom(first, "the machine that was running");
    try {
      await expect(replica.join(5_000)).resolves
        .toBe("the machine that was running");
      recordClocks(first, 2);
      await vi.waitFor(() => expect(stale.taken()).toHaveLength(2));

      // Launching a demo destroys the machine a replica is a copy of and boots
      // a different one. The replica has to be told, because its own computer
      // shows nothing: it holds a machine before and after.
      serving.stop();
      await vi.waitFor(() => expect(stale.ended()).toBe(1));

      // And it has to join the replacement rather than follow along on the
      // subscription it already has. A machine numbers its decisions from
      // zero, so the watcher that counted the first one's discards every one
      // of the second's as already seen.
      serving = serveFrom(second, "the machine that replaced it");
      const fresh = fakeSink();
      const stopFresh = replica.watch(fresh.sink);
      await expect(replica.join(5_000)).resolves
        .toBe("the machine that replaced it");
      recordClocks(second, 2);
      await vi.waitFor(() => expect(fresh.taken()).toHaveLength(2));
      expect(fresh.taken().map((entry) => entry.seq)).toEqual([0, 1]);
      expect(stale.taken()).toHaveLength(2);
      stopFresh();
    } finally {
      stopStale();
      serving.stop();
      computer.close();
      replica.close();
    }
  });

  it("withdraws an abandoned join instead of letting it win the recording", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const computer = new LocalReplicationLog<string>(channel);
    const replica = new LocalReplicationLog<string>(channel);
    const recorder = new ReplicationLogRecorder();

    // Asked while no machine answers — the window a viewer attempt lives in
    // during a take-over — then withdrawn, as an ended attempt withdraws it.
    const withdraw = new AbortController();
    const abandoned = replica.join(5_000, withdraw.signal);
    withdraw.abort();
    await expect(abandoned).rejects.toThrow(
      "the request to replicate the machine was withdrawn",
    );

    // A machine starts answering afterwards. Its serving broadcast re-posts
    // every question still standing, so the withdrawn one must not stand: it
    // would win the machine's one recording for an attempt that no longer
    // watches, and the live join would be refused.
    const live = replica.join(5_000);
    const serving = computer.serve(async (publish) => {
      const stopRecord = recorder.onRecord((entry) => publish([entry]));
      return { machine: "the machine", stop: async () => stopRecord() };
    });
    try {
      await expect(live).resolves.toBe("the machine");
    } finally {
      serving.stop();
      computer.close();
      replica.close();
    }
  });

  it("frees the recording when the asker that joined lets its replica go", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const computer = new LocalReplicationLog<string>(channel);
    const replica = new LocalReplicationLog<string>(channel);
    const recorder = new ReplicationLogRecorder();
    let stops = 0;
    const serving = computer.serve(async (publish) => {
      const stopRecord = recorder.onRecord((entry) => publish([entry]));
      return {
        machine: "the machine",
        stop: async () => {
          stops += 1;
          stopRecord();
        },
      };
    });
    try {
      // Aborted after the answer, not before: the person chose the mirror
      // once their replica was already running, so the question was long
      // answered when the attempt ended.
      const leave = new AbortController();
      await expect(replica.join(5_000, leave.signal)).resolves
        .toBe("the machine");
      leave.abort();

      // A machine records for one replica at a time. A recording still held
      // in the name of the asker that left would refuse every later join,
      // and this viewer would watch pixels for the rest of the session.
      await vi.waitFor(() => expect(stops).toBe(1));
      await expect(replica.join(5_000)).resolves.toBe("the machine");
    } finally {
      serving.stop();
      computer.close();
      replica.close();
    }
  });

  it("tells a watcher what it is granted, and again when it says hello", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const machine = new LocalReplicationLog(channel);
    const early = new LocalReplicationLog(channel);
    const late = new LocalReplicationLog(channel);
    const heardEarly: string[] = [];
    const heardLate: string[] = [];
    const stopEarly = early.onGrant((grant) => void heardEarly.push(grant));
    const grant = machine.publishGrant("watch");
    try {
      await vi.waitFor(() => expect(heardEarly).toEqual(["watch"]));
      grant.set("join");
      await vi.waitFor(() => expect(heardEarly).toEqual(["watch", "join"]));

      // A viewer that arrives late says hello when it starts watching, and
      // the grant is what parks its join loop — one that never heard it
      // would ask a machine that serves no joins and wait out its whole
      // timeout.
      const stopLate = late.onGrant((heard) => void heardLate.push(heard));
      const sink = fakeSink();
      const stopWatch = late.watch(sink.sink);
      await vi.waitFor(() => expect(heardLate).toEqual(["join"]));
      stopWatch();
      stopLate();
    } finally {
      grant.stop();
      stopEarly();
      machine.close();
      early.close();
      late.close();
    }
  });

  it("loses no entry to a wire that holds its bytes", async () => {
    const [near, far] = FakeDataChannel.pair({ auto: false });
    const publisher = new LocalReplicationLog(new ChunkedMessageChannel(near));
    const watcher = new LocalReplicationLog(new ChunkedMessageChannel(far));
    const recorder = new ReplicationLogRecorder();
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    const stopPublish = publisher.publish(recorder);
    try {
      // The wire delivers nothing until it is released, so every entry is
      // recorded while the far side is behind. A mirror would skip frames
      // here and resynchronise; the log may not, because the entry it skipped
      // is a decision the replica then never makes.
      recordClocks(recorder, 20);
      expect(sink.taken()).toHaveLength(0);
      await vi.waitFor(() => {
        near.flush();
        far.flush();
        expect(sink.taken()).toHaveLength(20);
      });
      expect(sink.taken()).toEqual([...recorder.entries]);
      expect(sink.divergences()).toEqual([]);
    } finally {
      stopPublish();
      stopWatch();
    }
  });
  it("tells a watcher which page the publisher's preview is on", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const following = new LocalReplicationLog(channel);
    const plain = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const followingSink = fakeSink();
    const plainSink = fakeSink();
    const paths: string[] = [];
    const stopFollowing = following.watch({
      ...followingSink.sink,
      navigated: (path) => void paths.push(path),
    });
    const stopPlain = plain.watch(plainSink.sink);
    try {
      publisher.publishNavigation("/wp-admin/");
      await vi.waitFor(() => expect(paths).toEqual(["/wp-admin/"]));
      // A navigation is presentation, not a log entry, and a sink without
      // the callback keeps receiving entries.
      recordClocks(recorder, 2);
      await vi.waitFor(() => expect(plainSink.taken()).toHaveLength(2));
      expect(followingSink.taken()).toHaveLength(2);
    } finally {
      stopFollowing();
      stopPlain();
      stopPublish();
      publisher.close();
      following.close();
      plain.close();
    }
  });
  it("carries a watcher's missing request line to the publisher", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const watcher = new LocalReplicationLog(channel);
    const misses: string[] = [];
    const stopMisses = publisher.onMiss((key) => void misses.push(key));
    try {
      watcher.reportMiss("GET /wp-content/style.css");
      await vi.waitFor(() =>
        expect(misses).toEqual(["GET /wp-content/style.css"]),
      );
    } finally {
      stopMisses();
      publisher.close();
      watcher.close();
    }
  });
  it("tells a watcher where the publisher's pointer is, and when it left", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const following = new LocalReplicationLog(channel);
    const plain = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const followingSink = fakeSink();
    const plainSink = fakeSink();
    const positions: Array<{ x: number; y: number } | null> = [];
    const stopFollowing = following.watch({
      ...followingSink.sink,
      cursor: (position) => void positions.push(position),
    });
    const stopPlain = plain.watch(plainSink.sink);
    try {
      publisher.publishCursor({ x: 0.25, y: 0.5 });
      publisher.publishCursor(null);
      await vi.waitFor(() =>
        expect(positions).toEqual([{ x: 0.25, y: 0.5 }, null]),
      );
      // A cursor is presentation, not a log entry, and a sink without the
      // callback keeps receiving entries.
      recordClocks(recorder, 2);
      await vi.waitFor(() => expect(plainSink.taken()).toHaveLength(2));
      expect(followingSink.taken()).toHaveLength(2);
    } finally {
      stopFollowing();
      stopPlain();
      stopPublish();
      publisher.close();
      following.close();
      plain.close();
    }
  });

  it("tells a watcher how far the publisher scrolled", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel);
    const following = new LocalReplicationLog(channel);
    const plain = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const followingSink = fakeSink();
    const plainSink = fakeSink();
    const positions: Array<{ x: number; y: number }> = [];
    const stopFollowing = following.watch({
      ...followingSink.sink,
      scrolled: (position) => void positions.push(position),
    });
    const stopPlain = plain.watch(plainSink.sink);
    try {
      publisher.publishScroll({ x: 0, y: 0.4 });
      publisher.publishScroll({ x: 0, y: 1 });
      await vi.waitFor(() =>
        expect(positions).toEqual([{ x: 0, y: 0.4 }, { x: 0, y: 1 }]),
      );
      // A scroll is presentation, not a log entry, and a sink without the
      // callback keeps receiving entries.
      recordClocks(recorder, 2);
      await vi.waitFor(() => expect(plainSink.taken()).toHaveLength(2));
      expect(followingSink.taken()).toHaveLength(2);
    } finally {
      stopFollowing();
      stopPlain();
      stopPublish();
      publisher.close();
      following.close();
      plain.close();
    }
  });
});

/**
 * A channel wrapper that rewrites one recorded second in transit. The
 * sequence numbers stay intact, so the corruption is invisible to the
 * hole check and only the digest can catch it.
 */
function tampering(channel: string, tamperSeq = 1): {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
} {
  const inner = new BroadcastChannel(channel);
  const wrapped = new Map<
    (event: MessageEvent) => void,
    (event: MessageEvent) => void
  >();
  return {
    postMessage: (message) => inner.postMessage(message),
    addEventListener: (type, listener) => {
      const tamper = (event: MessageEvent) => {
        const message = event.data as {
          kind: string;
          entries?: Array<{ seq: number; decision: { sec?: number } }>;
        };
        if (message.kind !== "entries") {
          listener(event);
          return;
        }
        const entries = message.entries!.map((entry) =>
          entry.seq === tamperSeq
            ? { ...entry, decision: { ...entry.decision, sec: 9_999 } }
            : entry,
        );
        listener({ data: { kind: "entries", entries } } as MessageEvent);
      };
      wrapped.set(listener, tamper);
      inner.addEventListener(type, tamper);
    },
    removeEventListener: (type, listener) => {
      const tamper = wrapped.get(listener);
      if (!tamper) return;
      wrapped.delete(listener);
      inner.removeEventListener(type, tamper);
    },
    close: () => inner.close(),
  };
}

describe("local replication log chained digest", () => {
  it("verifies a healthy stream without a word", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel, { digestInterval: 2 });
    const watcher = new LocalReplicationLog(channel);
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      recordClocks(recorder, 5);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(5));
      expect(sink.divergences()).toEqual([]);
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("catches an entry the wire rewrote, at the digest that covers it", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel, { digestInterval: 2 });
    const watcher = new LocalReplicationLog(tampering(channel));
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      recordClocks(recorder, 4);
      // The rewrite keeps every sequence number, so the entries all arrive.
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(4));
      await vi.waitFor(() => expect(sink.divergences()).not.toHaveLength(0));
      expect(sink.divergences()[0]!.message).toContain(
        "the log's running digest through 1 does not match the publisher's",
      );
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("publishes the digest of a partial interval when the recording ends", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const publisher = new LocalReplicationLog(channel, { digestInterval: 100 });
    const watcher = new LocalReplicationLog(tampering(channel));
    const recorder = new ReplicationLogRecorder();
    const stopPublish = publisher.publish(recorder);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      recordClocks(recorder, 3);
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(3));
      // Three entries never fill the interval; the stop is what sends the
      // digest, so a short recording is verified like a long one.
      expect(sink.divergences()).toEqual([]);
      stopPublish();
      await vi.waitFor(() => expect(sink.divergences()).not.toHaveLength(0));
    } finally {
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("keeps quiet for a watcher that started mid-stream", async () => {
    const channel = `replication-test-${crypto.randomUUID()}`;
    const raw = new BroadcastChannel(channel);
    const watcher = new LocalReplicationLog(channel);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      // A stream joined at sequence 5: the watcher cannot fold what it never
      // received, so the digest is ignored rather than reported against.
      raw.postMessage({
        kind: "entries",
        entries: [
          { seq: 5, decision: { kind: "clock", pid: 1, tid: 1, clockId: 0, sec: 1, nsec: 0 } },
        ],
      });
      raw.postMessage({ kind: "digest", seq: 5, hash: "0" });
      await vi.waitFor(() => expect(sink.taken()).toHaveLength(1));
      expect(sink.divergences()).toEqual([]);
    } finally {
      stopWatch();
      watcher.close();
      raw.close();
    }
  });
});

describe("local replication log resume", () => {
  /** The way the demo serves: the recorder's entries go out as it makes them. */
  function serveRecorder(
    wire: LocalReplicationLog<string>,
    recorder: ReplicationLogRecorder,
    stops: { count: number },
  ) {
    return wire.serve(async (publish) => {
      const stopRecord = recorder.onRecord((entry) => publish([entry]));
      return {
        machine: "the machine",
        stop: async () => {
          stops.count += 1;
          stopRecord();
        },
      };
    });
  }

  it("resumes a replica from the ring, no second checkpoint", async () => {
    const firstLink = `replication-test-${crypto.randomUUID()}`;
    const secondLink = `replication-test-${crypto.randomUUID()}`;
    const computerA = new LocalReplicationLog<string>(firstLink, {
      digestInterval: 2,
    });
    const replicaA = new LocalReplicationLog<string>(firstLink);
    const recorder = new ReplicationLogRecorder();
    const stops = { count: 0 };
    const servingA = serveRecorder(computerA, recorder, stops);
    const sinkA = fakeSink();
    const stopWatchA = replicaA.watch(sinkA.sink);
    let suspended: SuspendedRecording | null = null;
    try {
      await expect(replicaA.join(5_000)).resolves.toBe("the machine");
      recordClocks(recorder, 3);
      await vi.waitFor(() => expect(sinkA.taken()).toHaveLength(3));
      const position = sinkA.position()!;
      expect(position.nextSeq).toBe(3);

      // The link dies. The wire is gone; the recording is not.
      suspended = servingA.suspend();
      expect(suspended).not.toBeNull();
      stopWatchA();

      // Decided while no wire existed — what the ring is for.
      recordClocks(recorder, 2);

      const computerB = new LocalReplicationLog<string>(secondLink, {
        digestInterval: 2,
      });
      const replicaB = new LocalReplicationLog<string>(secondLink);
      let resumedTold = 0;
      const servingB = computerB.serve(
        async () => {
          throw new Error("a resume must not read the machine again");
        },
        { suspended, resumed: () => void (resumedTold += 1) },
      );
      suspended = null;
      const sinkB = fakeSink();
      const stopWatchB = replicaB.watch(sinkB.sink, { from: position });
      try {
        await replicaB.resume(position.nextSeq - 1, 5_000);
        expect(resumedTold).toBe(1);
        await vi.waitFor(() => expect(sinkB.taken()).toHaveLength(2));
        expect(sinkB.taken().map((entry) => entry.seq)).toEqual([3, 4]);

        // Live again: what the machine decides now still reaches the replica.
        recordClocks(recorder, 2);
        await vi.waitFor(() => expect(sinkB.taken()).toHaveLength(4));
        expect(sinkB.divergences()).toEqual([]);
        expect(stops.count).toBe(0);
      } finally {
        stopWatchB();
        servingB.stop();
        computerB.close();
        replicaB.close();
      }
      expect(stops.count).toBe(1);
    } finally {
      if (suspended !== null) void suspended.stop();
      computerA.close();
      replicaA.close();
    }
  });

  it("keeps verifying the digest chain across the resume", async () => {
    const firstLink = `replication-test-${crypto.randomUUID()}`;
    const secondLink = `replication-test-${crypto.randomUUID()}`;
    const computerA = new LocalReplicationLog<string>(firstLink, {
      digestInterval: 2,
    });
    const replicaA = new LocalReplicationLog<string>(firstLink);
    const recorder = new ReplicationLogRecorder();
    const stops = { count: 0 };
    const servingA = serveRecorder(computerA, recorder, stops);
    const sinkA = fakeSink();
    const stopWatchA = replicaA.watch(sinkA.sink);
    try {
      await expect(replicaA.join(5_000)).resolves.toBe("the machine");
      recordClocks(recorder, 3);
      await vi.waitFor(() => expect(sinkA.taken()).toHaveLength(3));
      const position = sinkA.position()!;
      const suspended = servingA.suspend()!;
      stopWatchA();
      recordClocks(recorder, 2);

      // The successor wire rewrites one of the missed entries in transit.
      // Sequence numbers survive the rewrite, so only a digest chain that
      // truly continued across the resume can catch it.
      const computerB = new LocalReplicationLog<string>(secondLink, {
        digestInterval: 2,
      });
      const replicaB = new LocalReplicationLog<string>(tampering(secondLink, 3));
      const servingB = computerB.serve(
        async () => {
          throw new Error("a resume must not read the machine again");
        },
        { suspended },
      );
      const sinkB = fakeSink();
      const stopWatchB = replicaB.watch(sinkB.sink, { from: position });
      try {
        await replicaB.resume(position.nextSeq - 1, 5_000);
        // The digest inside the replay batch cannot be checked by position,
        // but the chain is cumulative: the rewrite stays in every later
        // digest, and the first one after the batch is where it surfaces.
        recordClocks(recorder, 1);
        await vi.waitFor(() => expect(sinkB.divergences()).not.toHaveLength(0));
        expect(sinkB.divergences()[0]!.message).toContain(
          "does not match the publisher's",
        );
      } finally {
        stopWatchB();
        servingB.stop();
        computerB.close();
        replicaB.close();
      }
    } finally {
      computerA.close();
      replicaA.close();
    }
  });

  it("refuses a position the ring lost, and the fallback join supersedes", async () => {
    const firstLink = `replication-test-${crypto.randomUUID()}`;
    const secondLink = `replication-test-${crypto.randomUUID()}`;
    // A ring one byte deep evicts everything it is given: every position is
    // already lost, which is the far end of any real eviction.
    const computerA = new LocalReplicationLog<string>(firstLink, {
      historyBytes: 1,
    });
    const replicaA = new LocalReplicationLog<string>(firstLink);
    const recorder = new ReplicationLogRecorder();
    const stops = { count: 0 };
    const servingA = serveRecorder(computerA, recorder, stops);
    const sinkA = fakeSink();
    const stopWatchA = replicaA.watch(sinkA.sink);
    try {
      await expect(replicaA.join(5_000)).resolves.toBe("the machine");
      recordClocks(recorder, 3);
      await vi.waitFor(() => expect(sinkA.taken()).toHaveLength(3));
      const position = sinkA.position()!;
      const suspended = servingA.suspend()!;
      stopWatchA();
      recordClocks(recorder, 2);

      const computerB = new LocalReplicationLog<string>(secondLink);
      const replicaB = new LocalReplicationLog<string>(secondLink);
      const servingB = computerB.serve(
        async (publish) => {
          const stopRecord = recorder.onRecord((entry) => publish([entry]));
          return {
            machine: "the machine, read again",
            stop: async () => stopRecord(),
          };
        },
        { suspended },
      );
      const sinkB = fakeSink();
      const stopWatchB = replicaB.watch(sinkB.sink, { from: position });
      try {
        await expect(
          replicaB.resume(position.nextSeq - 1, 5_000),
        ).rejects.toThrow("no longer holds the log after 2");
        expect(stops.count).toBe(0);

        // The fallback the refusal sends a replica to: a full join. It reads
        // the machine again, and the recording nobody could resume stops
        // rather than run for the rest of the session.
        const freshSink = fakeSink();
        const stopFresh = replicaB.watch(freshSink.sink);
        await expect(replicaB.join(5_000)).resolves.toBe(
          "the machine, read again",
        );
        expect(stops.count).toBe(1);
        stopFresh();
      } finally {
        stopWatchB();
        servingB.stop();
        computerB.close();
        replicaB.close();
      }
    } finally {
      computerA.close();
      replicaA.close();
    }
  });

  it("resumes a replica that missed nothing", async () => {
    const firstLink = `replication-test-${crypto.randomUUID()}`;
    const secondLink = `replication-test-${crypto.randomUUID()}`;
    const computerA = new LocalReplicationLog<string>(firstLink);
    const replicaA = new LocalReplicationLog<string>(firstLink);
    const recorder = new ReplicationLogRecorder();
    const stops = { count: 0 };
    const servingA = serveRecorder(computerA, recorder, stops);
    const sinkA = fakeSink();
    const stopWatchA = replicaA.watch(sinkA.sink);
    try {
      await expect(replicaA.join(5_000)).resolves.toBe("the machine");
      recordClocks(recorder, 2);
      await vi.waitFor(() => expect(sinkA.taken()).toHaveLength(2));
      const position = sinkA.position()!;
      const suspended = servingA.suspend()!;
      stopWatchA();

      const computerB = new LocalReplicationLog<string>(secondLink);
      const replicaB = new LocalReplicationLog<string>(secondLink);
      const servingB = computerB.serve(
        async () => {
          throw new Error("a resume must not read the machine again");
        },
        { suspended },
      );
      const sinkB = fakeSink();
      const stopWatchB = replicaB.watch(sinkB.sink, { from: position });
      try {
        await replicaB.resume(position.nextSeq - 1, 5_000);
        recordClocks(recorder, 1);
        await vi.waitFor(() => expect(sinkB.taken()).toHaveLength(1));
        expect(sinkB.taken()[0]!.seq).toBe(2);
        expect(sinkB.divergences()).toEqual([]);
      } finally {
        stopWatchB();
        servingB.stop();
        computerB.close();
        replicaB.close();
      }
    } finally {
      computerA.close();
      replicaA.close();
    }
  });

  it("resumes a replica whose recording never published", async () => {
    // The browser's idle case: a captured shell sits at its prompt, decides
    // nothing, and the link dies. The replica received no entry and has no
    // position — it asks from -1, and the empty recording agrees.
    const firstLink = `replication-test-${crypto.randomUUID()}`;
    const secondLink = `replication-test-${crypto.randomUUID()}`;
    const computerA = new LocalReplicationLog<string>(firstLink);
    const replicaA = new LocalReplicationLog<string>(firstLink);
    const recorder = new ReplicationLogRecorder();
    const stops = { count: 0 };
    const servingA = serveRecorder(computerA, recorder, stops);
    const sinkA = fakeSink();
    const stopWatchA = replicaA.watch(sinkA.sink);
    try {
      await expect(replicaA.join(5_000)).resolves.toBe("the machine");
      expect(sinkA.position()).toBeNull();
      const suspended = servingA.suspend()!;
      stopWatchA();

      const computerB = new LocalReplicationLog<string>(secondLink);
      const replicaB = new LocalReplicationLog<string>(secondLink);
      const servingB = computerB.serve(
        async () => {
          throw new Error("a resume must not read the machine again");
        },
        { suspended },
      );
      const sinkB = fakeSink();
      const stopWatchB = replicaB.watch(sinkB.sink);
      try {
        await replicaB.resume(-1, 5_000);
        recordClocks(recorder, 2);
        await vi.waitFor(() => expect(sinkB.taken()).toHaveLength(2));
        expect(sinkB.taken().map((entry) => entry.seq)).toEqual([0, 1]);
        expect(sinkB.divergences()).toEqual([]);
      } finally {
        stopWatchB();
        servingB.stop();
        computerB.close();
        replicaB.close();
      }
    } finally {
      computerA.close();
      replicaA.close();
    }
  });

  it("refuses a resume when no recording is suspended", async () => {
    const link = `replication-test-${crypto.randomUUID()}`;
    const computer = new LocalReplicationLog<string>(link);
    const replica = new LocalReplicationLog<string>(link);
    const recorder = new ReplicationLogRecorder();
    const stops = { count: 0 };
    const serving = serveRecorder(computer, recorder, stops);
    try {
      await expect(replica.resume(4, 5_000)).rejects.toThrow(
        "holds no recording to resume",
      );
    } finally {
      serving.stop();
      computer.close();
      replica.close();
    }
  });

  it("hands a recording nobody resumed on to the next wire", async () => {
    const firstLink = `replication-test-${crypto.randomUUID()}`;
    const secondLink = `replication-test-${crypto.randomUUID()}`;
    const thirdLink = `replication-test-${crypto.randomUUID()}`;
    const computerA = new LocalReplicationLog<string>(firstLink);
    const replicaA = new LocalReplicationLog<string>(firstLink);
    const recorder = new ReplicationLogRecorder();
    const stops = { count: 0 };
    const servingA = serveRecorder(computerA, recorder, stops);
    const sinkA = fakeSink();
    const stopWatchA = replicaA.watch(sinkA.sink);
    try {
      await expect(replicaA.join(5_000)).resolves.toBe("the machine");
      recordClocks(recorder, 2);
      await vi.waitFor(() => expect(sinkA.taken()).toHaveLength(2));
      const position = sinkA.position()!;
      const suspended = servingA.suspend()!;
      stopWatchA();

      // The second link opens and dies again before any resume arrives —
      // two drops in a row must not cost the recording.
      const computerB = new LocalReplicationLog<string>(secondLink);
      const servingB = computerB.serve(
        async () => {
          throw new Error("nothing joins on this link");
        },
        { suspended },
      );
      const handedOn = servingB.suspend();
      computerB.close();
      expect(handedOn).toBe(suspended);
      expect(stops.count).toBe(0);

      const computerC = new LocalReplicationLog<string>(thirdLink);
      const replicaC = new LocalReplicationLog<string>(thirdLink);
      const servingC = computerC.serve(
        async () => {
          throw new Error("a resume must not read the machine again");
        },
        { suspended: handedOn },
      );
      const sinkC = fakeSink();
      const stopWatchC = replicaC.watch(sinkC.sink, { from: position });
      try {
        await replicaC.resume(position.nextSeq - 1, 5_000);
        recordClocks(recorder, 1);
        await vi.waitFor(() => expect(sinkC.taken()).toHaveLength(1));
      } finally {
        stopWatchC();
        servingC.stop();
        computerC.close();
        replicaC.close();
      }
      expect(stops.count).toBe(1);
    } finally {
      computerA.close();
      replicaA.close();
    }
  });
});

describe("replication history", () => {
  const clock = (seq: number): ReplicationLogEntry => ({
    seq,
    decision: { kind: "clock", pid: 102, tid: 102, clockId: 0, sec: 1_700_000 + seq, nsec: 0 },
  });

  it("hands back what follows a position, and refuses one it lost", () => {
    const size = encodeMessage(clock(0)).byteLength;
    const history = new ReplicationHistory(size * 2);
    history.push([clock(0), clock(1), clock(2), clock(3)]);
    // Two entries fit, so 0 and 1 were evicted — after they went to a wire.
    expect(history.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(history.after(3)).toEqual([]);
    expect(history.after(2)).toEqual([clock(3)]);
    expect(history.after(1)).toEqual([clock(2), clock(3)]);
    expect(history.after(0)).toBeNull();
    // A position ahead of the recording is a watcher this recording never
    // fed; there is nothing to resume.
    expect(history.after(7)).toBeNull();
  });

  it("folds each sequence number into the digest exactly once", () => {
    const history = new ReplicationHistory();
    expect(history.fold(clock(0))).toBe(true);
    expect(history.fold(clock(1))).toBe(true);
    const chain = history.digestHex;
    expect(history.fold(clock(1))).toBe(false);
    expect(history.fold(clock(0))).toBe(false);
    expect(history.digestHex).toBe(chain);
    expect(history.digestedThrough).toBe(1);
    expect(history.sinceDigest).toBe(2);
    history.settleDigest();
    expect(history.sinceDigest).toBe(0);
  });
});

describe("local replication log promotion", () => {
  const stateHash = (seq: number, fill: string): MachineStateHash => ({
    format: MACHINE_STATE_HASH_FORMAT,
    seq,
    regions: [{ region: "filesystem:/", bytes: 64, sha256: fill }],
    sha256: fill,
  });

  it("seals, adopts, and releases in one handshake", async () => {
    const link = `replication-test-${crypto.randomUUID()}`;
    const keeper = new LocalReplicationLog<string>(link);
    const taker = new LocalReplicationLog<string>(link);
    let released = 0;
    const adopted: MachineStateHash[] = [];
    const stopServing = keeper.servePromotion({
      seal: async () => ({ seq: 7, hash: stateHash(7, "aa") }),
      adopt: async (hash) => {
        adopted.push(hash);
        released += 1;
        return true;
      },
    });
    try {
      const sealed = await taker.requestPromotion(5_000);
      expect(sealed.seq).toBe(7);
      expect(sealed.hash.sha256).toBe("aa");
      await taker.requestAdoption(sealed.takeId, stateHash(7, "bb"), 5_000);
      expect(released).toBe(1);
      expect(adopted[0]!.sha256).toBe("bb");
    } finally {
      stopServing();
      keeper.close();
      taker.close();
    }
  });

  it("refuses the adoption when the keeper's proof says no", async () => {
    const link = `replication-test-${crypto.randomUUID()}`;
    const keeper = new LocalReplicationLog<string>(link);
    const taker = new LocalReplicationLog<string>(link);
    const stopServing = keeper.servePromotion({
      seal: async () => ({ seq: 3, hash: stateHash(3, "aa") }),
      adopt: async () => false,
    });
    try {
      const sealed = await taker.requestPromotion(5_000);
      await expect(
        taker.requestAdoption(sealed.takeId, stateHash(3, "cc"), 5_000),
      ).rejects.toThrow("the states do not match");
    } finally {
      stopServing();
      keeper.close();
      taker.close();
    }
  });

  it("relays a seal refusal, and frees the machine for the next take", async () => {
    const link = `replication-test-${crypto.randomUUID()}`;
    const keeper = new LocalReplicationLog<string>(link);
    const taker = new LocalReplicationLog<string>(link);
    let asked = 0;
    const stopServing = keeper.servePromotion({
      seal: async () => {
        asked += 1;
        if (asked === 1) return { refused: "this machine is mid-boot" };
        return { seq: 9, hash: stateHash(9, "dd") };
      },
      adopt: async () => true,
    });
    try {
      await expect(taker.requestPromotion(5_000)).rejects.toThrow(
        "this machine is mid-boot",
      );
      // The refusal cleared the slot: the next ask is served, not told a
      // take-over is already in progress.
      const sealed = await taker.requestPromotion(5_000);
      expect(sealed.seq).toBe(9);
    } finally {
      stopServing();
      keeper.close();
      taker.close();
    }
  });

  it("serves one take-over at a time", async () => {
    const link = `replication-test-${crypto.randomUUID()}`;
    const keeper = new LocalReplicationLog<string>(link);
    const taker = new LocalReplicationLog<string>(link);
    let releaseSeal: (() => void) | null = null;
    const stopServing = keeper.servePromotion({
      seal: () =>
        new Promise((resolve) => {
          releaseSeal = () => resolve({ seq: 1, hash: stateHash(1, "ee") });
        }),
      adopt: async () => true,
    });
    try {
      const first = taker.requestPromotion(5_000);
      await vi.waitFor(() => expect(releaseSeal).not.toBeNull());
      await expect(taker.requestPromotion(5_000)).rejects.toThrow(
        "already in progress",
      );
      releaseSeal!();
      await expect(first).resolves.toMatchObject({ seq: 1 });
    } finally {
      stopServing();
      keeper.close();
      taker.close();
    }
  });
});
