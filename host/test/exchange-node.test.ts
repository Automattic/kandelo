/**
 * Kandelo exchange end to end on the Node host: NodeKernelHost.exchange
 * offers a Blob and a stream, a guest consumer
 * (programs/exchange-consumer.c) receives them as a batch under
 * /run/kandelo/exchange/inbox (a regular file and a FIFO), publishes an
 * uppercased output for each through a work session (stored and streamed),
 * and settles the batch; the host's output listener reads the outputs and
 * their leases release them from outbox/.
 *
 * The machine boots from a kernel rootfs image, as every Kandelo machine
 * does; the legacy raw host-root mode has no exchange mount (see
 * docs/architecture.md). Skips if the program is not built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { ExchangeOfferError, type ExchangeOutput } from "../src/exchange-controller";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

/** A program that exits 0 at once, never opening `events`. */
const helloWasm = fileURLToPath(new URL("../../examples/hello.wasm", import.meta.url));

/** A rootfs image whose agent path holds `agent`, or nothing. */
async function imageWithAgent(agent?: string): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  if (agent) {
    for (const dir of ["/usr", "/usr/libexec", "/usr/libexec/kandelo"]) fs.mkdir(dir, 0o755);
    fs.createFileWithOwner(
      "/usr/libexec/kandelo/exchange-agent",
      0o755,
      0,
      0,
      new Uint8Array(readFileSync(agent)),
    );
  }
  return fs.saveImage();
}

