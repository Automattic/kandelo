import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { build, createServer } from "vite";

import { BUILD_ID_PLACEHOLDER, buildIdPlugin } from "./build-id";

const PLACEHOLDER_META =
  `<meta name="kandelo-build-id" content="${BUILD_ID_PLACEHOLDER}">`;
const BUILT_META = /<meta name="kandelo-build-id" content="([0-9a-f]{20})">/gu;

function tempRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kandelo-build-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function serveHtml(t: test.TestContext, html: string): Promise<string> {
  const server = await createServer({
    configFile: false,
    root: tempRoot(t),
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [buildIdPlugin()],
  });
  t.after(() => server.close());
  return server.transformIndexHtml("/page.html", html);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("the development server gives an HTML page without <head> the build id instead of failing it", async (t) => {
  const served = await serveHtml(
    t,
    '<html><body><div id="root"></div></body></html>',
  );
  assert.equal(count(served, PLACEHOLDER_META), 1);
  // Before <body>, where the HTML parser puts it in the implied <head>.
  assert.ok(served.indexOf(PLACEHOLDER_META) < served.indexOf("<body>"));
});

test("the development server puts the build id first in an existing <head>", async (t) => {
  const served = await serveHtml(
    t,
    "<!doctype html><html><head><title>t</title></head><body></body></html>",
  );
  assert.equal(count(served, PLACEHOLDER_META), 1);
  assert.ok(served.indexOf("<head>") < served.indexOf(PLACEHOLDER_META));
  assert.ok(served.indexOf(PLACEHOLDER_META) < served.indexOf("<title>"));
});

test("a page that already carries the build id meta is not given a second one", async (t) => {
  const served = await serveHtml(
    t,
    `<!doctype html><html><head>${PLACEHOLDER_META}</head><body></body></html>`,
  );
  assert.equal(count(served, PLACEHOLDER_META), 1);
});

test("a production build stamps the service worker's build id into entries with and without <head>", async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(
    path.join(root, "public", "service-worker.js"),
    `var KANDELO_BUILD_ID = ${JSON.stringify(BUILD_ID_PLACEHOLDER)};\n`,
  );
  fs.writeFileSync(
    path.join(root, "headless.html"),
    '<html><body><script type="module">console.log(1)</script></body></html>',
  );
  fs.writeFileSync(
    path.join(root, "headed.html"),
    "<!doctype html><html><head><title>t</title></head><body></body></html>",
  );
  await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [buildIdPlugin()],
    build: {
      outDir: "dist",
      rolldownOptions: {
        input: {
          headless: path.join(root, "headless.html"),
          headed: path.join(root, "headed.html"),
        },
      },
    },
  });
  const worker = fs.readFileSync(path.join(root, "dist", "service-worker.js"), "utf8");
  const workerId = /var KANDELO_BUILD_ID = "([0-9a-f]{20})";/u.exec(worker)?.[1];
  assert.ok(workerId, "the built worker carries a build id");
  for (const name of ["headless.html", "headed.html"]) {
    const html = fs.readFileSync(path.join(root, "dist", name), "utf8");
    const ids = [...html.matchAll(BUILT_META)].map((match) => match[1]);
    assert.deepEqual(ids, [workerId], `${name} carries the worker's build id once`);
    assert.ok(!html.includes(BUILD_ID_PLACEHOLDER), `${name} keeps no placeholder`);
  }
});
