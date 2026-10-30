import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MachineCookieJar } from "./cookie-jar";
import { machineIdentityFor, mintMachineIdentity, type MachineIdentity } from "./machine-names";
import {
  PreviewBridgeHost,
  type KernelHttpRequest,
  type KernelHttpResponse,
  type PreviewBridgeOptions,
} from "./preview-bridge";
import { PreviewBindRefused, relayFailureMessage } from "./preview-relay";
import {
  LEGACY_MACHINE_NAME_PATTERN,
  MACHINE_NAME_HASH_PATTERN,
  MACHINE_NAME_PATTERN,
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_RELAY_PATH,
  PREVIEW_SERVICE_WORKER_PATH,
  isLegacyMachineName,
  isMachineName,
  machineNameCommitment,
  machineNameHash,
  secretProvesMachineName,
} from "./protocol";
import {
  PREVIEW_HOST_LAYOUTS,
  PREVIEW_PROTOCOL_VERSION as BUNDLE_PROTOCOL_VERSION,
} from "../../vite/preview-origin";
import { rewriteSameHostUrls, translateFramePolicy } from "./response-shaping";

const PREVIEW = "http://127.0.0.1:5402";
const APP = "http://127.0.0.1:5401";
const SECRET_ONE = "00112233445566778899aabbccddeeff";
const SECRET_TWO = "ffeeddccbbaa99887766554433221100";
// Names commit to their secrets; computed once at load.
const ONE = (await machineIdentityFor("able-amber-acorn", SECRET_ONE)).name;
const fixedIdentity = (secret: string, words = "able-amber-acorn") => () => machineIdentityFor(words, secret);

/** A relay double: records binds and lets a test answer or refuse them. */
class FakeRelay {
  binds: Array<{ name: string; secret: string; port: MessagePort; seq: number }> = [];
  closings: Array<{ name: string; secret: string; seq: number }> = [];
  refuse: Array<"not-owner" | "version-mismatch" | Error> = [];
  needBridge = new Map<string, () => void>();
  workerChanged = new Set<() => void>();

  async bind(name: string, secret: string, port: MessagePort, seq: number): Promise<void> {
    const code = this.refuse.shift();
    if (code instanceof Error) throw code;
    if (code) throw new PreviewBindRefused(code, name);
    this.binds.push({ name, secret, port, seq });
  }
  closing(name: string, secret: string, seq: number): void {
    this.closings.push({ name, secret, seq });
  }
  onNeedBridge(name: string, handler: () => void): () => void {
    this.needBridge.set(name, handler);
    return () => this.needBridge.delete(name);
  }
  onWorkerChanged(listener: () => void): () => void {
    this.workerChanged.add(listener);
    return () => this.workerChanged.delete(listener);
  }
}

/** Answer the owner's liveness pings on `port`, as the preview worker does. */
function answerPings(port: MessagePort): void {
  port.onmessage = (event) => {
    const message = event.data as { type?: string; id?: number };
    if (message.type === "bridge-ping") {
      port.postMessage({ type: "bridge-pong", v: PREVIEW_PROTOCOL_VERSION, id: message.id });
    }
  };
}

function settle(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Served {
  request: KernelHttpRequest;
}

function kernel(answer: (request: KernelHttpRequest) => KernelHttpResponse) {
  const served: Served[] = [];
  return {
    served,
    fetchInKernel: async (_port: number, request: KernelHttpRequest) => {
      served.push({ request });
      return answer(request);
    },
  };
}

function text(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

async function open(
  answer: (request: KernelHttpRequest) => KernelHttpResponse,
  overrides: Partial<PreviewBridgeOptions> = {},
) {
  const relay = new FakeRelay();
  const fake = kernel(answer);
  const bridge = await PreviewBridgeHost.open({
    relay,
    previewOrigin: PREVIEW,
    scope: "/",
    appOrigin: APP,
    kernel: fake,
    port: 8080,
    interceptorSource: "window.__kandeloBlobIframePatched=true",
    mintIdentity: fixedIdentity(SECRET_ONE),
    ...overrides,
  });
  return { bridge, relay, fake };
}

/** Send one http-request over the bound port, as the preview worker does. */
async function request(
  port: MessagePort,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    port.onmessage = (event) => {
      port.onmessage = null;
      resolve(event.data);
    };
    port.postMessage({
      type: "http-request",
      v: PREVIEW_PROTOCOL_VERSION,
      id: 7,
      method: "GET",
      headers: [],
      body: null,
      mode: "navigate",
      destination: "iframe",
      navigation: false,
      ...message,
    });
  });
}

