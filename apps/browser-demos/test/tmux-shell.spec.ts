import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contrast } from "./theme-contrast";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("the browser shell runs tmux panes and preserves a detached session", async ({ page, browserName }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  // Exercise the public shell entry point without relying on test-only
  // product lookup modules in a regular ./run.sh browser server.
  await page.goto("/pages/kandelo/?profile=shell");
  const rows = page.locator(".xterm-rows:visible");
  const screen = () => rows.textContent();
  const input = page.locator(".xterm-helper-textarea:visible");
  const command = async (text: string) => {
    await input.focus();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  const prefix = async (key: string) => {
    await input.focus();
    await page.keyboard.press("Control+b");
    await page.keyboard.type(key);
  };

  await expect.poll(screen, { timeout: 120_000 }).toMatch(/kandelo\$/);
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-k-theme", "kandelo");
  await expect(page.locator("html")).toHaveAttribute("data-k-mode", "dark");
  await command("tmux new-session -s trial");
  await expect.poll(screen, { timeout: 30_000 }).toContain("[trial]");
  await rows.locator("span").filter({ hasText: "[trial]" }).first().evaluate(node => {
    node.setAttribute("data-contrast", "tmux status text");
  });
  const statusContrast = (await contrast(page)).find(item => item.name === "tmux status text");
  expect(statusContrast?.ratio, "tmux status text in the dark terminal").toBeGreaterThanOrEqual(4.5);
  await command("printf 'TMUX_%s\\n' 'PANE_ONE'");
  await expect.poll(screen, { timeout: 20_000 }).toContain("TMUX_PANE_ONE");
  await prefix("%");
  await command("printf 'TMUX_%s\\n' 'PANE_TWO'");
  await expect.poll(screen, { timeout: 20_000 }).toContain("TMUX_PANE_TWO");
  await expect.poll(screen).toContain("TMUX_PANE_ONE");

  await prefix("c");
  await command("printf 'TMUX_%s\\n' 'WINDOW_TWO'");
  await expect.poll(screen, { timeout: 20_000 }).toContain("TMUX_WINDOW_TWO");
  await prefix("0");
  await expect.poll(screen, { timeout: 20_000 }).toContain("TMUX_PANE_ONE");
  await expect.poll(screen).toContain("TMUX_PANE_TWO");

  await prefix("d");
  await expect.poll(screen, { timeout: 10_000 }).toContain("[detached (from session trial)]");
  await expect.poll(screen, { timeout: 10_000 }).toMatch(/kandelo\$/);
  await command("tmux attach-session -t trial");
  await expect.poll(screen, { timeout: 20_000 }).toContain("TMUX_PANE_ONE");
  await expect.poll(screen).toContain("TMUX_PANE_TWO");

  const windowSize = async (label: string) => {
    await command(`printf 'TMUX_%s ' '${label}'; tmux display-message -p '#{window_width}x#{window_height}'`);
    const size = new RegExp(`TMUX_${label} (\\d+)x(\\d+)`);
    await expect.poll(screen).toMatch(size);
    return (await screen())!.match(size)!.slice(1).map(Number);
  };
  const before = await windowSize("SIZE_BEFORE");
  await page.setViewportSize({ width: 1120, height: 760 });
  let sample = 0;
  await expect.poll(async () => {
    const after = await windowSize(`SIZE_AFTER_${++sample}`);
    return after[0] < before[0] && after[1] < before[1];
  }, { timeout: 20_000 }).toBe(true);
  await command("printf 'TMUX_%s\\n' 'REATTACHED'");
  await expect.poll(screen, { timeout: 20_000 }).toContain("TMUX_REATTACHED");
  await page.screenshot({ path: resolve(root, `.context/tmux-${browserName}.png`), fullPage: true });

  await command("tmux kill-server");
  await expect.poll(screen, { timeout: 10_000 }).toContain("[server exited]");
  await expect.poll(screen, { timeout: 10_000 }).toMatch(/kandelo\$/);
  expect(errors).toEqual([]);
});
