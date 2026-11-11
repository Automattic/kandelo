import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { buildRustBacktraceFixture } from "../../../host/test/fixtures/rust-backtrace-build";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const guest = "/usr/bin/rust-backtrace";
let directory: string;
let server: Server;
let origin: string;

test.beforeAll(async () => {
  test.setTimeout(900_000);
  directory = mkdtempSync(join(process.env.KANDELO_AGENT_SCRATCH_DIR ?? tmpdir(), "kandelo-browser-backtrace-"));
  const program = readFileSync(buildRustBacktraceFixture(directory));
  const image = KandeloImageFs.create();
  image.mkdir("/usr");
  image.mkdir("/usr/bin");
  image.writeFile(guest, program, 0o755);
  const assets = new Map([
    ["/kernel.wasm", new Uint8Array(readFileSync(resolveBinary("kernel.wasm")))],
    ["/image.vfs", await image.saveImage()],
  ]);
  server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    const bytes = assets.get(request.url ?? "");
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("backtrace server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  if (directory && !process.env.KANDELO_AGENT_SCRATCH_DIR) rmSync(directory, { recursive: true, force: true });
});

for (const mode of ["capture", "thread", "subprocess", "panic"]) {
  test(`ordinary Rust ${mode} has an owned symbolized backtrace`, async ({ page, baseURL, browserName }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async ({ moduleUrl, jobModuleUrl, origin, guest, mode }) => {
      const [{ BrowserKernel }, { readRustCompilerJob }] = await Promise.all([
        import(/* @vite-ignore */ moduleUrl), import(/* @vite-ignore */ jobModuleUrl),
      ]);
      const host = new BrowserKernel({ kernelOwnedFs: true });
      const fetchBytes = async (path: string) => {
        const response = await fetch(origin + path);
        if (!response.ok) throw new Error(`backtrace fetch failed: ${response.status} ${path}`);
        return response.arrayBuffer();
      };
      try {
        await host.initFromImage({ kernelWasm: await fetchBytes("/kernel.wasm"), vfsImage: new Uint8Array(await fetchBytes("/image.vfs")) });
        const command = await host.spawnFromVfs(guest, [guest, mode], {
          env: [`RUST_BACKTRACE=${mode === "panic" ? "1" : "0"}`],
          ownedJob: { id: `backtrace-${mode}`, timeoutMs: 30_000 },
        });
        void command.exit.catch(() => {});
        return await readRustCompilerJob(host, `backtrace-${mode}`, 40_000);
      } finally { await host.destroy(); }
    }, {
      moduleUrl: new URL(`/@fs/${join(repo, "host/src/browser-kernel-host.ts")}`, baseURL).href,
      jobModuleUrl: new URL(`/@fs/${join(repo, "host/test/fixtures/rust-guest-job.ts")}`, baseURL).href,
      origin, guest, mode,
    });
    const evidence = test.info().outputPath("backtrace-result.json");
    writeFileSync(evidence, JSON.stringify(result, null, 2) + "\n");
    await test.info().attach("backtrace-result", { path: evidence, contentType: "application/json" });
    const dump = JSON.stringify(result);
    expect(result.exitCode, dump).toBe(mode === "panic" ? 134 : 0);
    const trace = mode === "panic" ? result.stderr : result.stdout;
    const name = mode === "panic" ? "user_panic" : "user_inner";
    expect(trace, dump).toMatch(new RegExp(`^\\s+\\d+: kandelo_backtrace::${name}$`, "m"));
    // WebKit's native Wasm stack format can omit instruction offsets.
    // Function names remain required; source lines require an actual PC.
    if (browserName !== "webkit") {
      const line = mode === "panic" ? 15 : 5;
      expect(trace, dump).toMatch(new RegExp(`^\\s+\\d+: kandelo_backtrace::${name}\\n\\s+at .*programs/rust/backtrace/src/main\\.rs:${line}:5$`, "m"));
    }
    if (mode !== "panic") {
      expect(trace, dump).toMatch(/^\s+\d+: kandelo_backtrace::user_outer$/m);
      expect(result.stderr, dump).toBe("");
    }
    if (mode === "capture") expect(trace.split("DEBUG_BACKTRACE=")[1], dump).toContain('"kandelo_backtrace::user_inner"');
    expect(errors).toEqual([]);
  });
}