function headerMap(reply: Record<string, unknown>): Map<string, string> {
  return new Map(reply.headers as [string, string][]);
}

test("binds a minted name with its secret and serves its URLs on the preview origin", async () => {
  const { bridge, relay } = await open(() => ({ status: 200, headers: {}, body: text("ok") }));
  assert.equal(bridge.name, ONE);
  assert.match(ONE, /^able-amber-acorn-[a-z2-7]{20}$/);
  assert.equal(bridge.url, `${PREVIEW}/computer/${ONE}/`);
  assert.equal(bridge.viewerUrl, `${APP}/computer/${ONE}/`);
  assert.deepEqual(relay.binds.map((bind) => [bind.name, bind.secret]), [[ONE, SECRET_ONE]]);
  // The secret goes to the relay only; nothing public carries it.
  assert.equal(Object.values(bridge).some((value) => value === SECRET_ONE), false);
  assert.equal(bridge.url.includes(SECRET_ONE), false);
  bridge.dispose();
  assert.deepEqual(relay.closings.map(({ name, secret }) => ({ name, secret })), [{ name: ONE, secret: SECRET_ONE }]);
});

test("a name commits to its secret and to nothing else", async () => {
  assert.equal(await secretProvesMachineName(ONE, SECRET_ONE), true);
  assert.equal(await secretProvesMachineName(ONE, SECRET_TWO), false);
  assert.equal(await secretProvesMachineName(ONE, undefined), false);
  assert.equal(await secretProvesMachineName(ONE, SECRET_ONE.toUpperCase()), false);
  // The words are not part of the commitment, but a different secret never
  // yields the same name.
  const other = await machineIdentityFor("able-amber-acorn", SECRET_TWO);
  assert.notEqual(other.name, ONE);
  assert.equal(await secretProvesMachineName(other.name, SECRET_ONE), false);
  // A known vector, so the classic worker's copy can be checked against it.
  assert.equal(await machineNameCommitment(SECRET_ONE), ONE.slice(-20));
  assert.equal(ONE.slice(-20).length, 20);
});

test("old three-word names are recognized as old, never as machines", () => {
  assert.equal(isLegacyMachineName("able-amber-acorn"), true);
  assert.equal(isMachineName("able-amber-acorn"), false);
  assert.equal(isLegacyMachineName(ONE), false);
  assert.equal(isMachineName(ONE), true);
});

test("a protocol mismatch fails loudly instead of serving", async () => {
  const relay = new FakeRelay();
  relay.refuse.push("version-mismatch");
  await assert.rejects(
    PreviewBridgeHost.open({
      relay,
      previewOrigin: PREVIEW,
      scope: "/",
      appOrigin: APP,
      kernel: kernel(() => ({ status: 200, headers: {}, body: text("") })),
      port: 8080,
      mintIdentity: fixedIdentity(SECRET_ONE),
    }),
    /different preview protocol/,
  );
});

