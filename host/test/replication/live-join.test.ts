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
import type { ReplicationLogEntry } from "../../src/replication/log";
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
});
