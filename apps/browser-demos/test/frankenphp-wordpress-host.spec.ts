import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const imagePath = process.env.KANDELO_WORDPRESS_FRANKENPHP_VFS;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("WordPress on FrankenPHP serves PHP in the Chromium kernel host", async ({ page, baseURL, browserName }) => {
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
    body: readFileSync(resolve(repoRoot, "local-binaries/kernel.wasm")),
  }));
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);

  const result = await page.evaluate(async ({ imageUrl, kernelUrl, browserKernelUrl }) => {
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
      maxMemoryPages: 4096,
      onStdout: (data: Uint8Array) => {
        stdout += decoder.decode(data);
        if (stdout.includes("[  OK  ] frankenphp-classic")) serviceReady?.();
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
        "/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "frankenphp-classic",
      ], {
        env: [
          "HOME=/root", "TMPDIR=/tmp", "TERM=xterm-256color",
          "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
          "WP_APP_PATH=/", "WP_PROTO=http", "FRANKENPHP_LISTEN=:8080",
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
      return {
        homepageStatus: homepage.status,
        homepageBody: decoder.decode(homepage.body),
        loginStatus: login.status,
        loginBody: decoder.decode(login.body),
        diagnostics,
        stderr,
      };
    } catch (error) {
      const log = await kernel.readFileFromVfs("/var/log/frankenphp-classic.log").catch(() => null);
      throw new Error(`${String(error)}\nstdout=${stdout.slice(-1000)}\nstderr=${stderr.slice(-1000)}\nlog=${log ? decoder.decode(log).slice(-3000) : "missing"}`);
    } finally {
      if (dinitPid !== 0) await kernel.signalProcess(dinitPid, 15).catch(() => {});
      if (dinitExit) await Promise.race([
        dinitExit.catch(() => -1),
        new Promise<number>((resolveWait) => setTimeout(() => resolveWait(-1), 5_000)),
      ]);
      await kernel.destroy();
    }
  }, { imageUrl, kernelUrl, browserKernelUrl });

  expect(result.homepageStatus).toBe(200);
  expect(result.homepageBody).toContain("WordPress on Kandelo");
  expect(result.homepageBody).not.toContain("id=\"setup\"");
  expect(result.loginStatus).toBe(200);
  expect(result.loginBody).toContain("user_login");
  expect(result.diagnostics).toEqual([]);
  expect(result.stderr).not.toContain("panic");
});
