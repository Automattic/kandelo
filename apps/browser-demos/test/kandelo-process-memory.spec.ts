import { expect } from "../playwright-test";
import { test } from "./support/persistent-page";
import { gotoMachine, waitForMachineBootInput } from "./support/kandelo-machine";
import { setInternalsOpen } from "./support/dock";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test("Internals reports ordinary process backing separately from virtual size", async ({ page }) => {
  test.setTimeout(180_000);
  await installBrowserMemoryBoundaryProbe(page);
  await gotoMachine(page, "shell");
  await waitForMachineBootInput(page);
  await setInternalsOpen(page, true);
  await page.getByRole("tab", { name: "Procs", exact: true }).click();
  const table = page.getByRole("table", { name: "Processes", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText([
    "PID", "PPID", "USER", "ATTRIBUTED", "PRIVATE", "SHARED", "VIRTUAL", "COMMAND",
  ]);
  await expect(page.getByText("Guest backing, not resident RAM.", { exact: false })).toBeVisible();
  const rows = await table.locator("tbody > tr").evaluateAll(rows => rows.map(row =>
    Array.from(row.querySelectorAll("td"), cell => cell.textContent ?? "")));
  let measured = 0;
  for (const cells of rows) {
    if (cells[3] === "—") continue; // Synthetic init has no process memory.
    measured++;
    expect(cells[3]).toBe(cells[4]);
    expect(cells[5]).toBe("0 B");
    expect(cells[6]).toBe(cells[3]);
  }
  expect(measured).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(table).toBeVisible();
  await page.getByText(/^Unique mapped:/).click();
  await expect(page.locator(".kprocess-group").filter({ hasText: "shared group" })).toHaveCount(0);
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});