test("forwards the machine's prefix and host, and keeps cookies out of the browser", async () => {
  const { bridge, relay, fake } = await open((req) => req.url === "/wp-login.php"
    ? {
      status: 302,
      headers: {
        Location: "/wp-admin/",
        // The in-kernel parser joins repeated Set-Cookie lines with "\n".
        "Set-Cookie": [
          "wordpress_abc=admin; path=/wp-admin; HttpOnly",
          "wordpress_abc=plugins; path=/wp-content/plugins; HttpOnly",
          "wordpress_logged_in_abc=yes; path=/",
        ].join("\n"),
      },
      body: text(""),
    }
    : { status: 200, headers: { "Content-Type": "text/plain" }, body: text("ok") });
  const port = relay.binds[0]!.port;

  const login = await request(port, { method: "POST", url: "/wp-login.php", body: text("log=admin").buffer });
  assert.equal(login.type, "http-response");
  // A POST answered 302 becomes 303, under the machine prefix.
  assert.equal(login.status, 303);
  const headers = headerMap(login);
  assert.equal(headers.get("location"), `${PREVIEW}/computer/${ONE}/wp-admin/`);
  assert.equal(headers.has("set-cookie"), false);

  const sent = fake.served[0]!.request;
  assert.equal(sent.headers.host, "127.0.0.1:5402");
  assert.equal(sent.headers["x-forwarded-host"], "127.0.0.1:5402");
  assert.equal(sent.headers["x-forwarded-prefix"], `/computer/${ONE}`);
  assert.equal(sent.headers["x-forwarded-proto"], "http");
  assert.equal(new TextDecoder().decode(sent.body!), "log=admin");

  // Both same-name auth cookies survive, each for its own path.
  await request(port, { url: "/wp-admin/index.php" });
  assert.equal(
    fake.served[1]!.request.headers.cookie,
    "wordpress_abc=admin; wordpress_logged_in_abc=yes",
  );
  await request(port, { url: "/wp-content/plugins/x.js" });
  assert.equal(
    fake.served[2]!.request.headers.cookie,
    "wordpress_abc=plugins; wordpress_logged_in_abc=yes",
  );
  assert.deepEqual(
    bridge.cookieEntries().map((cookie) => cookie.path).sort(),
    [
      `/computer/${ONE}/`,
      `/computer/${ONE}/wp-admin`,
      `/computer/${ONE}/wp-content/plugins`,
    ],
  );
  bridge.dispose();
});

test("rewrites same-host URLs and injects the blob-iframe interceptor unless a CSP governs scripts", async () => {
  const html = `<html><head><title>t</title></head><body>` +
    `<a id="home" href="http://127.0.0.1:5402/computer/${ONE}">home</a>` +
    `<a id="root" href="http://127.0.0.1:5402/wp-content/x.css">x</a></body></html>`;
  const { bridge, relay } = await open((req) => ({
    status: 200,
    headers: req.url === "/csp"
      ? { "Content-Type": "text/html", "Content-Security-Policy": "script-src 'self'" }
      : req.url === "/framing"
        // WordPress's admin pages: a policy about framing only.
        ? { "Content-Type": "text/html", "Content-Security-Policy": "frame-ancestors 'self';", "X-Frame-Options": "SAMEORIGIN" }
        : { "Content-Type": "text/html; charset=utf-8" },
    body: text(html),
  }));
  const port = relay.binds[0]!.port;
  const page = new TextDecoder().decode((await request(port, { url: "/" })).body as ArrayBuffer);
  assert.match(page, /<head><script>window.__kandeloBlobIframePatched=true<\/script>/);
  // The bare machine prefix is not doubled; a root URL moves under it.
  assert.ok(page.includes(`href="http://127.0.0.1:5402/computer/${ONE}"`));
  assert.ok(page.includes(`href="http://127.0.0.1:5402/computer/${ONE}/wp-content/x.css"`));
  const withCsp = new TextDecoder().decode((await request(port, { url: "/csp" })).body as ArrayBuffer);
  assert.doesNotMatch(withCsp, /__kandeloBlobIframePatched/);
  const framing = await request(port, { url: "/framing" });
  assert.match(new TextDecoder().decode(framing.body as ArrayBuffer), /__kandeloBlobIframePatched/);
  assert.equal(headerMap(framing).get("content-security-policy"), `frame-ancestors 'self' ${APP};`);
  bridge.dispose();
});

test("refuses a request outside the machine instead of serving it", async () => {
  const { bridge, relay, fake } = await open(() => ({ status: 200, headers: {}, body: text("") }));
  const port = relay.binds[0]!.port;
  for (const url of ["//evil.example/", "relative", "/a\r\nb"]) {
    const reply = await request(port, { url });
    assert.equal(reply.type, "http-error");
  }
  const badMethod = await request(port, { method: "GET\r\nX: 1", url: "/" });
  assert.equal(badMethod.type, "http-error");
  assert.equal(fake.served.length, 0);
  bridge.dispose();
});

