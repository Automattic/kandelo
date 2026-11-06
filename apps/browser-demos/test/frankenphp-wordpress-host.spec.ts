import { appendFileSync, createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";

const imagePath = process.env.KANDELO_WORDPRESS_FRANKENPHP_VFS;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const churnRequests = Number(process.env.KANDELO_FRANKENPHP_CHURN_REQUESTS ?? "0");
const editorBurstRounds = Number(process.env.KANDELO_FRANKENPHP_EDITOR_BURST_ROUNDS ?? "0");
const parallelEditorRequests = process.env.KANDELO_FRANKENPHP_PARALLEL_EDITOR_REQUESTS === "1";
const memoryDiagnostics = process.env.KANDELO_FRANKENPHP_MEMORY_DIAGNOSTICS === "1";
const soakSeconds = Number(process.env.KANDELO_FRANKENPHP_SOAK_SECONDS ?? "0");
if (!Number.isSafeInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 600) {
  throw new Error("KANDELO_FRANKENPHP_SOAK_SECONDS must be an integer from 0 to 600");
}
if (!Number.isSafeInteger(churnRequests) || churnRequests < 0 || churnRequests > 40) {
  throw new Error("KANDELO_FRANKENPHP_CHURN_REQUESTS must be an integer from 0 to 40");
}
if (!Number.isSafeInteger(editorBurstRounds) || editorBurstRounds < 0 || editorBurstRounds > 20) {
  throw new Error("KANDELO_FRANKENPHP_EDITOR_BURST_ROUNDS must be an integer from 0 to 20");
}

const artifactTest = test.extend<{ artifactUrls: { imageUrl: string; kernelUrl: string } }>({
  artifactUrls: async ({ baseURL }, use) => {
    if (!imagePath) {
      await use({ imageUrl: "", kernelUrl: "" });
      return;
    }
    expect(baseURL).toBeTruthy();
    const kernelPath = resolveBinary("kernel.wasm");
    const artifacts = new Map([
      ["/__wordpress_frankenphp__.vfs.zst", { path: imagePath!, type: "application/octet-stream" }],
      ["/__wordpress_frankenphp_kernel__.wasm", { path: kernelPath, type: "application/wasm" }],
    ]);
    const server = createServer((request, response) => {
      const artifact = artifacts.get(request.url ?? "");
      if (!artifact) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": artifact.type,
        "Content-Length": statSync(artifact.path).size,
        "Access-Control-Allow-Origin": new URL(baseURL!).origin,
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      createReadStream(artifact.path).on("error", (error) => response.destroy(error)).pipe(response);
    });
    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveReady);
    });
    const address = server.address() as AddressInfo;
    const imageUrl = `http://127.0.0.1:${address.port}/__wordpress_frankenphp__.vfs.zst`;
    const kernelUrl = `http://127.0.0.1:${address.port}/__wordpress_frankenphp_kernel__.wasm`;
    try {
      await use({ imageUrl, kernelUrl });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
    }
  },
});

