/**
 * ExchangeController against a scripted kernel worker: the host side's
 * bookkeeping must end with nothing held, whatever order the kernel reports
 * things in and however the embedder treats outputs.
 */
import { describe, expect, it } from "vitest";
import { ExchangeController, ExchangeOfferError } from "../src/exchange-controller";
import type { ExchangeNotification, ExchangeWorkerRequest } from "../src/exchange-host";

const id = (n: number) => new Uint8Array(16).fill(n);
const text = (s: string) => new TextEncoder().encode(s);

function scriptedWorker(offer: { committed: boolean }) {
  const requests: ExchangeWorkerRequest[] = [];
  /** An input FIFO with `room` bytes free. */
  const fifo = { room: 0, pushed: [] as number[], ended: "" };
  /** A streamed output's writer. */
  const outputChunks: Uint8Array[] = [];
  let outputEnded = false;
  let outputEnd: Uint8Array | number = -61; // ENODATA
  const transport = {
    async request(request: ExchangeWorkerRequest): Promise<unknown> {
      requests.push(request);
      switch (request.op) {
        case "offer":
          return {
            ok: true,
            batch: id(1),
            entries: request.entries.map((_, index) => id(10 + index)),
            committed: offer.committed,
          };
        case "read_output":
          return request.offset === 0 ? text("bytes") : new Uint8Array(0);
        case "stream_push": {
          const accepted = Math.min(request.bytes.byteLength, fifo.room);
          fifo.room -= accepted;
          fifo.pushed.push(...request.bytes.subarray(0, accepted));
          return accepted;
        }
        case "stream_end":
          fifo.ended = request.failed ? "failed" : "clean";
          return 0;
        case "stream_read":
          return outputChunks.length > 0 ? outputChunks.shift()! : outputEnded ? new Uint8Array(0) : -11;
        case "output_end":
          return outputEnd;
        default:
          return 0;
      }
    },
    sendRange() {},
  };
  const controller = new ExchangeController(transport);
  const notify = (...notifications: ExchangeNotification[]) =>
    controller.handleNotifications(notifications);
  return {
    controller,
    requests,
    notify,
    fifo,
    write(chunk: Uint8Array) {
      outputChunks.push(chunk);
    },
    finish(end: string | null) {
      outputEnded = true;
      outputEnd = end === null ? -61 : text(end);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ExchangeController", () => {
  it("resolves released when source releases follow the settlement", async () => {
    const { controller, notify } = scriptedWorker({ committed: true });
    const batch = await controller.offer([{ name: "a.txt", source: new Blob(["a"]) }]);
    expect(controller.stats()).toMatchObject({ sources: 1, batches: 1 });

    // The kernel's order: the settlement, then the releases it caused.
    notify(
      { kind: "settled", batch: id(1), outcome: "removed", status: text("done") },
      { kind: "source-released", source: 1n },
    );
    await expect(batch.settled).resolves.toEqual({ outcome: "removed", status: "done" });
    await batch.released;
    expect(controller.stats()).toMatchObject({ sources: 0, batches: 0 });
  });

  it("cancels a batch no consumer takes in time and holds nothing after", async () => {
    const { controller, requests, notify } = scriptedWorker({ committed: false });
    await expect(
      controller.offer([{ name: "a.txt", source: new Blob(["a"]) }], { consumerTimeoutMs: 10 }),
    ).rejects.toSatisfy(
      (error) => error instanceof ExchangeOfferError && error.reason === "consumer-timeout",
    );
    expect(requests.some((request) => request.op === "cancel")).toBe(true);
    notify(
      { kind: "settled", batch: id(1), outcome: "cancelled", status: new Uint8Array(0) },
      { kind: "source-released", source: 1n },
    );
    await flush();
    expect(controller.stats()).toMatchObject({ sources: 0, batches: 0 });
    const interest = requests
      .filter((request) => request.op === "interest")
      .reduce((sum, request) => sum + (request as { delta: number }).delta, 0);
    expect(interest).toBe(0);
  });

  it("feeds a stream input only as the kernel reports room", async () => {
    const worker = scriptedWorker({ committed: true });
    let enqueue!: (chunk: Uint8Array) => void;
    let finish!: () => void;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (chunk) => controller.enqueue(chunk);
        finish = () => controller.close();
      },
    });
    await worker.controller.offer([{ name: "feed", source }]);
    expect(worker.requests.find((r) => r.op === "offer")).toMatchObject({
      entries: [{ kind: "stream", size: 0n, path: ["feed"] }],
    });
    enqueue(text("abcdef"));
    worker.fifo.room = 4;
    worker.notify({ kind: "stream-demand", source: 1n, free: 4 });
    await flush();
    expect(new TextDecoder().decode(new Uint8Array(worker.fifo.pushed))).toBe("abcd");
    // The rest waits for room; then the end follows the last bytes.
    worker.fifo.room = 10;
    worker.notify({ kind: "stream-demand", source: 1n, free: 10 });
    finish();
    await flush();
    await flush();
    expect(new TextDecoder().decode(new Uint8Array(worker.fifo.pushed))).toBe("abcdef");
    expect(worker.fifo.ended).toBe("clean");
  });

  it("cancels a stream input the kernel released", async () => {
    const worker = scriptedWorker({ committed: true });
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await worker.controller.offer([{ name: "feed", source }]);
    worker.notify({ kind: "source-released", source: 1n });
    await flush();
    expect(cancelled).toBe(true);
    expect(worker.controller.stats().sources).toBe(0);
  });

  it.each([
    ["complete", null],
    ["aborted disk full", "the guest aborted the stream: disk full"],
    [null, "the guest ended the stream without declaring it complete"],
  ] as const)("reads a streamed output once and ends it as declared (%s)", async (end, failure) => {
    const worker = scriptedWorker({ committed: true });
    const listening = new AbortController();
    let read: Promise<string> | undefined;
    let secondRead: unknown;
    worker.controller.onOutput(
      (output) => {
        expect(output.kind).toBe("stream");
        expect(output.size).toBeUndefined();
        read = new Response(output.read()).text();
        try {
          output.read();
        } catch (error) {
          secondRead = error;
        }
        return read.then(() => {}, () => {});
      },
      { signal: listening.signal },
    );
    worker.notify({ kind: "output-published", output: id(6), stream: true, size: 0n, name: text("s"), derivedFrom: [] });
    expect(secondRead).toBeInstanceOf(Error);
    await flush();
    worker.write(text("part one, "));
    worker.notify({ kind: "stream-readable", output: id(6) });
    await flush();
    worker.write(text("part two"));
    worker.finish(end);
    worker.notify({ kind: "stream-readable", output: id(6) });
    if (failure === null) await expect(read).resolves.toBe("part one, part two");
    else await expect(read).rejects.toThrow(failure);
    await flush();
    expect(worker.requests.some((request) => request.op === "release_output")).toBe(true);
    listening.abort();
  });

  it("rejects a waiting offer at once when its batch settles without committing", async () => {
    const { controller, notify } = scriptedWorker({ committed: false });
    const offered = controller.offer([{ name: "a.txt", source: new Blob(["a"]) }], { consumerTimeoutMs: 60_000 });
    await flush();
    notify({ kind: "settled", batch: id(1), outcome: "cancelled", status: text("failed: could not create the batch") });
    await expect(offered).rejects.toSatisfy(
      (error) => error instanceof ExchangeOfferError && error.reason === "failed"
        && error.message === "failed: could not create the batch",
    );
  });

  it("keeps its interest until a settled batch has also released its sources", async () => {
    const { controller, requests, notify } = scriptedWorker({ committed: true });
    const interest = () => requests
      .filter((request) => request.op === "interest")
      .reduce((sum, request) => sum + (request as { delta: number }).delta, 0);
    await controller.offer([{ name: "a.txt", source: new Blob(["a"]) }]);
    notify({ kind: "settled", batch: id(1), outcome: "removed", status: text("done") });
    await flush();
    expect(interest(), "still waiting for the source release").toBe(1);
    notify({ kind: "source-released", source: 1n });
    await flush();
    expect(interest()).toBe(0);
  });

  it("releases an output nobody listens for at once", async () => {
    const { controller, requests, notify } = scriptedWorker({ committed: true });
    notify({ kind: "output-published", output: id(5), stream: false, size: 5n, name: text("o"), derivedFrom: [] });
    expect(requests).toContainEqual({ op: "release_output", output: id(5) });
    expect(controller.stats().leases).toBe(0);
  });

  it("holds an output's lease until the listener settles and its streams close", async () => {
    const { controller, requests, notify } = scriptedWorker({ committed: true });
    const listening = new AbortController();
    let finish!: () => void;
    let read!: ReadableStream<Uint8Array>;
    controller.onOutput(
      (output) => {
        read = output.read();
        return new Promise<void>((resolve) => (finish = resolve));
      },
      { signal: listening.signal },
    );
    notify({ kind: "output-published", output: id(5), stream: false, size: 5n, name: text("o"), derivedFrom: [id(10)] });
    const released = () => requests.some((request) => request.op === "release_output");

    expect(await new Response(read).text()).toBe("bytes");
    await flush();
    expect(released(), "the listener has not settled").toBe(false);
    finish();
    await flush();
    expect(released()).toBe(true);
    expect(controller.stats().leases).toBe(0);
    listening.abort();
  });
});