test("reports pending requests and served navigations", async () => {
  let release: (() => void) | null = null;
  const counts: number[] = [];
  const navigations: unknown[] = [];
  const relay = new FakeRelay();
  const bridge = await PreviewBridgeHost.open({
    relay,
    previewOrigin: PREVIEW,
    scope: "/",
    appOrigin: APP,
    port: 8080,
    mintIdentity: fixedIdentity(SECRET_ONE),
    kernel: {
      fetchInKernel: () => new Promise<KernelHttpResponse>((resolve) => {
        release = () => resolve({ status: 200, headers: {}, body: text("ok") });
      }),
    },
    onPendingRequests: (count) => counts.push(count),
    onNavigation: (navigation) => navigations.push(navigation),
  });
  const reply = request(relay.binds[0]!.port, { url: "/page?x=1", navigation: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(counts, [1]);
  release!();
  await reply;
  assert.deepEqual(counts, [1, 0]);
  assert.deepEqual(navigations, [{ path: "/page?x=1", status: 200, method: "GET" }]);
  bridge.dispose();
});

test("a fresh port after a preview worker restart keeps the machine's cookies", async () => {
  const { bridge, relay, fake } = await open((req) => req.url === "/set"
    ? { status: 200, headers: { "Set-Cookie": "sid=1; path=/" }, body: text("") }
    : { status: 200, headers: {}, body: text("") });
  await request(relay.binds[0]!.port, { url: "/set" });
  relay.needBridge.get(bridge.name)!();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(relay.binds.length, 2);
  await request(relay.binds[1]!.port, { url: "/after" });
  assert.equal(fake.served[1]!.request.headers.cookie, "sid=1");
  bridge.dispose();
});

test("a rebind is never a loss: late, forged or repeated notices just bind again", async () => {
  const lost: string[] = [];
  const { bridge, relay, fake } = await open(() => ({ status: 200, headers: {}, body: text("") }), {
    onLost: (reason) => lost.push(reason),
  });
  // A worker update and a need-bridge that arrives after it (or one any
  // guest in this tab forged) both bind again, with the same secret.
  for (const listener of relay.workerChanged) listener();
  relay.needBridge.get(bridge.name)!();
  await settle();
  relay.needBridge.get(bridge.name)!();
  await settle();
  assert.ok(relay.binds.length >= 3);
  assert.ok(relay.binds.every((bind) => bind.name === ONE && bind.secret === SECRET_ONE));
  assert.deepEqual(lost, []);
  await request(relay.binds.at(-1)!.port, { url: "/after" });
  assert.equal(fake.served.length, 1);
  bridge.dispose();
});

test("an unconfirmed rebind is visibly unreachable until a later one succeeds", async () => {
  const lost: string[] = [];
  let restored = 0;
  const { bridge, relay } = await open(() => ({ status: 200, headers: {}, body: text("") }), {
    onLost: (reason) => lost.push(reason),
    onRestored: () => restored++,
  });
  relay.refuse.push(new Error("The preview origin did not confirm machine"));
  relay.needBridge.get(bridge.name)!();
  await settle();
  assert.deepEqual(lost, ["unreachable"]);
  relay.needBridge.get(bridge.name)!();
  await settle();
  assert.equal(restored, 1);
  assert.equal(relay.binds.length, 2);
  bridge.dispose();
});

test("a request in flight on a replaced port is still answered there", async () => {
  let release: (() => void) | null = null;
  const relay = new FakeRelay();
  const bridge = await PreviewBridgeHost.open({
    relay,
    previewOrigin: PREVIEW,
    scope: "/",
    appOrigin: APP,
    port: 8080,
    mintIdentity: fixedIdentity(SECRET_ONE),
    kernel: {
      fetchInKernel: (_port, req) => req.url === "/slow"
        ? new Promise<KernelHttpResponse>((resolve) => {
          release = () => resolve({ status: 200, headers: {}, body: text("slow") });
        })
        : Promise.resolve({ status: 200, headers: {}, body: text("fast") }),
    },
  });
  const first = relay.binds[0]!.port;
  const slow = request(first, { url: "/slow" });
  await settle();
  for (const listener of relay.workerChanged) listener();
  await settle();
  assert.equal(relay.binds.length, 2);
  release!();
  const reply = await slow;
  assert.equal(reply.type, "http-response");
  assert.equal(new TextDecoder().decode(reply.body as ArrayBuffer), "slow");
  bridge.dispose();
});

test("requests on a new port are answered before its bind is confirmed", async () => {
  const { bridge, relay } = await open(() => ({ status: 200, headers: {}, body: text("early") }));
  // The worker routes requests on a port as soon as it installs it; the
  // owner hears the confirmation later, on another channel.
  let confirm: (() => void) | null = null;
  const bind = relay.bind.bind(relay);
  relay.bind = async (name, secret, port, seq) => {
    await bind(name, secret, port, seq);
    await new Promise<void>((resolve) => {
      confirm = resolve;
    });
  };
  // An earlier request on the current port, answered while the new port
  // is still unconfirmed, must not close the new port.
  for (const listener of relay.workerChanged) listener();
  await settle();
  const fresh = relay.binds[1]!.port;
  const answers = await Promise.all([
    request(relay.binds[0]!.port, { url: "/old" }),
    new Promise<Array<Record<string, unknown>>>((resolve) => {
      const replies: Array<Record<string, unknown>> = [];
      fresh.onmessage = (event) => {
        replies.push(event.data);
        if (replies.length === 2) resolve(replies);
      };
      for (const id of [1, 2]) {
        fresh.postMessage({
          type: "http-request", v: PREVIEW_PROTOCOL_VERSION, id, method: "GET", url: `/new-${id}`,
          headers: [], body: null, mode: "cors", destination: "", navigation: false,
        });
      }
    }),
  ]);
  assert.equal(answers[0].type, "http-response");
  assert.deepEqual(answers[1].map((reply) => reply.type), ["http-response", "http-response"]);
  confirm!();
  await settle();
  bridge.dispose();
});

test("a new preview worker gets this tab's machine bound again at once", async () => {
  const lost: string[] = [];
  const { bridge, relay, fake } = await open((req) => req.url === "/set"
    ? { status: 200, headers: { "Set-Cookie": "sid=1; path=/" }, body: text("") }
    : { status: 200, headers: {}, body: text("") }, { onLost: (reason) => lost.push(reason) });
  await request(relay.binds[0]!.port, { url: "/set" });
  for (const listener of relay.workerChanged) listener();
  await settle();
  assert.equal(relay.binds.length, 2);
  await request(relay.binds[1]!.port, { url: "/after" });
  assert.equal(fake.served[1]!.request.headers.cookie, "sid=1");
  assert.deepEqual(lost, []);
  bridge.dispose();
});

test("a notice while the machine is first bound waits for that bind, then binds once more", async () => {
  // The real relay rejects a pending bind when the same name is bound again,
  // so two binds of one machine must never overlap.
  const relay = new FakeRelay();
  let active = 0;
  let maxActive = 0;
  let releaseFirst: (() => void) | null = null;
  const bind = relay.bind.bind(relay);
  relay.bind = async (name, secret, port, seq) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (relay.binds.length === 0 && !releaseFirst) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      await bind(name, secret, port, seq);
    } finally {
      active--;
    }
  };
  const opening = PreviewBridgeHost.open({
    relay,
    previewOrigin: PREVIEW,
    scope: "/",
    appOrigin: APP,
    kernel: kernel(() => ({ status: 200, headers: {}, body: text("ok") })),
    port: 8080,
    mintIdentity: fixedIdentity(SECRET_ONE),
  });
  await settle();
  assert.ok(releaseFirst, "open started its bind");
  // The preview worker changed while that first bind was on its way.
  for (const listener of relay.workerChanged) listener();
  await settle();
  releaseFirst!();
  const bridge = await opening;
  try {
    await settle();
    assert.equal(maxActive, 1);
    assert.equal(relay.binds.length, 2);
    const reply = await request(relay.binds[1]!.port, { url: "/after" });
    assert.equal(reply.type, "http-response");
  } finally {
    bridge.dispose();
  }
});

