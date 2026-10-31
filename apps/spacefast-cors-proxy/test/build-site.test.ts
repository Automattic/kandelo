import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execute = promisify(execFile);
const builder = fileURLToPath(new URL("../build-site.mjs", import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kandelo-spacefast-site-"));
  await writeFile(join(root, "index.html"), "<h1>Kandelo</h1>");
  await writeFile(join(root, "service-worker.js"), "// built worker");
  await mkdir(join(root, "vfs-groups"));
  await writeFile(join(root, "vfs-groups", "manifest.json"), "{}");
  return root;
}

test("site packager preserves the built app and emits a compiled file-router handler", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [builder, root]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  assert.deepEqual((await readdir(output)).sort(), ["_headers", "functions", "index.html", "service-worker.js", "sf.jsonc", "vfs-groups"]);
  assert.deepEqual((await readdir(join(output, "functions"))).sort(), ["_signalling.mjs", "cors-proxy", "cors-proxy-session.php", "signalling.mjs"]);
  assert.ok((await readFile(join(output, "functions/cors-proxy-session.php"), "utf8")).includes('$approved = null;'));
  assert.deepEqual((await readdir(join(output, "functions", "cors-proxy"))).sort(), ["[...rest].mjs", "_handler.mjs"]);
  assert.equal(await readFile(join(output, "index.html"), "utf8"), "<h1>Kandelo</h1>");
  assert.equal(await readFile(join(output, "vfs-groups", "manifest.json"), "utf8"), "{}");
  const config = JSON.parse(await readFile(join(output, "sf.jsonc"), "utf8"));
  assert.equal(config.runtime.kind, "functions"); assert.equal(config.runtime.entry, undefined);
  const headers = await readFile(join(output, "_headers"), "utf8");
  for (const line of ["Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Embedder-Policy: require-corp", "Cross-Origin-Resource-Policy: same-origin",
    "Content-Security-Policy: frame-ancestors 'self'", "Origin-Agent-Cluster: ?1"]) assert.ok(headers.includes(line));
  const workerPath = join(output, "functions", "cors-proxy", "[...rest].mjs");
  for (const entry of [workerPath, join(output, "functions", "signalling.mjs")]) {
    // Match the official CLI's route admission: its default-export scanner
    // cannot discover esbuild's `export { binding as default }` form.
    assert.match(await readFile(entry, "utf8"), /\bexport\s+default\b/);
  }
  const worker = await readFile(join(output, "functions", "cors-proxy", "_handler.mjs"), "utf8");
  assert.ok(worker.includes('import("cloudflare:sockets")'));
  assert.ok(!/node:|BEGIN PRIVATE KEY/.test(worker));
  const { default: route } = await import(pathToFileURL(workerPath).href);
  const { default: signalling } = await import(pathToFileURL(join(output, "functions", "signalling.mjs")).href);
  assert.equal((await signalling(new Request("https://site.example/__kandelo_signalling", { method: "OPTIONS" }), { env: {} })).status, 204);
  assert.equal((await signalling(new Request("https://site.example/__kandelo_signalling?session=foo"), { env: {} })).status, 503);
  const preflight = await route(new Request("https://site.example/cors-proxy", { method: "OPTIONS" }), { env: {} });
  assert.equal(preflight.status, 204);
  const unconfigured = await route(new Request("https://site.example/cors-proxy"), { env: {} });
  assert.equal(unconfigured.status, 503);
});

test("site packager makes browsers revalidate the service worker and pages, not hashed assets", async t => {
  // The first reload after a deploy only reaches the new deployment if
  // service-worker.js and the HTML entry points are revalidated; an edge
  // that keeps an old copy serves the old deployment for its lifetime.
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pages", "kandelo"), { recursive: true });
  await writeFile(join(root, "pages", "kandelo", "index.html"), "<h1>Kandelo</h1>");
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "main-AbCd1234.js"), "// hashed chunk");
  const { stdout } = await execute(process.execPath, [builder, root]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  const blocks = new Map((await readFile(join(output, "_headers"), "utf8")).split(/\n(?=\/)/)
    .map(block => { const [path, ...lines] = block.trim().split("\n"); return [path, lines.map(line => line.trim())]; }));
  for (const path of ["/service-worker.js", "/", "/index.html", "/index", "/pages/kandelo/", "/pages/kandelo/index.html"]) {
    assert.ok(blocks.get(path)?.includes("Cache-Control: no-cache"), `${path} must be revalidated`);
  }
  assert.ok(blocks.has("/assets/main-AbCd1234.js"));
  assert.ok(!blocks.get("/assets/main-AbCd1234.js").some(line => line.startsWith("Cache-Control:")),
    "a content-hashed chunk keeps the host's caching");
});

