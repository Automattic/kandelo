import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import ts from "typescript";
import { waitForHttpPreview as currentProbe } from "../../apps/browser-demos/lib/init/http-preview-readiness";

const beforeRoot = process.env.KANDELO_PREVIEW_READINESS_BEFORE_ROOT;
const file = beforeRoot
  ? `${beforeRoot}/apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
  : new URL("../../apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts", import.meta.url);
const source = ts.createSourceFile(String(file), readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const functionText = (name: string) => {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw Error(`Missing actual consumer function ${name}`);
  return declaration.getText(source);
};
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type Probe = typeof currentProbe;
function actualProbe(): Probe {
  if (!beforeRoot) return currentProbe;
  const code = ["waitForHttpPreview", "fetchWithTimeout", "sleep"].map(functionText).join("\n");
  return new Function("window", compile(code) + "\nreturn waitForHttpPreview;")({
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  });
}

interface Preview { status: string; url: string; message?: string }
function readiness() {
  let probing = false, done!: () => void;
  const settled = new Promise<void>(resolve => { done = resolve; });
  return {
    controller: new AbortController(), ready: false, failed: false,
    get probing() { return probing; },
    set probing(value: boolean) { const was = probing; probing = value; if (was && !value) done(); },
    settled,
  };
}

/** The real live consumer/disposer bodies run unchanged. Only the host and
 * transport boundary are supplied by this fixture, without booting a guest. */
function consumer() {
  const raw: Promise<void>[] = [], ticks: string[] = [], disposal: boolean[] = [];
  let preview: Preview | null = null;
  const host = { setWebPreview(value: Preview) { preview = value; } };
  const probe: Probe = (...args) => {
    const pending = actualProbe()(...args);
    raw.push(pending.then(() => {}, () => {}));
    return pending;
  };
  const mark = new Function("waitForHttpPreview", "HTTP_PORT", "window",
    compile(functionText("previewUrlForPath") + "\n" + functionText("maybeMarkWebReady")) + "\nreturn maybeMarkWebReady;",
  )(probe, 80, { location: { href: "http://127.0.0.1/" } });
  let disposeText = "";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "setWebPreviewHandler") {
      const object = node.arguments[0];
      if (object && ts.isObjectLiteralExpression(object)) {
        const property = object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === "dispose");
        if (property && ts.isPropertyAssignment(property)) disposeText = property.initializer.getText(source);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!disposeText) throw Error("Missing actual preview disposal edge");
  return {
    raw, ticks, disposal,
    get preview() { return preview; },
    set preview(value: Preview | null) { preview = value; },
    start(state: ReturnType<typeof readiness>, prefix: string, current: () => boolean) {
      mark(host, { requiredPorts: [80], probeHttp: true, probePath: "/kandelo-ready.php" },
        prefix, new Set(), new Set([80]), true, prefix, state,
        { hasSucceeded: () => true }, (line: string) => ticks.push(line), current);
    },
    dispose(state: ReturnType<typeof readiness>) {
      const callback = new Function("webReadiness", "BootSuperseded", "previewConnection", "disposeLocalWebBridge",
        compile("const dispose = " + disposeText + ";") + "\nreturn dispose;",
      )(state, class BootSuperseded extends Error {},
        { dispose: () => disposal.push(state.controller.signal.aborted) }, () => {});
      callback();
    },
  };
}

async function deadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), 1_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("machine-owned HTTP preview readiness", () => {
  it("actual consumer cancels its real outgoing fetch before bridge disposal and preserves the successor", async () => {
    let response!: ServerResponse, observed!: () => void, closed!: () => void;
    const started = new Promise<void>(resolve => { observed = resolve; });
    const oldClosed = new Promise<void>(resolve => { closed = resolve; });
    const requests: string[] = [];
    const server = createServer((request, reply) => {
      requests.push(request.url!);
      if (request.url!.startsWith("/old/")) {
        response = reply; reply.on("close", closed); observed();
      } else { reply.writeHead(200); reply.end("ready"); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing private server port");
    const base = `http://127.0.0.1:${address.port}`;
    const old = readiness(), next = readiness(), state = consumer();
    let oldCurrent = true;
    try {
      state.start(old, base + "/old/", () => oldCurrent);
      await deadline(started, "old actual request was never received");
      oldCurrent = false;
      state.dispose(old);
      state.start(next, base + "/new/", () => true);
      await deadline(oldClosed, "retired activation left its real fetch alive");
      await deadline(next.settled, "current activation did not become visible");
      expect(state.disposal).toEqual([true]);
      expect(next.controller.signal.aborted).toBe(false);
      expect(state.preview).toMatchObject({ status: "running", url: base + "/new/" });
      expect(requests).toEqual(["/old/kandelo-ready.php", "/new/kandelo-ready.php"]);
    } finally {
      // Also release the original implementation's uncancelled request after
      // a causal before failure, so no control leaves a poll/server running.
      if (response && !response.destroyed) { response.writeHead(200); response.end("cleanup"); }
      old.controller.abort(); next.controller.abort();
      await Promise.all(state.raw);
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections(); await stopped;
    }
  });

  it("cancels the actual retry timer instead of only hiding its later UI update", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fetch = vi.fn(async () => new Response("not ready", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const state = readiness(), ui = consumer();
    ui.start(state, "http://127.0.0.1/old/", () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    ui.dispose(state);
    // Advance past the original 90s budget to prove no delayed retry survives,
    // not merely a handful of microtasks that precede the next retry timer.
    await vi.advanceTimersByTimeAsync(91_500);
    await Promise.all(ui.raw);
    expect(fetch).toHaveBeenCalledOnce();
    expect(ui.ticks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a queued old success cannot resurrect a halted current activation", async () => {
    let reply!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { reply = resolve; })));
    const state = readiness(), ui = consumer();
    ui.start(state, "http://127.0.0.1/old/", () => true);
    ui.dispose(state);
    ui.preview = { status: "halted", url: "http://127.0.0.1/old/" };
    reply(new Response("late ready", { status: 200 }));
    await state.settled;
    expect(ui.preview?.status).toBe("halted");
    expect(ui.ticks).toEqual([]);
  });

  it("preserves the current activation's full deadline and genuine HTTP failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("database unavailable", { status: 503 })));
    const state = readiness(), ui = consumer();
    ui.start(state, "http://127.0.0.1/current/", () => true);
    await vi.advanceTimersByTimeAsync(89_000);
    expect(ui.preview?.status).toBe("starting");
    await vi.advanceTimersByTimeAsync(2_500);
    await state.settled;
    expect(state.controller.signal.aborted).toBe(false);
    expect(ui.preview).toMatchObject({ status: "error", message: "HTTP preview did not become ready" });
    expect(ui.ticks).toEqual(["HTTP preview readiness failed: HTTP 503"]);
  });

  it("retries a current per-request timeout instead of classifying it as generation cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let attempts = 0;
    const fetch = vi.fn((_url: string, options: RequestInit) => ++attempts === 1
      ? new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }))
      : Promise.resolve(new Response("ready", { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = actualProbe()("http://127.0.0.1/current/", 90_000, { requireOk: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5_250);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(controller.signal.aborted).toBe(false);
  });

  it("never starts a transport for an already retired activation", async () => {
    const fetch = vi.fn(async () => new Response("ready", { status: 200 })); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(), retired = Error("exact activation retired");
    controller.abort(retired);
    const pending = actualProbe()("http://127.0.0.1/old/", 90_000, { signal: controller.signal });
    await expect(pending).rejects.toBe(retired);
    expect(fetch).not.toHaveBeenCalled();
  });
});
