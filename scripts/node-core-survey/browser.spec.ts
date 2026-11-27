import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../../apps/browser-demos/playwright-test";
import { fileDigest, loadInputs, loadPeerFixtures, writeGuestReport } from "./inputs";
import type { NodeKernelHostOptions } from "../../host/src/node-kernel-host";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const kernelPath = fileURLToPath(new URL("../../host/src/browser-kernel-host.ts", import.meta.url));

test("Node core compatibility on the installed guest", async ({ page, browser, browserName, baseURL }) => {
  test.setTimeout(1_500_000);
  const setupStartedAt = performance.now();
  const prepared = process.env.NODE_CORE_SURVEY_PREPARED;
  const peerDirectory = process.env.NODE_CORE_SURVEY_PEER_FIXTURES;
  const output = process.env.NODE_CORE_SURVEY_OUTPUT;
  if (Boolean(prepared) === Boolean(peerDirectory) || !output || !baseURL) {
    throw new Error("Expected a prepared shard, --preflight, or peer fixtures, plus a report directory and browser runner URL");
  }
  const report = resolve(output, browserName);
  mkdirSync(report, { recursive: false });
  let wroteTransport = false;
  const responses = new Map<string, Uint8Array>();
  const server = createServer((request, response) => {
    const bytes = responses.get(request.url ?? "");
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.length,
    }).end(bytes);
  });

  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); done(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot bind fixture server to loopback");
    const origin = `http://127.0.0.1:${address.port}`;
    const { image, kernel, assets, shard, identity } = loadInputs(prepared ?? "--preflight", origin + "/");
    const peer = peerDirectory ? loadPeerFixtures(peerDirectory) : undefined;
    responses.set("/survey/image", image);
    responses.set("/survey/kernel", kernel.bytes);
    if (shard) {
      responses.set("/survey/fixtures", shard.fixtures);
      responses.set("/survey/observer", shard.observer);
    }
    if (peer) {
      for (const [name, bytes] of Object.entries(peer.fixtures)) responses.set("/survey/" + name, bytes);
    }
    for (const asset of assets) responses.set(new URL(asset.url).pathname, asset.bytes);

    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("crash", () => pageErrors.push("Browser page crashed"));
    writeFileSync(join(report, "inputs.json"), JSON.stringify({
      ...identity, host: browserName, version: browser.version(), platform: process.platform, arch: process.arch,
      peerFixturesSha256: peer?.fixtureSha256,
      harnessSha256: { ...identity.harnessSha256,
        "browser.spec.ts": fileDigest("browser.spec.ts"), "browser.config.ts": fileDigest("browser.config.ts"),
        ...(peer && { "peer-https.ts": fileDigest("peer-https.ts") }) },
    }, null, 2) + "\n");
    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href, { timeout: 30_000 });
    const run = await page.evaluate(async ({ origin, runnerUrl, peerUrl, kernelUrl, selectors, setupElapsedMs }) => {
      const readinessStartedAt = performance.now() - setupElapsedMs;
      const remainingReadiness = 180_000 - setupElapsedMs;
      if (remainingReadiness <= 0) throw new Error("Setup exceeded the browser survey readiness limit");
      const controller = new AbortController();
      const readinessTimer = setTimeout(() => controller.abort(), remainingReadiness);
      try {
        async function fetchBytes(name: string) {
          const response = await fetch(origin + "/survey/" + name, { signal: controller.signal });
          if (!response.ok) throw new Error(`Missing exact browser survey artifact ${name}: ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        }

        const [{ BrowserKernel }, image, kernel] = await Promise.all([
          import(/* @vite-ignore */ kernelUrl) as Promise<typeof import("../../host/src/browser-kernel-host")>,
          fetchBytes("image"), fetchBytes("kernel"),
        ]);
        const createHost = (options: NodeKernelHostOptions) => {
          const host = new BrowserKernel({
            kernelOwnedFs: true, onProcessEvent: options.onProcessEvent,
            onHostDiagnostic: options.onHostDiagnostic, onProcessGenerationEvent: options.onProcessGenerationEvent,
          });
          return {
            init: (kernelWasm: ArrayBuffer) => host.initFromImage({
              kernelWasm, vfsImage: image, lazyAssetDirectory: origin + "/",
            }),
            destroy: host.destroy.bind(host),
            spawnFromVfs: host.spawnFromVfs.bind(host),
            enumProcs: host.enumProcs.bind(host),
            readFileFromVfs: host.readFileFromVfs.bind(host),
            writeFileToVfs: host.writeFileToVfs.bind(host),
            subscribeDestroyProgress: host.subscribeDestroyProgress.bind(host),
            readOwnedJob: host.readOwnedJob.bind(host),
            releaseOwnedJob: host.releaseOwnedJob.bind(host),
            hostRemoteNetwork: host.hostRemoteNetwork.bind(host),
            joinRemoteNetwork: host.joinRemoteNetwork.bind(host),
            attachRemotePeer: host.attachRemotePeer.bind(host),
            remoteNetworkSnapshot: host.remoteNetworkSnapshot.bind(host),
          };
        };
        if (peerUrl) {
          const [{ runPeerHttps }, program, certificate, key] = await Promise.all([
            import(/* @vite-ignore */ peerUrl) as Promise<typeof import("./peer-https")>,
            fetchBytes("program"), fetchBytes("certificate"), fetchBytes("key"),
          ]);
          return { kind: "peer" as const, result: await runPeerHttps(createHost, image, kernel,
            { program, certificate, key }, readinessStartedAt) };
        }
        const [{ runGuestShard }, shard] = await Promise.all([
          import(/* @vite-ignore */ runnerUrl) as Promise<typeof import("./guest-shard")>,
          selectors && Promise.all([fetchBytes("fixtures"), fetchBytes("observer")]).then(([fixtures, observer]) =>
            ({ fixtures, observer, selectors })),
        ]);
        return { kind: "upstream" as const, result: await runGuestShard(createHost,
          { image, kernel, shard, readinessStartedAt }) };
      } finally {
        clearTimeout(readinessTimer);
      }
    }, {
      origin, runnerUrl: new URL(`/@fs/${currentDirectory}guest-shard.ts`, baseURL).href,
      peerUrl: peer ? new URL(`/@fs/${currentDirectory}peer-https.ts`, baseURL).href : undefined,
      kernelUrl: new URL(`/@fs/${kernelPath}`, baseURL).href,
      selectors: shard?.selectors, setupElapsedMs: performance.now() - setupStartedAt,
    });
    if (run.kind === "peer") {
      writeFileSync(join(report, "peer-https.json"), JSON.stringify({ ...run.result, pageErrors }, null, 2) + "\n");
      wroteTransport = true;
      expect(pageErrors).toEqual([]);
      expect(run.result.failure).toBeNull();
      expect(run.result.teardown).toEqual([null, null]);
      return;
    }
    const { result } = run;
    writeGuestReport(report, pageErrors.length === 0 ? result : {
      ...result, outcome: "transport-error",
      error: [result.error, ...pageErrors].filter(Boolean).join("\n"),
    });
    wroteTransport = true;
    expect(pageErrors).toEqual([]);
    expect(result.teardownError).toBeNull();
    expect(result.outcome, result.error ?? undefined).toBe("finished");
    if (shard) expect(result.invocations.find(row => row.phase === "upstream-runner")?.exitStatus).toBe(0);
  } catch (error) {
    writeFileSync(join(report, wroteTransport ? "test-failure.txt" : "setup-error.txt"), String(error) + "\n");
    throw error;
  } finally {
    if (server.listening) {
      await new Promise<void>((done, reject) => {
        server.close(error => error ? reject(error) : done());
        server.closeAllConnections();
      });
    }
  }
});
