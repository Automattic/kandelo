import type { Page } from "../playwright-test";
import { gotoMachine } from "./support/kandelo-machine";
import { test } from "./support/persistent-page";

const AUDIO_ACTIVE_SIGNAL = "kandelo-test-audio-active";
const AUDIO_RUNNING_SIGNAL = "kandelo-test-audio-running";

function audioSignal(page: Page, signal: string, timeout: number): Promise<unknown> {
  return page.waitForEvent("console", { predicate: message => message.text() === signal, timeout });
}

/**
 * Report audio transitions from inside the page. Polling the page from
 * Playwright must wait until the outcome: evaluating in a document can grant
 * it user activation, which real users do not get, and polling hid the
 * defect this test guards against.
 */
async function bootDoomWithoutActivation(page: Page): Promise<void> {
  await page.addInitScript(([active, running]) => {
    const pending = new Map([['[data-audio-active="true"]', active], ['[data-audio-state="running"]', running]]);
    new MutationObserver(() => {
      for (const [selector, signal] of pending) {
        if (!document.querySelector(selector)) continue;
        pending.delete(selector);
        console.debug(signal);
      }
    }).observe(document, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-audio-active", "data-audio-state"],
    });
  }, [AUDIO_ACTIVE_SIGNAL, AUDIO_RUNNING_SIGNAL]);
  const active = audioSignal(page, AUDIO_ACTIVE_SIGNAL, 240_000);
  // Not gotoMachineOrSkip: its error-overlay check queries the page.
  await gotoMachine(page, "doom");
  await active;
}

test("Enable starts audio after a key that is not user activation", async ({ page }) => {
  test.setTimeout(300_000);
  await bootDoomWithoutActivation(page);
  const running = audioSignal(page, AUDIO_RUNNING_SIGNAL, 6_000);
  // Shift activates the page on WebKit, which removes Enable before the click.
  await page.keyboard.press("Shift");
  await page.waitForTimeout(1_500);
  await page.locator(".kpcm-audio-enable").click({ timeout: 2_000 }).catch(() => {});
  await running;
});
