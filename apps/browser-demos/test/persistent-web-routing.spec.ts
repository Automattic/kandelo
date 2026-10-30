import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

let server: Server;
let origin: string;

const pausedCachePutFixture = `
let routingPausePort;
let routingResumePut;
const routingNativePut = Cache.prototype.put;
Cache.prototype.put = async function(key, response) {
  if (routingPausePort && String(key).includes("bridge-authority-v1/")) {
    const port = routingPausePort;
    routingPausePort = null;
    await new Promise(resolve => { routingResumePut = resolve; port.postMessage("paused"); });
    port.close();
  }
  return routingNativePut.call(this, key, response);
};
self.addEventListener("message", event => {
  if (event.data?.type === "routing-test-arm") {
    routingPausePort = event.ports[0];
    routingPausePort.postMessage("armed");
  } else if (event.data?.type === "routing-test-resume") {
    routingResumePut?.();
    routingResumePut = null;
  }
});
`;

test.beforeAll(async () => {
  const source = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/service-worker.js" ? "application/javascript" : "text/html");
    response.setHeader("Cache-Control", "no-store");
    response.end(request.url === "/service-worker.js" ? pausedCachePutFixture + source : "<!doctype html><title>Persistent web routing</title>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

async function prepare(page: Page): Promise<void> {
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  });
}

async function acquireLease(page: Page, name: string): Promise<() => Promise<void>> {
  await page.evaluate(async computerName => {
    const state = window as Window & { releaseRoutingLease?: () => void; routingLease?: Promise<unknown> };
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    state.routingLease = navigator.locks.request(`kandelo-fixed-rootfs-runtime:${computerName}`, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new Error("fixture computer lease is busy");
      state.releaseRoutingLease = release;
      acquired();
      await released;
    });
    await Promise.race([ready, state.routingLease]);
  }, name);
  return () => page.evaluate(async () => {
    const state = window as Window & { releaseRoutingLease?: () => void; routingLease?: Promise<unknown> };
    state.releaseRoutingLease?.();
    await state.routingLease;
  });
}

async function install(page: Page, label: string, computerName?: string): Promise<{ type: string; name: string; appPrefix: string; code?: string }> {
  return page.evaluate(async parameters => {
    const state = window as Window & { routingReplies?: Record<string, Record<string, { status?: number; headers: Record<string, string>; body: string }>>; routingPorts?: MessagePort[]; routingSessions?: Record<string, string> };
    state.routingReplies ??= {};
    state.routingPorts ??= [];
    state.routingSessions ??= {};
    const sessionId = crypto.randomUUID();
    state.routingSessions[parameters.label] = sessionId;
    const bridge = new MessageChannel();
    bridge.port1.onmessage = event => {
      if (event.data?.type !== "http-request") return;
      const configured = state.routingReplies?.[parameters.label]?.[event.data.url];
      bridge.port1.postMessage({ type: "http-response", requestId: event.data.requestId, status: configured?.status ?? 200,
        headers: configured?.headers ?? { "Content-Type": "application/json", "Set-Cookie": `routing=${parameters.label}; Path=/` },
        body: new TextEncoder().encode(configured?.body ?? JSON.stringify({ label: parameters.label, url: event.data.url, cookie: event.data.headers.cookie ?? "" })) });
    };
    bridge.port1.start();
    state.routingPorts.push(bridge.port1);
    const reply = new MessageChannel();
    let releaseProof: (() => void) | undefined;
    let proof: Promise<unknown> | undefined;
    try {
      return await new Promise<{ type: string; name: string; appPrefix: string; code?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("routing handshake timed out")), 15000);
        reply.port1.onmessage = event => {
          const message = event.data;
          if (message?.type === "bridge-lease-challenge") {
            const released = new Promise<void>(complete => { releaseProof = complete; });
            proof = navigator.locks.request(`kandelo-http-bridge-proof:${message.nonce}`, { mode: "exclusive", ifAvailable: true }, async lock => {
              if (!lock) throw new Error("routing challenge lease is busy");
              reply.port1.postMessage({ type: "bridge-lease-proof", nonce: message.nonce });
              await released;
            });
            void proof.catch(reject);
          } else {
            clearTimeout(timer);
            resolve(message);
          }
        };
        reply.port1.start();
        navigator.serviceWorker.controller!.postMessage({ type: "init-bridge", sessionId,
          ...(parameters.computerName === undefined ? {} : { persistentComputerName: parameters.computerName }) }, [bridge.port2, reply.port2]);
      });
    } finally { releaseProof?.(); await proof; reply.port1.close(); }
  }, { label, computerName });
}

