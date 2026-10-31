import {
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Page,
} from "@playwright/test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { machineIdentityFor } from "../lib/preview/machine-names";
import {
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_HOST_LAYOUTS,
  previewBundleFiles,
  servePreviewOriginRequest,
} from "../vite/preview-origin";

/**
 * The preview origin's service worker and relay, driven at the protocol level.
 *
 * Guest web pages are served from a separate preview origin by
 * `preview-origin/preview-service-worker.js`, which forwards each request to
 * the Kandelo tab that owns the machine over a MessagePort that tab handed
 * through its relay frame (`preview-origin/relay.js`). These tests serve the
 * real bundle (as the Vite plugin injects it) from one origin and a minimal
 * owner page from another, so every routing, ownership and offline rule is
 * observed in a real browser. Where the owner's own reaction matters (a new
 * worker version, a guest's attack, blob documents), the owner page runs the real
 * `PreviewRelay` and `PreviewBridgeHost` (bundled from
 * `test/support/preview-owner-entry.ts`) over a fake kernel. The owner's
 * cookie jar and response shaping are covered by
 * `lib/preview/preview-bridge.test.ts`; a real machine by
 * preview-isolation.spec.ts.
 */

// Ephemeral ports, so engines and workers can run this file side by side.
let APP = "";
let OTHER_SITE = "";
let PREVIEW = "";
const SCOPE = "/a/";
// Machine names commit to their owners' secrets (lib/preview/protocol.ts).
const SECRETS: Record<string, string> = {};
let ONE = "";
let TWO = "";
// A well-formed name whose secret no tab holds.
let UNKNOWN = "";

let appServer: Server;
let previewServer: Server;
let realOwnerScript = "";
// Appended to the preview worker's bytes to stand in for a new deployment.
let workerRevision = "";
// When set, the preview worker gives up on an owner's answer after this
// long instead of its own 120 s, so a test can watch a request time out.
let askTimeoutMs: number | null = null;

// The owner page: embeds the relay, binds machines, and answers their
// requests with `bridge:<label>:<method>:<path>`. It knows every machine's
// secret; `__bind(name, label, secret)` can send another one.
const OWNER_PAGE = () => `<!doctype html><meta charset="utf-8"><title>owner</title><body><script>
const PREVIEW = ${JSON.stringify(PREVIEW)};
const V = ${PREVIEW_PROTOCOL_VERSION};
const SECRETS = ${JSON.stringify(SECRETS)};
window.__relayMessages = [];
window.__requests = [];
const nameHash = async (name) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");
const owned = new Map();
const pendingBinds = new Map();
const relay = document.createElement("iframe");
relay.setAttribute("sandbox", "allow-scripts allow-same-origin");
relay.referrerPolicy = "origin";
relay.hidden = true;
relay.src = PREVIEW + ${JSON.stringify(`${SCOPE}__kandelo_preview/relay.html`)};
window.__relayReady = new Promise((resolve) => { window.__resolveRelay = resolve; });
window.addEventListener("message", (event) => {
  if (event.origin !== PREVIEW || event.source !== relay.contentWindow) return;
  const message = event.data;
  window.__relayMessages.push(message);
  if (message.type === "preview-relay-ready") window.__resolveRelay();
  if (message.type === "preview-bridge-ready" || message.type === "preview-bridge-refused") {
    const settle = pendingBinds.get(message.name);
    pendingBinds.delete(message.name);
    if (settle) settle(message.type === "preview-bridge-ready" ? "ready" : message.code);
  }
  if (message.type === "preview-need-bridge") {
    // The worker names the machine only by a hash of its name.
    for (const name of owned.keys()) {
      nameHash(name).then((hash) => {
        if (hash === message.nameHash && owned.has(name)) window.__bind(name, owned.get(name));
      });
    }
  }
});
document.body.append(relay);
// Each bind and closing carries this page's next sequence number unless a
// test passes its own.
let nextSeq = 1;
window.__bind = (name, label, secret = SECRETS[name], seq = nextSeq++) => new Promise((resolve) => {
  owned.set(name, label);
  const channel = new MessageChannel();
  window.__ports[label] = channel.port1;
  channel.port1.onmessage = (event) => {
    const request = event.data;
    if (request.type === "bridge-pong") {
      window.__pongs.push({ label, id: request.id });
      return;
    }
    if (label.startsWith("silent")) {
      window.__requests.push({ label, method: request.method, url: request.url });
      return;
    }
    window.__requests.push({
      label, method: request.method, url: request.url, navigation: request.navigation,
      body: request.body === null ? null : Array.from(new Uint8Array(request.body)),
    });
    const body = new TextEncoder().encode("bridge:" + label + ":" + request.method + ":" + request.url).buffer;
    channel.port1.postMessage({
      type: "http-response", v: V, id: request.id, status: 200,
      headers: [["content-type", request.url === "/" ? "text/html" : "text/plain"]], body,
    }, [body]);
  };
  pendingBinds.set(name, resolve);
  relay.contentWindow.postMessage({ type: "preview-bridge", v: V, name, secret, seq }, PREVIEW, [channel.port2]);
});
window.__ports = {};
window.__pongs = [];
// Ask the worker on the port bound under label whether it still holds it.
window.__ping = (label, id) => window.__ports[label].postMessage({ type: "bridge-ping", v: V, id });
window.__close = (name, secret = SECRETS[name], seq = nextSeq++) => {
  owned.delete(name);
  relay.contentWindow.postMessage({ type: "preview-machine-closing", v: V, name, secret, seq }, PREVIEW);
};
window.__frame = (name, path) => new Promise((resolve) => {
  const frame = document.createElement("iframe");
  frame.name = name;
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  frame.onload = () => resolve();
  frame.src = PREVIEW + ${JSON.stringify(`${SCOPE}computer/`)} + name + path;
  document.body.append(frame);
});
</script>`;

// A guest page whose app shows a document from a text/html blob URL in an
// iframe, as the WordPress site editor does. Its stylesheet is relative.
const BLOB_EDITOR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>editor</title></head>
<body><p id="editor">editor</p></body></html>`;
const BLOB_CANVAS = `<!doctype html><html><head><link rel="stylesheet" href="canvas.css"></head>` +
  `<body><p id="canvas">canvas</p></body></html>`;

const REAL_OWNER_PAGE = () => `<!doctype html><meta charset="utf-8"><title>real owner</title><body><script>
window.__ownerConfig = ${JSON.stringify({
    preview: PREVIEW,
    scope: SCOPE,
    interceptor: readFileSync(new URL("../public/blob-iframe-interceptor.js", import.meta.url), "utf8"),
    pages: { "/editor": BLOB_EDITOR_PAGE },
    secrets: SECRETS,
  }).replace(/</g, "\\u003c")};
