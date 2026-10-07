import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { gotoMachine } from "./support/kandelo-machine";

const games = [
  ["pong", "Pong"], ["snake", "Snake"], ["breakout", "Breakout"],
  ["asteroids", "Asteroids"], ["bytepath", "BYTEPATH"], ["snkrx", "SNKRX"],
] as const;

async function showDemo(page: Page) {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await expect(internals).toBeVisible({ timeout: 60_000 });
  if (await internals.getAttribute("aria-pressed") === "true") await internals.click();
  await page.getByLabel("Computer views").getByRole("button", { name: "Demo", exact: true }).click();
}

async function flips(page: Page): Promise<number> {
  const text = await page.locator("body").innerText();
  return Number(text.match(/(\d+)\s*flips\s*·/i)?.[1] ?? -1);
}

async function terminalText(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const rows = page.locator(".xterm-rows");
  await expect.poll(async () => (await rows.allTextContents()).join("\n"))
    .toContain("love: using upstream");
  return (await rows.allTextContents()).join("\n");
}

test("LÖVE menu launches all six games through the native renderer @slow", async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || /\[webgl\].*failed|GL_INVALID_|GL_OUT_OF_MEMORY|WebGL: INVALID_/.test(message.text())) {
      errors.push(message.text());
    }
  });
  await gotoMachine(page, "love");
  await showDemo(page);
  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText(/Waiting for PAGE_FLIP on CRTC/)).toBeHidden({ timeout: 180_000 });

  const menuButton = page.getByTestId("kms-dock-action-games");
  await menuButton.click();
  const menu = page.getByTestId("kms-dock-menu-games");
  await expect(menu.getByRole("menuitem")).toHaveCount(games.length);
  for (const [id, label] of games) {
    await expect(page.getByTestId(`kms-dock-menu-entry-${id}`)).toContainText(label);
  }
  await page.keyboard.press("Escape");

  const screenshotDir = resolve("../../.context/love-browser");
  mkdirSync(screenshotDir, { recursive: true });
  // Return to Pong too, proving the last custom loop releases the display.
  for (const [index, [id]] of [...games, games[0]].entries()) {
    if (index > 0) {
      await menuButton.click();
      await page.getByTestId(`kms-dock-menu-entry-${id}`).click();
      await expect(menuButton).toBeDisabled();
      await expect(menuButton).toBeEnabled({ timeout: 180_000 });
      await expect(page.getByTestId("kms-dock-action-status")).toBeHidden({ timeout: 180_000 });
      if (await page.getByTestId("kms-dock-action-error").count()) {
        const error = await page.getByTestId("kms-dock-action-error").innerText();
        throw new Error(`${id}: ${error}\n${await terminalText(page)}`);
      }
      await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);
    }
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => flips(page), { timeout: 120_000 }).toBeGreaterThan(0);
    // Sustained flips prove the guest is running its loop after startup.
    const before = await flips(page);
    await expect.poll(() => flips(page), { timeout: 30_000 }).toBeGreaterThan(before + 5);
    if (id === "bytepath") {
      // Exercise the full upstream intro, including delayed text-glitch
      // callbacks, rather than stopping at its first visible frame.
      await expect.poll(() => flips(page), { timeout: 120_000 })
        .toBeGreaterThan(before + 2_000);
    }
    // BYTEPATH's upstream introduction starts dark. Require visible rendering,
    // as well as flips, before capturing the selected game's surface.
    await expect.poll(async () => (await canvas.screenshot()).byteLength, {
      timeout: 120_000, intervals: [1_000, 2_000, 5_000],
    }).toBeGreaterThan(5_000);
    await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);
    await canvas.screenshot({ path: resolve(screenshotDir, `${id}.png`) });
    // Mount the terminal view so guest stderr is available for inspection.
    const terminal = await terminalText(page);
    expect(terminal, id).toContain(`/usr/share/love/examples/${id}`);
    expect(terminal, id).not.toMatch(/lovefb:.*(?:error|main\.lua:)|configured command failed/);
    await showDemo(page);
  }
  expect(errors).toEqual([]);
});
