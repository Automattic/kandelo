import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/test/fixtures/display-handoff.html");
  await expect(page.getByTestId("view")).toHaveText("demo");
});

test("dock replacement retains the stage across owner release and ends at its first frame", async ({ page }) => {
  const action = page.getByTestId("fixture-dock-action-replace");
  await action.click();
  // Hold the stop promise after ownership is gone, before starting is emitted.
  await expect(action).toHaveText("stopping…");
  await expect(page.getByTestId("available")).toHaveText("true");
  await expect(page.getByTestId("view")).toHaveText("demo");
  await page.getByRole("button", { name: "Finish stopping", exact: true }).click();
  await expect(page.getByTestId("fixture-dock-action-status")).toHaveText("Preparing display");
  await expect(action).toHaveText("Replace display");
  await expect(action).toBeDisabled();
  await page.getByRole("button", { name: "Replacement frame", exact: true }).click();
  await expect(page.getByTestId("fixture-dock-action-progress")).toHaveCount(0);
  await expect(action).toBeEnabled();
  await page.getByRole("button", { name: "Ordinary quit", exact: true }).click();
  await expect(page.getByTestId("view")).toHaveText("terminal");
  await expect(page.getByTestId("available")).toHaveText("false");
});

test("the user can inspect the terminal during a replacement", async ({ page }) => {
  await page.getByTestId("fixture-dock-action-replace").click();
  await page.getByRole("button", { name: "Finish stopping", exact: true }).click();
  await expect(page.getByTestId("fixture-dock-action-status")).toHaveText("Preparing display");
  await page.getByRole("button", { name: "Select terminal", exact: true }).click();
  await expect(page.getByTestId("view")).toHaveText("terminal");
  await expect(page.getByTestId("available")).toHaveText("true");
  await page.getByRole("button", { name: "Select demo", exact: true }).click();
  await expect(page.getByTestId("fixture-dock-action-status")).toHaveText("Preparing display");
});

for (const end of ["Return prompt", "Fail dispatch", "Unmount actions", "Stop machine"]) {
  test(`replacement releases the stage on ${end.toLowerCase()}`, async ({ page }) => {
    if (end === "Fail dispatch") await page.getByRole("button", { name: end, exact: true }).click();
    await page.getByTestId("fixture-dock-action-replace").click();
    await expect(page.getByTestId("fixture-dock-action-replace")).toHaveText("stopping…");
    await page.getByRole("button", { name: "Finish stopping", exact: true }).click();
    if (end !== "Fail dispatch") {
      await expect(page.getByTestId("fixture-dock-action-status")).toHaveText("Preparing display");
      await page.getByRole("button", { name: end, exact: true }).click();
    }
    await expect(page.getByTestId("available")).toHaveText("false");
    await expect(page.getByTestId("view")).toHaveText("terminal");
    if (end === "Stop machine") {
      await page.getByRole("button", { name: "Resume machine", exact: true }).click();
      await expect(page.getByTestId("available")).toHaveText("false");
      await expect(page.getByTestId("view")).toHaveText("terminal");
    }
  });
}
