/**
 * The guest-preview bundle for PHP hosts (`./run.sh build-browser
 * --preview-host php`), run by real PHP.
 *
 * A host such as WP Cloud runs PHP but may not let a site set headers on
 * static files, and the relay's first load comes before any preview service
 * worker exists, so the server must send the cross-origin isolation headers
 * itself. These tests serve the generated bundle with PHP's built-in server
 * (which, like WordPress-style hosting, routes a missing path to
 * `index.php`) and check every response a Kandelo tab or a visitor gets.
 * See docs/browser-support.md, "Guest web previews run on their own origin".
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findSignallingPhp } from "../vite/dev-signalling";
import {
  PREVIEW_HOST_LAYOUTS,
  PREVIEW_ORIGIN_HEADERS,
  appPreviewOriginConfig,
  phpPreviewSiteFiles,
  previewBundleConfig,
  previewBundleFiles,
} from "../vite/preview-origin";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = "https://kandelo.dev";
const MACHINE = "able-amber-acorn-abcdefghijklmnopqrst";

let php: string;
const servers: { child: ChildProcess; root: string }[] = [];

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

/** Serve `files` at `scope` with `php -S`; returns the origin. */
async function servePhp(files: Record<string, string>, scope = "/"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kandelo-preview-php-test-"));
  for (const [relative, text] of Object.entries(files)) {
    const file = join(root, scope, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  const port = await freePort();
  const child = spawn(php, ["-S", `127.0.0.1:${port}`, "-t", root], { stdio: "ignore" });
  servers.push({ child, root });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`php -S exited with ${child.exitCode}`);
    try {
      await fetch(`${origin}/`);
      return origin;
    } catch {
      await new Promise((wait) => setTimeout(wait, 100));
    }
  }
  throw new Error("php -S did not start");
}

before(async () => {
  php = await findSignallingPhp(REPO_ROOT);
});

after(async () => {
  for (const { child, root } of servers) {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

function assertPreviewOriginHeaders(response: Response, what: string): void {
  for (const [name, value] of Object.entries(PREVIEW_ORIGIN_HEADERS)) {
    assert.equal(response.headers.get(name), value, `${what}: ${name}`);
  }
  // Kandelo frames the relay and guest pages; nothing may forbid it.
  assert.equal(response.headers.get("x-frame-options"), null, `${what}: X-Frame-Options`);
  assert.equal(response.headers.get("content-security-policy"), null, `${what}: CSP`);
  assert.equal(response.headers.get("x-powered-by"), null, `${what}: X-Powered-By`);
}

const phpConfig = previewBundleConfig(APP, "php");
const staticFiles = previewBundleFiles(phpConfig);
const phpFiles = phpPreviewSiteFiles(phpConfig, "/");

test("the PHP bundle is three PHP entry points at the php layout's paths", () => {
  assert.deepEqual(Object.keys(phpFiles).sort(), [
    PREVIEW_HOST_LAYOUTS.php.relayPath,
    "index.php",
    PREVIEW_HOST_LAYOUTS.php.workerFile,
  ].sort());
  assert.deepEqual(
    { relayPath: phpConfig.relayPath, workerFile: phpConfig.workerFile },
    { relayPath: "__kandelo_preview/relay.php", workerFile: "preview-service-worker.php" },
  );
  for (const text of Object.values(phpFiles)) assert.ok(text.startsWith("<?php\n"));
  // A static-host configuration would send the relay to the wrong worker.
  assert.throws(() => phpPreviewSiteFiles(previewBundleConfig(APP), "/"), /php host/);
  assert.throws(() => phpPreviewSiteFiles(phpConfig, "candidate/"), /scope/);
});

test("the relay page carries the isolation headers and its script inline", async () => {
  const origin = await servePhp(phpFiles);
  const response = await fetch(`${origin}/__kandelo_preview/relay.php`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assertPreviewOriginHeaders(response, "relay.php");
  const html = await response.text();
  assert.ok(!html.includes('src="relay.js"'));
  const script = /<script>\n([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.equal(script, staticFiles["__kandelo_preview/relay.js"]);
  assert.ok(script!.includes(`"kandeloOrigins":["${APP}"]`));
  assert.ok(script!.includes('"workerFile":"preview-service-worker.php"'));
});

test("the worker script is served byte for byte as JavaScript", async () => {
  const origin = await servePhp(phpFiles);
  const url = `${origin}/preview-service-worker.php`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assertPreviewOriginHeaders(response, "preview-service-worker.php");
  assert.equal(await response.text(), staticFiles["preview-service-worker.js"]);
  assert.ok(staticFiles["preview-service-worker.js"]!.includes('"relayPath":"__kandelo_preview/relay.php"'));

  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await fetch(url, { method: "POST", body: "x" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assertPreviewOriginHeaders(post, "POST to the worker");
});

test("a visit to a machine address goes to the viewer shell; anything else is 404", async () => {
  const origin = await servePhp(phpFiles);
  for (const path of [`/computer/${MACHINE}/probe.html?x=1&y=2`, `/computer/${MACHINE}/`, "/computer"]) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), `${APP}${path}`, path);
    assertPreviewOriginHeaders(response, path);
  }
  const post = await fetch(`${origin}/computer/${MACHINE}/login`, { method: "POST", body: "a=b", redirect: "manual" });
  assert.equal(post.status, 405);
  assert.match(await post.text(), /cannot be replayed/);
  for (const path of ["/", "/elsewhere/", "/computerx/"]) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(response.status, 404, path);
    assertPreviewOriginHeaders(response, path);
  }
  // The static host's paths are not this bundle's: a mismatched app build
  // fails loudly instead of finding a relay.
  assert.equal((await fetch(`${origin}/__kandelo_preview/relay.html`)).status, 404);
  assert.equal((await fetch(`${origin}/preview-service-worker.js`)).status, 404);
});

test("a scoped PHP bundle redirects only its own scope's machine addresses", async () => {
  const origin = await servePhp(phpPreviewSiteFiles(phpConfig, "/candidate/"), "/candidate/");
  const response = await fetch(`${origin}/candidate/computer/${MACHINE}/`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${APP}/candidate/computer/${MACHINE}/`);
  assert.equal((await fetch(`${origin}/candidate/__kandelo_preview/relay.php`)).status, 200);
  const outside = await fetch(`${origin}/candidate/other/computer/${MACHINE}/`, { redirect: "manual" });
  assert.equal(outside.status, 404);
});

test("the app is told the relay path of the host it was built for", () => {
  const saved = { ...process.env };
  try {
    process.env.KANDELO_PREVIEW_ORIGIN = "https://kandelo.site";
    process.env.KANDELO_PREVIEW_HOST = "php";
    assert.deepEqual(appPreviewOriginConfig("build"), {
      kind: "origin",
      origin: "https://kandelo.site",
      relayPath: "__kandelo_preview/relay.php",
    });
    delete process.env.KANDELO_PREVIEW_HOST;
    assert.deepEqual(appPreviewOriginConfig("build"), {
      kind: "origin",
      origin: "https://kandelo.site",
      relayPath: "__kandelo_preview/relay.html",
    });
    process.env.KANDELO_PREVIEW_HOST = "nginx";
    assert.throws(() => appPreviewOriginConfig("build"), /KANDELO_PREVIEW_HOST must be "static" or "php"/);
  } finally {
    for (const name of ["KANDELO_PREVIEW_ORIGIN", "KANDELO_PREVIEW_HOST"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
