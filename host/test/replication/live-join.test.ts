/**
 * A replica that follows a machine which is still running.
 *
 * `replay-determinism.test.ts` measures a replica fed a recording that is
 * already complete. That replica can never be asked for a decision the log
 * does not hold. A live replica can, and constantly: it runs the machine at
 * its own speed, so it reaches the end of what the primary has recorded
 * whenever it gets ahead.
 *
 * The claim here is that it stops there. It does not read its own clock, it
 * does not reuse the last reading, and it does not fail — it waits, and takes
 * the primary's next decision when the primary makes it. That is what makes
 * the log a live wire rather than a transcript.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "How a replica joins a GL machine".
 */
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../../src/node-kernel-host";
import type {
  ReplicationDivergence,
  ReplicationLogEntry,
} from "../../src/replication/log";
import {
  LocalReplicationLog,
  type ReplicationWatchPosition,
} from "../../src/replication/log-local";
import {
  ReplicationLogQueueWriter,
  createReplicationLogQueue,
} from "../../src/replication/log-queue";
import {
  GUEST,
  captureWhenIdle,
  collectStdout,
  pause,
  printedSeconds,
  runGuest,
} from "../support/replication-machine";

/** Long enough that a replica which is merely slow is not called parked. */
const PARKED_FOR_MS = 500;

/** How long a replica may still need the primary before the test gives up. */
const FOLLOW_LIMIT_MS = 60_000;

/** How many times the guest of the third test reads the clock. */
const LIVE_READS = 12;

/**
 * A guest that is still running when the machine is read.
 *
 * The inner loop is the shell's own arithmetic, so the guest spends its time
 * between clock reads without forking. That keeps what the freeze parks — and
 * what the replica therefore resumes — one process reading one clock, which is
 * the property the log is being asked to preserve.
 */
const LIVE_GUEST = [
  "sh",
  "-c",
  `i=0; while [ $i -lt ${LIVE_READS} ]; do date +%s; j=0; `
  + `while [ $j -lt 2000 ]; do j=$((j+1)); done; i=$((i+1)); done`,
];