for (const serviceName of ["frankenphp-classic", "frankenphp-caddy"] as const) {
  artifactTest(`WordPress on ${serviceName} serves PHP in the browser kernel host`, async ({ page, baseURL, browser, artifactUrls }) => {
    test.setTimeout(Math.max(serviceName === "frankenphp-caddy" || parallelEditorRequests ? 300_000 : 240_000,
      (soakSeconds + 240) * 1000));
    test.skip(!imagePath, "Build the WordPress image and set KANDELO_WORDPRESS_FRANKENPHP_VFS");
    expect(baseURL).toBeTruthy();
    const { imageUrl, kernelUrl } = artifactUrls;
    const browserKernelUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href;
    const lifecycle: string[] = [];
    const record = (event: string) => lifecycle.push(`${new Date().toISOString()} ${event}`);
    page.on("crash", () => record("page crashed"));
    page.on("close", () => record("page closed"));
    browser.on("disconnected", () => record("browser disconnected"));
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) record(`main frame: ${frame.url()}`);
    });
    page.on("pageerror", error => record(`page error: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error" || message.type() === "warning") record(`console ${message.type()}: ${message.text()}`);
    });
    // Retain phase evidence outside the page if its execution context is lost.
    const memoryEvidencePath = test.info().outputPath("browser-memory-samples.jsonl");
    await page.exposeFunction("recordFrankenPhpStage", (stage: string, memory?: unknown) => {
      record(`stage: ${stage}`);
      if (memory !== undefined) appendFileSync(memoryEvidencePath,
        JSON.stringify({ recordedAt: new Date().toISOString(), stage, memory }) + "\n");
    });
    await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

    const result = await page.evaluate(async ({ imageUrl, kernelUrl, browserKernelUrl, gracefulProbeUrl, runtimeUrlsModuleUrl, churnRequests, editorBurstRounds, parallelEditorRequests, serviceName, memoryDiagnostics, soakSeconds }) => {
      let readMemory: (() => Promise<unknown>) | undefined;
      const stage = async (message: string) => {
        let snapshot: unknown;
        try {
          if (memoryDiagnostics && readMemory) snapshot = await readMemory();
        } catch (error) {
          snapshot = { error: String(error) };
        }
        await (globalThis as typeof globalThis & {
          recordFrankenPhpStage: (message: string, memory?: unknown) => Promise<void>;
        }).recordFrankenPhpStage(message, snapshot);
      };
      await stage("loading artifacts");
      const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
      const { observeProcessExits, verifyFrankenPhpGracefulShutdown } = await import(/* @vite-ignore */ gracefulProbeUrl);
      const { imageOwnedLazyAssetDirectory } = await import(/* @vite-ignore */ runtimeUrlsModuleUrl);
      const processExits = observeProcessExits();
      const [imageResponse, kernelResponse] = await Promise.all([fetch(imageUrl), fetch(kernelUrl)]);
      if (!imageResponse.ok || !kernelResponse.ok) throw new Error("WordPress test artifacts failed to load");
      const [imageBytes, kernelWasm] = await Promise.all([
        imageResponse.arrayBuffer(), kernelResponse.arrayBuffer(),
      ]);
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      const diagnostics: unknown[] = [];
      const shutdown: { phase: string; completed: number; total: number }[] = [];
      let serviceReady: (() => void) | undefined;
      const serviceReadiness = new Promise<void>((resolveReady) => { serviceReady = resolveReady; });
      let dinitPid = 0;
      let dinitExit: Promise<number> | undefined;
      const kernel = new BrowserKernel({
        kernelOwnedFs: true,
        maxWorkers: 12,
        maxMemoryPages: 16384,
        onStdout: (data: Uint8Array) => {
          stdout += decoder.decode(data);
          if (stdout.includes(`[  OK  ] ${serviceName}`)) serviceReady?.();
        },
        onStderr: (data: Uint8Array) => { stderr += decoder.decode(data); },
        onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
        onProcessEvent: processExits.onEvent,
      });
      kernel.subscribeDestroyProgress((event: { phase: string; completed: number; total: number }) => shutdown.push(event));
      try {
        await kernel.initFromImage({
          kernelWasm, vfsImage: new Uint8Array(imageBytes),
          // Use the app's ordinary transport for the image's deferred bodies.
          lazyAssetDirectory: imageOwnedLazyAssetDirectory(),
        });
        readMemory = async () => {
          const [kernelPages, processes, modules] = await Promise.all([
            kernel.getKernelMemoryPages(), kernel.enumProcs(), kernel.getWasmModuleCacheStats(),
          ]);
          return { kernelBytes: kernelPages * 65536, processes, modules };
        };
        await stage("kernel initialized");
        const template = await kernel.readFileFromVfs("/etc/wp-config-template.php");
        if (!template) throw new Error("WordPress config template missing");
        await kernel.writeFileToVfs("/var/www/html/wp-config.php", new TextEncoder().encode(
          decoder.decode(template).replaceAll("@@APP_PATH@@", "/").replaceAll("@@PROTO@@", "http"),
        ));
        await kernel.writeFileToVfs("/var/www/html/__kandelo_opcache_target.php", new TextEncoder().encode("<?php return 1;"));
        await kernel.writeFileToVfs("/var/www/html/__kandelo_opcache_probe.php", new TextEncoder().encode(`<?php
header('Content-Type: application/json');
$configuration = opcache_get_configuration();
$target = __DIR__ . '/__kandelo_opcache_target.php';
$compiled = opcache_compile_file($target);
echo json_encode([
    'loaded' => extension_loaded('Zend OPcache'),
    'fileCacheOnly' => !empty($configuration['directives']['opcache.file_cache_only']),
    'compiled' => $compiled,
    'cacheFilePresent' => count(glob('/var/cache/opcache/*' . $target . '.bin')) > 0,
], JSON_THROW_ON_ERROR);
`));
        const { pid, exit } = await kernel.spawnFromVfs("/bin/sh", [
          "sh", "/sbin/kandelo-init", serviceName,
        ], {
          env: [
            "HOME=/root", "TMPDIR=/tmp", "TERM=xterm-256color",
            "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
            "WP_APP_PATH=/", "WP_PROTO=http", "FRANKENPHP_NUM_THREADS=6", "FRANKENPHP_LISTEN=:8080",
          ],
          cwd: "/",
        });
        dinitPid = pid;
        dinitExit = exit;
        exit.catch(() => {});
        await Promise.race([
          serviceReadiness,
          exit.then((code: number) => { throw new Error(`dinit exited before readiness: ${code}`); }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service readiness timeout")), 90_000)),
        ]);
        await stage("service ready");

        let homepage: Awaited<ReturnType<typeof kernel.fetchInKernel>> | undefined;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          try {
            homepage = await kernel.fetchInKernel(8080, {
              method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null,
            }, { timeoutMs: 30_000 });
            break;
          } catch (error) {
            if (!String(error).includes("No in-kernel listener")) throw error;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
          }
        }
        if (!homepage) throw new Error("FrankenPHP did not bind port 8080");
        const opcacheResponse = await kernel.fetchInKernel(8080, {
          method: "GET", url: "/__kandelo_opcache_probe.php", headers: { Host: "localhost:8080" }, body: null,
        }, { timeoutMs: 30_000 });
        const opcacheBody = decoder.decode(opcacheResponse.body);
        const login = await kernel.fetchInKernel(8080, {
          method: "GET", url: "/wp-login.php", headers: { Host: "localhost:8080" }, body: null,
        }, { timeoutMs: 30_000 });
        const loginForm = new TextEncoder().encode("log=admin&pwd=password&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1");
        const loginPost = await kernel.fetchInKernel(8080, {
          method: "POST", url: "/wp-login.php", headers: {
            Host: "localhost:8080",
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: "wordpress_test_cookie=WP%20Cookie%20check",
          }, body: loginForm,
        }, { timeoutMs: 30_000 });
        const loginCookie = Object.entries(loginPost.headers).find(([name]) => name.toLowerCase() === "set-cookie")?.[1]
          ?.split("\n").map((line) => line.split(";")[0]).join("; ");
        const editor = await kernel.fetchInKernel(8080, {
          method: "GET", url: "/wp-admin/site-editor.php", headers: {
            Host: "localhost:8080",
            Cookie: loginCookie ?? "",
          }, body: null,
        }, { timeoutMs: 60_000 });
        const editorHtml = decoder.decode(editor.body);
        await stage("WordPress login and editor complete");
        if (editorBurstRounds > 0) {
          const restNonce = /var wpApiSettings = \{[^;]*"nonce":"([^"]+)"/.exec(editorHtml)?.[1];
          const compressionNonce = /var compressionNonce = "([^"]+)"/.exec(editorHtml)?.[1];
          if (!restNonce || !compressionNonce) throw new Error("Editor request nonces are missing");
          for (let round = 0; round < editorBurstRounds; round += 1) {
            const responses = await Promise.all([
              kernel.fetchInKernel(8080, {
                method: "GET",
                url: "/index.php?rest_route=%2Fwp%2Fv2%2Fpages&context=edit&per_page=100&_fields=id%2Clink%2Cmenu_order%2Cparent%2Ctitle%2Ctype&orderby=menu_order&order=asc&_locale=user",
                headers: { Host: "localhost:8080", Cookie: loginCookie ?? "", "X-WP-Nonce": restNonce },
                body: null,
              }, { timeoutMs: 30_000 }),
              kernel.fetchInKernel(8080, {
                method: "GET",
                url: `/wp-admin/admin-ajax.php?action=wp-compression-test&test=no&_ajax_nonce=${compressionNonce}&round=${round}`,
                headers: { Host: "localhost:8080", Cookie: loginCookie ?? "" },
                body: null,
              }, { timeoutMs: 30_000 }),
            ]);
            if (responses.some((response) => response.status !== 200)) {
              throw new Error(`Editor burst ${round} returned ${responses.map((response) => response.status).join(", ")}`);
            }
          }
        }
        if (parallelEditorRequests) {
          const restNonce = /var wpApiSettings = \{[^;]*"nonce":"([^"]+)"/.exec(editorHtml)?.[1];
          const compressionNonce = /var compressionNonce = "([^"]+)"/.exec(editorHtml)?.[1];
          if (!restNonce || !compressionNonce) throw new Error("Editor request nonces are missing");
          const paths = [
            "/index.php?rest_route=%2Fwp%2Fv2%2Ftaxonomies&context=view&_locale=user",
            "/index.php?rest_route=%2Fwp%2Fv2%2Ftemplate-parts%2Ftwentytwentyfive%2F%2Fheader&context=edit&_locale=user",
            "/index.php?rest_route=%2Fwp%2Fv2%2Ftemplate-parts%2Ftwentytwentyfive%2F%2Ffooter&context=edit&_locale=user",
            "/index.php?rest_route=%2Fwp%2Fv2%2Fposts&context=edit&offset=0&order=desc&orderby=date&per_page=3&_locale=user",
            "/index.php?rest_route=%2Fwp%2Fv2%2Fblock-patterns%2Fpatterns&_locale=user",
            "/index.php?rest_route=%2Fwp%2Fv2%2Fsettings&_locale=user",
            "/index.php?rest_route=%2Fwp%2Fv2%2Ftemplates&_locale=user",
            "/index.php?rest_route=%2Fwp%2Fv2%2Fpages&context=edit&per_page=100&_locale=user",
            `/wp-admin/admin-ajax.php?action=wp-compression-test&test=2&_ajax_nonce=${compressionNonce}`,
            `/wp-admin/site-editor.php?health=${Date.now()}`,
          ];
          const parallel = await Promise.all(paths.map(async (url) => {
            const response = await kernel.fetchInKernel(8080, {
              method: "GET", url,
              headers: { Host: "localhost:8080", Cookie: loginCookie ?? "", "X-WP-Nonce": restNonce },
              body: null,
            }, { timeoutMs: 60_000 });
            return { url, status: response.status };
          }));
          // The direct kernel host does not rewrite WordPress's canonical
          // editor redirect into a preview URL; a prompt 302 is valid here.
          if (parallel.some(({ status }, index) => index === paths.length - 1
            ? status !== 200 && status !== 302 : status !== 200)) {
            throw new Error(`Parallel editor requests returned ${JSON.stringify(parallel)}`);
          }
        }
        await stage("editor burst and parallel requests complete");
        for (let index = 0; index < churnRequests; index += 1) {
          const isLogin = index % 2 === 1;
          const response = await kernel.fetchInKernel(8080, {
            method: "GET",
            url: isLogin ? `/wp-login.php?round=${index}` : `/?round=${index}`,
            headers: { Host: "localhost:8080" },
            body: null,
          }, { timeoutMs: 30_000 });
          const body = decoder.decode(response.body);
          if (response.status !== 200 || !body.includes(isLogin ? "user_login" : "WordPress on Kandelo")) {
            throw new Error(`WordPress PHP request ${index} returned ${response.status}`);
          }
        }
        await stage("request churn complete");
        const soakStarted = performance.now();
        let soakSampledAt = soakStarted;
        let soakRequests = 0;
        while (performance.now() - soakStarted < soakSeconds * 1000) {
          const response = await kernel.fetchInKernel(8080, {
            method: "GET", url: `/?soak=${soakRequests}`, headers: { Host: "localhost:8080" }, body: null,
          }, { timeoutMs: 30_000 });
          if (response.status !== 200 || !decoder.decode(response.body).includes("WordPress on Kandelo")) {
            throw new Error(`Soak request ${soakRequests} returned ${response.status}`);
          }
          soakRequests++;
          if (performance.now() - soakSampledAt >= 15_000) {
            await stage(`soak requests: ${soakRequests}`);
            soakSampledAt = performance.now();
          }
        }
        const soakDurationMs = performance.now() - soakStarted;
        let restarted = false;
        if (serviceName === "frankenphp-caddy") {
          const listener = await kernel.pickListenerTarget(8080);
          if (!listener) throw new Error("FrankenPHP listener missing before restart test");
          if (!(await kernel.signalProcess(listener.pid, 9))) {
            throw new Error("Could not kill FrankenPHP process for restart test");
          }
          for (let attempt = 0; attempt < 300; attempt += 1) {
            const replacement = await kernel.pickListenerTarget(8080);
            if (replacement && replacement.pid !== listener.pid) {
              try {
                const recovered = await kernel.fetchInKernel(8080, {
                  method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null,
                }, { timeoutMs: 30_000 });
                restarted = recovered.status === 200 && decoder.decode(recovered.body).includes("WordPress on Kandelo");
                if (restarted) break;
              } catch {}
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
          }
          if (!restarted) throw new Error("FrankenPHP did not recover after SIGKILL");
          await stage("Caddy recovered after SIGKILL");
        }
        const graceful = await verifyFrankenPhpGracefulShutdown(
          kernel, 8080, processExits.waitForExit, serviceName,
        );
        await stage("held PHP request drained");
        const serviceLog = await kernel.readFileFromVfs(`/var/log/${serviceName}.log`);
        if (!serviceLog) throw new Error("FrankenPHP service log missing");
        return {
          graceful,
          opcacheStatus: opcacheResponse.status,
          opcacheBody,
          homepageStatus: homepage.status,
          homepageBody: decoder.decode(homepage.body),
          loginStatus: login.status,
          loginBody: decoder.decode(login.body),
          loginPostStatus: loginPost.status,
          editorStatus: editor.status,
          editorBody: decoder.decode(editor.body).slice(0, 500),
          churnCompleted: churnRequests,
          editorBurstCompleted: editorBurstRounds,
          parallelEditorCompleted: parallelEditorRequests,
          soakRequests,
          soakDurationMs,
          restarted,
          serviceLog: decoder.decode(serviceLog),
          diagnostics,
          shutdown,
          stderr,
        };
      } catch (error) {
        const log = await Promise.race([
          kernel.readFileFromVfs(`/var/log/${serviceName}.log`).catch(() => null),
          new Promise<null>((resolveLog) => setTimeout(() => resolveLog(null), 5_000)),
        ]);
        throw new Error(`${String(error)}\nstdout=${stdout.slice(-1000)}\nstderr=${stderr.slice(-1000)}\nlog=${log ? decoder.decode(log).slice(-3000) : "missing"}`);
      } finally {
        await stage("stopping init and destroying machine");
        if (dinitPid !== 0) await kernel.signalProcess(dinitPid, 15).catch(() => {});
        if (dinitExit) await Promise.race([
          dinitExit.catch(() => -1),
          new Promise<number>((resolveWait) => setTimeout(() => resolveWait(-1), 5_000)),
        ]);
        await kernel.destroy();
        readMemory = undefined;
        await stage("machine destroyed");
      }
    }, {
      imageUrl, kernelUrl, browserKernelUrl, churnRequests, editorBurstRounds, parallelEditorRequests, serviceName,
      memoryDiagnostics, soakSeconds,
      gracefulProbeUrl: new URL(`/@fs/${resolve(repoRoot, "host/test/support/frankenphp-graceful.ts")}`, baseURL!).href,
      runtimeUrlsModuleUrl: new URL("/lib/init/image-owned-runtime-urls.ts", baseURL!).href,
    }).catch(async error => {
      const evidencePath = test.info().outputPath("browser-page-lifecycle.json");
      writeFileSync(evidencePath, JSON.stringify({ url: page.url(), lifecycle }, null, 2));
      await test.info().attach("browser-page-lifecycle", {
        path: evidencePath, contentType: "application/json",
      });
      if (existsSync(memoryEvidencePath)) await test.info().attach("browser-memory-samples", {
        path: memoryEvidencePath, contentType: "application/x-ndjson",
      });
      throw error;
    });

    const serviceLogPath = test.info().outputPath(`${serviceName}.log`);
    writeFileSync(serviceLogPath, result.serviceLog);
    await test.info().attach("guest-service-log", { path: serviceLogPath, contentType: "text/plain" });

    expect(result.opcacheStatus, `${result.opcacheBody}\n${result.serviceLog.slice(-3000)}`).toBe(200);
    expect(JSON.parse(result.opcacheBody)).toEqual({
      loaded: true, fileCacheOnly: true, compiled: true, cacheFilePresent: true,
    });
    expect(result.homepageStatus, `${result.homepageBody.slice(-1000)}\n${result.serviceLog.slice(-3000)}\n${result.stderr.slice(-1000)}\n${JSON.stringify(result.diagnostics)}`).toBe(200);
    expect(result.homepageBody).toContain("WordPress on Kandelo");
    expect(result.homepageBody).not.toContain("id=\"setup\"");
    expect(result.loginStatus).toBe(200);
    expect(result.loginBody).toContain("user_login");
    expect(result.loginPostStatus).toBe(302);
    expect(result.editorStatus, `${result.editorBody}\n${result.serviceLog.slice(-3000)}`).toBe(200);
    expect(result.churnCompleted).toBe(churnRequests);
    expect(result.editorBurstCompleted).toBe(editorBurstRounds);
    expect(result.parallelEditorCompleted).toBe(parallelEditorRequests);
    expect(result.soakDurationMs).toBeGreaterThanOrEqual(soakSeconds * 1000);
    if (soakSeconds > 0) expect(result.soakRequests).toBeGreaterThan(0);
    if (serviceName === "frankenphp-caddy") {
      expect(result.restarted).toBe(true);
    }
    expect(result.graceful).toMatchObject({ listenerClosed: true, status: 200, serverExit: 0, stopExit: 0 });
    expect(result.serviceLog).toContain(serviceName === "frankenphp-caddy" ? '"num_threads":6' : "num_threads=6");
    expect(result.serviceLog).not.toMatch(/^(?:panic:|fatal error:)/m);
    expect(result.diagnostics).toEqual([]);
    const drained = result.shutdown.filter(event => event.phase === "draining").at(-1);
    expect(drained, JSON.stringify(result.shutdown)).toBeDefined();
    expect(drained!.completed, JSON.stringify(result.shutdown)).toBe(drained!.total);
    expect(result.shutdown.filter(event => event.phase === "terminating").at(-1)?.total)
      .toBe(drained!.total);
    expect(result.stderr).not.toContain("panic");
  });
}
