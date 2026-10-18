/**
 * Take-over promotion: adopt the replica this computer already runs.
 *
 * A take-over used to mean a checkpoint transfer even when the taker had
 * been running a replica all along — megabytes on the wire and a restore,
 * to reproduce a machine the taker already holds. Promotion replaces the
 * transfer with a proof: the keeper seals its recording inside a freeze and
 * hashes the sealed state, the replica drains to the seal and hashes its
 * own, and the machine changes hands only when the two hashes agree.
 *
 * The claim these tests hold is the platform half of that protocol: a seal
 * and a drained replica's hash agree at the promotion boundary — every
 * process region byte for byte, the kernel region (which holds the
 * filesystems) exempt at the measured boundary `state-hash.ts` documents —
 * and the replica then carries on as a machine of its own. The wire and the
 * page are the product half, on top of these primitives.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "Divergence detection and resync", and doc 026's step 2 shape:
 * seal → drain → hash → adopt, with the checkpoint path as the fallback.
 */
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../../src/node-kernel-host";
import type { ReplicationLogEntry } from "../../src/replication/log";
import { comparePromotionStateHashes } from "../../src/replication/state-hash";
import {
  ReplicationLogQueueWriter,
  createReplicationLogQueue,
} from "../../src/replication/log-queue";
import {
  collectStdout,
  pause,
  printedSeconds,
} from "../support/replication-machine";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

/** How long a replica may need to drain to the seal before the test gives up. */
const DRAIN_LIMIT_MS = 60_000;

/** How many times the guest reads the clock. */
const READS = 12;

/** A guest that is mid-loop when the recording starts and ends. */
const GUEST = [
  "sh",
  "-c",
  `i=0; while [ $i -lt ${READS} ]; do date +%s; j=0; `
  + `while [ $j -lt 2000 ]; do j=$((j+1)); done; i=$((i+1)); done`,
];

/** A guest whose two subshells make syscalls without pause. */
const BUSY_PAIR = [
  "sh",
  "-c",
  "for k in 1 2; do (while :; do : >/dev/null; done) & done; wait",
];

