import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";

const imagePath = process.env.KANDELO_WORDPRESS_FRANKENPHP_VFS;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const churnRequests = Number(process.env.KANDELO_FRANKENPHP_CHURN_REQUESTS ?? "0");
if (!Number.isSafeInteger(churnRequests) || churnRequests < 0 || churnRequests > 40) {
  throw new Error("KANDELO_FRANKENPHP_CHURN_REQUESTS must be an integer from 0 to 40");
}

for (const serviceName of ["frankenphp-classic", "frankenphp-caddy"] as const) {
  test(`WordPress on ${serviceName} serves PHP in the Chromium kernel host`, async ({ page, baseURL, browserName }) => {
    test.setTimeout(240_000);
    test.skip(browserName !== "chromium", "FrankenPHP WordPress browser gate uses Chromium");
    test.skip(!imagePath, "Build the WordPress image and set KANDELO_WORDPRESS_FRANKENPHP_VFS");
    expect(baseURL).toBeTruthy();

    const imageUrl = new URL("/__wordpress_frankenphp__.vfs.zst", baseURL!).href;
    const kernelUrl = new URL("/__wordpress_frankenphp_kernel__.wasm", baseURL!).href;
    const browserKernelUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/browser-kernel-host.ts")}`, baseURL!).href;
    await page.route(imageUrl, (route) => route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: readFileSync(imagePath!),
    }));
    await page.route(kernelUrl, (route) => route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: readFileSync(resolveBinary("kernel.wasm")),
    }));
    await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

    const result = await page.evaluate(async ({ imageUrl, kernelUrl, browserKernelUrl, churnRequests, serviceName }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
      const [imageResponse, kernelResponse] = await Promise.all([fetch(imageUrl), fetch(kernelUrl)]);
      if (!imageResponse.ok || !kernelResponse.ok) throw new Error("WordPress test artifacts failed to load");
      const [imageBytes, kernelWasm] = await Promise.all([
        imageResponse.arrayBuffer(), kernelResponse.arrayBuffer(),
      ]);
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      const diagnostics: unknown[] = [];
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
      });
      try {
        await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(imageBytes) });
        const template = await kernel.readFileFromVfs("/etc/wp-config-template.php");
        if (!template) throw new Error("WordPress config template missing");
        await kernel.writeFileToVfs("/var/www/html/wp-config.php", new TextEncoder().encode(
          decoder.decode(template).replaceAll("@@APP_PATH@@", "/").replaceAll("@@PROTO@@", "http"),
        ));
        const { pid, exit } = await kernel.spawnFromVfs("/sbin/dinit", [
          "/sbin/dinit", "--container", "-p", "/tmp/dinitctl", serviceName,
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
        const serviceLog = await kernel.readFileFromVfs(`/var/log/${serviceName}.log`);
        if (!serviceLog) throw new Error("FrankenPHP service log missing");
        return {
          homepageStatus: homepage.status,
          homepageBody: decoder.decode(homepage.body),
          loginStatus: login.status,
          loginBody: decoder.decode(login.body),
          loginPostStatus: loginPost.status,
          editorStatus: editor.status,
          editorBody: decoder.decode(editor.body).slice(0, 500),
          churnCompleted: churnRequests,
          serviceLog: decoder.decode(serviceLog),
          diagnostics,
          stderr,
        };
      } catch (error) {
        const log = await kernel.readFileFromVfs(`/var/log/${serviceName}.log`).catch(() => null);
        throw new Error(`${String(error)}\nstdout=${stdout.slice(-1000)}\nstderr=${stderr.slice(-1000)}\nlog=${log ? decoder.decode(log).slice(-3000) : "missing"}`);
      } finally {
        if (dinitPid !== 0) await kernel.signalProcess(dinitPid, 15).catch(() => {});
        if (dinitExit) await Promise.race([
          dinitExit.catch(() => -1),
          new Promise<number>((resolveWait) => setTimeout(() => resolveWait(-1), 5_000)),
        ]);
        await kernel.destroy();
      }
    }, { imageUrl, kernelUrl, browserKernelUrl, churnRequests, serviceName });

    expect(result.homepageStatus).toBe(200);
    expect(result.homepageBody).toContain("WordPress on Kandelo");
    expect(result.homepageBody).not.toContain("id=\"setup\"");
    expect(result.loginStatus).toBe(200);
    expect(result.loginBody).toContain("user_login");
    expect(result.loginPostStatus).toBe(302);
    expect(result.editorStatus, `${result.editorBody}\n${result.serviceLog.slice(-3000)}`).toBe(200);
    expect(result.churnCompleted).toBe(churnRequests);
    expect(result.serviceLog).toContain(serviceName === "frankenphp-caddy" ? '"num_threads":6' : "num_threads=6");
    expect(result.diagnostics).toEqual([]);
    expect(result.stderr).not.toContain("panic");
  });
}
