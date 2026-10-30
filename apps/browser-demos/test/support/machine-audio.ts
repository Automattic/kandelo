import { expect, type Page } from "@playwright/test";

export async function expectRunningMachineAudio(page: Page, timeout = 30_000): Promise<void> {
  await page.keyboard.press("Shift");
  await expect(page.locator("[data-audio-state]")).toHaveAttribute("data-audio-state", "running", { timeout });
}