test("every bind and closing carries a larger sequence number than the last", async () => {
  const { bridge, relay } = await open(() => ({ status: 200, headers: {}, body: text("") }));
  for (const listener of relay.workerChanged) listener();
  await settle();
  relay.needBridge.get(bridge.name)!();
  await settle();
  bridge.dispose();
  const seqs = [...relay.binds.map((bind) => bind.seq), ...relay.closings.map((closing) => closing.seq)];
  assert.equal(seqs.length, 4);
  for (const seq of seqs) assert.ok(Number.isSafeInteger(seq) && seq > 0, `sequence ${seq}`);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, `sequence ${seqs.join(",")}`);
});

test("verify keeps a port the worker answers on and rebinds one it does not", async () => {
  const { bridge, relay } = await open(() => ({ status: 200, headers: {}, body: text("") }), {
    pingTimeoutMs: 50,
  });
  answerPings(relay.binds[0]!.port);
  await bridge.verify();
  assert.equal(relay.binds.length, 1);
  // The worker that held the port is gone: nobody answers.
  relay.binds[0]!.port.onmessage = null;
  relay.binds[0]!.port.close();
  await bridge.verify();
  assert.equal(relay.binds.length, 2);
  bridge.dispose();
});

test("readiness probes follow redirects that stay inside the machine", async () => {
  const { bridge, fake } = await open((req) => req.url === "/"
    ? { status: 302, headers: { Location: "http://127.0.0.1:5402/wp-admin/install.php" }, body: text("") }
    : { status: 200, headers: {}, body: text("ready") });
  const response = await bridge.probe("/");
  assert.equal(response.status, 200);
  assert.deepEqual(fake.served.map((served) => served.request.url), ["/", "/wp-admin/install.php"]);
  bridge.dispose();
});

