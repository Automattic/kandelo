import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "../playwright-test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";

const repository = resolve(import.meta.dirname, "../../..");
const probes = [
  { name: "mapping", source: "grouped-sdk-mapping.c", markers: ["heap-ok\n", "protection-io-ok\n", "moving-remap-ok\n", "grouped-sdk-mapping PASS"], partial: "ordinary-protection-partial" },
  { name: "private-file", source: "grouped-sdk-private-file.c", markers: ["grouped-sdk-private-file PASS"], partial: "ordinary-private-file-growth-partial" },
  { name: "fork", source: "grouped-sdk-fork.c", markers: ["grouped-fork-child PASS", "grouped-sdk-fork PASS"], partial: "", groupedOnly: true },
  { name: "pthread", source: "grouped-sdk-pthread.c", markers: ["grouped-sdk-pthread PASS tls-init-growth-wait32-wait64-join"], partial: "", groupedOnly: true },
  { name: "pthread-churn", source: "grouped-sdk-pthread-churn.c", markers: ["grouped-sdk-pthread-churn PASS 256"], partial: "", groupedOnly: true },
];
const fixtures: ReturnType<typeof compileSdkFixture>[] = [];
let server: Server | undefined;
let url: string;
let inputs: Record<string, string>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const routes = new Map<string, Uint8Array>([
    ["/kernel.wasm", readFileSync(resolveBinary("kernel.wasm"))],
    ["/image-module.wasm", readFileSync(join(repository, "local-binaries/kandelo_image_module32.wasm"))],
  ]);
  for (const probe of probes) {
    const ordinary = compileSdkFixture(new URL(`../../../host/test/fixtures/${probe.source}`, import.meta.url), [], { forkInstrument: true });
    fixtures.push(ordinary);
    const groupedPath = `${ordinary.programPath}.grouped.wasm`;
    execFileSync(join(repository, "sdk/bin/wasm32posix-shared-memory"), [ordinary.programPath, "-o", groupedPath],
      { cwd: repository, stdio: "pipe" });
    routes.set(`/${probe.name}/ordinary.wasm`, readFileSync(ordinary.programPath));
    routes.set(`/${probe.name}/grouped.wasm`, readFileSync(groupedPath));
  }
  inputs = Object.fromEntries([...routes].map(([path, bytes]) => [path, hash(bytes)]));
  for (const [route, source] of [
    ["/kernel.mjs", "host/test/fixtures/grouped-sdk-execution-browser.ts"],
    ["/process.mjs", "host/src/worker-entry-browser.ts"],
  ]) {
    const bundle = await build({ entryPoints: [join(repository, source)], bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", metafile: true });
    routes.set(route, bundle.outputFiles[0].contents);
    inputs[route] = hash(bundle.outputFiles[0].contents);
    for (const path of Object.keys(bundle.metafile!.inputs)) inputs[path] = hash(readFileSync(path));
  }
  server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const path = request.url ?? "/";
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>SDK grouped Worker execution</title>");
    } else if (routes.has(path)) {
      response.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
      response.end(routes.get(path));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture server address");
  url = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
  for (const fixture of fixtures) fixture.cleanup();
});

for (const probe of probes) for (const grouped of [false, true]) {
  if ('groupedOnly' in probe && probe.groupedOnly && !grouped) continue;
  test(`normal SDK libc ${probe.name}: ${grouped ? "grouped" : "ordinary"}`, async ({ page, browser }, info) => {
    test.setTimeout(90_000);
    await page.goto(url);
    const result = await page.evaluate(request => new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker("/kernel.mjs", { type: "module" });
      const deadline = setTimeout(() => { worker.terminate(); reject(new Error("kernel Worker deadline")); }, 75_000);
      worker.onmessage = event => { clearTimeout(deadline); worker.terminate(); resolve(event.data); };
      worker.onerror = event => { clearTimeout(deadline); worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage(request);
    }), { grouped, probe: probe.name });
    writeFileSync(info.outputPath("result.json"), JSON.stringify({ engine: info.project.name,
      version: browser.version(), inputs, result }, null, 2) + "\n");
    expect(result.failure, JSON.stringify(result)).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.stderr).toBe("");
    expect(result.kernelExit).toBe(0);
    expect(result.processExit).toBe(0);
    expect(result.processReady).toBe(true);
    expect(result.quiescent).toBe(true);
    if (grouped) expect(result.retirement).toMatchObject({ after: { backing: { allocatedPages: 1, images: 0, replicas: 0, nativeObservers: 0 } } });
    for (const marker of probe.markers) expect(result.stdout).toContain(marker);
    if (probe.partial) expect(String(result.stdout).includes(probe.partial)).toBe(!grouped);
    if (probe.name === 'fork') {
      expect(result.children).toEqual([expect.objectContaining({ kernelExit: 23, processExit: 23, ready: true, quiescent: true })]);
    }
    if (probe.name === 'pthread-churn') {
      expect(result.threads).toEqual(Array.from({ length: 256 }, () => expect.objectContaining({ exited: true, quiescent: true, retired: true })));
      const samples = result.threadRetirementMemory as any[];
      expect(samples).toHaveLength(256);
      const extents = samples.slice(-128).map(row => row.backing.physicalExtentPages);
      expect(new Set(extents).size, JSON.stringify(extents)).toBe(1);
    }
    if (probe.name === 'pthread') {
      expect(result.threads).toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ exited: true, quiescent: true })));
    }
  });
}

for (const probe of ['pthread', 'fork']) test(`forty SDK ${probe} cohorts reuse one backing after exact retirement`, async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  await page.goto(url);
  const result = await page.evaluate(probe => new Promise<any>((resolve, reject) => {
    const worker = new Worker('/kernel.mjs', { type: 'module' });
    const deadline = setTimeout(() => { worker.terminate(); reject(Error('SDK cycle deadline')); }, 180_000);
    worker.onmessage = event => { clearTimeout(deadline); worker.terminate(); resolve(event.data); };
    worker.onerror = event => { clearTimeout(deadline); worker.terminate(); reject(Error(event.message)); };
    worker.postMessage({ grouped: true, probe, cycles: 40 });
  }), probe);
  writeFileSync(info.outputPath('result.json'), JSON.stringify({ engine: info.project.name,
    version: browser.version(), inputs, result }, null, 2) + '\n');
  expect(result.failure, JSON.stringify(result)).toBeUndefined();
  expect(result.cycles).toHaveLength(40);
  expect(new Set(result.cycles.map((row: any) => row.memory.group)).size).toBe(1);
  expect(new Set(result.cycles.map((row: any) => row.memory.pid)).size).toBe(40);
  for (const row of result.cycles) {
    expect(row.failure, JSON.stringify(row)).toBeUndefined();
    expect(row.kernelExit).toBe(0); expect(row.processExit).toBe(0);
    expect(row.stdout).toContain(`grouped-sdk-${probe} PASS`);
    expect(row.stderr).toBe(''); expect(row.diagnostics).toEqual([]);
    if (probe === 'pthread') expect(row.threads).toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ exited: true, quiescent: true })));
    else expect(row.children).toEqual([expect.objectContaining({ kernelExit: 23, processExit: 23, ready: true, quiescent: true })]);
    expect(row.memory).toMatchObject({ maximumVirtualPages: 2048, declaredThreadSlots: probe === 'pthread' ? 1024 : 0,
      backing: { allocatedPages: 1, images: 0, replicas: 0, nativeObservers: 0 } });
  }
  const extents = result.cycles.slice(-20).map((row: any) => row.memory.backing.physicalExtentPages);
  expect(new Set(extents).size, JSON.stringify(extents)).toBe(1);
});
