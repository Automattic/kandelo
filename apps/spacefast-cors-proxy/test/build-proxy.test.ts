import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const execute = promisify(execFile);
const builder = fileURLToPath(new URL("../build.mjs", import.meta.url));

test("standalone proxy build requires an explicit valid Referer allowlist", async () => {
  for (const args of [[], ["--allow-referer"], ["--allow-referer", "--unknown"], ["--unknown"], ["unexpected-site"],
    ["--allow-referer", "https://kandelo.dev/"], ["--allow-referer", "https://*.example.com"],
    ["--allow-referer", "https://kandelo.dev https://site.example"],
    ["--allow-referer", "https://kandelo.dev", "--allow-referer", "https://kandelo.dev"]]) {
    await assert.rejects(execute(process.execPath, [builder, ...args]), /origin|argument/i);
  }
});

test("standalone output contains only runtime files and enforces the compiled allowlist", async t => {
  const { stdout } = await execute(process.execPath, [builder, "--allow-referer", "https://kandelo.dev",
    "--allow-referer", "https://remote-oak.space.fast"]);
  const output = stdout.trim(); t.after(() => rm(output, { recursive: true, force: true }));
  assert.deepEqual((await readdir(output)).sort(), ["handler.mjs", "sf.jsonc"]);
  const config = JSON.parse(await readFile(join(output, "sf.jsonc"), "utf8"));
  assert.equal(config.runtime.entry, "handler.mjs");
  const { default: worker } = await import(pathToFileURL(join(output, "handler.mjs")).href);
  let fetched = 0;
  t.mock.method(globalThis, "fetch", async () => { fetched++; return new Response("approved"); });
  const url = "https://proxy.space.fast/?url=https%3A%2F%2Fpublic.example%2Fasset";
  for (const origin of ["https://kandelo.dev", "https://remote-oak.space.fast"]) {
    const response = await worker.fetch(new Request(url, { headers: { Origin: origin, Referer: origin + "/page" } }),
      { CORS_PROXY_DISABLE_RATE_LIMIT: "1", CORS_PROXY_ALLOWED_REFERER_ORIGINS: "https://evil.example" });
    assert.equal(response.status, 200); assert.equal(await response.text(), "approved");
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
  for (const headers of [{}, { Referer: "https://evil.example/" },
    { Origin: "https://kandelo.dev", Referer: "https://evil.example/" }]) {
    assert.equal((await worker.fetch(new Request(url, { headers }), { CORS_PROXY_DISABLE_RATE_LIMIT: "1" })).status, 403);
  }
  assert.equal(fetched, 2);
  assert.equal((await worker.fetch(new Request(url, { headers: { Referer: "https://kandelo.dev/" } }), {})).status, 503);
  const preflight = await worker.fetch(new Request(url, { method: "OPTIONS", headers: { Origin: "https://kandelo.dev" } }), {});
  assert.equal(preflight.status, 204);
});
