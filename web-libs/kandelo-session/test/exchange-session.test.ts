/**
 * ExchangeSession against a scripted exchange: the session's view of
 * batches, consumer state and the output tray, and that leases end only when
 * the user saves or dismisses.
 */
import { describe, expect, it } from "vitest";
import {
  describeExchangeConsumer,
  ExchangeSession,
  type ExchangeConsumerStateView,
  type ExchangeLike,
} from "../src/exchange-session";
import { TERMINAL_REQUEST_MIME, type TerminalRequest } from "../src/terminal-request";

function scripted() {
  let outputListener: Parameters<ExchangeLike["onOutput"]>[0] | null = null;
  const consumerListeners = new Set<(state: ExchangeConsumerStateView) => void>();
  let settle!: (s: { outcome: "removed" | "discarded" | "cancelled"; status?: string }) => void;
  let statusListener: ((status: string) => void) | null = null;
  let refuse: string | null = null;
  const exchange: ExchangeLike = {
    async offer(items) {
      if (refuse) throw Object.assign(new Error("refused"), { reason: refuse });
      return {
        id: "batch-1",
        entries: items.map((item, i) => ({ id: `entry-${i}`, path: item.name })),
        onStatus: (listener) => {
          statusListener = listener;
          return () => {};
        },
        settled: new Promise((resolve) => (settle = resolve)),
      };
    },
    onOutput(callback) {
      outputListener = callback;
    },
    async consumerState() {
      return { state: "ready", activation: "on-demand" };
    },
    onConsumer(listener) {
      consumerListeners.add(listener);
      return () => consumerListeners.delete(listener);
    },
  };
  return {
    exchange,
    publish(id: string, derivedFrom: string[], content: { body: string; mimeType: string } = { body: "out", mimeType: "text/plain" }) {
      let withdraw!: () => void;
      const lease = outputListener!(
        {
          id,
          name: `${id}.txt`,
          kind: "stored",
          size: new TextEncoder().encode(content.body).byteLength,
          mimeType: content.mimeType,
          derivedFrom,
          read: () => new Response(content.body).body!,
          withdrawn: new Promise<void>((resolve) => (withdraw = resolve)),
        },
        { signal: new AbortController().signal },
      );
      return { lease: Promise.resolve(lease), withdraw };
    },
    consumer(state: ExchangeConsumerStateView) {
      for (const listener of consumerListeners) listener(state);
    },
    status: (text: string) => statusListener?.(text),
    settle: (s: Parameters<typeof settle>[0]) => settle(s),
    refuseWith(reason: string) {
      refuse = reason;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ExchangeSession", () => {
  it("follows a batch from offer to settlement", async () => {
    const fake = scripted();
    const session = new ExchangeSession();
    session.attach(fake.exchange);
    await tick();
    expect(session.consumer).toEqual({ state: "ready", activation: "on-demand" });
    const key = await session.offer([{ name: "photo.jpg", source: new Blob(["x"]) }], "drop");
    expect(key).toBe("batch-1");
    expect(session.batches).toEqual([{ key, names: ["photo.jpg"], phase: "active", status: "" }]);
    fake.status("resizing");
    expect(session.batches[0]!.status).toBe("resizing");
    fake.settle({ outcome: "removed", status: "saved to ~/Downloads/photo.jpg" });
    await tick();
    expect(session.batches[0]).toMatchObject({ phase: "done", status: "saved to ~/Downloads/photo.jpg" });
    fake.settle({ outcome: "removed", status: "x" });
    session.dismissBatch(key);
    expect(session.batches).toEqual([]);
  });

  it("shows a handler failure, an early exit, a refusal and an unreadable drop as failed", async () => {
    const fake = scripted();
    const session = new ExchangeSession();
    session.attach(fake.exchange);
    await session.offer([{ name: "a.bin", source: new Blob(["a"]) }], "drop");
    fake.settle({ outcome: "removed", status: "no handler: a.bin" });
    await tick();
    expect(session.batches[0]).toMatchObject({ phase: "failed", status: "no handler: a.bin" });

    const second = scripted();
    session.attach(second.exchange);
    await session.offer([{ name: "b" }], "picker");
    second.settle({ outcome: "discarded" });
    await tick();
    expect(session.batches.at(-1)).toMatchObject({ phase: "failed", status: "The file handler exited before finishing" });

    second.refuseWith("unavailable");
    await session.offer([{ name: "c", source: new Blob(["c"]) }], "drop");
    expect(session.batches.at(-1)).toMatchObject({ phase: "failed", status: "This machine doesn't accept files" });

    session.reportUnreadable("NotFoundError");
    expect(session.batches.at(-1)).toMatchObject({ names: [], phase: "failed", status: "Could not read the files: NotFoundError" });
  });

  it("holds an output's lease until it is saved or dismissed, and names its inputs", async () => {
    const fake = scripted();
    const session = new ExchangeSession();
    session.attach(fake.exchange);
    await session.offer([{ name: "notes.txt", source: new Blob(["n"]) }], "drop");
    let released = false;
    const { lease } = fake.publish("out-1", ["entry-0"]);
    void lease.then(() => (released = true));
    expect(session.outputs).toEqual([
      { id: "out-1", name: "out-1.txt", kind: "stored", size: 3, mimeType: "text/plain", derivedFrom: ["notes.txt"], withdrawn: false },
    ]);
    expect(await new Response(session.readOutput("out-1")).text()).toBe("out");
    await tick();
    expect(released).toBe(false);
    session.finishOutput("out-1");
    await tick();
    expect(released).toBe(true);
    expect(session.outputs).toEqual([]);
  });

  it("marks withdrawn outputs and forgets everything on detach", async () => {
    const fake = scripted();
    const session = new ExchangeSession();
    session.attach(fake.exchange);
    const { withdraw } = fake.publish("out-2", []);
    withdraw();
    await tick();
    expect(session.outputs[0]!.withdrawn).toBe(true);
    session.detach();
    expect(session.outputs).toEqual([]);
    expect(session.consumer).toBeNull();
  });

  it("hands a terminal request to the app's handler instead of the tray", async () => {
    const fake = scripted();
    const session = new ExchangeSession();
    session.attach(fake.exchange);
    const opened: TerminalRequest[] = [];
    session.setTerminalRequestHandler(async (request) => { opened.push(request); });
    const body = JSON.stringify({ version: 1, command: "retro-run ~/roms/'Game (U).sfc'", title: "Game (U).sfc", display: "framebuffer" });
    const { lease } = fake.publish("req-1", [], { body, mimeType: TERMINAL_REQUEST_MIME });
    await lease;
    await tick();
    expect(opened).toEqual([{ command: "retro-run ~/roms/'Game (U).sfc'", title: "Game (U).sfc", display: "framebuffer" }]);
    expect(session.outputs).toEqual([]);
    expect(session.batches).toEqual([]);
  });

  it("keeps a terminal request as an ordinary output when no handler is set", async () => {
    const fake = scripted();
    const session = new ExchangeSession();
    session.attach(fake.exchange);
    const body = JSON.stringify({ version: 1, command: "ls", title: "ls" });
    fake.publish("req-2", [], { body, mimeType: TERMINAL_REQUEST_MIME });
    expect(session.outputs.map((o) => o.id)).toEqual(["req-2"]);
  });

  it("shows a refused or failed terminal request as a failed entry", async () => {
    const fake = scripted();
    const session = new ExchangeSession();
    session.attach(fake.exchange);
    const opened: TerminalRequest[] = [];
    session.setTerminalRequestHandler(async (request) => {
      if (request.title === "busy") throw new Error("Another activity is starting or stopping");
      opened.push(request);
    });
    // A newline would run a second command at the prompt.
    await fake.publish("req-3", [], {
      body: JSON.stringify({ version: 1, command: "ls\nrm -rf ~", title: "two lines" }),
      mimeType: TERMINAL_REQUEST_MIME,
    }).lease;
    await fake.publish("req-4", [], {
      body: JSON.stringify({ version: 1, command: "ls", title: "busy" }),
      mimeType: TERMINAL_REQUEST_MIME,
    }).lease;
    await tick();
    expect(opened).toEqual([]);
    expect(session.outputs).toEqual([]);
    expect(session.batches.map((b) => [b.names, b.phase, b.status])).toEqual([
      [["req-3.txt"], "failed", "The machine asked for a terminal, but the request's command contains control characters"],
      [["busy"], "failed", "Could not open a terminal: Another activity is starting or stopping"],
    ]);
  });

  it("describes each consumer state for the UI", () => {
    expect(describeExchangeConsumer({ state: "ready", activation: "on-demand" })).toBeNull();
    expect(describeExchangeConsumer({ state: "idle", activation: "on-demand" })).toBe("Starting the file handler…");
    expect(describeExchangeConsumer({ state: "idle", activation: "off" })).toBe("Waiting for a file handler");
    expect(describeExchangeConsumer({ state: "starting", activation: "on-demand", lastFailure: { exitStatus: 78 } }))
      .toBe("The file handler exited with status 78; retrying");
    expect(describeExchangeConsumer({ state: "unavailable", activation: "on-demand" })).toBe("This machine doesn't accept files");
  });
});
