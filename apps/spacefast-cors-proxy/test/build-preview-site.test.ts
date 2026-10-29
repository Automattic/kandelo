import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { previewBundleConfig, previewBundleFiles } from "../../browser-demos/vite/preview-origin.ts";

const execute = promisify(execFile);
const builder = fileURLToPath(new URL("../build-preview-site.mjs", import.meta.url));
const APP = "https://kandelo.space.fast";

// The real preview bundle, injected as `vite build` injects it.
async function fixture(appOrigin = APP) {
  const root = await mkdtemp(join(tmpdir(), "kandelo-spacefast-preview-"));
  for (const [path, text] of Object.entries(previewBundleFiles(previewBundleConfig(appOrigin)))) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test("preview packager adds isolation headers and the viewer-shell redirect, nothing else", async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [builder, root, "--app-origin", APP]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  assert.deepEqual((await readdir(output)).sort(),
    ["__kandelo_preview", "_headers", "_redirects", "preview-service-worker.js"]);
  const headers = await readFile(join(output, "_headers"), "utf8");
  assert.match(headers, /^\/\*\n/);
  for (const line of ["Cross-Origin-Embedder-Policy: require-corp", "Cross-Origin-Resource-Policy: cross-origin",
    "Origin-Agent-Cluster: ?1"]) assert.ok(headers.includes(line), line);
  // The relay and guest pages are framed by Kandelo: never forbid framing.
  assert.doesNotMatch(headers, /frame-ancestors|X-Frame-Options/i);
  assert.equal(await readFile(join(output, "_redirects"), "utf8"),
    `/computer/*  ${APP}/computer/:splat  302\n`);
  // The relay accepts the app and its Spacefast version hosts only.
  const relay = await readFile(join(output, "__kandelo_preview/relay.js"), "utf8");
  assert.ok(relay.includes(`"kandeloOrigins":["${APP}"]`));
  assert.ok(relay.includes("kandelo--v[0-9]+"));
});

test("preview packager refuses a bundle built for another app or holding other files", async t => {
  const other = await fixture("https://other.space.fast"); t.after(() => rm(other, { recursive: true, force: true }));
  await assert.rejects(execute(process.execPath, [builder, other, "--app-origin", APP]), /was not built for/);
  const extra = await fixture(); t.after(() => rm(extra, { recursive: true, force: true }));
  await writeFile(join(extra, "index.html"), "app page");
  await assert.rejects(execute(process.execPath, [builder, extra, "--app-origin", APP]), /unexpected index.html/);
  const missing = await fixture(); t.after(() => rm(missing, { recursive: true, force: true }));
  await rm(join(missing, "__kandelo_preview/relay.js"));
  await assert.rejects(execute(process.execPath, [builder, missing, "--app-origin", APP]), /relay.js is missing/);
  await assert.rejects(execute(process.execPath, [builder, missing]), /--app-origin is required/);
  await assert.rejects(execute(process.execPath, [builder, missing, "--app-origin", `${APP}/`]), /exactly an origin/);
});
