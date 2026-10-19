/**
 * Suite: Replication take-over
 *
 * Measures the two paths a take-over can ride, on one machine pair, so the
 * promotion protocol (seal → drain → hash → adopt) is designed against
 * numbers rather than intuition. The checkpoint path is what ships today;
 * the drain is what promotion would replace it with.
 *
 * Metrics:
 *   primary_init_ms              — boot a machine from the default image
 *   capture_ms                   — freeze + read + resume + start the stream
 *   checkpoint_encoded_bytes     — the checkpoint on the wire (codec bytes)
 *   checkpoint_encode_ms         — serialize the checkpoint
 *   checkpoint_decode_ms         — parse it back
 *   restore_init_ms              — boot a replica from that checkpoint
 *   workload_ms                  — the primary runs the clock-reading guest
 *   log_entries                  — decisions published during the workload
 *   log_encoded_bytes            — those decisions on the wire (codec bytes)
 *   replica_behind_reads_at_freeze — guest prints the replica still owed
 *                                    when the primary froze
 *   replica_drain_ms             — freeze until the replica's guest exited
 *   replay_consumed / replay_total — the replica's final replay progress
 *   borrowed_clock_readings, borrowed_accept_selections,
 *   scanned_ahead_clock_readings — tolerance counters; all zero is the
 *                                  strict replay the promotion hash gate
 *                                  will require
 */
import { NodeKernelHost } from "../../host/src/node-kernel-host.js";
import { encodeMessage, decodeMessage } from "../../host/src/migration/codec.js";
import type { ReplicationLogEntry } from "../../host/src/replication/log.js";
import {
  ReplicationLogQueueWriter,
  createReplicationLogQueue,
} from "../../host/src/replication/log-queue.js";
import type { BenchmarkSuite } from "../types.js";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const READS = 12;
const GUEST = [
  "sh",
  "-c",
  `i=0; while [ $i -lt ${READS} ]; do date +%s; j=0; `
  + `while [ $j -lt 2000 ]; do j=$((j+1)); done; i=$((i+1)); done`,
];
const FOLLOW_LIMIT_MS = 120_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function collectStdout(): { onStdout: (pid: number, data: Uint8Array) => void; read: () => string } {
  let text = "";
  const decoder = new TextDecoder();
  return {
    onStdout: (_pid, data) => {
      text += decoder.decode(data);
    },
    read: () => text,
  };
}

function printedLines(stdout: string): number {
  const trimmed = stdout.trim();
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

async function until(
  ready: () => boolean,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + FOLLOW_LIMIT_MS;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${describe()}`);
    await pause(10);
  }
}

const suite: BenchmarkSuite = {
  name: "replication-takeover",

  async run(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const primaryOut = collectStdout();
    const replicaOut = collectStdout();
    const queue = createReplicationLogQueue();
    const writer = new ReplicationLogQueueWriter(queue);
    let logEntries = 0;
    let logEncodedBytes = 0;

    const t0 = performance.now();
    const primary = new NodeKernelHost({
      rootfsImage: "default",
      onStdout: primaryOut.onStdout,
    });
    await primary.init();
    results.primary_init_ms = performance.now() - t0;

    let replica: NodeKernelHost | null = null;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await primary.enumProcs()).every((proc) => proc.pid <= 1)) break;
        await pause(25);
      }
      const t1 = performance.now();
      const joined = await primary.captureAndStreamReplicationLog(
        TIMEOUTS,
        (entries: readonly ReplicationLogEntry[]) => {
          logEntries += entries.length;
          for (const entry of entries) {
            logEncodedBytes += encodeMessage(entry).byteLength;
          }
          writer.push(entries);
        },
      );
      results.capture_ms = performance.now() - t1;
      if (joined.capture.status !== "captured") {
        throw new Error(`capture failed: ${JSON.stringify(joined.capture)}`);
      }
      const checkpoint = joined.capture.checkpoint;

      const t2 = performance.now();
      const encoded = encodeMessage(checkpoint);
      results.checkpoint_encode_ms = performance.now() - t2;
      results.checkpoint_encoded_bytes = encoded.byteLength;
      const t3 = performance.now();
      decodeMessage(encoded);
      results.checkpoint_decode_ms = performance.now() - t3;

      const t4 = performance.now();
      replica = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        replicationReplay: { entries: [], queue },
        onStdout: replicaOut.onStdout,
      });
      await replica.init();
      results.restore_init_ms = performance.now() - t4;

      const replicaExit = replica
        .spawnFromVfs("/bin/sh", GUEST)
        .then(({ exit }) => exit);

      const t5 = performance.now();
      const { exit } = await primary.spawnFromVfs("/bin/sh", GUEST);
      const primaryExit = await exit;
      if (primaryExit !== 0) throw new Error(`guest exited ${primaryExit}`);
      await until(
        () => printedLines(primaryOut.read()) === READS,
        () => `the primary printed ${JSON.stringify(primaryOut.read())}`,
      );
      results.workload_ms = performance.now() - t5;

      results.replica_behind_reads_at_freeze =
        READS - printedLines(replicaOut.read());
      const t6 = performance.now();
      await joined.stop();
      writer.end();
      const drained = await Promise.race([
        replicaExit,
        pause(FOLLOW_LIMIT_MS).then(() => "parked" as const),
      ]);
      if (drained !== 0) {
        throw new Error(`replica did not drain: ${JSON.stringify(drained)}`);
      }
      await until(
        () => printedLines(replicaOut.read()) === READS,
        () => `the replica printed ${JSON.stringify(replicaOut.read())}`,
      );
      results.replica_drain_ms = performance.now() - t6;
      if (replicaOut.read() !== primaryOut.read()) {
        throw new Error(
          `replica diverged: ${JSON.stringify(replicaOut.read())} `
          + `vs ${JSON.stringify(primaryOut.read())}`,
        );
      }

      results.log_entries = logEntries;
      results.log_encoded_bytes = logEncodedBytes;
      const progress = await replica.stopReplicationReplay();
      results.replay_consumed = progress.consumed;
      results.replay_total = progress.total;
      results.borrowed_clock_readings = progress.borrowedClockReadings;
      results.borrowed_accept_selections = progress.borrowedAcceptSelections;
      results.scanned_ahead_clock_readings = progress.scannedAheadClockReadings;
      return results;
    } finally {
      writer.end();
      await replica?.destroy();
      await primary.destroy();
    }
  },
};

export default suite;
