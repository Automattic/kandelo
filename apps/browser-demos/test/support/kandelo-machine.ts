// Navigate a Playwright page to ONE curated Kandelo machine.
//
// The app used to accept `?demo=<id>`, where `<id>` was one of a dozen names
// the app itself held. That table is gone: a machine is now whatever an
// image's own `/etc/kandelo/demo.json` says it is, and a URL selects one with
// `?vfs=<image-url>` plus an optional `&profile=<id>`
// (docs/browser-support.md, "Selecting a machine").
//
// A spec therefore cannot name a machine in a URL without naming its image.
// This module closes that gap the same way the app's gallery does: the tracked
// `gallery-roster.json` says which PRODUCT owns a profile, and the in-app
// fixture `test/fixtures/vfs-product-images.ts` resolves that product's image
// URL through the same Vite specifiers `live-setup.ts` uses, so the resulting
// `?vfs=` URL is the one the loader recognizes as that product.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type FrameLocator, type Page } from "@playwright/test";
import { parseGalleryRoster } from "../../../../web-libs/kandelo-session/src/gallery-roster";
import { readLocalSupportedSet } from "../../../../scripts/local-supported-set.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const GALLERY_ROSTER = parseGalleryRoster(
  readFileSync(join(here, "../../pages/kandelo/gallery-roster.json"), "utf8"),
);

/**
 * The `[[products]]` ids packages/sets/local-supported.toml declares active.
 * `./run.sh setup` and `./run.sh local-build` build every one of them, so a
 * missing image for one of these is a build defect, not optional content.
 */
export const SUPPORTED_PRODUCT_IDS: ReadonlySet<string> = readLocalSupportedSet(
  readFileSync(join(here, "../../../../packages/sets/local-supported.toml"), "utf8"),
).activeProducts;

/** A page under the app, honouring an external deployment base URL. */
export const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

export function galleryProductForProfile(profileId: string): string {
  const entry = GALLERY_ROSTER.entries.find(
    (candidate) => candidate.profile === profileId,
  );
  if (entry === undefined) {
    throw new Error(
      `no gallery roster entry declares profile ${JSON.stringify(profileId)}`,
    );
  }
  return entry.product;
}

/**
 * The VFS image URL this deployment serves for a gallery product, resolved
 * inside the app so it is the exact string the app itself resolves.
 *
 * Cached per worker: the dev server's asset URLs are stable for a run, and
 * every resolution costs one throwaway page load.
 */
const imageUrlByProduct = new Map<string, Promise<string>>();

export async function vfsImageUrlForProduct(
  page: Page,
  productId: string,
): Promise<string> {
  const key = `${appUrl("/")}\0${productId}`;
  const cached = imageUrlByProduct.get(key);
  if (cached !== undefined) return cached;
  const resolved = resolveVfsImageUrl(page, productId);
  imageUrlByProduct.set(key, resolved);
  // A rejected promise must not be cached: the next spec in this worker
  // would inherit a failure that may have been this page's alone.
  resolved.catch(() => imageUrlByProduct.delete(key));
  return resolved;
}

async function resolveVfsImageUrl(
  page: Page,
  productId: string,
): Promise<string> {
  // Resolve on a throwaway page so the caller's page keeps a clean history:
  // several specs assert first-load behavior (the service worker's one-time
  // takeover reload, for instance) on the page they navigate themselves.
  const probe = await page.context().newPage();
  try {
    await probe.goto(appUrl("/trap-signal-test.html"), {
      waitUntil: "domcontentloaded",
    });
    const result = await probe.evaluate(async (id) => {
      const { vfsProductImageUrl, VfsProductImageNotBuiltError } = await import(
        "/test/fixtures/vfs-product-images.ts"
      );
      try {
        return { url: await vfsProductImageUrl(id), notBuilt: null };
      } catch (error) {
        if (error instanceof VfsProductImageNotBuiltError) {
          return { url: null, notBuilt: (error as Error).message };
        }
        throw error;
      }
    }, productId);
    if (result.url === null) {
      throw new VfsProductImageMissing(result.notBuilt ?? productId);
    }
    return new URL(result.url, probe.url()).href;
  } finally {
    await probe.close();
  }
}

/** This worktree has not materialized the product's image. */
export class VfsProductImageMissing extends Error {}

export interface MachineUrlOptions {
  /** Extra page-level fragment, e.g. a `#k1=` boot link. */
  hash?: string;
  /** Extra query parameters appended after `?vfs=`/`&profile=`. */
  search?: Record<string, string>;
}

/**
 * Build the URL that boots `profileId`: `?vfs=<image>&profile=<id>`, the same
 * pair the gallery's Launch and Copy-link write.
 *
 * Both parts are always written, even for a profile inside the image a bare
 * page load would have picked anyway. Naming the image is what makes the URL
 * say which machine it boots without depending on the roster's current first
 * entry, and it is the form every shared link actually has.
 */