async function until(
  ready: () => boolean,
  describeWait: () => string,
): Promise<void> {
  const deadline = Date.now() + DRAIN_LIMIT_MS;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting: ${describeWait()}`);
    }
    await pause(25);
  }
}

describe("take-over promotion", () => {
  it(
    "seals the keeper, drains the replica, and the hashes agree",
    { timeout: 300_000 },
    async () => {
      const keeperOut = collectStdout();
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: keeperOut.onStdout,
      });
      await keeper.init();
      const replicaOut = collectStdout();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      let published = 0;
      try {
        const guestExit = keeper
          .spawnFromVfs("/bin/sh", GUEST)
          .then(({ exit }) => exit);
        await until(
          () => printedSeconds(keeperOut.read()).length >= 2,
          () => `the guest printed ${keeperOut.read().trim().length} bytes`,
        );

        // The guest forks a `date` every iteration, so a freeze can land on
        // a child that exits under it; the departure is transient, like the
        // one `captureWhenIdle` retries.
        const onEntries = (entries: readonly ReplicationLogEntry[]) => {
          published += entries.length;
          writer.push(entries);
        };
        let joined = await keeper.captureAndStreamReplicationLog(
          TIMEOUTS,
          onEntries,
        );
        for (
          let attempt = 0;
          joined.capture.status === "failed"
          && /ended during the checkpoint freeze/.test(joined.capture.reason)
          && attempt < 40;
          attempt++
        ) {
          await pause(25);
          joined = await keeper.captureAndStreamReplicationLog(
            TIMEOUTS,
            onEntries,
          );
        }
        expect(
          joined.capture.status,
          joined.capture.status === "captured" ? "" : joined.capture.reason,
        ).toBe("captured");
        if (joined.capture.status !== "captured") return;

        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: joined.capture.checkpoint,
          replicationReplay: { entries: [], queue },
          onStdout: replicaOut.onStdout,
        });
        await replica.init();
        await until(
          () => printedSeconds(replicaOut.read()).length >= 1,
          () => `the replica printed ${JSON.stringify(replicaOut.read())}`,
        );

        // The keeper's guest finishes before the seal, so the sealed state is
        // a settled machine rather than a race with its own workload.
        expect(await guestExit).toBe(0);
        await until(
          () => printedSeconds(keeperOut.read()).length === READS,
          () => `the keeper printed ${JSON.stringify(keeperOut.read())}`,
        );

        // Sealed once the guest is truly gone. Its exit promise resolves
        // before the kernel finishes reaping it, and a freeze that arms a
        // process which then leaves refuses transiently — the same departure
        // `captureWhenIdle` waits out.
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((await keeper.enumProcs()).every((proc) => proc.pid <= 1)) break;
          await pause(25);
        }
        let sealed = await keeper.sealReplicationRecording(TIMEOUTS);
        for (
          let attempt = 0;
          sealed.status === "refused"
          && /ended during the checkpoint freeze/.test(sealed.reason)
          && attempt < 40;
          attempt++
        ) {
          await pause(25);
          sealed = await keeper.sealReplicationRecording(TIMEOUTS);
        }
        expect(
          sealed.status,
          sealed.status === "sealed" ? "" : sealed.reason,
        ).toBe("sealed");
        if (sealed.status !== "sealed") return;
        // The seal names the position the next entry would have taken, which
        // is exactly how many the recording published.
        expect(sealed.seq).toBe(published);

        // A machine whose recording is sealed cannot be sealed again: the
        // second ask must say so rather than freeze for nothing.
        const again = await keeper.sealReplicationRecording(TIMEOUTS);
        expect(again.status).toBe("refused");
        if (again.status === "refused") {
          expect(again.reason).toContain("not recording");
        }

        // The replica finishes the sealed workload at its own pace: its guest
        // resumed from the checkpoint, so it prints the keeper's tail — the
        // reads after the capture — and exits. Freezing it mid-guest contends
        // with the freeze the way any capture of a busy machine does — the
        // mid-run seal is the boundary the module doc names — so the settled
        // machine is what this proof hashes.
        const printed = printedSeconds(keeperOut.read());
        await until(
          () => {
            const replicated = printedSeconds(replicaOut.read());
            return replicated.length > 0
              && JSON.stringify(replicated) === JSON.stringify(
                printed.slice(printed.length - replicated.length),
              )
              && replicated[replicated.length - 1]
                === printed[printed.length - 1];
          },
          () => `the replica printed ${JSON.stringify(replicaOut.read())} `
            + `while the keeper printed ${JSON.stringify(keeperOut.read())}`,
        );
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((await replica.enumProcs()).every((proc) => proc.pid <= 1)) {
            break;
          }
          await pause(25);
        }

        // Drain to the seal. A refusal names the replica's position, or the
        // departure of a guest that has just finished; both pass, and the
        // nudge applies pushed decisions a parked guest would never pull.
        let hashed = await replica.hashReplicaAtSeal(sealed.seq, sealed.armSeq, TIMEOUTS);
        const deadline = Date.now() + DRAIN_LIMIT_MS;
        while (hashed.status === "refused") {
          if (Date.now() > deadline) {
            throw new Error(`the replica never drained: ${hashed.reason}`);
          }
          expect(hashed.reason).toMatch(
            /stands at|ended during the checkpoint freeze/,
          );
          replica.drainReplicationReplay();
          await pause(50);
          hashed = await replica.hashReplicaAtSeal(sealed.seq, sealed.armSeq, TIMEOUTS);
        }

        // A position past the seal is refused with where the replica stands,
        // which is what tells the caller to keep draining or give up.
        const past = await replica.hashReplicaAtSeal(
          sealed.seq + 5,
          sealed.armSeq,
          TIMEOUTS,
        );
        expect(past.status).toBe("refused");
        if (past.status === "refused") {
          expect(past.reason).toContain("stands at");
        }

        // The promotion gate: every process region of the drained replica
        // matches the sealed keeper byte for byte.
        const report = comparePromotionStateHashes(sealed.hash, hashed.hash);
        expect(report.diverged, report.summary).toBe(false);

        // Adopt: the replay ends, strictly consumed, and the machine is this
        // computer's own from here on — a fresh guest runs on its real clock.
        // Not asserted: zero tolerance counters. Before the seal they are
        // enforced by the hash itself — a borrowed or reordered reading lands
        // in a hashed region and fails the gate above. After the seal the
        // machine lives past the log's end, and a clock read its init makes
        // there borrows legitimately: that is the machine's own life
        // beginning, not replay softness.
        const progress = await replica.stopReplicationReplay();
        expect(progress.consumed).toBe(progress.total);
        const beforePromotion = printedSeconds(replicaOut.read()).length;
        const promoted = await replica.spawnFromVfs("/bin/sh", [
          "sh",
          "-c",
          "date +%s",
        ]);
        expect(await promoted.exit).toBe(0);
        await until(
          () => printedSeconds(replicaOut.read()).length === beforePromotion + 1,
          () => `the promoted machine printed `
            + `${JSON.stringify(replicaOut.read())}`,
        );
      } finally {
        writer.end();
        await replica?.destroy();
        await keeper.destroy();
      }
    },
  );

  it(
    "refuses a replica short of the seal's freeze without freezing it",
    { timeout: 300_000 },
    async () => {
      const keeperOut = collectStdout();
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: keeperOut.onStdout,
      });
      await keeper.init();
      const replicaOut = collectStdout();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      // Entries the replica has not been sent yet. Holding them back keeps
      // the replica mid-guest, short of the place the seal's freeze began.
      let held: ReplicationLogEntry[] | null = null;
      try {
        const guestExit = keeper
          .spawnFromVfs("/bin/sh", GUEST)
          .then(({ exit }) => exit);
        await until(
          () => printedSeconds(keeperOut.read()).length >= 2,
          () => `the guest printed ${keeperOut.read().trim().length} bytes`,
        );
        const onEntries = (entries: readonly ReplicationLogEntry[]) => {
          if (held === null) writer.push(entries);
          else held.push(...entries);
        };
        let joined = await keeper.captureAndStreamReplicationLog(
          TIMEOUTS,
          onEntries,
        );
        for (
          let attempt = 0;
          joined.capture.status === "failed"
          && /ended during the checkpoint freeze/.test(joined.capture.reason)
          && attempt < 40;
          attempt++
        ) {
          await pause(25);
          joined = await keeper.captureAndStreamReplicationLog(
            TIMEOUTS,
            onEntries,
          );
        }
        expect(
          joined.capture.status,
          joined.capture.status === "captured" ? "" : joined.capture.reason,
        ).toBe("captured");
        if (joined.capture.status !== "captured") return;

        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: joined.capture.checkpoint,
          replicationReplay: { entries: [], queue },
          onStdout: replicaOut.onStdout,
        });
        await replica.init();
        await until(
          () => printedSeconds(replicaOut.read()).length >= 1,
          () => `the replica printed ${JSON.stringify(replicaOut.read())}`,
        );
        held = [];

        expect(await guestExit).toBe(0);
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((await keeper.enumProcs()).every((proc) => proc.pid <= 1)) break;
          await pause(25);
        }
        let sealed = await keeper.sealReplicationRecording(TIMEOUTS);
        for (
          let attempt = 0;
          sealed.status === "refused"
          && /ended during the checkpoint freeze/.test(sealed.reason)
          && attempt < 40;
          attempt++
        ) {
          await pause(25);
          sealed = await keeper.sealReplicationRecording(TIMEOUTS);
        }
        expect(
          sealed.status,
          sealed.status === "sealed" ? "" : sealed.reason,
        ).toBe("sealed");
        if (sealed.status !== "sealed") return;
        expect(sealed.armSeq).toBeLessThanOrEqual(sealed.seq);

        // A freeze here would do the seal freeze's work early: the syscalls
        // the replica's processes unwind at would take the turns of syscalls
        // the keeper made, and the replica would never reach the seal.
        const short = await replica.hashReplicaAtSeal(
          sealed.seq,
          sealed.armSeq,
          TIMEOUTS,
        );
        expect(short.status).toBe("refused");
        if (short.status === "refused") {
          expect(short.reason).toContain("short of the seal's freeze");
        }

        // So the replica is still the keeper's machine: sent the rest of the
        // log, it drains to the seal mid-guest and hashes the same state.
        writer.push(held);
        let hashed = await replica.hashReplicaAtSeal(
          sealed.seq,
          sealed.armSeq,
          TIMEOUTS,
        );
        const deadline = Date.now() + DRAIN_LIMIT_MS;
        while (hashed.status === "refused") {
          if (Date.now() > deadline) {
            throw new Error(`the replica never drained: ${hashed.reason}`);
          }
          expect(hashed.reason).toMatch(
            /short of the seal's freeze|stands at|ended during the checkpoint freeze/,
          );
          replica.drainReplicationReplay();
          await pause(50);
          hashed = await replica.hashReplicaAtSeal(
            sealed.seq,
            sealed.armSeq,
            TIMEOUTS,
          );
        }
        const report = comparePromotionStateHashes(sealed.hash, hashed.hash);
        expect(report.diverged, report.summary).toBe(false);
      } finally {
        writer.end();
        await replica?.destroy();
        await keeper.destroy();
      }
    },
  );

  it(
    "hashes a replica sealed while two processes make syscalls",
    { timeout: 300_000 },
    async () => {
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      let replica: NodeKernelHost | null = null;
      const queue = createReplicationLogQueue();
      const writer = new ReplicationLogQueueWriter(queue);
      try {
        void keeper.spawnFromVfs("/bin/sh", BUSY_PAIR);
        let procs = 0;
        for (let attempt = 0; attempt < 400 && procs < 4; attempt++) {
          procs = (await keeper.enumProcs()).length;
          if (procs < 4) await pause(25);
        }
        expect(procs).toBeGreaterThanOrEqual(4);

        const joined = await keeper.captureAndStreamReplicationLog(
          TIMEOUTS,
          (entries) => writer.push(entries),
        );
        expect(
          joined.capture.status,
          joined.capture.status === "captured" ? "" : joined.capture.reason,
        ).toBe("captured");
        if (joined.capture.status !== "captured") return;
        replica = new NodeKernelHost({
          rootfsImage: "default",
          restoreCheckpoint: joined.capture.checkpoint,
          replicationReplay: { entries: [], queue },
        });
        await replica.init();
        await pause(1_000);

        // A live replica reaches the seal's entries before it hears of the
        // seal. Unheld, its loopers would take the turns of their own unwind
        // work and never reach the seal.
        const sealed = await keeper.sealReplicationRecording(TIMEOUTS);
        expect(
          sealed.status,
          sealed.status === "sealed" ? "" : sealed.reason,
        ).toBe("sealed");
        if (sealed.status !== "sealed") return;

        let hashed = await replica.hashReplicaAtSeal(
          sealed.seq,
          sealed.armSeq,
          TIMEOUTS,
        );
        const deadline = Date.now() + DRAIN_LIMIT_MS;
        while (hashed.status === "refused") {
          if (Date.now() > deadline) {
            throw new Error(`the replica never drained: ${hashed.reason}`);
          }
          expect(hashed.reason).toContain("short of the seal's freeze");
          replica.drainReplicationReplay();
          await pause(50);
          hashed = await replica.hashReplicaAtSeal(
            sealed.seq,
            sealed.armSeq,
            TIMEOUTS,
          );
        }
        const report = comparePromotionStateHashes(sealed.hash, hashed.hash);
        expect(report.diverged, report.summary).toBe(false);
      } finally {
        writer.end();
        await replica?.destroy();
        await keeper.destroy();
      }
    },
  );

  it(
    "refuses to seal a machine that is not recording",
    { timeout: 120_000 },
    async () => {
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      try {
        const sealed = await keeper.sealReplicationRecording(TIMEOUTS);
        expect(sealed.status).toBe("refused");
        if (sealed.status === "refused") {
          expect(sealed.reason).toContain("not recording");
        }
      } finally {
        await keeper.destroy();
      }
    },
  );
});
