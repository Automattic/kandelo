import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

// A shell machine runs no program that opens /dev/dsp. The kernel's shared
// PCM control header therefore still reads generation === 0 and
// state === CLOSED, and the app must not warn the user about a device
// nothing in the machine ever asked for.
test("Kandelo shell machine never warns about audio", async ({ page }) => {
  test.setTimeout(180_000);

  await gotoMachineOrSkip(page, "shell");

  // Wait for the machine itself, not for audio: the app root carries the
  // real audio state, so its presence means the shell is mounted.
  await expect(page.locator("[data-audio-state]")).toHaveCount(1, {
    timeout: 120_000,
  });

  // Before any interaction is where the bug lived. Browser autoplay policy
  // holds the sink at "suspended" until a gesture, which is honest — and
  // which the app used to report as a problem on a machine with no audio.
  await page.waitForTimeout(5_000);
  await expect(page.locator("[data-audio-state]")).not.toHaveAttribute(
    "data-audio-state",
    "running",
  );
  await expect(page.locator("[data-audio-active]")).toHaveAttribute(
    "data-audio-active",
    "false",
  );
  await expect(page.locator(".kpcm-audio-status")).toHaveCount(0);

  // And it must stay silent once the user does interact, whether or not the
  // browser grants audio: still no guest has asked for a sink.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(3_000);
  await expect(page.locator("[data-audio-active]")).toHaveAttribute(
    "data-audio-active",
    "false",
  );
  await expect(page.locator(".kpcm-audio-status")).toHaveCount(0);
});
