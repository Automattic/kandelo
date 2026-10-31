import { describe, expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host.js";
import { BrowserKernel } from "../src/browser-kernel-host.js";
import { NodeInputSource } from "../src/input/node-input-source.js";
import type { MainToKernelMessage } from "../src/node-kernel-protocol.js";
import { LiveKernelHost } from "../../web-libs/kandelo-session/src/kernel-host.js";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker.js";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch.js";

/**
 * Dual-host parity test. Covers the Node side of `attachInputSource`
 * — the browser side is mirror-imaged in `BrowserKernel` and exercised
 * end-to-end by the Playwright demo spec. The contract verified here:
 *
 *   1. `setInputCanvasDims` runs exactly once with the requested dims.
 *   2. `source.start(dispatch)` runs exactly once.
 *   3. The dispatch handed to `start` groups each SYN_REPORT frame and
 *      forwards it as one `input_event_batch_inject` worker msg.
 *
 * We bypass `init()` (which spawns a worker_thread + waits for ready
 * over a worker channel) and stub `sendToWorker` directly. The
 * constructor only stores options, so a bare `new NodeKernelHost()`
 * is safe to construct.
 */
describe("NodeKernelHost.attachInputSource", () => {
  it("sets canvas dims, starts the source, and batches each SYN_REPORT frame", () => {
    const host = new NodeKernelHost();
    const sent: MainToKernelMessage[] = [];
    (host as unknown as { sendToWorker: (m: MainToKernelMessage) => void })
      .sendToWorker = (m) => sent.push(m);

    const source = new NodeInputSource();
    const startSpy = vi.spyOn(source, "start");

    host.attachInputSource(source, { width: 1024, height: 768 });

    // 1. canvas dims went out exactly once with the right values.
    const dims = sent.filter((m) => m.type === "set_input_canvas_dims");
    expect(dims).toEqual([
      { type: "set_input_canvas_dims", width: 1024, height: 768 },
    ]);

    // 2. source.start was called exactly once with a function arg.
    expect(startSpy).toHaveBeenCalledTimes(1);
    const dispatch = startSpy.mock.calls[0]?.[0];
    expect(typeof dispatch).toBe("function");

    // 3. A pointer frame (REL_X, REL_Y, SYN_REPORT) crosses as one batch.
    const relX = { device: 1 as const, ev_type: 0x02, code: 0x00, value: 5 };
    const relY = { device: 1 as const, ev_type: 0x02, code: 0x01, value: -3 };
    const syn = { device: 1 as const, ev_type: 0x00, code: 0x00, value: 0 };
    dispatch!(relX);
    dispatch!(relY);
    // Nothing crosses until the frame closes.
    expect(sent.filter((m) => m.type === "input_event_batch_inject")).toEqual(
      [],
    );
    dispatch!(syn);

    const batches = sent.filter((m) => m.type === "input_event_batch_inject");
    expect(batches).toEqual([
      { type: "input_event_batch_inject", records: [relX, relY, syn] },
    ]);
    // The per-record channel is unused by the batched path.
    expect(sent.filter((m) => m.type === "input_event_inject")).toEqual([]);
  });

  it("setInputCanvasDims posts the worker message standalone", () => {
    const host = new NodeKernelHost();
    const sent: MainToKernelMessage[] = [];
    (host as unknown as { sendToWorker: (m: MainToKernelMessage) => void })
      .sendToWorker = (m) => sent.push(m);

    host.setInputCanvasDims(640, 480);
    host.setInputCanvasDims(800, 600);

    expect(sent).toEqual([
      { type: "set_input_canvas_dims", width: 640, height: 480 },
      { type: "set_input_canvas_dims", width: 800, height: 600 },
    ]);
  });

  it("injectInputEvent posts the worker message standalone", () => {
    const host = new NodeKernelHost();
    const sent: MainToKernelMessage[] = [];
    (host as unknown as { sendToWorker: (m: MainToKernelMessage) => void })
      .sendToWorker = (m) => sent.push(m);

    host.injectInputEvent(0, 0x01, 1, 0);

    expect(sent).toEqual([
      {
        type: "input_event_inject",
        device: 0,
        ev_type: 0x01,
        code: 1,
        value: 0,
      },
    ]);
  });

  it("injectInputEventBatch posts one message and drops an empty batch", () => {
    const host = new NodeKernelHost();
    const sent: MainToKernelMessage[] = [];
    (host as unknown as { sendToWorker: (m: MainToKernelMessage) => void })
      .sendToWorker = (m) => sent.push(m);

    host.injectInputEventBatch([]); // empty → no message
    const records = [
      { device: 1 as const, ev_type: 0x02, code: 0x00, value: 2 },
      { device: 1 as const, ev_type: 0x00, code: 0x00, value: 0 },
    ];
    host.injectInputEventBatch(records);

    expect(sent).toEqual([
      { type: "input_event_batch_inject", records },
    ]);
  });
});

describe("KMS pointer frames through the existing host transports", () => {
  it.each(["Node", "Browser"] as const)(
    "%s preserves all records and schedules one worker wake per complete frame",
    (kind) => {
      const records: number[][] = [];
      const wakeAfter: number[] = [];
      const worker = createCentralizedKernelWorkerTestDouble();
      installKernelWorkerTestScratch(worker, new WebAssembly.Memory({ initial: 2 }), 128, 4, {
        kernelExports: {
          kernel_input_event: (...record: number[]) => { records.push(record); },
        },
        kernelExportNames: ["kernel_input_event"],
      });
      worker.testAuthority.configureScratchBoundaryHooksForTest({
        scheduleWakeBlockedRetries: () => { wakeAfter.push(records.length); },
      });
      const sent: MainToKernelMessage[] = [];
      const send = (message: MainToKernelMessage) => {
        sent.push(message);
        if (message.type === "input_event_batch_inject") {
          worker.injectInputEventBatch(message.records);
        } else if (message.type === "input_event_inject") {
          worker.injectInputEvent(message.device, message.ev_type, message.code, message.value);
        }
      };
      const proxy = kind === "Node" ? new NodeKernelHost() : new BrowserKernel();
      Object.assign(proxy, kind === "Node" ? { sendToWorker: send } : { sendToKernel: send });
      const host = new LiveKernelHost();
      // Keep the actual transport methods/receivers; canvas transfer is not
      // under test and no worker thread, display, SDK or guest is booted.
      host.attachKernel({
        kmsAttachCanvas: () => {},
        injectInputEvent: proxy.injectInputEvent.bind(proxy),
        injectInputEventBatch: proxy.injectInputEventBatch.bind(proxy),
      });
      const handle = host.attachKmsDisplay({
        transferControlToOffscreen: () => ({}),
      } as unknown as HTMLCanvasElement)!;
      Atomics.store(handle.stats, 2, 960);
      Atomics.store(handle.stats, 3, 540);
      handle.sendPointerAbs(959, 0, 2);
      handle.sendPointerAbs(0, 539, 1);
      handle.sendPointerAbs(0, 539, 1);
      Atomics.store(handle.stats, 2, 1280);
      Atomics.store(handle.stats, 3, 720);
      handle.sendPointerAbs(1279, 719, 0);
      const syn = [1, 0, 0, 0];
      expect(records).toEqual([
        [1, 3, 0, 65535], [1, 3, 1, 0], syn, [1, 1, 0x111, 1], syn,
        [1, 3, 0, 0], [1, 3, 1, 65535], syn, [1, 1, 0x111, 0], [1, 1, 0x110, 1], syn,
        [1, 3, 0, 0], [1, 3, 1, 65535], syn,
        [1, 3, 0, 65535], [1, 3, 1, 65535], syn, [1, 1, 0x110, 0], syn,
      ]);
      expect(sent).toHaveLength(7);
      expect(sent.every(message => message.type === "input_event_batch_inject")).toBe(true);
      // Observe the real batch method's wake-scheduling seam only after each
      // SYN has entered the gated kernel fixture, never after partial axes.
      expect(wakeAfter).toEqual([3, 5, 8, 11, 14, 17, 19]);
      handle.close();
    },
  );
});
