import { expect } from "@playwright/test";
import { test } from "./support/persistent-page";
import { machineUrl } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { currentComputerMetadata } from "./support/computer-library";

test("group web servers reuse their network and replace only the conflicting port while preserving the shell and disk", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto(await machineUrl(page, "shell"));
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  const original = await currentComputerMetadata(page);
  await runTerminalCommand(page, "printf 'activity-endpoint\\n' > /home/projects/index.html; printf '%s\\n' \"$PPID\" > /home/projects/server-shell-pid; printf '%s%s\\n' SERVER_FILE_ READY", "SERVER_FILE_READY");
  const panel = page.getByRole("region", { name: "Installed activities" });
  let room: string | null = null;
  for (const key of ["php/server", "python-browser-bundle/server"]) {
    await page.getByRole("button", { name: "Activities", exact: true }).click();
    await panel.getByRole("button", { name: "Group activities", exact: true }).click();
    await panel.locator(`[data-local-activity="${key}"]`).getByRole("button", { name: "Start", exact: true }).click();
    await panel.getByLabel("Directory to serve", { exact: true }).fill("/home/projects");
    await panel.getByRole("button", { name: "Start activity", exact: true }).click();
    await expect(panel).not.toBeVisible({ timeout: 120_000 });
    const session = page.getByRole("dialog", { name: "Active session", exact: true });
    await expect(session).toBeVisible({ timeout: 60_000 });
    const link = await session.locator("[data-network-link]").getAttribute("data-network-link");
    const nextRoom = new URL(link!).searchParams.get("network");
    expect(nextRoom).toBeTruthy();
    if (room !== null) expect(nextRoom).toBe(room);
    room = nextRoom;
    await session.locator(".kshare-x").click();
    await page.getByRole("tab", { name: "TTY1", exact: true }).click();
    await expect.poll(async () => {
      const result = await runTerminalCommand(page, "curl --fail --silent http://127.0.0.1:8080/; true");
      return result.output;
    }, { timeout: 120_000 }).toContain("activity-endpoint");
  }
  await runTerminalCommand(page, "test \"$(ps -A | grep -c '[p]hp')\" -eq 0 && ps -A | grep '[p]ython' >/dev/null && kill -0 \"$(cat /home/projects/server-shell-pid)\" && printf '%s%s\\n' PORT_REPLACEMENT_ OK", "PORT_REPLACEMENT_OK");
  expect(await currentComputerMetadata(page)).toMatchObject(original);
});
