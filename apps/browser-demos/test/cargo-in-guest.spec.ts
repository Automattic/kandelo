import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { opfsTest as test } from "./support/opfs-page";
import { tryResolveBinaries } from "../../../host/src/binary-resolver";
import { rustCompilerEnv } from "../../../host/test/fixtures/rust-compiler";

const resolved = tryResolveBinaries(["kernel.wasm", "programs/wasm32/kandelo-rust-sdk.zip"]);
const paths = [resolved[0], process.env.KANDELO_GUEST_RUST_SDK_BUNDLE ?? resolved[1]];
import { createRustCargoImage } from "../../../host/test/fixtures/rust-cargo";
import { cargoProjectOutput, cargoTestArgs, cargoFailingTestArgs, cargoWrongPanicArgs } from "../../../host/test/fixtures/cargo-project";

const available = paths.every(path => path !== null);
if (!available && process.env.KANDELO_REQUIRE_GUEST_CARGO === "1") {
  throw new Error("Build kernel and kandelo-rust-sdk before Cargo acceptance");
}

test("guest Cargo builds and runs a workspace with a build script on a persistent disk", async ({ page, baseURL }) => {
  test.skip(!available, "Experimental Rust SDK is outside the supported build set");
  test.setTimeout(1_200_000);
  page.on("console", message => {
    console.log(`[cargo browser ${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", error => console.error(`[cargo browser pageerror] ${error.message}`));
  page.on("crash", () => console.error("[cargo browser] page crashed"));
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) console.info("[cargo browser navigation]", frame.url());
  });
  const [kernel, bundle] = paths.map(path => readFileSync(path!));
  const { image, assets } = await createRustCargoImage(bundle!);
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
    const results = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, lazyUrlMap, env, testArgs, failingArgs, wrongPanicArgs, diagnostics }) => {
      const { BrowserKernel } = await import(moduleUrl);
      const createHost = () => new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 8,
        onHostDiagnostic: (event: unknown) => console.info("[cargo host diagnostic]", JSON.stringify(event)),
        onProcessEvent: diagnostics ? (event: unknown) => console.info("[cargo process]", JSON.stringify(event)) : undefined,
      });
      let host = createHost();
      const results: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
      let sequence = 0;
      async function run(path: string, argv: string[], expectedExit = 0, timeoutMs = 300_000) {
        console.info("[cargo acceptance] starting", path, argv.join(" "));
        let stdout = "", stderr = "";
        const id = `cargo-browser-${++sequence}`;
        const { exit } = await host.spawnFromVfs(path, argv, {
          uid: 1000, gid: 1000, cwd: "/home/maker/project", env,
          ownedJob: { id, timeoutMs },
        });
        void exit.catch(() => {});
        let cursor = 0;
        let nextDiagnostic = Date.now() + 5000;
        const deadline = Date.now() + timeoutMs + 30_000;
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        for (;;) {
          if (diagnostics && Date.now() >= nextDiagnostic) {
            nextDiagnostic = Date.now() + 5000;
            console.info("[cargo memory]", JSON.stringify({
              processes: await host.enumProcs(), kernelPages: await host.getKernelMemoryPages(),
              cache: await host.getWasmModuleCacheStats(),
            }));
          }
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
            console.info("[cargo acceptance] completed", job.exitCode, stdout, stderr);
            if (job.exitCode !== expectedExit) throw new Error(JSON.stringify(results));
            return;
          }
          if (Date.now() >= deadline) throw new Error("Rust compiler family did not retire");
          if (!job.hasMore) await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      const name = `cargo-${crypto.randomUUID()}`;
      // Toolchain files belong on disk: an ephemeral rootfs retains every
      // hydrated archive member in the kernel's linear memory.
      const bootOptions = {
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()), lazyUrlMap,
        experimentalResizablePersistenceName: name, persistentComputerName: name,
      };
      try {
        console.info("[cargo acceptance] booting persistent image");
        await host.initFromImage(bootOptions);
        console.info("[cargo acceptance] image ready");
        await run("/usr/bin/cargo", ["cargo", "-vV"]);
        await run("/usr/bin/cargo", ["cargo", "metadata", "--offline", "--format-version=1"]);
        await run("/usr/bin/cargo", ["cargo", "check", "--offline"]);
        await run("/usr/bin/cargo", ["cargo", "run", "--offline", "-j1", "-p", "cargo-hello"]);
        await run("/usr/bin/cargo", ["cargo", "build", "--offline", "-j1"]);
        // This cold command links and prepares three separate libtest binaries.
        await run("/usr/bin/cargo", ["cargo", ...testArgs], 0, 600_000);
        await run("/usr/bin/cargo", ["cargo", ...failingArgs], 101);
        await run("/usr/bin/cargo", ["cargo", ...wrongPanicArgs], 101);
        await host.destroy();
        host = createHost();
        await host.initFromImage({ ...bootOptions, requireExistingRootfsPersistence: true });
        await run("/usr/bin/cargo", ["cargo", "run", "--offline", "-j1", "-p", "cargo-hello"]);
        await run("/home/maker/project/target/debug/cargo-hello.wasm", ["cargo-hello"]);
        await run("/usr/bin/cargo", ["cargo", ...testArgs]);
        return results;
      } finally { await host.destroy(); }
    }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl, lazyUrlMap,
      env: rustCompilerEnv, testArgs: cargoTestArgs, failingArgs: cargoFailingTestArgs,
      wrongPanicArgs: cargoWrongPanicArgs, diagnostics: process.env.KANDELO_CARGO_DIAGNOSTICS === "1" });
    expect(results[0]!.stdout).toContain("cargo 1.97.0-nightly");
    expect(results[1]!.stdout).toContain('"name":"message"');
    expect(results[3]!.stdout).toContain(cargoProjectOutput);
    expect(results[4]!.stderr).not.toContain("Compiling");
    expect(results[5]!.stdout).toContain("test result: ok. 4 passed; 0 failed; 2 ignored");
    expect(results[5]!.stdout).toMatch(/expected_panic.*ok/);
    expect(results[5]!.stdout).toContain("compiled_binary_runs_as_a_child ... ok");
    expect(results[6]!.stdout).toContain("test result: FAILED. 0 passed; 1 failed");
    expect(results[7]!.stdout).toContain("panic did not contain expected string");
    expect(results[8]!.stdout).toBe(cargoProjectOutput);
    expect(results[9]!.stdout).toBe(cargoProjectOutput);
    expect(results[10]!.stdout).toContain("test result: ok. 4 passed; 0 failed; 2 ignored");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