test("a guest's cross-origin read is re-issued credentialless through the page's fetch", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const { bridge, relay } = await open(() => ({ status: 200, headers: {}, body: text("") }), {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("font bytes", { headers: { "Content-Type": "font/woff2", "Set-Cookie": "x=1" } });
    }) as typeof fetch,
  });
  const port = relay.binds[0]!.port;
  const reply = await new Promise<Record<string, unknown>>((resolve) => {
    port.onmessage = (event) => resolve(event.data);
    port.postMessage({
      type: "proxy-fetch",
      v: PREVIEW_PROTOCOL_VERSION,
      id: 3,
      url: "https://fonts.example/a.woff2",
      method: "GET",
      headers: [["accept", "font/woff2"], ["authorization", "Bearer secret"]],
    });
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.headers, [["content-type", "font/woff2"]]);
  assert.equal(calls[0]!.init.credentials, "omit");
  const sent = new Headers(calls[0]!.init.headers);
  assert.equal(sent.get("accept"), "font/woff2");
  assert.equal(sent.has("authorization"), false);

  const write = await new Promise<Record<string, unknown>>((resolve) => {
    port.onmessage = (event) => resolve(event.data);
    port.postMessage({
      type: "proxy-fetch", v: PREVIEW_PROTOCOL_VERSION, id: 4,
      url: "https://api.example/", method: "POST", headers: [],
    });
  });
  assert.equal(write.type, "http-error");
  bridge.dispose();
});

test("a guest cannot read the configured CORS proxy's own endpoints", async () => {
  const calls: string[] = [];
  const { bridge, relay } = await open(() => ({ status: 200, headers: {}, body: text("") }), {
    refusedProxyOrigins: ["https://cors.example"],
    fetch: (async (url: string) => {
      calls.push(url);
      return new Response("token");
    }) as typeof fetch,
  });
  const port = relay.binds[0]!.port;
  for (const url of ["https://cors.example/cors-proxy-session", "https://cors.example/?url=https://a.example/"]) {
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      port.onmessage = (event) => resolve(event.data);
      port.postMessage({ type: "proxy-fetch", v: PREVIEW_PROTOCOL_VERSION, id: 5, url, method: "GET", headers: [] });
    });
    assert.equal(reply.type, "http-error", url);
  }
  assert.deepEqual(calls, []);
  bridge.dispose();
});

