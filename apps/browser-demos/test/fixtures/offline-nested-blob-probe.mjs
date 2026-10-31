import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { webkit } from "@playwright/test";

const directory = mkdtempSync(join(tmpdir(), "offline-nested-blob-probe-"));
const script = `let url; self.onmessage = () => {
  url ??= URL.createObjectURL(new Blob(['self.postMessage("child-ready")'], {type:"text/javascript"}));
  const child = new Worker(url);
  child.onmessage = event => { self.postMessage({ok:true,value:event.data}); child.terminate(); };
  child.onerror = event => { self.postMessage({ok:false,error:event.message}); child.terminate(); };
}; self.postMessage({ready:true});`;
const server = createServer((request, response) => {
  response.writeHead(200, {
    "Content-Type": request.url === "/owner.js" ? "text/javascript" : "text/html",
    "Cache-Control": "public,max-age=31536000,immutable",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  response.end(request.url === "/owner.js" ? script : "<!doctype html><title>Offline worker probe</title>");
});
let context;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  context = await webkit.launchPersistentContext(join(directory, "profile"), { env: { ...env, CFFIXED_USER_HOME: directory } });
  const page = context.pages()[0];
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const initialize = () => page.evaluate(async () => {
    window.owner?.terminate();
    const owner = window.owner = new Worker("/owner.js", { type: "module" });
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve("owner-timeout"), 5000);
      owner.onmessage = event => { clearTimeout(timer); resolve(event.data); };
      owner.onerror = event => { clearTimeout(timer); resolve({ error: event.message }); };
    });
  });
  const execute = () => page.evaluate(async () => {
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve("child-timeout"), 5000);
      window.owner.onmessage = event => { clearTimeout(timer); resolve(event.data); };
      window.owner.postMessage({});
    });
  });
  assert.deepEqual(await initialize(), { ready: true });
  assert.deepEqual(await execute(), { ok: true, value: "child-ready" });
  await context.setOffline(true);
  assert.deepEqual(await execute(), { ok: true, value: "child-ready" });
  assert.deepEqual(await initialize(), { ready: true });
  const freshOffline = await execute();
  await context.setOffline(false);
  assert.deepEqual(await execute(), { ok: true, value: "child-ready" });
  assert.notEqual(freshOffline, "child-timeout");
  console.log(JSON.stringify({
    target: "Playwright WebKit offline emulation",
    version: context.browser()?.version(),
    reproduced: freshOffline.ok === false,
    freshOffline,
  }));
} finally {
  try { await context?.close(); }
  finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
