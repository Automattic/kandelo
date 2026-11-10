import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "../playwright-test";
import { test } from "./support/persistent-page";
import { runTerminalCommand } from "./support/terminal-command";

// The worktree's partial image (`./run.sh partial <image> <pkg>...`), served by
// the dev server as its own gallery machine (vite/dev-partial-image.ts). These
// tests run against whatever partial image this worktree built, and skip when
// there is none.
const manifestPath = resolve(import.meta.dirname, "../../../local-binaries/partial/partial.json");
const manifest: { image: string; sha256: string; packages: string[]; activities: string[] } | null =
  existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;

test.skip(manifest === null, "no partial image is built in this worktree");
test.use({ actionTimeout: 30_000 });

const PARTIAL_URL = "/@kandelo-partial/image.vfs.zst";

async function ready(page: Page) {
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toMatch(/maker@[^:\s]+:[^\r\n]*\$ ?/);
}

async function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
}

test("the partial image is served uncached at one URL", async ({ page }) => {
  const response = await page.request.get(PARTIAL_URL);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-kandelo-partial-image-sha256"]).toBe(manifest!.sha256);
});

test("the partial image boots as its own machine with only its activities", async ({ page }) => {
  // A derived partial image (LAMP, WordPress, ...) boots its own services
  // rather than the maker login this test drives.
  test.skip(manifest?.image !== "shell", "drives the partial shell's login terminal");
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?vfs=${encodeURIComponent(PARTIAL_URL)}&profile=shell`);
  await ready(page);

  // The named packages' programs run from the image; an unselected one is absent.
  for (const [pkg, command, expected] of [
    ["tmux", "tmux -V", /tmux \d/],
    ["less", "less --version | head -n 1", /less \d+/],
    ["dosbox-pure", "dosbox-pure --info", /CPU: x86 interpreter/],
  ] as const) {
    if (!manifest!.packages.includes(pkg)) continue;
    expect((await runTerminalCommand(page, command)).output).toMatch(expected);
  }
  // This suite accepts any selected package set. Presence must follow the
  // manifest; assuming ffmpeg is absent rejects valid graphics partials.
  const ffmpeg = (await runTerminalCommand(page, "command -v ffmpeg || echo NO_FFMPEG")).output;
  if (manifest!.packages.includes("ffmpeg")) expect(ffmpeg).toMatch(/\/usr\/bin\/ffmpeg/);
  else expect(ffmpeg).toContain("NO_FFMPEG");

  // The activity list is the image's own: exactly the activities it kept.
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  for (const activity of manifest!.activities.filter((id) => id !== "shell")) {
    await expect(panel.locator(`[data-image-activity="${activity}"]`)).toBeVisible();
  }
  for (const absent of ["quake", "scummvm", "freeciv", "ffplay"]) {
    if (!manifest!.activities.includes(absent)) {
      await expect(panel.locator(`[data-image-activity="${absent}"]`)).toHaveCount(0);
    }
  }

  await page.screenshot({ path: test.info().outputPath("partial-image-activities.png") });

  // Nothing the partial route served went into Cache Storage.
  expect((await cachedUrls(page)).filter((url) => url.includes("@kandelo-partial"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("the gallery lists the partial image first, by what it carries", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto(`/?vfs=${encodeURIComponent(PARTIAL_URL)}`);
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 300_000 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "+ New computer", exact: true }).click();
  const named = manifest!.packages.length === 0 ? "the base only" : manifest!.packages.join(", ");
  await expect(page.getByText(`Partial ${manifest!.image} + ${named}`).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("partial-image-gallery.png") });
});