const consumer = tryResolveBinary("programs/exchange-consumer.wasm");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(check: () => boolean, what: string, timeoutMs: number, log: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}.\n${log()}`);
}

describe("Kandelo exchange (Node host)", () => {
  it.skipIf(!consumer)(
    "delivers offered files and streams to a guest consumer and its outputs back",
    async () => {
      let out = "";
      let err = "";
      // The test program is the consumer, so no agent races it.
      const host = new NodeKernelHost({
        rootfsImage: await KandeloImageFs.create().saveImage(),
        exchange: { activation: "off" },
        onStdout: (_pid, data) => { out += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err += new TextDecoder().decode(data); },
      });
      const log = () => `${out}\n--- stderr ---\n${err}`;
      const listening = new AbortController();
      try {
        await host.init();
        expect(await host.exchange.consumerPresent()).toBe(false);
        expect(await host.exchange.consumerState()).toEqual({ state: "idle", activation: "off" });

        // No consumer: the batch waits, then gives up and is cancelled.
        await expect(
          host.exchange.offer([{ name: "early.txt", source: new Blob(["early"]) }], {
            consumerTimeoutMs: 100,
          }),
        ).rejects.toSatisfy(
          (error) => error instanceof ExchangeOfferError && error.reason === "consumer-timeout",
        );

        const received: { output: ExchangeOutput; text: string }[] = [];
        host.exchange.onOutput(
          async (output) => {
            const text = await new Response(output.read()).text().catch((error: Error) => `ERROR ${error.message}`);
            received.push({ output, text });
          },
          { signal: listening.signal },
        );

        // Offered before the consumer exists; delivered when it opens events.
        const feed = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("feed "));
            controller.enqueue(new TextEncoder().encode("me"));
            controller.close();
          },
        });
        const offered = host.exchange.offer(
          [
            { name: "hello.txt", source: new Blob(["hello exchange"]), mimeType: "text/plain" },
            { name: "feed.txt", source: feed, mimeType: "text/plain" },
          ],
          { source: "drop" },
        );
        const exit = host.spawn(loadBytes(consumer!), ["exchange-consumer"], {});
        const batch = await offered.catch((error: Error) => {
          throw new Error(`${error.message}\n${log()}`);
        });
        expect(batch.entries).toEqual([
          { id: expect.any(String), path: "hello.txt" },
          { id: expect.any(String), path: "feed.txt" },
        ]);

        const settlement = await batch.settled;
        expect(settlement, log()).toEqual({ outcome: "removed", status: "done" });
        await batch.released;
        expect(await exit, log()).toBe(0);
        expect(out).toContain("EXCH_EVENT outputs accepting\n");
        expect(out).toContain(`EXCH_EVENT batch ${batch.id}\n`);
        expect(out).toContain(
          `EXCH_INPUT_ATTRS name=hello.txt id=${batch.entries[0]!.id} mime=text/plain`,
        );
        expect(out).toContain("EXCH_INPUT name=hello.txt kind=file bytes=hello exchange");
        expect(out).toContain("EXCH_INPUT name=feed.txt kind=stream bytes=feed me");
        expect(out).toContain("EXCH_DONE");

        await waitFor(() => received.length === 2, "the outputs", 20_000, log);
        const stored = received.find((r) => r.output.name === "upper-hello.txt")!;
        expect(stored.text).toBe("HELLO EXCHANGE");
        expect(stored.output.kind).toBe("stored");
        expect(stored.output.size).toBe(14);
        expect(stored.output.mimeType).toBe("text/plain");
        expect(stored.output.derivedFrom).toEqual([batch.entries[0]!.id]);
        expect(out).toContain(`EXCH_PUBLISHED name=upper-hello.txt id=${stored.output.id}`);
        // The streamed output arrived as the guest wrote it, and closed
        // because the guest declared it complete.
        const streamed = received.find((r) => r.output.name === "upper-feed.txt")!;
        expect(streamed.text).toBe("FEED ME");
        expect(streamed.output.kind).toBe("stream");
        expect(streamed.output.derivedFrom).toEqual([batch.entries[1]!.id]);
        expect(out).toContain("EXCH_PUBLISHED name=upper-feed.txt stream");

        // Reading done and the listener settled: the lease ends and
        // nothing is left on either side.
        await waitFor(() => host.exchange.stats().leases === 0, "the lease to end", 5_000, log);
        expect(host.exchange.stats()).toEqual({ sources: 0, batches: 0, leases: 0, listener: true });
        expect(await host.exchange.consumerPresent()).toBe(false);
        expect(err).toBe("");
      } finally {
        listening.abort();
        await host.destroy();
      }
    },
    60_000,
  );

  it("refuses an offer at once when no agent exists and nothing consumes", async () => {
    const host = new NodeKernelHost({ rootfsImage: await imageWithAgent() });
    try {
      await host.init();
      await expect(
        host.exchange.offer([{ name: "a.txt", source: new Blob(["a"]) }]),
      ).rejects.toSatisfy(
        (error) => error instanceof ExchangeOfferError && error.reason === "unavailable",
      );
      expect(await host.exchange.consumerState()).toEqual({ state: "unavailable", activation: "on-demand" });
      expect(host.exchange.stats()).toMatchObject({ sources: 0, batches: 0 });
    } finally {
      await host.destroy();
    }
  }, 60_000);

  it("refuses a malformed offer without harming the machine", async () => {
    const host = new NodeKernelHost({ rootfsImage: await imageWithAgent(), exchange: { activation: "off" } });
    try {
      await host.init();
      await expect(
        host.exchange.offer([{ name: "x".repeat(70_000), source: new Blob(["a"]) }]),
      ).rejects.toSatisfy((error) => error instanceof ExchangeOfferError && error.reason === "invalid-name");
      await expect(
        host.exchange.offer([{ name: "a.txt", source: new Blob(["a"]), modifiedMs: Number.NaN }]),
      ).rejects.toSatisfy((error) => error instanceof ExchangeOfferError && error.reason === "invalid-name");
      // The kernel is still serving.
      expect(await host.exchange.consumerState()).toEqual({ state: "idle", activation: "off" });
    } finally {
      await host.destroy();
    }
  }, 60_000);

  it.skipIf(!consumer)(
    "starts the image's agent on demand to take an offer",
    async () => {
      const host = new NodeKernelHost({ rootfsImage: await imageWithAgent(consumer!) });
      const listening = new AbortController();
      try {
        await host.init();
        expect(await host.exchange.consumerState()).toEqual({ state: "idle", activation: "on-demand" });
        const states: string[] = [];
        const unsubscribe = host.exchange.onConsumer((state) => states.push(state.state));
        const outputs: string[] = [];
        host.exchange.onOutput(
          async (output) => {
            const text = await new Response(output.read()).text().catch((error: Error) => `ERROR ${error.message}`);
            outputs.push(`${output.name}=${text}`);
          },
          { signal: listening.signal },
        );
        // Nothing consumes until the kernel activates the agent (here the
        // test consumer, installed at the agent path).
        const batch = await host.exchange.offer([{ name: "note.txt", source: new Blob(["on demand"]) }]);
        expect(await batch.settled).toEqual({ outcome: "removed", status: "done" });
        await waitFor(() => outputs.length === 1, "the agent's output", 20_000,
          () => `states ${states.join(",")} stats ${JSON.stringify(host.exchange.stats())}`);
        expect(outputs).toEqual(["upper-note.txt=ON DEMAND"]);
        // The agent exits when done; init reaps it and the state returns to idle.
        await waitFor(() => states.at(-1) === "idle", "the agent to exit", 20_000, () => states.join(","));
        expect(states).toContain("starting");
        expect(states).toContain("ready");
        unsubscribe();
      } finally {
        listening.abort();
        await host.destroy();
      }
    },
    60_000,
  );

  it("reports an agent that exits without consuming as a failure and backs off", async () => {
    const host = new NodeKernelHost({ rootfsImage: await imageWithAgent(helloWasm) });
    try {
      await host.init();
      const states: { state: string; lastFailure?: unknown }[] = [];
      const unsubscribe = host.exchange.onConsumer((state) => states.push(state));
      await expect(
        host.exchange.offer([{ name: "a.txt", source: new Blob(["a"]) }], { consumerTimeoutMs: 2_000 }),
      ).rejects.toSatisfy(
        (error) => error instanceof ExchangeOfferError && error.reason === "consumer-timeout",
      );
      // hello exits 0 without opening `events`: a failure, then a retry.
      expect(states).toContainEqual({ state: "starting", activation: "on-demand", lastFailure: { exitStatus: 0 } });
      unsubscribe();
    } finally {
      await host.destroy();
    }
  }, 60_000);
});