test("cookie jar: Max-Age wins, expiry deletes, and paths match per RFC 6265", () => {
  let now = 1_000_000;
  const jar = new MachineCookieJar("/computer/${ONE}", () => now);
  jar.store([
    "a=1; Path=/docs; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60",
    "b=2; Path=/",
  ]);
  assert.equal(jar.headerFor("/computer/${ONE}/docs/x"), "a=1; b=2");
  assert.equal(jar.headerFor("/computer/${ONE}/docsx"), "b=2");
  now += 61_000;
  assert.equal(jar.headerFor("/computer/${ONE}/docs/x"), "b=2");
  jar.store(["b=gone; Path=/; Max-Age=0"]);
  assert.equal(jar.headerFor("/computer/${ONE}/"), "");
});

test("same-host rewriting leaves other hosts alone", () => {
  const location = { previewOrigin: PREVIEW, machineRoot: "/computer/${ONE}" };
  assert.equal(
    rewriteSameHostUrls("see https://example.com/x and http://127.0.0.1:5402/y", location),
    "see https://example.com/x and http://127.0.0.1:5402/computer/${ONE}/y",
  );
});

test("minted identities match the pattern the preview worker accepts and prove themselves", async () => {
  const names = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const identity: MachineIdentity = await mintMachineIdentity();
    assert.match(identity.name, MACHINE_NAME_PATTERN);
    assert.match(identity.secret, /^[0-9a-f]{32}$/);
    assert.equal(await secretProvesMachineName(identity.name, identity.secret), true);
    names.add(identity.name);
  }
  assert.equal(names.size, 200);
});

test("the classic preview scripts mirror the protocol constants", async () => {
  const worker = readFileSync(new URL("../../preview-origin/preview-service-worker.js", import.meta.url), "utf8");
  const relay = readFileSync(new URL("../../preview-origin/relay.js", import.meta.url), "utf8");
  for (const source of [worker, relay]) {
    assert.match(source, new RegExp(`var PROTOCOL_VERSION = ${PREVIEW_PROTOCOL_VERSION};`));
  }
  assert.equal(BUNDLE_PROTOCOL_VERSION, PREVIEW_PROTOCOL_VERSION);
  // Version 3: the worker's preview-need-bridge and preview-machine-status
  // broadcasts name a machine by `nameHash`, not `name`. Change the version
  // with any message shape, so a mismatched bundle fails loudly.
  assert.equal(PREVIEW_PROTOCOL_VERSION, 3);
  assert.ok(worker.includes(`var NAME_PATTERN = /${MACHINE_NAME_PATTERN.source}/;`));
  assert.ok(worker.includes(`var LEGACY_NAME_PATTERN = /${LEGACY_MACHINE_NAME_PATTERN.source}/;`));
  // The worker's own commitment function gives the same `t` as the page's.
  const workerCommitment = new Function(
    [
      /var COMMITMENT_LENGTH = \d+;/.exec(worker)![0],
      /var BASE32_ALPHABET = "[a-z2-7]+";/.exec(worker)![0],
      /function nameCommitment\(secret\) \{[\s\S]*?\n\}\n/.exec(worker)![0],
      "return nameCommitment;",
    ].join("\n"),
  )() as (secret: string) => Promise<string>;
  assert.equal(await workerCommitment(SECRET_ONE), await machineNameCommitment(SECRET_ONE));
  assert.equal(await workerCommitment(SECRET_TWO), await machineNameCommitment(SECRET_TWO));
  // Its broadcasts name a machine by the same hash the page looks for:
  // SHA-256 of the name, in hex.
  const workerNameHash = new Function(
    [/function machineNameHash\(name\) \{[\s\S]*?\n\}\n/.exec(worker)![0], "return machineNameHash;"].join("\n"),
  )() as (name: string) => Promise<string>;
  const named = (await machineIdentityFor("able-amber-acorn", SECRET_ONE)).name;
  const expected = createHash("sha256").update(named, "utf8").digest("hex");
  assert.equal(await machineNameHash(named), expected);
  assert.equal(await workerNameHash(named), expected);
  assert.match(expected, MACHINE_NAME_HASH_PATTERN);
  const kandeloWorker = readFileSync(new URL("../../public/service-worker.js", import.meta.url), "utf8");
  assert.ok(kandeloWorker.includes(`var MACHINE_NAME_PATTERN = /${MACHINE_NAME_PATTERN.source}/;`));
  assert.ok(kandeloWorker.includes(`var LEGACY_MACHINE_NAME_PATTERN = /${LEGACY_MACHINE_NAME_PATTERN.source}/;`));
  // The page's static-host paths are the build's static layout, and the
  // worker's fallback when its injected configuration is unusable.
  assert.deepEqual(PREVIEW_HOST_LAYOUTS.static, {
    relayPath: PREVIEW_RELAY_PATH,
    workerFile: PREVIEW_SERVICE_WORKER_PATH,
  });
  assert.ok(worker.includes(`relayPath: "${PREVIEW_RELAY_PATH}",`));
  assert.ok(worker.includes(`workerFile: "${PREVIEW_SERVICE_WORKER_PATH}",`));
  // Each host's relay sits one directory below the scope: the relay finds
  // the scope as "../".
  for (const layout of Object.values(PREVIEW_HOST_LAYOUTS)) {
    assert.match(layout.relayPath, /^[^/]+\/[^/]+$/);
    assert.match(layout.workerFile, /^[^/]+$/);
  }
  assert.ok(relay.includes('new URL(scope + config.workerFile, location.href)'));
  const interceptor = readFileSync(new URL("../../public/blob-iframe-interceptor.js", import.meta.url), "utf8");
  assert.match(interceptor, new RegExp(`var PROTOCOL_VERSION = ${PREVIEW_PROTOCOL_VERSION};`));
  const name = MACHINE_NAME_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");
  assert.ok(
    interceptor.includes(`var MACHINE_ROOT = /^(.*\\/computer\\/${name})(?:\\/|$)/;`),
    "the interceptor's machine-root pattern embeds MACHINE_NAME_PATTERN",
  );
});

