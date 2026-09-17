// K10 I0 probes on Chromium and WebKit, under the same cross-origin isolation
// the real demo ships with (SharedArrayBuffer is required for a shared memory).
// Harness shape follows docs/plans/probes/2026-09-09-k0c-epoll/run-browsers.mjs.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../apps/browser-demos/", import.meta.url));
const { chromium, webkit } = require("playwright");

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};
const server = http.createServer((req, res) => {
  const p = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = readFileSync(new URL("." + p, import.meta.url));
    res.writeHead(200, {
      "Content-Type": types[p.slice(p.lastIndexOf("."))] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const all = [];
for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await type.launch();
  const out = { engine: name };
  try {
    out.version = browser.version();
    const page = await browser.newPage();
    const noise = [];
    page.on("crash", () => noise.push("PAGE CRASHED"));
    page.on("pageerror", (e) => noise.push("pageerror: " + e.message));
    await page.goto(base, { waitUntil: "load" });
    await page.waitForFunction(() => window.__done !== undefined, { timeout: 60000 });
    out.results = await page.evaluate(() => window.__done);
    if (noise.length) out.noise = noise;
  } catch (e) {
    out.fatal = String((e && e.message) || e);
  } finally {
    await browser.close();
  }
  all.push(out);
}
console.log(JSON.stringify(all, null, 2));
server.close();