/** Wait until `ready` holds, or give up and say what was true instead. */
async function until(
  ready: () => boolean,
  limitMs: number,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${describe()}`);
    await pause(25);
  }
}

describe("live replica join", () => {
  it(
    "waits for the primary's next decision rather than reading its own clock",
    { timeout: 300_000 },
    async () => {
      const primaryOut = collectStdout();
      const primary = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: primaryOut.onStdout,
      });
      await primary.init();
      const replicaOut = collectStdout();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      const published: ReplicationLogEntry[] = [];
      try {
        const checkpoint = await captureWhenIdle(primary);
        expect(checkpoint.processes).toEqual([]);

        // The primary holds no log of its own: every decision it makes goes
        // straight to the wire, which here is the shared queue.
        const stopStream = await primary.streamReplicationLog((entries) => {
          published.push(...entries);
          writer.push(entries);
        });

        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: checkpoint,
          onStdout: replicaOut.onStdout,
        });
        await replica.init();
        // An empty log and a queue: the replica has nothing to replay yet and
        // every decision it needs is still to be made.
        await replica.startReplicationReplay([], queue);

        // Started, deliberately not awaited. The replica's own spawn reads the
        // clock, so it parks inside this call until the primary has recorded
        // as far. Awaiting it here would be waiting for the primary's guest,
        // which has not run.
        const replicaSpawn = replica.spawnFromVfs("/bin/sh", GUEST);
        const replicaExit = replicaSpawn.then(({ exit }) => exit);
        expect(
          await Promise.race([
            replicaExit.then(() => "ran" as const),
            pause(PARKED_FOR_MS).then(() => "waiting" as const),
          ]),
        ).toBe("waiting");
        expect(published).toEqual([]);
        expect(replicaOut.read()).toBe("");

        // Now the primary runs the machine, and its decisions reach the
        // replica as it makes them.
        await runGuest(primary);
        expect(published.length).toBeGreaterThan(0);

        expect(
          await Promise.race([
            replicaExit,
            pause(FOLLOW_LIMIT_MS).then(() => "still waiting" as const),
          ]),
        ).toBe(0);

        // And what it printed is what the primary printed — from the primary's
        // clock, taken across a wire, while the primary was still running.
        expect(printedSeconds(replicaOut.read()))
          .toEqual(printedSeconds(primaryOut.read()));

        await stopStream();
        writer.end();
        const progress = await replica.stopReplicationReplay();
        expect(progress.consumed).toBeGreaterThan(0);
        expect(progress.consumed).toBe(progress.total);
      } finally {
        // Releases a replica still parked on the queue, so a failure above is
        // reported rather than held open by a worker that cannot be asked
        // anything while it waits.
        writer.end();
        await replica?.destroy();
        await primary.destroy();
      }
    },
  );

  it(
    "joins through one capture that hands back the state and starts the log",
    { timeout: 300_000 },
    async () => {
      const primaryOut = collectStdout();
      const primary = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: primaryOut.onStdout,
      });
      await primary.init();
      const replicaOut = collectStdout();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      try {
        // One operation, not two. That the recorder starts while the machine
        // is still parked is `migration/checkpoint.test.ts`; what this covers
        // is that a replica can be built out of what the single call returns.
        const joined = await primary.captureAndStreamReplicationLog(
          { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 },
          (entries) => writer.push(entries),
        );
        expect(joined.capture.status).toBe("captured");
        if (joined.capture.status !== "captured") return;

        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: joined.capture.checkpoint,
          onStdout: replicaOut.onStdout,
        });
        await replica.init();
        await replica.startReplicationReplay([], queue);

        const replicaExit = replica
          .spawnFromVfs("/bin/sh", GUEST)
          .then(({ exit }) => exit);
        await runGuest(primary);

        expect(
          await Promise.race([
            replicaExit,
            pause(FOLLOW_LIMIT_MS).then(() => "still waiting" as const),
          ]),
        ).toBe(0);
        expect(printedSeconds(replicaOut.read()))
          .toEqual(printedSeconds(primaryOut.read()));

        await joined.stop();
        writer.end();
      } finally {
        writer.end();
        await replica?.destroy();
        await primary.destroy();
      }
    },
  );

  it(
    "carries on a guest that was mid-loop when the machine was read",
    { timeout: 300_000 },
    async () => {
      // The two tests above read an idle machine, so their replicas start with
      // nothing running and exercise the API rather than the gap it closes.
      // This one reads a machine with a guest between two clock reads. That
      // guest resumes on the replica inside `init`, before any message the
      // main thread could send afterwards, so it is the case that says whether
      // a replica's first reading is the primary's or its own host's.
      const primaryOut = collectStdout();
      const primary = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: primaryOut.onStdout,
      });
      await primary.init();
      const replicaOut = collectStdout();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      try {
        const guestExit = primary
          .spawnFromVfs("/bin/sh", LIVE_GUEST)
          .then(({ exit }) => exit);
        await until(
          () => printedSeconds(primaryOut.read()).length >= 2,
          FOLLOW_LIMIT_MS,
          () => `the guest printed ${primaryOut.read().trim().length} bytes`,
        );

        const joined = await primary.captureAndStreamReplicationLog(
          { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 },
          (entries) => writer.push(entries),
        );
        expect(
          joined.capture.status,
          joined.capture.status === "captured" ? "" : joined.capture.reason,
        ).toBe("captured");
        if (joined.capture.status !== "captured") return;
        // The point of the test: something was running when the read happened.
        expect(joined.capture.checkpoint.processes.length).toBeGreaterThan(0);

        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: joined.capture.checkpoint,
          // Not `startReplicationReplay`. The restored guest runs during
          // `init`, so a replay installed after it returns is installed too
          // late.
          replicationReplay: { entries: [], queue },
          onStdout: replicaOut.onStdout,
        });
        await replica.init();

        expect(await guestExit).toBe(0);
        // A guest's exit promise settles before the last of its output has
        // reached this callback, so the transcript is waited for rather than
        // read at the exit.
        await until(
          () => printedSeconds(primaryOut.read()).length === LIVE_READS,
          FOLLOW_LIMIT_MS,
          () => `the primary printed ${JSON.stringify(primaryOut.read())}`,
        );
        const printed = printedSeconds(primaryOut.read());
        // The replica has no exit promise for a process it never spawned, so
        // it is followed by what that process prints. It settles when its
        // transcript is the primary's tail. The final readings repeat —
        // seconds are coarser than the loop — so matching only the last one
        // catches a replica still two readings short of the log's end.
        await until(
          () => {
            const replicated = printedSeconds(replicaOut.read());
            return replicated.length > 0
              && replicated.length < printed.length
              && JSON.stringify(replicated)
                === JSON.stringify(printed.slice(printed.length - replicated.length));
          },
          FOLLOW_LIMIT_MS,
          () => `the replica printed ${JSON.stringify(replicaOut.read())} `
            + `while the primary printed ${JSON.stringify(printed)}`,
        );

        const replicated = printedSeconds(replicaOut.read());
        expect(replicated.length).toBeGreaterThan(0);
        expect(replicated.length).toBeLessThan(printed.length);
        // Every reading the replica printed is the one the primary printed at
        // that position. A replica reading its own clock would agree to the
        // second on a fast machine and disagree the moment it did not, which
        // is exactly the silent divergence the log exists to prevent — so the
        // comparison is the whole tail, not the last line.
        expect(replicated).toEqual(printed.slice(printed.length - replicated.length));

        await joined.stop();
        writer.end();
        const progress = await replica.stopReplicationReplay();
        expect(progress.consumed).toBeGreaterThan(0);
      } finally {
        writer.end();
        await replica?.destroy();
        await primary.destroy();
      }
    },
  );

  it(
    "resumes a replica across a dropped wire without a second checkpoint",
    { timeout: 300_000 },
    async () => {
      // The claim of the history ring: the wire dies mid-follow, the machine
      // keeps deciding, and the wire that replaces it hands the replica every
      // decision it missed — out of the ring, not out of another freeze.
      const primaryOut = collectStdout();
      const primary = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: primaryOut.onStdout,
      });
      await primary.init();
      const replicaOut = collectStdout();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      const firstLink = `replication-test-${crypto.randomUUID()}`;
      const secondLink = `replication-test-${crypto.randomUUID()}`;
      const user = new LocalReplicationLog<string>(firstLink);
      const viewer = new LocalReplicationLog<string>(firstLink);
      let userB: LocalReplicationLog<string> | null = null;
      let viewerB: LocalReplicationLog<string> | null = null;
      let captures = 0;
      let joined:
        | Awaited<ReturnType<typeof primary.captureAndStreamReplicationLog>>
        | null = null;
      const divergences: ReplicationDivergence[] = [];
      let position: ReplicationWatchPosition | null = null;
      try {
        const guestExit = primary
          .spawnFromVfs("/bin/sh", LIVE_GUEST)
          .then(({ exit }) => exit);
        await until(
          () => printedSeconds(primaryOut.read()).length >= 2,
          FOLLOW_LIMIT_MS,
          () => `the guest printed ${primaryOut.read().trim().length} bytes`,
        );

        const serving = user.serve(async (publish) => {
          captures += 1;
          const streamed = await primary.captureAndStreamReplicationLog(
            { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 },
            (entries) => publish(entries),
          );
          if (streamed.capture.status !== "captured") return null;
          joined = streamed;
          return { machine: "the machine", stop: streamed.stop };
        });
        const stopWatching = viewer.watch({
          entries: (entries) => writer.push(entries),
          advanced: (at) => void (position = at),
          diverged: (error) => void divergences.push(error),
          ended: () => {},
        });
        await expect(viewer.join(60_000)).resolves.toBe("the machine");
        expect(captures).toBe(1);
        expect(joined).not.toBeNull();
        if (joined === null || joined.capture.status !== "captured") return;

        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: joined.capture.checkpoint,
          replicationReplay: { entries: [], queue },
          onStdout: replicaOut.onStdout,
        });
        await replica.init();
        await until(
          () => printedSeconds(replicaOut.read()).length >= 1,
          FOLLOW_LIMIT_MS,
          () => `the replica printed ${JSON.stringify(replicaOut.read())}`,
        );
        const beforeDrop = printedSeconds(replicaOut.read()).length;

        // The link dies mid-follow. The recording is suspended, not stopped,
        // and the replica's queue is left open — it parks at the log's end.
        const suspended = serving.suspend();
        expect(suspended).not.toBeNull();
        stopWatching();
        user.close();
        viewer.close();
        expect(position).not.toBeNull();

        // The machine finishes the whole workload while no wire exists, so
        // every remaining decision lands only in the ring.
        expect(await guestExit).toBe(0);
        await until(
          () => printedSeconds(primaryOut.read()).length === LIVE_READS,
          FOLLOW_LIMIT_MS,
          () => `the primary printed ${JSON.stringify(primaryOut.read())}`,
        );
        const printed = printedSeconds(primaryOut.read());

        // The next link. Its serve never reads the machine: the resume is
        // answered from the suspended recording alone.
        userB = new LocalReplicationLog<string>(secondLink);
        viewerB = new LocalReplicationLog<string>(secondLink);
        const servingB = userB.serve(
          async () => {
            captures += 1;
            return null;
          },
          { suspended },
        );
        const stopWatchingB = viewerB.watch(
          {
            entries: (entries) => writer.push(entries),
            advanced: (at) => void (position = at),
            diverged: (error) => void divergences.push(error),
            ended: () => writer.end(),
          },
          { from: position! },
        );
        await viewerB.resume(position!.nextSeq - 1, 30_000);

        // The replica drains the missed decisions and prints past where the
        // drop parked it.
        await until(
          () => printedSeconds(replicaOut.read()).length > beforeDrop,
          FOLLOW_LIMIT_MS,
          () => `the replica printed ${JSON.stringify(replicaOut.read())}`,
        );

        // Ending the recording ends the queue behind it, and the replica
        // consumes everything ahead of the end before it honors it.
        servingB.stop();
        await until(
          () => {
            const replicated = printedSeconds(replicaOut.read());
            return replicated.length > beforeDrop
              && replicated[replicated.length - 1] === printed[printed.length - 1]
              && JSON.stringify(replicated) === JSON.stringify(
                printed.slice(printed.length - replicated.length),
              );
          },
          FOLLOW_LIMIT_MS,
          () => `the replica printed ${JSON.stringify(replicaOut.read())} `
            + `while the primary printed ${JSON.stringify(printed)}`,
        );
        stopWatchingB();

        expect(divergences).toEqual([]);
        expect(captures).toBe(1);
        const progress = await replica.stopReplicationReplay();
        expect(progress.consumed).toBe(progress.total);
        expect(progress.borrowedClockReadings).toBe(0);
        expect(progress.borrowedAcceptSelections).toBe(0);
        expect(progress.scannedAheadClockReadings).toBe(0);
      } finally {
        writer.end();
        userB?.close();
        viewerB?.close();
        await replica?.destroy();
        await primary.destroy();
      }
    },
  );
});