test("site packager rejects private build inputs and symlinks", async t => {
  for (const forbidden of [".env.local", "pages-vfs-products.private.json", ".git", ".spacefast", "node_modules",
    "functions", "handler.ts", "handler.js", "handler.mjs", ".open-next"]) {
    const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, forbidden), "private input");
    await assert.rejects(execute(process.execPath, [builder, root]), /Not a publishable build/);
  }
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(root, "index.html"), join(root, "linked.html"));
  await assert.rejects(execute(process.execPath, [builder, root]), /Not a publishable build/);
  await rm(join(root, "service-worker.js"));
  await assert.rejects(execute(process.execPath, [builder, root]), /ENOENT/);
});

test("Spacefast packaging substitutes its signalling Function and preserves the WP Cloud input", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "signalling"));
  const php = "<?php /* portable WP Cloud signalling */";
  await writeFile(join(root, "signalling/piplet.php"), php);
  const { stdout } = await execute(process.execPath, [builder, root]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  assert.equal(await readFile(join(root, "signalling/piplet.php"), "utf8"), php);
  await assert.rejects(readFile(join(output, "signalling/piplet.php")), { code: "ENOENT" });
  const { default: signalling } = await import(pathToFileURL(join(output, "functions/signalling.mjs")).href);
  assert.equal((await signalling(new Request("https://site.example/signalling", { method: "OPTIONS" }), { env: {} })).status, 204);
});

test("isolation headers cover documents and workers without claiming large binary downloads", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pages", "demo"), { recursive: true });
  await mkdir(join(root, "assets"));
  for (const path of ["pages/demo/index.html", "pages/help.html", "assets/worker.mjs", "assets/examples.zip", "assets/kernel.wasm"]) {
    await writeFile(join(root, path), "fixture");
  }
  const { stdout } = await execute(process.execPath, [builder, root]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  const headers = await readFile(join(output, "_headers"), "utf8");
  const paths = headers.split("\n").filter(line => line.startsWith("/"));
  assert.deepEqual(paths, ["/", "/assets/worker.mjs", "/index", "/index.html", "/pages/demo", "/pages/demo/", "/pages/demo/index", "/pages/demo/index.html", "/pages/help", "/pages/help.html", "/service-worker.js"]);
  assert.ok(!headers.includes("*"));
  assert.ok(!headers.includes("examples.zip"));
  assert.ok(!headers.includes("kernel.wasm"));
  assert.equal(headers.match(/Cross-Origin-Embedder-Policy: require-corp/g)?.length, paths.length);
});

test("combined site can restrict its proxy without changing the static build or signalling route", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [builder, root, "--allow-referer", "https://site.example"]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  assert.equal(await readFile(join(output, "index.html"), "utf8"), "<h1>Kandelo</h1>");
  const { default: proxy } = await import(pathToFileURL(join(output, "functions/cors-proxy/[...rest].mjs")).href);
  const { default: signalling } = await import(pathToFileURL(join(output, "functions/signalling.mjs")).href);
  const url = "https://site.example/cors-proxy";
  assert.equal((await proxy(new Request(url), { env: {} })).status, 403);
  assert.equal((await proxy(new Request(url, { headers: { Referer: "https://site.example/page" } }), { env: {} })).status, 503);
  assert.equal((await proxy(new Request(url, { method: "OPTIONS", headers: { Origin: "https://site.example" } }), { env: {} })).status, 204);
  assert.equal((await signalling(new Request("https://site.example/signalling", { method: "OPTIONS" }), { env: {} })).status, 204);
  await assert.rejects(execute(process.execPath, [builder, root, root]), /Unexpected build argument/);
});

test("a Spacefast app using a separate proxy can omit the local proxy route", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [builder, root, "--without-proxy"]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  assert.deepEqual((await readdir(join(output, "functions"))).sort(), ["_signalling.mjs", "signalling.mjs"]);
  assert.match(await readFile(join(output, "functions", "signalling.mjs"), "utf8"), /\bexport\s+default\b/);
  assert.equal(await readFile(join(output, "index.html"), "utf8"), "<h1>Kandelo</h1>");
  assert.ok((await readFile(join(output, "_headers"), "utf8")).includes("Cross-Origin-Embedder-Policy: require-corp"));
  await assert.rejects(execute(process.execPath, [builder, root, "--without-proxy", "--allow-referer", "https://site.example"]), /cannot be used/);
});

test("a build with the viewer shell rewrites computer/ addresses to it", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pages", "kandelo"), { recursive: true });
  await writeFile(join(root, "pages/kandelo/viewer.html"), "viewer");
  const { stdout } = await execute(process.execPath, [builder, root, "--without-proxy"]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  assert.equal(await readFile(join(output, "_redirects"), "utf8"), "/computer/*  /pages/kandelo/viewer.html  200\n");
});
