import { expect, test } from "@playwright/test";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { appUrl, gotoMachine } from "./support/kandelo-machine";

test("Kandelo dock defaults to full width", async ({ page }) => {
  await gotoMachine(page, "shell");

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
  await gotoMachine(page, "shell");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launch New Computer" })).toBeVisible();

  await page
    .locator(".kgal-row", {
      has: page.locator(".kgal-machine-title", { hasText: /^Node\.js$/ }),
    })
    .getByRole("button", { name: "Launch" })
    .click();

  // The app rewrites the URL only after the new machine has booted (#1410),
  // so a failed boot never leaves the address bar naming a machine that is
  // not running. Shell and Node.js share one image, so waiting on `vfs`
  // would pass on the pre-launch URL: wait on the profile instead.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("profile"), {
      timeout: 120_000,
    })
    .toBe("node");
  const url = new URL(page.url());
  expect(url.searchParams.get("vfs")).toContain("/shell.vfs.zst");
  // The machine is named by the profile the IMAGE declares, not by an app-side
  // id: `&profile=` carries it. The image URL itself never carries a
  // fragment, and the removed `?demo=` must not come back.
  expect(url.searchParams.get("profile")).toBe("node");
  expect(url.searchParams.get("vfs")).not.toContain("#");
  expect(url.searchParams.get("vfs")).not.toContain("%23");
  expect(url.searchParams.get("demo")).toBeNull();
  // WHY: selecting a VFS updates the URL before the replacement machine has
  // finished its service-worker reload and VFS assembly. Assert the stable
  // accessible machine identity across that boundary instead of racing a
  // transient descendant from the old dock.
  await expect(
    page.getByRole("button", {
      name: /^Current computer: Node\.js,/,
    }),
  ).toBeVisible({ timeout: 30_000 });
});

test("Kandelo URL helper preserves a selected VFS image URL", async ({ page }) => {
  await gotoMachine(page, "shell");

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
    const fragmentImage =
      "https%3A%2F%2Fcdn.example.invalid%2Fsite.vfs.zst%23doom";
    return {
      href,
      parsed: readKandeloBootQuery("?demo=site&vfs=https%3A%2F%2Fcdn.example.invalid%2Fsite.vfs.zst"),
      // `&profile=` is the ONLY channel now: a fragment on the image URL is
      // never read as a profile id, whether or not `&profile=` is also
      // present.
      singleChannel: {
        queryWithFragmentPresent: readKandeloBootQuery(
          `?vfs=${fragmentImage}&profile=shell`,
        ),
        fragmentAloneIsNotAProfile: readKandeloBootQuery(`?vfs=${fragmentImage}`),
      },
      localRefUrl: vfsImageUrlFromDescriptor(descriptor),
      relativeRefUrl: vfsImageUrlFromDescriptor(withRelativeVfs),
      expectedRelativeRefUrl: new URL("images/site.vfs.zst", window.location.href).href,
    };
  }, ABI_VERSION);

  const url = new URL(result.href);
  // Launching from a legacy `?demo=` link strips the dead parameter and writes
  // the profile the image declares instead.
  expect(url.searchParams.get("profile")).toBe("site");
  expect(url.searchParams.get("demo")).toBeNull();
  expect(url.searchParams.get("vfs")).toBe("https://cdn.example.invalid/site.vfs.zst");
  // The app never stamps a fragment on an image URL it generates.
  expect(url.searchParams.get("vfs")).not.toContain("#");
  expect(url.searchParams.get("vfs")).not.toContain("%23");
  // A surviving `?demo=` in the wild is IGNORED, not rejected: the link still
  // resolves its image and boots that image's declared default profile.
  expect(result.parsed).toEqual({
    vfsImageUrl: "https://cdn.example.invalid/site.vfs.zst",
    profileId: null,
  });
  expect(result.singleChannel).toEqual({
    // `&profile=` is read regardless of what fragment the image URL happens
    // to carry.
    queryWithFragmentPresent: { vfsImageUrl: "https://cdn.example.invalid/site.vfs.zst#doom", profileId: "shell" },
    // With no `&profile=`, the image URL's `#doom` fragment is NOT read as a
    // profile id: this is the one boot machine loses if it only carries a
    // fragment, by design.
    fragmentAloneIsNotAProfile: { vfsImageUrl: "https://cdn.example.invalid/site.vfs.zst#doom", profileId: null },
  });
  expect(result.localRefUrl).toBeNull();
  expect(result.relativeRefUrl).toBe(result.expectedRelativeRefUrl);
});

test("Kandelo identifies a built-in VFS image only by its exact source", async ({ page }) => {
  await gotoMachine(page, "shell");

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

test("a computer/ request from the shell page does not capture the shell", async ({ page }) => {
  // Guest pages live on the preview origin. A request the Kandelo page itself
  // makes under computer/ is refused by Kandelo's service worker, and must
  // never turn the shell into something routed into a machine.
  await gotoMachine(page, "shell");

  const refused = await page.evaluate(async () => {
    const response = await fetch("/computer/able-amber-acorn-lfd5pqz5pa7zjm5uyguw/", { cache: "no-store" });
    return { status: response.status, body: await response.text() };
  });
  expect(refused.status).toBe(404);
  expect(refused.body).toContain("preview origin");

  await page.goto(appUrl("/?vfs=https%3A%2F%2Fcdn.example.invalid%2Fshell.vfs.zst"), {
    waitUntil: "domcontentloaded",
  });

  const url = new URL(page.url());
  expect(url.pathname).toBe("/");
  expect(url.searchParams.get("vfs")).toBe("https://cdn.example.invalid/shell.vfs.zst");
});

test("a shared address for a computer no tab runs takes its frame down and says so", async ({ page }) => {
  // The viewer shell (what `<scope>computer/<name>/` opens on Kandelo's
  // origin) embeds the machine from the preview origin. With no owning tab,
  // the preview worker reports the machine offline; the viewer must not
  // keep a frame on screen for it.
  await page.goto(appUrl("/computer/able-amber-acorn-lfd5pqz5pa7zjm5uyguw/"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".kviewer-status")).toContainText("no longer running", { timeout: 60_000 });
  await expect(page.locator(".kviewer-frame")).toHaveCount(0);
  expect(page.frames().filter((frame) => frame !== page.mainFrame() && frame.url().includes("/computer/")))
    .toEqual([]);
});

test("an old three-word computer link says it no longer works", async ({ page }) => {
  // Names now commit to their owner's secret; three-word names from before
  // that never name a computer, and must not resolve to some other one.
  await page.goto(appUrl("/computer/able-amber-acorn/wp-admin/"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".kviewer-status")).toContainText("older Kandelo computer address", { timeout: 30_000 });
  await expect(page.locator(".kviewer-frame")).toHaveCount(0);
});
