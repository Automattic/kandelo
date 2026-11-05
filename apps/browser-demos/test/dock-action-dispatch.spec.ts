import { expect, test } from "@playwright/test";

// A queued restart is written to the machine it was asked of. The pane can
// unmount while the command waits (on /dev/fb0 it does, because the restart
// ended the display's owner); that must not drop the command. A machine
// that stopped, or was booted again in the meantime, must not receive it.
const cases = [
  { end: null, title: "writes when ready", result: "written" },
  { end: "Unmount pane", title: "still writes after the pane unmounts", result: "written" },
  { end: "Stop machine", title: "cancels when the machine stops", result: "cancelled" },
  { end: "Reboot machine", title: "cancels when the machine reboots", result: "cancelled" },
] as const;

for (const { end, title, result } of cases) {
  test(`queued dock dispatch ${title}`, async ({ page }) => {
    await page.goto("/test/fixtures/dock-action-dispatch.html");
    await page.getByTestId("fixture-dock-action-restart").click();
    await expect(page.getByTestId("result")).toHaveText("queued");
    if (end) await page.getByRole("button", { name: end, exact: true }).click();
    await page.getByRole("button", { name: "Finish old command", exact: true }).click();
    await expect(page.getByTestId("result")).toHaveText(result);
    await expect(page.getByTestId("writes")).toHaveText(result === "written" ? "1" : "0");
  });
}
