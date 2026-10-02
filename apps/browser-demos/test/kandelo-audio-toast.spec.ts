import { expect, test, type Page } from "@playwright/test";
import { machineUrl, VfsProductImageMissing } from "./support/kandelo-machine";

// These tests assert what the app shows BEFORE the user has interacted with
// the page, so they must not interact with it themselves — and in Chromium
// every Playwright call into the page does. Each `evaluate`, each poll of a
// locator assertion, and each reply to an `exposeBinding` call runs through
// CDP with `userGesture: true`, which gives the document sticky user
// activation. The machine's AudioContext is created during boot, and one
// created after that activation starts "running" with no click at all, so a
// test that polls the DOM races its own polls against the boot.
//
// So the page is only ever observed one way: an init script reports the
// audio attributes on the console whenever the DOM changes, and the test
// reads those reports. Console messages carry no reply into the page.

interface AudioReport {
  /** `navigator.userActivation.hasBeenActive`: the premise, checked. */
  hasBeenActive: boolean;
  active: string | null;
  state: string | null;
  warningShown: boolean;
}

const REPORT_PREFIX = "kandelo-audio-report ";

async function watchAudio(page: Page): Promise<() => AudioReport | null> {
  let latest: AudioReport | null = null;
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith(REPORT_PREFIX)) {
      latest = JSON.parse(text.slice(REPORT_PREFIX.length)) as AudioReport;
    }
  });
  await page.addInitScript((prefix) => {
    let last = "";
    const report = () => {
      const warning = document.querySelector(".kpcm-audio-status");
      const text = JSON.stringify({
        hasBeenActive: navigator.userActivation?.hasBeenActive ?? false,
        active: document.querySelector("[data-audio-active]")
          ?.getAttribute("data-audio-active") ?? null,
        state: document.querySelector("[data-audio-state]")
          ?.getAttribute("data-audio-state") ?? null,
        warningShown: warning instanceof HTMLElement && warning.checkVisibility(),
      });
      if (text === last) return;
      last = text;
      console.log(prefix + text);
    };
    new MutationObserver(report).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, REPORT_PREFIX);
  return () => latest;
}

/**
 * `gotoMachineOrSkip` without its Vite-overlay check, which queries the page
 * and so would grant it activation.
 */
async function bootWithoutTouching(page: Page, profileId: string): Promise<void> {
  let target: string;
  try {
    target = await machineUrl(page, profileId);
  } catch (error) {
    if (error instanceof VfsProductImageMissing) {
      test.skip(true, `${profileId}: ${error.message}`);
      return;
    }
    throw error;
  }
  await page.goto(target, { waitUntil: "domcontentloaded" });
}

// A shell machine runs no program that opens /dev/dsp. The kernel's shared
// PCM control header therefore still reads generation === 0 and
// state === CLOSED, and the app must not warn the user about a device
// nothing in the machine ever asked for.
test("Kandelo shell machine never warns about audio", async ({ page }) => {
  test.setTimeout(180_000);

  const audio = await watchAudio(page);
  await bootWithoutTouching(page, "shell");

  // Wait for the machine itself, not for audio: the app root carries the
  // real audio state, so its presence means the shell is mounted.
  await expect.poll(() => audio()?.state ?? null, { timeout: 120_000 }).not.toBeNull();

  // Before any interaction is where the bug lived. Browser autoplay policy
  // holds the sink at "suspended" until a gesture, which is honest — and
  // which the app used to report as a problem on a machine with no audio.
  await page.waitForTimeout(5_000);
  expect(audio()).toMatchObject({
    hasBeenActive: false,
    active: "false",
    warningShown: false,
  });
  expect(audio()!.state).not.toBe("running");

  // And it must stay silent once the user does interact, whether or not the
  // browser grants audio: still no guest has asked for a sink.
  await page.mouse.click(5, 5);
  await page.waitForTimeout(3_000);
  expect(audio()).toMatchObject({ active: "false", warningShown: false });
});

// The other direction, and the one that matters more: a machine whose guest
// really does open /dev/dsp must still surface a real audio problem. Without
// a gesture the browser's autoplay policy holds the sink below "running", so
// the warning is the correct thing to show — and it must still appear.
test("Kandelo sdl2 machine still warns when its audio cannot play", async ({ page }) => {
  test.setTimeout(300_000);

  const audio = await watchAudio(page);
  await bootWithoutTouching(page, "sdl2");

  // No click: the image's command starts the SDL2 playground from the boot
  // path, and it opens /dev/dsp for its synth during startup, which is
  // exactly the demand signal under test.
  await expect.poll(() => audio()?.active, { timeout: 240_000 }).toBe("true");
  await expect.poll(() => audio()?.warningShown, { timeout: 10_000 }).toBe(true);
  expect(audio()!.hasBeenActive).toBe(false);
  expect(audio()!.state).not.toBe("running");
});