</script><script src="/a/real-owner.js"></script>`;

test.beforeAll(async () => {
  for (const [words, secret] of [
    ["able-amber-acorn", "00112233445566778899aabbccddeeff"],
    ["brave-blue-birch", "ffeeddccbbaa99887766554433221100"],
    ["happy-teal-otter", "0f1e2d3c4b5a69788796a5b4c3d2e1f0"],
  ] as const) {
    const identity = await machineIdentityFor(words, secret);
    if (words !== "happy-teal-otter") SECRETS[identity.name] = identity.secret;
    if (words === "able-amber-acorn") ONE = identity.name;
    if (words === "brave-blue-birch") TWO = identity.name;
    if (words === "happy-teal-otter") UNKNOWN = identity.name;
  }
  const bundle = await build({
    entryPoints: [new URL("./support/preview-owner-entry.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
  });
  realOwnerScript = bundle.outputFiles[0]!.text;
  let files: Record<string, string> = {};
  previewServer = createServer((request, response) => {
    servePreviewOriginRequest(request, response, {
      scope: SCOPE,
      files: {
        ...files,
        "preview-service-worker.js": (askTimeoutMs === null
          ? files["preview-service-worker.js"]!
          : files["preview-service-worker.js"]!.replace(
            "var ASK_TIMEOUT_MS = 120000;",
            `var ASK_TIMEOUT_MS = ${askTimeoutMs};`,
          )) + workerRevision,
      },
      appOriginFor: () => APP,
    });
  });
  appServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", APP);
    if (url.pathname === "/a/real-owner.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      response.end(realOwnerScript);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(
      url.pathname === "/a/owner.html"
        ? OWNER_PAGE()
        : url.pathname === "/a/real-owner.html"
          ? REAL_OWNER_PAGE()
          : `<!doctype html><title>${url.pathname}</title>`,
    );
  });
  const [previewPort, appPort] = await Promise.all([
    listen(previewServer, 0, "127.0.0.1"),
    // localhost names the same host as a different site, so a cross-site
    // parent can be tested.
    listen(appServer, 0, "127.0.0.1"),
  ]);
  APP = `http://127.0.0.1:${appPort}`;
  OTHER_SITE = `http://localhost:${appPort}`;
  PREVIEW = `http://127.0.0.1:${previewPort}`;
  files = previewBundleFiles({
    protocolVersion: PREVIEW_PROTOCOL_VERSION,
    kandeloOrigins: [APP],
    kandeloOriginPattern: null,
    ...PREVIEW_HOST_LAYOUTS.static,
  });
});

test.afterAll(async () => {
  await Promise.all([close(appServer), close(previewServer)]);
});

async function ownerPage(context: BrowserContext, origin = APP): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/a/owner.html`);
  await page.evaluate(() => (window as any).__relayReady);
  return page;
}

/** A Kandelo-like owner tab running the real PreviewRelay and PreviewBridgeHost. */
async function realOwnerPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${APP}/a/real-owner.html`);
  await page.evaluate(() => (window as any).__relayReady);
  return page;
}

function guestFrame(page: Page, name: string): Frame {
  const frame = page.frames().find((candidate) => candidate.name() === name);
  if (!frame) throw new Error(`no guest frame for ${name}`);
  return frame;
}

async function guestFetch(
  frame: Frame,
  path: string,
  init: { method?: string; body?: number[] } = {},
): Promise<{ status: number; body: string; url: string; corp: string | null }> {
  return frame.evaluate(async ({ path, init }) => {
    const response = await fetch(path, {
      method: init.method ?? "GET",
      cache: "no-store",
      body: init.body ? new Uint8Array(init.body) : undefined,
    });
    return {
      status: response.status,
      body: await response.text(),
      url: response.url,
      corp: response.headers.get("cross-origin-resource-policy"),
    };
  }, { path, init });
}

test("each machine's guest requests reach the tab that bound it", async ({ context }) => {
  const owner = await ownerPage(context);
  expect(await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE)).toBe("ready");
  expect(await owner.evaluate((name) => (window as any).__bind(name, "two"), TWO)).toBe("ready");
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), TWO);

  const one = guestFrame(owner, ONE);
  expect(new URL(one.url()).origin).toBe(PREVIEW);
  const page = await guestFetch(one, "page?x=1");
  expect(page).toMatchObject({ status: 200, body: "bridge:one:GET:/page?x=1", corp: "cross-origin" });
  expect(await guestFetch(guestFrame(owner, TWO), "page")).toMatchObject({ body: "bridge:two:GET:/page" });
  // The frame's own document was a navigation; its subresource was not.
  const requests = await owner.evaluate(() => (window as any).__requests);
  expect(requests[0]).toMatchObject({ label: "one", url: "/", navigation: true });
  expect(requests.find((r: any) => r.url === "/page?x=1")).toMatchObject({ navigation: false });
  // No guest bytes ever come from the preview origin's network.
  expect(await guestFetch(one, `${SCOPE}__kandelo_preview/relay.html`)).toMatchObject({ status: 200 });
});

test("nameless root-relative reads and writes belong to the viewing machine", async ({ context }) => {
  const owner = await ownerPage(context);
  await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__bind(name, "two"), TWO);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const one = guestFrame(owner, ONE);

  const read = await guestFetch(one, "/wp-content/x.css");
  expect(read.body).toBe("bridge:one:GET:/wp-content/x.css");
  expect(read.url).toBe(`${PREVIEW}${SCOPE}computer/${ONE}/wp-content/x.css`);

  const payload = [0, 1, 127, 128, 255, 10, 13];
  for (const method of ["POST", "PUT", "PATCH"]) {
    const write = await guestFetch(one, "/api/write", { method, body: payload });
    // A write is dispatched once, never replayed through a redirect.
    expect(write).toMatchObject({ status: 200, body: `bridge:one:${method}:/api/write` });
    expect(write.url).toBe(`${PREVIEW}/api/write`);
  }
  const writes = await owner.evaluate(() =>
    (window as any).__requests.filter((r: any) => r.method !== "GET"));
  expect(writes).toHaveLength(3);
  for (const write of writes) expect(write).toMatchObject({ label: "one", url: "/api/write", body: payload });
});

/**
 * The body of the document in the frame at `path` (iframe names, outermost
 * first). Looked up afresh: a sandboxed refusal page can move the frame to
 * another process, which detaches Playwright's Frame object.
 */
