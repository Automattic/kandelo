import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("Kandelo gallery launch updates the browser URL with a VFS image", async ({ page }) => {
  await page.goto(appUrl("/pages/kandelo/?mock=1&idle=1"), {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: /browse all presets/i }).click();
  await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible();

  await page
    .locator(".kgal-card", {
      has: page.locator(".kgal-card-title", { hasText: /^Node\.js$/ }),
    })
    .getByRole("button", { name: "Launch" })
    .click();

  await expect
    .poll(() => new URL(page.url()).searchParams.get("vfs"))
    .toContain("/mock-vfs/node.vfs.zst#node");
  const url = new URL(page.url());
  expect(url.searchParams.has("demo")).toBe(false);
  expect(url.searchParams.has("idle")).toBe(false);
});

test("Kandelo URL helper preserves a selected VFS image URL", async ({ page }) => {
  await page.goto(appUrl("/pages/kandelo/?mock=1&idle=1"), {
    waitUntil: "domcontentloaded",
  });

  const result = await page.evaluate(async () => {
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
      base: "kandelo:shell@abi11",
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
      base: "kandelo:shell@abi11",
      packages: [],
      bootCommand: ["bash", "-l", "-i"],
      vfsImageUrl,
      accent: "#2f6f73",
      glyph: "st",
      estimatedUrlBytes: 120,
    }, "https://kandelo.dev/pages/kandelo/?mock=1&idle=1&demo=shell");
    return {
      href,
      parsed: readKandeloBootQuery("?demo=site&vfs=https%3A%2F%2Fcdn.example.invalid%2Fsite.vfs.zst"),
      localRefUrl: vfsImageUrlFromDescriptor(descriptor),
      relativeRefUrl: vfsImageUrlFromDescriptor(withRelativeVfs),
      expectedRelativeRefUrl: new URL("images/site.vfs.zst", window.location.href).href,
    };
  });

  const url = new URL(result.href);
  expect(url.searchParams.has("demo")).toBe(false);
  expect(url.searchParams.get("vfs")).toBe("https://cdn.example.invalid/site.vfs.zst");
  expect(url.searchParams.has("idle")).toBe(false);
  expect(result.parsed).toEqual({
    vfsImageUrl: "https://cdn.example.invalid/site.vfs.zst",
  });
  expect(result.localRefUrl).toBeNull();
  expect(result.relativeRefUrl).toBe(result.expectedRelativeRefUrl);
});
