import { expect, test } from "@playwright/test";
import { ABI_VERSION } from "../../../host/src/generated/abi";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("Kandelo dock defaults to full width", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell"), {
    waitUntil: "domcontentloaded",
  });

  // WHY: a brand-new origin reloads once after its service worker first takes
  // control. This test must also pass alone, without another test priming it.
  await expect(page.getByRole("navigation", { name: "Kandelo tools" }))
    .toHaveClass(/\bkdock-full-width\b/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Use compact dock" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".kdocked-app"))
    .toHaveClass(/\bis-dock-full-width\b/);
});

test("Kandelo gallery launch updates the browser URL with a VFS image", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell"), {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launch New Machine" })).toBeVisible();

  await page
    .locator(".kgal-row", {
      has: page.locator(".kgal-machine-title", { hasText: /^Node\.js$/ }),
    })
    .getByRole("button", { name: "Launch" })
    .click();

  await expect
    .poll(() => new URL(page.url()).searchParams.get("vfs"))
    .toContain("/node-vfs.vfs.zst#node");
  const url = new URL(page.url());
  expect(url.searchParams.get("demo")).toBe("node");
  await expect(page.locator(".kdock-status-title")).toHaveText("Node.js");
});

test("Kandelo URL helper preserves a selected VFS image URL", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell"), {
    waitUntil: "domcontentloaded",
  });

  const result = await page.evaluate(async (abiVersion) => {
    const {
      descriptorWithVfsImageUrl,
      galleryItemUrl,
      readKandeloBootQuery,
      vfsImageUrlFromDescriptor,
    } = await import("/pages/kandelo/url-state.ts");
    const vfsImageUrl = "https://cdn.example.invalid/site.vfs.zst";
    const descriptor = {
      version: 1,
      id: "shell",
      title: "Shell",
      base: `kandelo:shell@abi${abiVersion}`,
      runtime: {
        arch: "wasm32",
        kernel: "kernel@local",
        memoryPages: 2048,
        features: ["shared-array-buffer", "pty"],
        time: "real",
      },
      packages: [],
      mounts: [
        { path: "/", source: "image", ref: "shell.vfs@local", readonly: false },
      ],
      boot: { argv: ["bash", "-l", "-i"], cwd: "/home", env: {} },
      caps: { network: false },
    };
    const withRelativeVfs = descriptorWithVfsImageUrl(descriptor, "images/site.vfs.zst");
    const href = galleryItemUrl({
      id: "site",
      title: "Site",
      summary: "Third-party VFS image",
      base: `kandelo:shell@abi${abiVersion}`,
      packages: [],
      bootCommand: ["bash", "-l", "-i"],
      vfsImageUrl,
      accent: "#2f6f73",
      glyph: "st",
      estimatedUrlBytes: 120,
    }, "https://kandelo.dev/?demo=shell");
    return {
      href,
      parsed: readKandeloBootQuery("?demo=site&vfs=https%3A%2F%2Fcdn.example.invalid%2Fsite.vfs.zst"),
      localRefUrl: vfsImageUrlFromDescriptor(descriptor),
      relativeRefUrl: vfsImageUrlFromDescriptor(withRelativeVfs),
      expectedRelativeRefUrl: new URL("images/site.vfs.zst", window.location.href).href,
    };
  }, ABI_VERSION);

  const url = new URL(result.href);
  expect(url.searchParams.get("demo")).toBe("site");
  expect(url.searchParams.get("vfs")).toBe("https://cdn.example.invalid/site.vfs.zst");
  expect(result.parsed).toEqual({
    vfsImageUrl: "https://cdn.example.invalid/site.vfs.zst",
  });
  expect(result.localRefUrl).toBeNull();
  expect(result.relativeRefUrl).toBe(result.expectedRelativeRefUrl);
});