function frameBody(page: Page, path: string[]) {
  let locator = page.frameLocator(`iframe[name="${path[0]}"]`);
  for (const name of path.slice(1)) locator = locator.frameLocator(`iframe[name="${name}"]`);
  return locator.locator("body");
}

async function showsRefusal(page: Page, path: string[]): Promise<boolean> {
  const text = await frameBody(page, path).textContent({ timeout: 1_000 }).catch(() => "");
  return (text ?? "").includes("belongs to another Kandelo computer");
}

test("a guest page cannot read or write another tab's machine", async ({ context, browserName }) => {
  // Machine ONE runs in tab A, machine TWO in tab B. A guest page of ONE
  // knows TWO's address (it is in every shared link).
  const tabA = await ownerPage(context);
  expect(await tabA.evaluate((name) => (window as any).__bind(name, "one"), ONE)).toBe("ready");
  const tabB = await ownerPage(context);
  expect(await tabB.evaluate((name) => (window as any).__bind(name, "two"), TWO)).toBe("ready");
  await tabA.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  await tabB.evaluate((name) => (window as any).__frame(name, "/"), TWO);
  const guest = guestFrame(tabA, ONE);
  const other = `${SCOPE}computer/${TWO}`;

  // fetch and XHR, reads and writes.
  const read = await guestFetch(guest, `${other}/wp-admin/`);
  expect(read.status).toBe(403);
  expect(read.body).toContain("belongs to another Kandelo computer");
  expect(read.body).not.toContain("bridge:two");
  expect((await guestFetch(guest, `${other}/wp-admin/options.php`, { method: "POST", body: [1, 2, 3] })).status)
    .toBe(403);
  expect(await guest.evaluate((url) => new Promise<number>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.onloadend = () => resolve(xhr.status);
    xhr.send("action=delete");
  }), `${other}/xhr`)).toBe(403);
  // Subresources.
  await guest.evaluate((url) => new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = image.onerror = () => resolve();
    image.src = url;
  }), `${other}/pixel.png`);
  await guest.evaluate((url) => new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.onload = script.onerror = () => resolve();
    script.src = url;
    document.head.append(script);
  }), `${other}/script.js`);
  // A nested frame of ONE's own, then navigated to TWO by its parent.
  await guest.evaluate((path) => new Promise<void>((resolve) => {
    const frame = document.createElement("iframe");
    frame.name = "nested-one";
    frame.onload = () => resolve();
    frame.src = path;
    document.body.append(frame);
  }), "nested");
  await guest.evaluate((url) => {
    (document.querySelector("iframe[name=nested-one]") as HTMLIFrameElement).contentWindow!.location.href = url;
  }, `${other}/wp-admin/users.php`);
  await expect.poll(() => showsRefusal(tabA, [ONE, "nested-one"])).toBe(true);
  // A form POST that navigates the guest's own frame.
  await guest.evaluate((url) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = url;
    const field = document.createElement("input");
    field.name = "log";
    field.value = "admin";
    form.append(field);
    document.body.append(form);
    form.submit();
  }, `${other}/wp-login.php`);
  await expect.poll(() => tabA.frames().find((frame) => frame.name() === ONE)?.url())
    .toBe(`${PREVIEW}${other}/wp-login.php`);
  // Playwright's Chromium never gets an execution context in this frame
  // once it shows the scriptless sandboxed refusal page (its screenshot
  // shows the page), so only Firefox and WebKit read it here.
  if (browserName !== "chromium") await expect.poll(() => showsRefusal(tabA, [ONE])).toBe(true);

  // TWO's owner never heard any of it.
  expect(await tabB.evaluate(() => (window as any).__requests.map((r: any) => r.url))).toEqual(["/"]);
  // TWO itself is unaffected, and so are ONE's own requests.
  expect(await guestFetch(guestFrame(tabB, TWO), "still")).toMatchObject({ status: 200, body: "bridge:two:GET:/still" });
  await tabA.evaluate((name) => (window as any).__frame(name, "/again"), ONE);
  const again = tabA.frames().filter((frame) => frame.name() === ONE).at(-1)!;
  expect(await guestFetch(again, "own")).toMatchObject({ status: 200, body: "bridge:one:GET:/own" });
  expect(await guestFetch(again, "own", { method: "POST", body: [7] })).toMatchObject({ status: 200, body: "bridge:one:POST:/own" });
  // The refusal page in the first frame (the first child named ONE) is not
  // a document a guest page can script to make requests in its name.
  expect(await again.evaluate((name) => {
    try {
      return (parent as any)[name].document.body.textContent.includes("another Kandelo computer")
        ? "scriptable refusal"
        : "scriptable";
    } catch {
      return "not scriptable";
    }
  }, ONE)).toBe("not scriptable");
});

test("worker broadcasts carry a hash of a machine's name, never the name", async ({ context }) => {
  const tabA = await ownerPage(context);
  const tabB = await ownerPage(context);
  expect(await tabB.evaluate((name) => (window as any).__bind(name, "two"), TWO)).toBe("ready");
  // A machine no tab runs: the worker asks every relay for a port, then
  // reports it offline.
  await tabA.evaluate((name) => (window as any).__frame(name, "/"), UNKNOWN);
  // A machine its owner closed is reported offline.
  await tabB.evaluate((name) => (window as any).__close(name), TWO);
  await expect.poll(() => tabA.evaluate(() => (window as any).__relayMessages
    .filter((m: any) => m.type === "preview-machine-status").map((m: any) => m.nameHash).sort()))
    .toEqual([nameHash(TWO), nameHash(UNKNOWN)].sort());
  const heard = await tabA.evaluate(() => (window as any).__relayMessages);
  expect(heard).toContainEqual(expect.objectContaining({ type: "preview-need-bridge", nameHash: nameHash(UNKNOWN) }));
  const text = JSON.stringify(heard);
  expect(text).not.toContain(TWO);
  expect(text).not.toContain(UNKNOWN);
});

test("a live machine name cannot be taken over without its secret", async ({ context }) => {
  const owner = await ownerPage(context);
  await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
  const intruder = await ownerPage(context);
  // Knowing the name (it is in every link) is not enough; neither is the
  // secret of another machine.
  for (const secret of [WRONG_SECRET, SECRETS[TWO], null]) {
    expect(await intruder.evaluate(({ name, secret }) =>
      (window as any).__bind(name, "intruder", secret), { name: ONE, secret }))
      .toBe("not-owner");
  }
  await intruder.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  expect(await guestFetch(guestFrame(intruder, ONE), "x")).toMatchObject({ body: "bridge:one:GET:/x" });
});

