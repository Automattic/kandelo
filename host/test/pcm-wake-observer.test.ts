import { describe, expect, it, vi } from "vitest";
import {
  PCM_CONTROL,
  PcmStreamState,
  pcmControlWords,
  signalPcmConsumerProgress,
  writeConsumerPosition,
  type PcmTransportDescriptor,
} from "../src/audio/pcm-transport";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { createPcmTransport, writeProducer } from "./pcm-test-helpers";

type WakeObserverAccess = {
  startPcmWakeObserver(descriptor: PcmTransportDescriptor): void;
};

function testWorker(
  descriptor: PcmTransportDescriptor,
  pcmReconcile: () => number,
): CentralizedKernelWorker {
  return Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    pcmTransportDescriptor: descriptor,
    pcmWakeObserverGeneration: 0,
    kernel: { pcmReconcile },
    drainAndProcessWakeupEvents: vi.fn(),
    scheduleWakeBlockedRetries: vi.fn(),
  }) as CentralizedKernelWorker;
}

describe("PCM wake observation", () => {
  it("reconciles final-quantum progress without requiring a later wake", async () => {
    const descriptor = createPcmTransport({ state: PcmStreamState.Draining });
    const words = pcmControlWords(descriptor);
    writeProducer(descriptor, 4n);
    const reconcile = vi.fn(() => {
      if (reconcile.mock.calls.length === 1) {
        // Model the worklet publishing the final cursor while the preceding
        // reconciliation is in flight. Its notification may run before the
        // observer arms again, so the remembered sequence must cause a retry.
        writeConsumerPosition(words, 4n);
        signalPcmConsumerProgress(words);
      }
      return 0;
    });
    const worker = testWorker(descriptor, reconcile);

    const observer = worker as unknown as WakeObserverAccess;
    observer.startPcmWakeObserver(descriptor);

    // The first pass observes the progress race; the sequence recheck drives
    // the second reconciliation synchronously without another notification.
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(Atomics.load(words, PCM_CONTROL.wakeSeq)).toBe(1);

    worker.shutdownPcmTransport();
    await Promise.resolve();
  });

  it("does not sleep when progress lands between the drain check and wait", async () => {
    const descriptor = createPcmTransport({ state: PcmStreamState.Draining });
    const words = pcmControlWords(descriptor);
    writeProducer(descriptor, 4n);
    const worker = testWorker(descriptor, () => 0);
    const originalLoad = Atomics.load.bind(Atomics);
    let wakeSequenceLoads = 0;
    const loadSpy = vi.spyOn(Atomics, "load").mockImplementation(
      ((array: Int32Array, index: number) => {
        if (
          array.buffer === words.buffer &&
          array.byteOffset === words.byteOffset &&
          index === PCM_CONTROL.wakeSeq
        ) {
          wakeSequenceLoads++;
          if (wakeSequenceLoads === 2) {
            // The first load remembers the prior sequence. Inject the final
            // cursor at the explicit pre-wait recheck to exercise the window
            // that used to lose this one-shot notification.
            writeConsumerPosition(words, 4n);
            signalPcmConsumerProgress(words);
          }
        }
        return originalLoad(array, index);
      }) as typeof Atomics.load,
    );

    let settledWithoutAnotherWake: boolean | undefined;
    try {
      let settled: boolean | undefined;
      const drain = worker.waitForPcmDrain(1_000).then((value) => {
        settled = value;
        return value;
      });
      await Promise.resolve();
      settledWithoutAnotherWake = settled;

      // Keep a failing implementation from leaving a live waiter behind.
      if (settled === undefined) {
        writeConsumerPosition(words, 4n);
        signalPcmConsumerProgress(words);
        await drain;
      }
    } finally {
      loadSpy.mockRestore();
    }

    expect(wakeSequenceLoads).toBeGreaterThanOrEqual(2);
    expect(settledWithoutAnotherWake).toBe(true);
  });
});
