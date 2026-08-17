import { describe, expect, it, vi } from "vitest";
import {
  PCM_CONTROL,
  PcmStreamState,
  pcmControlWords,
  signalPcmConsumerProgress,
  writeConsumerPosition,
  type PcmTransportDescriptor,
} from "../src/audio/pcm-transport";
import {
  createPcmKernelWorker,
  writeProducer,
} from "./pcm-test-helpers";

describe("PCM wake observation", () => {
  it("reconciles final-quantum progress without requiring a later wake", async () => {
    const reconcile = vi.fn((descriptor: PcmTransportDescriptor) => {
      const words = pcmControlWords(descriptor);
      if (reconcile.mock.calls.length === 1) {
        // Model the worklet publishing the final cursor while the preceding
        // reconciliation is in flight. Its notification may run before the
        // observer arms again, so the remembered sequence must cause a retry.
        writeConsumerPosition(words, 4n);
        signalPcmConsumerProgress(words);
      }
      return 0;
    });
    const { worker, descriptor } = createPcmKernelWorker({
      transport: { state: PcmStreamState.Draining },
      beforeClaim: (transport) => writeProducer(transport, 4n),
      reconcile,
      observeConsumerWake: true,
    });
    const words = pcmControlWords(descriptor);

    // The first pass observes the progress race; the sequence recheck drives
    // the second reconciliation synchronously without another notification.
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(Atomics.load(words, PCM_CONTROL.wakeSeq)).toBe(1);

    worker.shutdownPcmTransport();
    await Promise.resolve();
  });

  it("does not sleep when progress lands between the drain check and wait", async () => {
    const { worker, descriptor } = createPcmKernelWorker({
      transport: { state: PcmStreamState.Draining },
    });
    const words = pcmControlWords(descriptor);
    writeProducer(descriptor, 4n);
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
