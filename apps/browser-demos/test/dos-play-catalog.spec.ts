// Network acceptance: exercise the shipped launcher/catalog from the normal
// shell image. Deterministic download/integrity/cache checks live in the
// package's Node tests; this test intentionally uses the real upstream URLs.
import { expect } from "../playwright-test";
import { test } from "./support/persistent-page";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { quitDosAndCheck } from "./support/dos-exit";

test("dos-play fetches the three freely licensed DOS demos @slow", async ({ page }) => {
  test.setTimeout(600_000);
  const terminal = page.locator(".kshell-terminal-slot:not([hidden]) .xterm-rows").first();
  const terminalText = () => terminal.textContent().then(value => value ?? "");
  const prompt = /maker@[^:\s]+:[^\r\n]*\$\s*$/;
  await gotoMachineOrSkip(page, "shell");
  await expect(terminal).toBeVisible({ timeout: 180_000 });
  await expect.poll(terminalText, { timeout: 180_000 }).toMatch(prompt);
  const screenshots = join(findRepoRoot(), ".scratch/dos-play");
  mkdirSync(screenshots, { recursive: true });
  for (const id of ["dosdefender", "vitetris", "anarch"]) {
    await page.locator(".kshell-terminal-slot:not([hidden]) .xterm-screen").first().click();
    await page.keyboard.insertText(`dos-play ${id}`);
    await page.keyboard.press("Enter");
    const canvas = page.locator("canvas.kframebuffer-canvas").first();
    try {
      await expect(canvas).toBeVisible({ timeout: 180_000 });
      await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
        const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
        const colors = new Set<number>();
        for (let i = 0; i < pixels.length; i += 4)
          colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
        return colors.size;
      }), { timeout: 60_000 }).toBeGreaterThan(4);
      await canvas.focus();
      await page.keyboard.press("Enter", { delay: 100 });
      // Preserve the actual game's initial screen for visual inspection.
      await page.screenshot({ path: join(screenshots, `${id}-${test.info().project.name}.png`) });
      await quitDosAndCheck(page, `DOS_${id}`);
    } catch (error) {
      await test.info().attach(`${id}-terminal`, { body: await terminalText(), contentType: "text/plain" });
      throw error;
    }
  }
});