test("only the machine's secret closes it, and closing takes it offline everywhere", async ({ context }) => {
  const owner = await ownerPage(context);
  await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
  const viewer = await ownerPage(context);
  await viewer.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const frame = guestFrame(viewer, ONE);

  // A tab that does not hold the secret cannot retire it.
  await viewer.evaluate(({ name, secret }) => (window as any).__close(name, secret), { name: ONE, secret: WRONG_SECRET });
  await viewer.waitForTimeout(300);
  expect(await guestFetch(frame, "still")).toMatchObject({ body: "bridge:one:GET:/still" });

  await owner.evaluate((name) => (window as any).__close(name), ONE);
  await expect.poll(() => viewer.evaluate((hash) =>
    (window as any).__relayMessages.some((m: any) =>
      m.type === "preview-machine-status" && m.nameHash === hash && m.status === "offline"), nameHash(ONE)))
    .toBe(true);
  const offline = await guestFetch(frame, "after");
  expect(offline.status).toBe(503);
  expect(offline.body).toContain("This Kandelo computer is offline");
  expect(offline.body).toContain(ONE);
});

test("a crashed owner is found gone on the next request", async ({ context }) => {
  const owner = await ownerPage(context);
  await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
  const viewer = await ownerPage(context);
  await viewer.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const frame = guestFrame(viewer, ONE);
  // No closing notice: the tab just disappears.
  await owner.close();
  await expect.poll(async () => (await guestFetch(frame, "after-crash")).status, { timeout: 20_000 })
    .toBe(503);
});

test("an unknown machine is offline, an old three-word name is explained, and a malformed name is not a machine", async ({ context }) => {
  const owner = await ownerPage(context);
  await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const frame = guestFrame(owner, ONE);
  // The owner tab opens a machine no tab runs (a guest page of ONE could
  // not ask: that address belongs to another machine).
  await owner.evaluate((name) => (window as any).__frame(name, "/"), UNKNOWN);
  const unknown = await guestFrame(owner, UNKNOWN).locator("body").textContent();
  expect(unknown).toContain("This Kandelo computer is offline");
  expect(unknown).toContain(UNKNOWN);
  expect((await guestFetch(guestFrame(owner, UNKNOWN), "x")).status).toBe(503);
  // A link from before names carried a commitment: never resolved to any
  // machine, and says why.
  const legacy = await guestFetch(frame, `${SCOPE}computer/able-amber-acorn/wp-admin/`);
  expect(legacy.status).toBe(404);
  expect(legacy.body).toContain("older version");
  expect(await owner.evaluate(() => (window as any).__requests.filter((r: any) => r.url.includes("wp-admin"))))
    .toEqual([]);
  for (const path of [`${SCOPE}computer/`, `${SCOPE}computer/not-a-valid-name-segment/x`]) {
    expect.soft((await guestFetch(frame, path)).status, path).toBe(404);
  }
});

test("a guest page opened as its own tab goes to Kandelo's viewer shell", async ({ context }) => {
  const owner = await ownerPage(context);
  await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
  const tab = await context.newPage();
  await tab.goto(`${PREVIEW}${SCOPE}computer/${ONE}/wp-admin/?x=1`);
  expect(tab.url()).toBe(`${APP}${SCOPE}computer/${ONE}/wp-admin/?x=1`);
  // An old three-word link goes to the viewer shell too, which explains it.
  await tab.goto(`${PREVIEW}${SCOPE}computer/able-amber-acorn/`);
  expect(tab.url()).toBe(`${APP}${SCOPE}computer/able-amber-acorn/`);
  const requests = await owner.evaluate(() => (window as any).__requests);
  expect(requests).toEqual([]);
});

test("the relay answers only this deployment's Kandelo origin", async ({ context }) => {
  // localhost is a different site from 127.0.0.1, and not a configured app origin.
  const stranger = await context.newPage();
  await stranger.goto(`${OTHER_SITE}/a/owner.html`);
  await stranger.waitForTimeout(2_000);
  expect(await stranger.evaluate(() => (window as any).__relayMessages)).toEqual([]);
  const bound = await stranger.evaluate((name) =>
    Promise.race([(window as any).__bind(name, "stranger"), new Promise((r) => setTimeout(() => r("no answer"), 2_000))]), ONE);
  expect(bound).toBe("no answer");
});