test("a persistent public route survives lease handoff while cookies and old close messages remain isolated", async ({ page, context }) => {
  await prepare(page);
  const release = await acquireLease(page, "persistent-routing");
  const first = await install(page, "first", "persistent-routing");
  expect(first.type).toBe("bridge-ready");
  expect(first.name).toMatch(/^p-[a-f0-9]{64}$/);
  await page.evaluate(async prefix => { await fetch(prefix); }, first.appPrefix);
  const successor = await context.newPage();
  await prepare(successor);
  expect((await install(successor, "unauthorized", "persistent-routing")).type).toBe("bridge-error");
  await release();
  const releaseSuccessor = await acquireLease(successor, "persistent-routing");
  try {
    const second = await install(successor, "second", "persistent-routing");
    expect(second.type).toBe("bridge-ready");
    expect(second.appPrefix).toBe(first.appPrefix);
    await page.evaluate(name => navigator.serviceWorker.controller!.postMessage({ type: "instance-closing", name }), first.name);
    const response = await successor.evaluate(async prefix => (await fetch(prefix)).json(), second.appPrefix);
    expect(response).toMatchObject({ label: "second", cookie: "" });
  } finally { await releaseSuccessor(); }
});

test("persistent routes reject a claim without the computer lease", async ({ page }) => {
  await prepare(page);
  expect((await install(page, "unleased", "unleased-routing")).type).toBe("bridge-error");
});

test("explicit computer URLs survive response and redirect rewriting", async ({ page }) => {
  await prepare(page);
  const first = await install(page, "first");
  const second = await install(page, "second");
  const remote = `${origin}${second.appPrefix}media.gif`;
  await page.evaluate(({ label, remote, origin, secondPrefix }) => {
    const state = window as Window & { routingReplies: Record<string, Record<string, unknown>> };
    const payload = { other: remote, encoded: encodeURIComponent(remote), root: `${origin}/media.gif`,
      encodedRoot: encodeURIComponent(`${origin}/media.gif`), sibling: `${origin}/other/computer/remote-test-name/media.gif`,
      query: encodeURIComponent(`${origin}${secondPrefix.slice(0, -1)}?x=1`),
      fragment: encodeURIComponent(`${origin}${secondPrefix.slice(0, -1)}#picture`).replaceAll("%2F", "%2f") };
    state.routingReplies[label] = {
      "/plain": { headers: { "Content-Type": "application/json", "Link": `<${remote}>; rel="related"` }, body: JSON.stringify(payload) },
      "/escaped": { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload).replaceAll("/", "\\/") },
      "/redirect": { status: 302, headers: { Location: secondPrefix }, body: "" },
    };
  }, { label: "first", remote, origin, secondPrefix: second.appPrefix });
  for (const path of ["plain", "escaped"]) {
    const response = await page.evaluate(async url => { const response = await fetch(url); return { body: await response.json(), link: response.headers.get("link") }; }, `${first.appPrefix}${path}`);
    response.body.fragment = decodeURIComponent(response.body.fragment);
    expect(response.body).toEqual({ other: remote, encoded: encodeURIComponent(remote), root: `${origin}${first.appPrefix}media.gif`,
      encodedRoot: encodeURIComponent(`${origin}${first.appPrefix}media.gif`), sibling: `${origin}/other/computer/remote-test-name/media.gif`,
      query: encodeURIComponent(`${origin}${second.appPrefix.slice(0, -1)}?x=1`),
      fragment: `${origin}${second.appPrefix.slice(0, -1)}#picture` });
    if (path === "plain") expect(response.link).toBe(`<${remote}>; rel="related"`);
  }
  expect(await page.evaluate(async url => (await fetch(url)).json(), `${first.appPrefix}redirect`)).toMatchObject({ label: "second" });
});

test("offline cleanup drains an already-writing cookie revision without resurrecting the retired session", async ({ page }) => {
  await prepare(page);
  const release = await acquireLease(page, "retired-routing");
  try {
    const installed = await install(page, "retired", "retired-routing");
    await page.evaluate(async () => {
      const state = window as Window & { routingPaused?: Promise<void>; routingCookieFetch?: Promise<unknown> };
      let paused!: () => void;
      state.routingPaused = new Promise<void>(resolve => { paused = resolve; });
      await new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => {
          if (event.data === "armed") resolve();
          if (event.data === "paused") { paused(); channel.port1.close(); }
        };
        navigator.serviceWorker.controller!.postMessage({ type: "routing-test-arm" }, [channel.port2]);
      });
    });
    await page.evaluate(prefix => {
      const state = window as Window & { routingCookieFetch?: Promise<unknown> };
      state.routingCookieFetch = fetch(prefix).catch(() => null);
    }, installed.appPrefix);
    await page.evaluate(async () => { await (window as Window & { routingPaused: Promise<void> }).routingPaused; });
    await page.evaluate(name => {
      const state = window as Window & { routingSessions: Record<string, string> };
      navigator.serviceWorker.controller!.postMessage({ type: "instance-closing", name, sessionId: state.routingSessions.retired });
      navigator.serviceWorker.controller!.postMessage({ type: "routing-test-resume" });
    }, installed.name);
    await expect.poll(() => page.evaluate(async name => {
      const cache = await caches.open("kandelo-sw:%2F:bridge-v2");
      return !!(await cache.match(`bridge-authority-v1/${name}`));
    }, installed.name)).toBe(false);
    await page.evaluate(async () => { await (window as Window & { routingCookieFetch?: Promise<unknown> }).routingCookieFetch; });
  } finally { await release(); }
});