test("a guest's same-origin framing policy admits the Kandelo page that hosts it, and nothing more", () => {
  const sameOrigin = new Headers({ "X-Frame-Options": "SAMEORIGIN" });
  translateFramePolicy(sameOrigin, APP);
  assert.equal(sameOrigin.has("x-frame-options"), false);
  assert.equal(sameOrigin.get("content-security-policy"), `frame-ancestors 'self' ${APP}`);

  const csp = new Headers({ "Content-Security-Policy": "script-src 'self'; frame-ancestors 'self'" });
  translateFramePolicy(csp, APP);
  assert.equal(csp.get("content-security-policy"), `script-src 'self'; frame-ancestors 'self' ${APP}`);

  for (const [name, value] of [
    ["X-Frame-Options", "DENY"],
    ["Content-Security-Policy", "frame-ancestors 'none'"],
    ["Content-Security-Policy", "frame-ancestors https://partner.example"],
  ]) {
    const kept = new Headers({ [name]: value });
    translateFramePolicy(kept, APP);
    assert.equal(kept.get(name), value, `${name}: ${value}`);
  }
});

test("a relay the browser denies storage names the preview origin and both remedies", () => {
  const origin = "https://kandelo.site";
  const blocked = relayFailureMessage(origin, "The operation is insecure.", "SecurityError");
  assert.equal(
    blocked,
    "This browser blocks storage for the preview origin https://kandelo.site, so web previews can't start. " +
      "Allow cookies and site data for https://kandelo.site, or use a Kandelo deployment whose preview origin " +
      "is on the same site as Kandelo. (The browser said: The operation is insecure.)",
  );
  // Any other failure keeps its existing wording.
  assert.equal(
    relayFailureMessage(origin, "Failed to fetch", "TypeError"),
    "The preview origin could not start: Failed to fetch",
  );
  assert.equal(
    relayFailureMessage(origin, "service workers are unavailable", ""),
    "The preview origin could not start: service workers are unavailable",
  );
});