test("a restarted preview worker asks the owning tab for a fresh port", async ({ context, browserName }) => {
  test.skip(browserName !== "chromium", "stopping a service worker needs the Chromium DevTools Protocol");
  const owner = await ownerPage(context);
  await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const frame = guestFrame(owner, ONE);
  expect(await guestFetch(frame, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  await stopWorker(context, owner, `${PREVIEW}${SCOPE}preview-service-worker.js`);
  // The first request after the restart is a nameless write: the restarted
  // worker recovers the guest document's machine from its URL, asks the
  // owner for a fresh port, and dispatches the write once with its bytes.
  const payload = [0, 1, 127, 128, 255];
  const write = await guestFetch(frame, "/api/after-restart", { method: "POST", body: payload });
  expect(write).toMatchObject({ status: 200, body: "bridge:one:POST:/api/after-restart" });
  const writes = await owner.evaluate(() =>
    (window as any).__requests.filter((r: any) => r.method === "POST"));
  expect(writes).toEqual([
    { label: "one", method: "POST", url: "/api/after-restart", navigation: false, body: payload },
  ]);
  expect(await guestFetch(frame, "after")).toMatchObject({ body: "bridge:one:GET:/after" });
  const needBridge = await owner.evaluate((hash) =>
    (window as any).__relayMessages.filter((m: any) => m.type === "preview-need-bridge" && m.nameHash === hash).length, nameHash(ONE));
  expect(needBridge).toBe(1);
  expect(await guestFetch(frame, "/root.css")).toMatchObject({ body: "bridge:one:GET:/root.css" });
});

test("a guest cannot replace this deployment's preview worker by registering its script", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const frame = guestFrame(owner, ONE);
  expect(await guestFetch(frame, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  // The static host ignores query strings, so `?x` would be these same bytes
  // as a new worker with no bridge ports; a narrower scope would take part
  // of computer/ away from the deployment's worker.
  const result = await frame.evaluate(async (scope) => {
    const outcomes: string[] = [];
    for (const [script, registrationScope] of [
      [`${scope}preview-service-worker.js?x`, scope],
      [`${scope}preview-service-worker.js`, `${scope}computer/`],
    ]) {
      try {
        const registration = await navigator.serviceWorker.register(script!, { scope: registrationScope });
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (worker) {
          await new Promise<void>((resolve) => {
            const settled = () => worker.state === "redundant" || worker.state === "activated";
            if (settled()) return resolve();
            worker.addEventListener("statechange", () => {
              if (settled()) resolve();
            });
          });
        }
        outcomes.push(worker ? worker.state : "no worker");
      } catch (error) {
        outcomes.push(`register threw ${(error as Error).name}`);
      }
    }
    const registration = await navigator.serviceWorker.getRegistration(scope);
    return { outcomes, active: registration?.active?.scriptURL ?? null };
  }, SCOPE);
  expect(result.outcomes).toEqual(["redundant", "redundant"]);
  expect(result.active).toBe(`${PREVIEW}${SCOPE}preview-service-worker.js`);
  expect(await guestFetch(frame, "after")).toMatchObject({ body: "bridge:one:GET:/after" });
  expect(await owner.evaluate(() => (window as any).__lost)).toEqual([]);
});

test("a new preview worker version under a live owner gets its machine bound again", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const frame = guestFrame(owner, ONE);
  expect(await guestFetch(frame, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  workerRevision = "\n// the next deployment\n";
  try {
    const before = await frame.evaluate(async (scope) =>
      (await navigator.serviceWorker.getRegistration(scope))?.active?.scriptURL ?? null, SCOPE);
    // A deploy (or the browser's own update check) installs the new bytes;
    // the new worker activates at once and holds no ports.
    await frame.evaluate(async (scope) => {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      const changed = new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
      await registration!.update();
      await changed;
    }, SCOPE);
    expect(before).toBe(`${PREVIEW}${SCOPE}preview-service-worker.js`);
    // The relay saw the new worker and the owner bound its machine to it
    // before any guest request asked for it.
    await expect.poll(() => owner.evaluate(() => (window as any).__workerChanges), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const after = await guestFetch(frame, "after");
    expect(after).toMatchObject({ status: 200, body: "bridge:one:GET:/after" });
    expect(await owner.evaluate(() => (window as any).__lost)).toEqual([]);
  } finally {
    workerRevision = "";
  }
});

test("an HTML blob document in a guest iframe is served by the preview worker to its own machine", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__open(name, "two"), TWO);
  await owner.evaluate((name) => (window as any).__frame(name, "/editor"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), TWO);
  const editor = guestFrame(owner, ONE);

  const shown = await editor.evaluate(async (html) => {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const iframe = document.createElement("iframe");
    const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
    // Assigned before insertion, as React does, so the only load is the
    // document's own.
    iframe.src = url;
    document.body.append(iframe);
    await loaded;
    const inner = iframe.contentWindow!;
    await new Promise((resolve) => {
      if (inner.document.readyState === "complete") resolve(null);
      else inner.addEventListener("load", resolve, { once: true });
    });
    return {
      assigned: url,
      src: iframe.src,
      location: inner.location.href,
      controlled: inner.navigator.serviceWorker.controller !== null,
      text: inner.document.getElementById("canvas")?.textContent ?? null,
    };
  }, BLOB_CANVAS);
  // The app still reads back the blob URL it assigned.
  expect(shown.src).toBe(shown.assigned);
  expect(shown.location).toMatch(new RegExp(`^${PREVIEW}${SCOPE}computer/${ONE}/__kandelo_blob/[0-9a-f]{32}$`));
  expect(shown.controlled).toBe(true);
  expect(shown.text).toBe("canvas");
  // Its relative stylesheet went through the bridge to its own machine.
  await expect.poll(() => owner.evaluate(() =>
    (window as any).__requests.some((r: any) => r.label === "one" && r.url === "/canvas.css"))).toBe(true);
  // Shown again while its blob URL lives (a reload, a history visit).
  const again = await guestFetch(editor, new URL(shown.location).pathname);
  expect(again.status).toBe(200);
  expect(again.body).toContain("canvas");

  // A document posted by another machine's page is not served under this
  // one: not to that page (it may not ask for this machine's addresses at
  // all), and not to a frame of this machine.
  const id = "0123456789abcdef0123456789abcdef";
  const foreign = await guestFrame(owner, TWO).evaluate(async ({ scope, one, v, id }) => {
    navigator.serviceWorker.controller!.postMessage({
      type: "preview-blob-document", v, id, html: "<p>foreign</p>", baseUrl: location.href,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const response = await fetch(`${scope}computer/${one}/__kandelo_blob/${id}`, { cache: "no-store" });
    return response.status;
  }, { scope: SCOPE, one: ONE, v: PREVIEW_PROTOCOL_VERSION, id });
  expect(foreign).toBe(403);
  await owner.evaluate(({ name, path }) => (window as any).__frame(name, path), { name: ONE, path: `/__kandelo_blob/${id}` });
  const served = owner.frames().filter((frame) => frame.name() === ONE).at(-1)!;
  expect(await served.locator("body").textContent()).toContain("No such Kandelo document");
});

test("a guest's keepalive write reaches its machine in every engine", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/editor"), ONE);
  // WordPress saves editor preferences this way. Firefox 155 (Playwright
  // build) sends keepalive fetches past the service worker
  // (FIREFOX-KEEPALIVE-FETCH-BYPASSES-SERVICE-WORKER); the injected guest
  // helper keeps them on the bridge.
  const written = await guestFrame(owner, ONE).evaluate(async () => {
    const response = await fetch("index.php?rest_route=/wp/v2/users/me", {
      method: "POST", body: "{}", keepalive: true, headers: { "content-type": "application/json" },
    });
    return { status: response.status, body: await response.text() };
  });
  expect(written).toEqual({ status: 200, body: "bridge:one:POST:/index.php?rest_route=/wp/v2/users/me" });
});

// --- Attacks by guest pages on the shared preview origin ---
//
// Any guest page can script a relay window in its own tab (same origin, and
// `parent.frames` is readable across origins), so it can send the preview
// worker anything a relay can. These tests act as such a guest.

const WRONG_SECRET = "0123456789abcdef0123456789abcdef";

/** What the worker broadcasts in place of a machine name (lib/preview/protocol.ts). */
function nameHash(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

/**
 * Run `code` inside the relay frame of `frame`'s tab, as a guest that
 * scripts it would. `code` may record results in `window.__attack`.
 */
async function inRelay(frame: Frame, code: string): Promise<void> {
  await frame.evaluate((code) => {
    let relay: Window | null = null;
    for (let i = 0; i < parent.frames.length; i++) {
      try {
        if (parent.frames[i]!.location.pathname.endsWith("/__kandelo_preview/relay.html")) relay = parent.frames[i]!;
      } catch {
        /* another origin's frame */
      }
    }
    if (!relay) throw new Error("no relay frame in this tab");
    const script = relay.document.createElement("script");
    script.textContent = code;
    relay.document.body.append(script);
  }, code);
}

async function relayAttackLog(frame: Frame): Promise<any[]> {
  return frame.evaluate(() => {
    for (let i = 0; i < parent.frames.length; i++) {
      try {
        const log = (parent.frames[i] as any).__attack;
        if (log) return log;
      } catch {
        /* another origin's frame */
      }
    }
    return [];
  });
}

/** Script the tab's relay to bind `name` to a port that answers `bridge:intruder`. */
function intruderBind(name: string, secret: string | null): string {
  return `(() => {
    window.__attack = window.__attack || [];
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.name === ${JSON.stringify(name)}) window.__attack.push(event.data);
    });
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const request = event.data;
      if (request.type !== "http-request") return;
      const body = new TextEncoder().encode("bridge:intruder:" + request.method + ":" + request.url).buffer;
      channel.port1.postMessage({ type: "http-response", v: request.v, id: request.id, status: 200,
        headers: [["content-type", "text/plain"]], body }, [body]);
    };
    window.__intruderPort = channel.port1;
    navigator.serviceWorker.getRegistration().then((registration) => {
      registration.active.postMessage({ type: "preview-bridge", v: ${PREVIEW_PROTOCOL_VERSION},
        name: ${JSON.stringify(name)}, secret: ${JSON.stringify(secret)}, seq: Number.MAX_SAFE_INTEGER
      }, [channel.port2]);
    });
  })();`;
}

function relayToWorker(message: Record<string, unknown>): string {
  return `navigator.serviceWorker.getRegistration().then((registration) => {
    registration.active.postMessage(${JSON.stringify({ v: PREVIEW_PROTOCOL_VERSION, ...message })});
  });`;
}

test("a guest-scripted relay cannot bind, close or dispute another tab's machine", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  // The attacker is a guest page in another tab, scripting that tab's relay.
  const viewer = await ownerPage(context);
  await viewer.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const guest = guestFrame(viewer, ONE);
  expect(await guestFetch(guest, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  await inRelay(guest, intruderBind(ONE, WRONG_SECRET));
  await expect.poll(() => relayAttackLog(guest)).toEqual([
    expect.objectContaining({ type: "preview-bridge-refused", name: ONE, code: "not-owner" }),
  ]);
  await inRelay(guest, relayToWorker({ type: "preview-machine-closing", name: ONE, secret: WRONG_SECRET }));
  await inRelay(guest, relayToWorker({ type: "preview-machine-closing", name: ONE }));
  await inRelay(guest, relayToWorker({ type: "preview-bridge-disputed", name: ONE }));
  // Longer than the relays' periodic worker check: nothing here changed the
  // worker, so the owner never hears that it did.
  await viewer.waitForTimeout(2_500);

  expect(await guestFetch(guest, "after")).toMatchObject({ status: 200, body: "bridge:one:GET:/after" });
  expect(await owner.evaluate(() => (window as any).__lost)).toEqual([]);
  expect(await owner.evaluate(() => (window as any).__workerChanges)).toBe(0);
});

test("after a worker restart, a guest cannot bind a machine's name without its secret", async ({ context, browserName }) => {
  test.skip(browserName !== "chromium", "stopping a service worker needs the Chromium DevTools Protocol");
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  const viewer = await ownerPage(context);
  await viewer.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const guest = guestFrame(viewer, ONE);
  expect(await guestFetch(guest, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  await stopWorker(context, owner, `${PREVIEW}${SCOPE}preview-service-worker.js`);
  // The restarted worker holds no port for the name. A guest that binds it
  // first, before any request wakes the owner, is refused.
  await inRelay(guest, intruderBind(ONE, WRONG_SECRET));
  await expect.poll(() => relayAttackLog(guest), { timeout: 10_000 }).toEqual([
    expect.objectContaining({ type: "preview-bridge-refused", name: ONE, code: "not-owner" }),
  ]);
  expect(await guestFetch(guest, "after")).toMatchObject({ status: 200, body: "bridge:one:GET:/after" });
  expect(await owner.evaluate(() => (window as any).__lost)).toEqual([]);
});

test("a guest that unregisters and re-registers the preview worker leaves the owner bound", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const viewer = await ownerPage(context);
  await viewer.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const guest = guestFrame(viewer, ONE);
  expect(await guestFetch(guest, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  // The exact deployment script at the exact scope installs (it is the
  // deployment's own worker), as a new registration with no ports.
  const reinstalled = await guest.evaluate(async (scope) => {
    const registration = await navigator.serviceWorker.getRegistration(scope);
    await registration!.unregister();
    const fresh = await navigator.serviceWorker.register(`${scope}preview-service-worker.js`, { scope });
    const worker = fresh.installing ?? fresh.waiting ?? fresh.active;
    await new Promise<void>((resolve) => {
      if (!worker || worker.state === "activated") return resolve();
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated" || worker.state === "redundant") resolve();
      });
      setTimeout(resolve, 10_000);
    });
    return worker?.state ?? "no worker";
  }, SCOPE);
  expect(reinstalled).toBe("activated");
  await expect.poll(async () => (await guestFetch(guest, "after")).body, { timeout: 20_000 })
    .toBe("bridge:one:GET:/after");
  expect(await guestFetch(guestFrame(owner, ONE), "owner-after")).toMatchObject({ body: "bridge:one:GET:/owner-after" });
  expect(await owner.evaluate(() => (window as any).__lost)).toEqual([]);
});

test("a guest that only unregisters the preview worker does not strand new previews", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  const viewer = await ownerPage(context);
  await viewer.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const guest = guestFrame(viewer, ONE);
  expect(await guestFetch(guest, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  await guest.evaluate(async (scope) => {
    await (await navigator.serviceWorker.getRegistration(scope))!.unregister();
  }, SCOPE);
  // The owner tab's relay registers the deployment's worker again; a
  // preview the owner opens after that is served by its machine, not by the
  // preview origin's network.
  let attempt = 0;
  await expect.poll(async () => {
    const frameName = `${ONE}-fresh-${attempt++}`;
    await owner.evaluate(({ name, frameName }) => new Promise<void>((resolve) => {
      const frame = document.createElement("iframe");
      frame.name = frameName;
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      frame.onload = () => resolve();
      frame.src = `${(window as any).__ownerConfig.preview}${(window as any).__ownerConfig.scope}computer/${name}/fresh`;
      document.body.append(frame);
    }), { name: ONE, frameName });
    return (await guestFrame(owner, frameName).locator("body").textContent()) ?? "";
  }, { timeout: 30_000, intervals: [2_000] }).toBe("bridge:one:GET:/fresh");
  expect(await owner.evaluate(() => (window as any).__lost)).toEqual([]);
});

test("a late or forged need-bridge under a live owner never costs the owner its machine", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const guest = guestFrame(owner, ONE);
  expect(await guestFetch(guest, "before")).toMatchObject({ body: "bridge:one:GET:/before" });

  workerRevision = "\n// the next deployment\n";
  try {
    // A new worker version, with guest requests racing the owner's rebind.
    const raced = await guest.evaluate(async (scope) => {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      const changed = new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
      await registration!.update();
      await changed;
      return Promise.all([1, 2, 3].map(async (n) => {
        try {
          return (await fetch(`race-${n}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) })).text();
        } catch (error) {
          return String(error);
        }
      }));
    }, SCOPE);
    expect(raced).toEqual(["bridge:one:GET:/race-1", "bridge:one:GET:/race-2", "bridge:one:GET:/race-3"]);
    // A need-bridge that arrives after the owner already rebound (forged
    // here through the relay, as any guest in this tab can) makes it bind
    // again; it must not see its own name as taken.
    for (let i = 0; i < 3; i++) {
      await inRelay(guest, `window.parent.postMessage({ type: "preview-need-bridge", v: ${PREVIEW_PROTOCOL_VERSION}, nameHash: ${JSON.stringify(nameHash(ONE))} }, "*");`);
      await owner.waitForTimeout(300);
    }
    expect(await guestFetch(guest, "after")).toMatchObject({ status: 200, body: "bridge:one:GET:/after" });
    expect(await owner.evaluate(() => (window as any).__lost)).toEqual([]);
  } finally {
    workerRevision = "";
  }
});

// --- Blob documents: lifetime and bounds ---

/** Post `html` as blob document `id` from `frame`'s document, as the helper does. */
test("a bind delivered after a newer one never replaces it", async ({ context }) => {
  const owner = await ownerPage(context);
  expect(await owner.evaluate((name) => (window as any).__bind(name, "current", undefined, 5), ONE)).toBe("ready");
  await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
  const frame = guestFrame(owner, ONE);
  // A bind the owner gave up on (its confirmation timed out, so it closed
  // that port) can still reach the worker late, after the bind that
  // replaced it: the relay retries delivery while the worker is starting.
  expect(await owner.evaluate((name) => (window as any).__bind(name, "stale", undefined, 2), ONE))
    .toBe("superseded");
  expect(await guestFetch(frame, "after")).toMatchObject({ status: 200, body: "bridge:current:GET:/after" });

  // Nor does a late bind revive a machine its owner has since closed.
  await owner.evaluate((name) => (window as any).__close(name, undefined, 7), ONE);
  await expect.poll(() => owner.evaluate((hash) =>
    (window as any).__relayMessages.some((m: any) =>
      m.type === "preview-machine-status" && m.nameHash === hash && m.status === "offline"), nameHash(ONE)))
    .toBe(true);
  expect(await owner.evaluate((name) => (window as any).__bind(name, "late", undefined, 6), ONE))
    .toBe("superseded");
  expect(await guestFetch(frame, "closed")).toMatchObject({ status: 503 });
});

test("a request that times out on a replaced port closes that port", async ({ context }) => {
  askTimeoutMs = 1_500;
  try {
    const owner = await ownerPage(context);
    await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
    await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
    const frame = guestFrame(owner, ONE);
    // A port whose owner never answers (a wedged tab) takes one request...
    expect(await owner.evaluate((name) => (window as any).__bind(name, "silent"), ONE)).toBe("ready");
    const slow = guestFetch(frame, "slow");
    await expect.poll(() => owner.evaluate(() =>
      (window as any).__requests.some((r: any) => r.label === "silent" && r.url === "/slow"))).toBe(true);
    // ...and is replaced while that request waits on it.
    expect(await owner.evaluate((name) => (window as any).__bind(name, "two"), ONE)).toBe("ready");
    expect((await slow).status).toBe(504);
    expect(await guestFetch(frame, "next")).toMatchObject({ status: 200, body: "bridge:two:GET:/next" });
    // The worker no longer holds the replaced port: it answers no ping there.
    await owner.evaluate(() => (window as any).__ping("silent", 1));
    await owner.evaluate(() => (window as any).__ping("two", 2));
    await expect.poll(() => owner.evaluate(() => (window as any).__pongs)).toContainEqual({ label: "two", id: 2 });
    await owner.waitForTimeout(500);
    expect(await owner.evaluate(() => (window as any).__pongs)).toEqual([{ label: "two", id: 2 }]);
  } finally {
    askTimeoutMs = null;
  }
});

test("the worker forgets the guest documents that are gone", async ({ context }) => {
  // The worker records each guest document's machine (`viewers`). A guest
  // that opens and removes frames in a loop must not grow that record
  // without bound: once it reaches its pruning size, the worker drops every
  // document that no longer exists. The test lowers the size and the grace
  // period a fresh document gets, and reads the record's size through a
  // message handler appended to the worker.
  workerRevision = `
self.VIEWER_PRUNE_AT = 8;
self.VIEWER_PRUNE_GRACE_MS = 0;
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "test-viewer-count") {
    event.source.postMessage({ type: "test-viewer-count", count: viewers.size });
  }
});
`;
  try {
    const owner = await ownerPage(context);
    await owner.evaluate((name) => (window as any).__bind(name, "one"), ONE);
    await owner.evaluate((name) => (window as any).__frame(name, "/"), ONE);
    const guest = guestFrame(owner, ONE);
    const openAndRemove = (count: number) => guest.evaluate(async (count) => {
      for (let n = 0; n < count; n++) {
        const frame = document.createElement("iframe");
        frame.src = `page-${Date.now()}-${n}`;
        await new Promise((resolve) => {
          frame.onload = resolve;
          document.body.append(frame);
        });
        frame.remove();
      }
    }, count);
    const viewerCount = () => guest.evaluate(() => new Promise<number>((resolve) => {
      navigator.serviceWorker.addEventListener("message", function listener(event) {
        if (event.data?.type !== "test-viewer-count") return;
        navigator.serviceWorker.removeEventListener("message", listener);
        resolve(event.data.count);
      });
      navigator.serviceWorker.controller!.postMessage({ type: "test-viewer-count" });
    }));

    await openAndRemove(40);
    // Every removed frame was a document the worker served. Each poll opens
    // one more, which gives the worker a reason to prune.
    await expect.poll(async () => {
      await openAndRemove(1);
      return viewerCount();
    }, { timeout: 15_000 }).toBeLessThan(8);
    // The guest that is still open keeps its machine.
    expect(await guestFetch(guest, "/still-mine")).toMatchObject({
      status: 200, body: "bridge:one:GET:/still-mine",
    });
  } finally {
    workerRevision = "";
  }
});

async function postBlobDocument(frame: Frame, id: string, html: string | { repeat: string; count: number }): Promise<void> {
  await frame.evaluate(({ id, html, v }) => {
    const text = typeof html === "string" ? html : html.repeat.repeat(html.count);
    navigator.serviceWorker.controller!.postMessage({
      type: "preview-blob-document", v, id, html: text, baseUrl: location.href,
    });
  }, { id, html, v: PREVIEW_PROTOCOL_VERSION });
  await frame.waitForTimeout(300);
}

function blobId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

test("a blob document lives as long as its blob URL and carries the guest helper", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/editor"), ONE);
  const editor = guestFrame(owner, ONE);
  const shown = await editor.evaluate(async (html) => {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const iframe = document.createElement("iframe");
    const load = () => new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
    let loaded = load();
    iframe.src = url;
    document.body.append(iframe);
    await loaded;
    const first = iframe.contentWindow!.location.href;
    // The canvas has the helper, so a blob iframe inside it is routed too.
    const helper = (iframe.contentWindow as any).__kandeloBlobIframePatched === true;
    const nested = await (iframe.contentWindow as any).eval(`(async () => {
      const url = URL.createObjectURL(new Blob(["<p id=inner>inner</p>"], { type: "text/html" }));
      const frame = document.createElement("iframe");
      const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
      frame.src = url;
      document.body.append(frame);
      await loaded;
      return { location: frame.contentWindow.location.href, text: frame.contentWindow.document.getElementById("inner")?.textContent ?? null };
    })()`);
    // Reloading the canvas (or coming back to it) shows it again.
    loaded = load();
    iframe.contentWindow!.location.reload();
    await loaded;
    const reloaded = iframe.contentWindow!.document.getElementById("canvas")?.textContent ?? null;
    URL.revokeObjectURL(url);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterRevoke = (await fetch(new URL(first).pathname, { cache: "no-store" })).status;
    return { first, helper, nested, reloaded, afterRevoke };
  }, BLOB_CANVAS);
  expect(shown.first).toMatch(new RegExp(`^${PREVIEW}${SCOPE}computer/${ONE}/__kandelo_blob/[0-9a-f]{32}$`));
  expect(shown.helper).toBe(true);
  expect(shown.nested.location).toMatch(new RegExp(`/computer/${ONE}/__kandelo_blob/[0-9a-f]{32}$`));
  expect(shown.nested.text).toBe("inner");
  expect(shown.reloaded).toBe("canvas");
  expect(shown.afterRevoke).toBe(404);
});

test("blob documents are bounded in bytes, in total, and in waiting frames", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/editor"), ONE);
  const editor = guestFrame(owner, ONE);
  const root = `${SCOPE}computer/${ONE}/__kandelo_blob/`;

  // 6 Mi three-byte characters: under 16 Mi characters, over 16 MiB.
  await postBlobDocument(editor, blobId(1), { repeat: "\u20ac", count: 6 * 1024 * 1024 });
  expect((await guestFetch(editor, root + blobId(1))).status).toBe(404);

  // Five 14 MiB documents exceed the 64 MiB total: the oldest is dropped.
  for (let n = 2; n <= 6; n++) await postBlobDocument(editor, blobId(n), { repeat: "a", count: 14 * 1024 * 1024 });
  expect((await guestFetch(editor, root + blobId(2))).status).toBe(404);
  expect((await guestFetch(editor, root + blobId(6))).status).toBe(200);

  // A frame may ask for a document before it is posted, but only so many
  // can wait: past the bound, an unknown id is refused at once.
  const timings = await editor.evaluate(async (root) => {
    const started = performance.now();
    const ids = Array.from({ length: 80 }, (_, n) => (1000 + n).toString(16).padStart(32, "0"));
    return Promise.all(ids.map(async (id) => {
      const response = await fetch(root + id, { cache: "no-store" });
      return { status: response.status, ms: performance.now() - started };
    }));
  }, root);
  expect(timings.every((timing) => timing.status === 404)).toBe(true);
  expect(timings.filter((timing) => timing.ms < 2_000).length).toBeGreaterThanOrEqual(16);
});

test("a guest's keepalive Request and beacon reach its machine", async ({ context }) => {
  const owner = await realOwnerPage(context);
  await owner.evaluate((name) => (window as any).__open(name, "one"), ONE);
  await owner.evaluate((name) => (window as any).__frame(name, "/editor"), ONE);
  const sent = await guestFrame(owner, ONE).evaluate(async () => {
    const request = new Request("keepalive-request", { method: "POST", body: "{}", keepalive: true });
    const response = await fetch(request, { headers: { "content-type": "application/json" } });
    const queued = navigator.sendBeacon("beacon", "x");
    return { body: await response.text(), queued };
  });
  expect(sent).toEqual({ body: "bridge:one:POST:/keepalive-request", queued: true });
  await expect.poll(() => owner.evaluate(() =>
    (window as any).__requests.some((r: any) => r.method === "POST" && r.url === "/beacon"))).toBe(true);
});

// Genuinely terminate a running service worker via the Chromium DevTools
// Protocol, so the restart path runs with an empty in-memory registry.
async function stopWorker(context: BrowserContext, page: Page, scriptUrl: string): Promise<void> {
  const client = await context.newCDPSession(page);
  try {
    const versionId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timed out finding ${scriptUrl}`)), 10_000);
      client.on("ServiceWorker.workerVersionUpdated", (event) => {
        const running = (event.versions ?? []).find((version: {
          runningStatus?: string;
          scriptURL?: string;
          versionId: string;
        }) => version.runningStatus === "running" && version.scriptURL === scriptUrl);
        if (!running) return;
        clearTimeout(timeout);
        resolve(String(running.versionId));
      });
      void client.send("ServiceWorker.enable").catch(reject);
    });
    await client.send("ServiceWorker.stopWorker", { versionId });
  } finally {
    await client.detach();
  }
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
