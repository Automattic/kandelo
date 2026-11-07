import { expect, type Page } from "../../playwright-test";

/**
 * Activate audio the way a user does. A bare modifier key is not user
 * activation in Chromium or Firefox, so when Shift leaves the context
 * suspended the toast's Enable button is the gesture that counts.
 */
export async function expectRunningMachineAudio(page: Page, timeout = 30_000): Promise<void> {
  await page.keyboard.press("Shift");
  const state = page.locator("[data-audio-state]");
  if (await state.getAttribute("data-audio-state") !== "running") {
    // The button disappears as soon as audio runs, so losing that race is fine.
    await page.locator(".kpcm-audio-enable").click({ timeout: 2_000 }).catch(() => {});
  }
  await expect(state).toHaveAttribute("data-audio-state", "running", { timeout });
}
