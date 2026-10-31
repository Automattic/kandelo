import { expect, test } from "@playwright/test";
import { expectRunningMachineAudio } from "./support/machine-audio";

test("audio activation observes running after its enable control disappears", async ({ page }) => {
  await page.setContent('<main data-audio-state="suspended"><button class="kpcm-audio-enable">Enable</button></main>');
  await page.evaluate(() => {
    document.addEventListener("keydown", event => {
      if (!event.isTrusted) return;
      document.querySelector("main")!.setAttribute("data-audio-state", "running");
      document.querySelector("button")!.remove();
    }, { capture: true });
    document.addEventListener("pointerdown", event => {
      if (!event.isTrusted) return;
      document.querySelector("main")!.setAttribute("data-audio-state", "running");
      document.querySelector("button")!.remove();
    }, { capture: true });
  });
  await expectRunningMachineAudio(page);
  await expect(page.locator("button")).toHaveCount(0);
});

test("audio activation does not accept a sink that remains suspended", async ({ page }) => {
  await page.setContent('<main data-audio-state="suspended"></main>');
  await expect(expectRunningMachineAudio(page, 100)).rejects.toThrow('suspended');
});
