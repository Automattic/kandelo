import { expect, test, type Locator, type Page } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { QUAKE_ZIP_URL } from "../../web-libs/kandelo-session/src/demo-guides";

// The quake demo fetches id's original shareware archive (quake106.zip, ~9 MB)
// at load, then the machine extracts id1/pak0.pak from it in-place with real
// tools before the software renderer paints anything. If the archive mirror is
// unreachable (offline CI), the demo genuinely cannot run, so skip rather than
// fail — the same policy the doom demo uses for its WAD.
let archiveReachable = false;

test.beforeAll(async () => {
  try {
    const res = await fetch(QUAKE_ZIP_URL, { method: "HEAD" });
    archiveReachable = res.ok;
  } catch {
    archiveReachable = false;
  }
});

/** Count distinct RGB colors in the framebuffer canvas (a blank/1-color frame
 *  returns 1). The framebuffer pane is a same-thread 2d canvas, so getImageData
 *  is reliable here (unlike the OffscreenCanvas KMS pane). */
function distinctColors(canvas: Locator): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (seen.size > 8) break;
    }
    return seen.size;
  });
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

test("Kandelo quake software demo boots the shareware first scene", async ({
  page,
}) => {
  test.setTimeout(300_000);
  test.skip(
    !archiveReachable,
    "quake106.zip mirror unreachable (offline) — demo can't run",
  );

  await gotoMachineOrSkip(page, "quake");

  // The launch wrapper is what the machine runs; it extracts the pak, then
  // execs the engine. Confirm the machine launched the demo command.
  await expect
    .poll(() => syslogText(page), { timeout: 120_000 })
    .toMatch(/running \/usr\/local\/bin\/quake/);

  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });

  // Satisfy the browser audio-autoplay gesture and give the framebuffer focus.
  await canvas.click();

  // The real proof: after fetch (~9 MB) + in-machine extraction + engine load,
  // the software renderer paints a colored scene (id logo / menu / level).
  // A blank or single-color canvas means nothing rendered.
  await expect
    .poll(() => distinctColors(canvas), {
      timeout: 240_000,
      intervals: [2_000, 3_000, 5_000],
    })
    .toBeGreaterThan(8);

  // Drive a key through the framebuffer keyboard path and confirm the engine
  // keeps rendering (input reaches the game; no crash). ESC toggles the menu.
  await page.keyboard.press("Escape");
  await expect
    .poll(() => distinctColors(canvas), { timeout: 30_000 })
    .toBeGreaterThan(8);

  // The machine must not have reported a failed launch.
  expect(await syslogText(page)).not.toMatch(/quake.*failed/i);
});
