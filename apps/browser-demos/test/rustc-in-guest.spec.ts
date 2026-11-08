import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { tryResolveBinaries } from "../../../host/src/binary-resolver";
import { createRustCompilerImage, rustCompilerArgs, rustCompilerEnv } from "../../../host/test/fixtures/rust-compiler";

const paths = tryResolveBinaries([
  "kernel.wasm", "programs/wasm32/rustc/rustc.wasm",
  "programs/wasm32/rustc/rust-std.zip", "programs/wasm32/kandelo-sdk.zip",
]);
const available = paths.every(path => path !== null);
if (!available && process.env.KANDELO_REQUIRE_GUEST_RUSTC === "1") {
  throw new Error("Build rustc, kernel and kandelo-sdk-browser-bundle before Rust compiler acceptance");
}

test("guest Rust compiler type-checks, compiles, and runs a std program", async ({ page, baseURL }) => {
  test.skip(!available, "Experimental rustc is outside the supported build set");
  test.setTimeout(900_000);
  page.on("console", message => {
    console.log(`[rustc browser ${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", error => console.error(`[rustc browser pageerror] ${error.message}`));
  page.on("crash", () => console.error("[rustc browser] page crashed"));
  const [kernel, compiler, std, sdk] = paths.map(path => readFileSync(path!));
  const { image, assets } = await createRustCompilerImage(compiler!, std!, sdk!);
  // Keep large compiler downloads on the real HTTP path. Browser-control
  // protocol messages are unsuitable for transporting whole toolchains.
  const payloads = new Map<string, Uint8Array>([
    ["/kernel.wasm", kernel!], ["/image.vfs", image],
    ...assets.map(asset => [new URL(asset.url).pathname, asset.bytes] as [string, Uint8Array]),
  ]);
  const server = createServer((request, response) => {
    const bytes = payloads.get(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Range");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (bytes === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Rust compiler asset server has no TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const kernelUrl = origin + "/kernel.wasm", imageUrl = origin + "/image.vfs";
    const lazyUrlMap = Object.fromEntries(assets.map(asset => [asset.url, origin + new URL(asset.url).pathname]));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    const results = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, lazyUrlMap, args, env }) => {
      const { BrowserKernel } = await import(moduleUrl);
      const createHost = () => new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 8 });
      let host = createHost();
      const results: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
      let sequence = 0;
      async function run(path: string, argv: string[], expectedExit = 0) {
        console.info("[rustc acceptance] starting", path, argv.join(" "));
        let stdout = "", stderr = "";
        const id = `rustc-browser-${++sequence}`;
        const { exit } = await host.spawnFromVfs(path, argv, {
          uid: 1000, gid: 1000, cwd: "/home/maker", env,
          ownedJob: { id, timeoutMs: 300_000 },
        });
        void exit.catch(() => {});
        let cursor = 0;
        const deadline = Date.now() + 330_000;
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        for (;;) {
          const job = await host.readOwnedJob(id, cursor, 65536);
          if (job.expired) throw new Error("Rust compiler output expired");
          for (const chunk of job.chunks) {
            const text = decoders[chunk.stream as "stdout" | "stderr"].decode(chunk.bytes, { stream: true });
            if (chunk.stream === "stdout") stdout += text;
            else stderr += text;
          }
          cursor = job.next;
          if (job.terminationObserved && !job.hasMore) {
            await host.releaseOwnedJob(id);
            stdout += decoders.stdout.decode(); stderr += decoders.stderr.decode();
            results.push({ exitCode: job.exitCode, stdout, stderr });
            console.info("[rustc acceptance] completed", job.exitCode, stdout, stderr);
            if (job.exitCode !== expectedExit) throw new Error(JSON.stringify(results));
            return;
          }
          if (Date.now() >= deadline) throw new Error("Rust compiler family did not retire");
          if (!job.hasMore) await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      const name = `rustc-${crypto.randomUUID()}`;
      // Toolchain files belong on disk: an ephemeral rootfs retains every
      // hydrated archive member in the kernel's linear memory.
      const bootOptions = {
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()), lazyUrlMap,
        experimentalResizablePersistenceName: name, persistentComputerName: name,
      };
      try {
        console.info("[rustc acceptance] booting persistent image");
        await host.initFromImage(bootOptions);
        console.info("[rustc acceptance] image ready");
        await run("/usr/bin/rustc", ["rustc", "-Zunstable-options", "--sysroot", "/usr", "-vV"]);
        await run("/usr/bin/rustc", [...args, "--emit=metadata", "--crate-type=lib", "-o", "/home/maker/hello.rmeta"]);
        await run("/usr/bin/rustc", [...args, "-Copt-level=0", "-Ccodegen-units=1", "-Cdebuginfo=0", "-o", "/home/maker/hello.wasm"]);
        await run("/home/maker/hello.wasm", ["hello"]);
        // The current abort-only Rust target cannot unwind fatal diagnostics.
        await run("/usr/bin/rustc", [...args.slice(0, -1), "/home/maker/type-error.rs",
          "--emit=metadata", "-o", "/home/maker/bad.rmeta"], 134);
        await host.destroy();
        host = createHost();
        await host.initFromImage({ ...bootOptions, requireExistingRootfsPersistence: true });
        await run("/home/maker/hello.wasm", ["hello"]);
        return results;
      } finally { await host.destroy(); }
    }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl, lazyUrlMap,
      args: rustCompilerArgs, env: rustCompilerEnv });
    expect(results[0]!.stdout).toContain("rustc 1.97.0-nightly");
    expect(results[0]!.stdout).toContain("host: wasm32-unknown-kandelo-std");
    expect(results[0]!.stdout).toContain("LLVM version: 22.1.2");
    expect(results[3]).toMatchObject({ exitCode: 0, stdout: "Kandelo compiled Rust: sum=6\n" });
    expect(results[4]!.stderr).toContain("E0308");
    expect(results[5]).toMatchObject({ exitCode: 0, stdout: "Kandelo compiled Rust: sum=6\n" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
