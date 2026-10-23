import { expect, test } from "@playwright/test";

for (const end of [null, "Unmount pane", "Stop machine"]) {
  test(`queued dock dispatch ${end ? `cancels on ${end.toLowerCase()}` : "writes when ready"}`, async ({ page }) => {
    await page.goto("/test/fixtures/dock-action-dispatch.html");
    await page.getByTestId("fixture-dock-action-restart").click();
    await expect(page.getByTestId("result")).toHaveText("queued");
    if (end) await page.getByRole("button", { name: end, exact: true }).click();
    await page.getByRole("button", { name: "Finish old command", exact: true }).click();
    await expect(page.getByTestId("result")).toHaveText(end ? "cancelled" : "written");
    await expect(page.getByTestId("writes")).toHaveText(end ? "0" : "1");
  });
}