test("Kandelo identifies a built-in VFS image only by its exact source", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell"), {
    waitUntil: "domcontentloaded",
  });

  const result = await page.evaluate(async () => {
    const { matchTrustedVfsSourceId } = await import("/pages/kandelo/url-state.ts");
    const baseHref = "https://kandelo.example/app/";
    const candidates = [
      {
        id: "alpha",
        resolveVfsImageUrl: () => "./images/alpha.vfs.zst",
      },
      {
        id: "beta",
        resolveVfsImageUrl: async () =>
          "https://cdn.example.invalid/beta.vfs.zst",
      },
    ] as const;

    return {
      exact: await matchTrustedVfsSourceId(
        "https://cdn.example.invalid/beta.vfs.zst#beta",
        candidates,
        baseHref,
      ),
      fragmentDoesNotChangeSource: await matchTrustedVfsSourceId(
        "https://kandelo.example/app/images/alpha.vfs.zst#beta",
        candidates,
        baseHref,
      ),
      relativeSource: await matchTrustedVfsSourceId(
        "https://kandelo.example/app/images/alpha.vfs.zst",
        candidates,
        baseHref,
      ),
      unmatched: await matchTrustedVfsSourceId(
        "https://cdn.example.invalid/other.vfs.zst",
        candidates,
        baseHref,
      ),
      ambiguousSource: await matchTrustedVfsSourceId(
        "https://cdn.example.invalid/shared.vfs.zst#shell",
        [
          { id: "shell", resolveVfsImageUrl: () => "https://cdn.example.invalid/shared.vfs.zst" },
          { id: "doom", resolveVfsImageUrl: () => "https://cdn.example.invalid/shared.vfs.zst" },
        ] as const,
        baseHref,
      ),
      failedResolver: await matchTrustedVfsSourceId(
        "https://cdn.example.invalid/missing.vfs.zst#missing",
        [{
          id: "missing",
          resolveVfsImageUrl: () => Promise.reject(new Error("not built")),
        }] as const,
        baseHref,
      ),
      duplicateIds: await matchTrustedVfsSourceId(
        "https://cdn.example.invalid/one.vfs.zst#same",
        [
          { id: "same", resolveVfsImageUrl: () => "https://cdn.example.invalid/one.vfs.zst" },
          { id: "same", resolveVfsImageUrl: () => "https://cdn.example.invalid/two.vfs.zst" },
        ] as const,
        baseHref,
      ),
      invalidProtocol: await matchTrustedVfsSourceId(
        "file:///tmp/alpha.vfs.zst#alpha",
        candidates,
        baseHref,
      ),
    };
  });

  expect(result).toEqual({
    exact: "beta",
    fragmentDoesNotChangeSource: "alpha",
    relativeSource: "alpha",
    unmatched: null,
    ambiguousSource: null,
    failedResolver: null,
    duplicateIds: null,
    invalidProtocol: null,
  });
});

test("Kandelo service worker app probe does not capture the shell page client", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell"), {
    waitUntil: "domcontentloaded",
  });

  await installDummyAppBridge(page);
  await page.evaluate(async () => {
    const response = await fetch("/app/", { cache: "no-store" });
    await response.text();
  });

  await page.goto(appUrl("/?vfs=https%3A%2F%2Fcdn.example.invalid%2Fshell.vfs.zst"), {
    waitUntil: "domcontentloaded",
  });

  const url = new URL(page.url());
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get("vfs")).toBe("https://cdn.example.invalid/shell.vfs.zst");
});

async function installDummyAppBridge(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers unavailable");
    }

    await navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    const controller = navigator.serviceWorker.controller ?? await new Promise<ServiceWorker>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        reject(new Error("Timed out waiting for service worker control"));
      }, 10_000);
      const onControllerChange = () => {
        const next = navigator.serviceWorker.controller;
        if (!next) return;
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        resolve(next);
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    });

    const bridge = new MessageChannel();
    bridge.port1.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type !== "http-request") return;
      bridge.port1.postMessage({
        type: "http-response",
        requestId: msg.requestId,
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: new TextEncoder().encode("<!doctype html><title>Dummy app</title>"),
      });
    };
    bridge.port1.start();

    const reply = new MessageChannel();
    await new Promise<void>((resolve) => {
      reply.port1.onmessage = () => resolve();
      controller.postMessage(
        { type: "init-bridge", appPrefix: "/app/" },
        [bridge.port2, reply.port2],
      );
    });
  });
}