export async function machineUrl(
  page: Page,
  profileId: string,
  options: MachineUrlOptions = {},
): Promise<string> {
  const preparedUrls = process.env.KANDELO_TEST_MACHINE_URLS;
  let url: URL;
  if (preparedUrls !== undefined) {
    const prepared: unknown = JSON.parse(readFileSync(preparedUrls, "utf8"));
    if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)
      || !(profileId in prepared) || typeof (prepared as Record<string, unknown>)[profileId] !== "string") {
      throw new Error(`prepared machine URLs lack profile ${profileId}`);
    }
    url = new URL((prepared as Record<string, string>)[profileId]!);
    if (!/^https?:$/.test(url.protocol) || !url.searchParams.get("vfs")
      || url.searchParams.get("profile") !== profileId) {
      throw new Error(`invalid prepared machine URL for ${profileId}`);
    }
  } else {
    const productId = galleryProductForProfile(profileId);
    url = new URL(appUrl("/"), "https://kandelo.invalid/");
    url.searchParams.set("vfs", await vfsImageUrlForProduct(page, productId));
    url.searchParams.set("profile", profileId);
  }
  for (const [key, value] of Object.entries(options.search ?? {})) {
    url.searchParams.set(key, value);
  }
  if (options.hash !== undefined) url.hash = options.hash;
  return process.env.KANDELO_TEST_BASE_URL === undefined && preparedUrls === undefined
    ? `${url.pathname}${url.search}${url.hash}`
    : url.href;
}

/** Navigate to the machine `profileId` names. */
export async function gotoMachine(
  page: Page,
  profileId: string,
  options: MachineUrlOptions = {},
): Promise<void> {
  await page.goto(await machineUrl(page, profileId, options), {
    waitUntil: "domcontentloaded",
  });
}

/**
 * Fail the test when Vite could not build the page. The overlay means a
 * module did not resolve, most often a `@binaries` import of a package output
 * that is not published. That is a build defect the spec must report, not a
 * reason to skip it.
 */
export async function expectNoViteErrorOverlay(page: Page): Promise<void> {
  const overlay = page.locator("vite-error-overlay");
  if ((await overlay.count()) === 0) return;
  const message = await overlay
    .locator(".message-body")
    .first()
    .textContent({ timeout: 1_000 })
    .catch(() => null);
  throw new Error(
    `Vite could not build the page: ${message?.trim() || "see its error overlay"}\n` +
      "If a binary is missing, the supported build did not publish it; run ./run.sh local-build.",
  );
}

/** Navigate to an app path and fail if Vite could not build it. */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  await expectNoViteErrorOverlay(page);
}

/**
 * `gotoMachine`, but check that this worktree can serve the machine first.
 *
 * A machine whose product packages/sets/local-supported.toml declares is
 * something `./run.sh setup` builds, so a missing image fails the test with
 * the reason. Only a product outside that set is optional content here, and
 * only then is the test skipped. A Vite build error always fails.
 */
export async function gotoMachineOrSkip(
  page: Page,
  profileId: string,
  options: MachineUrlOptions = {},
): Promise<void> {
  let target: string;
  try {
    target = await machineUrl(page, profileId, options);
  } catch (error) {
    if (error instanceof VfsProductImageMissing) {
      const productId = galleryProductForProfile(profileId);
      if (SUPPORTED_PRODUCT_IDS.has(productId)) {
        throw new Error(
          `${profileId}: the supported build produces ${productId}, but its image ` +
            `is missing: ${error.message}\nRun ./run.sh local-build.`,
        );
      }
      test.skip(true, `${profileId}: optional product ${productId} is not built: ${error.message}`);
      return;
    }
    throw error;
  }
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  await expectNoViteErrorOverlay(page);
}

/**
 * Locator for a machine's web-preview iframe.
 *
 * The pane title is the machine's own `identity.title` from its image's
 * `/etc/kandelo/demo.json`, so it names the machine rather than the transport
 * that happens to serve it.
 */
export function previewFrameSelector(title: string): string {
  return `iframe[title="${title}"]`;
}

export function previewFrame(page: Page, title: string): FrameLocator {
  return page.frameLocator(previewFrameSelector(title));
}

/**
 * The URL path prefix this machine's web preview is served under, read from
 * the iframe the app rendered.
 *
 * WHY THIS IS READ, NOT WRITTEN AS A CONSTANT: the service worker MINTS the
 * prefix per machine — `appPrefixForName()` in `public/service-worker.js`
 * returns `<scope>computer/<name>/` — so no literal is correct for more than
 * one machine. A literal is exactly what went stale when per-machine routing
 * moved the preview off the old shared `/app/` prefix and left six specs
 * waiting on an iframe that would never appear.
 *
 * Always ends in `/`, so `${prefix}wp-login.php` is a complete app path.
 */
export async function machineAppPrefix(
  page: Page,
  title: string,
  timeout = 180_000,
): Promise<string> {
  const iframe = await page.waitForSelector(previewFrameSelector(title), {
    timeout,
  });
  const src = await iframe.getAttribute("src");
  if (src === null || src === "" || src === "about:blank") {
    throw new Error(`web preview for ${title} has no src yet: ${src}`);
  }
  const { pathname } = new URL(src, page.url());
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

/** Navigate inside a machine's web preview to one of its own app paths. */
export async function gotoInPreview(
  frame: FrameLocator,
  appPrefix: string,
  path: string,
): Promise<void> {
  const ownerLocator = frame.owner();
  const owner = await ownerLocator.elementHandle();
  if (owner === null) throw new Error("web preview iframe is unavailable");
  try {
    const destination = new URL(`${appPrefix}${path}`, ownerLocator.page().url());
    const content = await owner.contentFrame();
    if (content === null) throw new Error("web preview content frame is unavailable");
    await content.goto(destination.href, { waitUntil: "commit" });
  } finally {
    await owner.dispose();
  }
}
