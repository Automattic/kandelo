import { expect, type FrameLocator } from "@playwright/test";
import { gotoInPreview } from "./kandelo-machine";

export async function loginToWordPress(frame: FrameLocator, appPrefix: string): Promise<void> {
  await gotoInPreview(frame, appPrefix, "wp-login.php");
  await expect(frame.locator("#loginform")).toBeVisible({ timeout: 120_000 });
  await expect(async () => {
    await frame.locator("#user_login").fill("admin");
    await frame.locator("#user_pass").fill("password");
    expect(await frame.locator("#user_login").inputValue()).toBe("admin");
    expect(await frame.locator("#user_pass").inputValue()).toBe("password");
  }).toPass({ timeout: 10_000 });
  await frame.locator("#user_pass").press("Enter");
  await expect(frame.locator("#adminmenu")).toBeVisible({ timeout: 180_000 });
}
