// The dock's "Download files" dialog lists the machine's filesystem through
// the kernel worker and saves one file to the user's disk. Chromium's
// showSaveFilePicker opens a native dialog Playwright cannot drive, so the
// page loses it and the dialog saves through `<a download>`, as Firefox and
// WebKit do.

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { assertTerminalCommandResult, runTerminalCommand } from "./support/terminal-command";

test("the dock downloads a file from the machine's filesystem", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });
  await gotoMachineOrSkip(page, "shell");
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  assertTerminalCommandResult(await runTerminalCommand(page, [
    "printf 'from the machine' > \"$HOME/notes.txt\"",
    "mkdir \"$HOME/foo\"",
    "ln -s /nowhere \"$HOME/bar\"",
    "ln -s /dev/null \"$HOME/baz\"",
  ].join(" && ")));

  await page.getByTestId("machine-download-files").click();
  const dialog = page.getByTestId("machine-download-dialog");
  const entry = (name: string) => dialog.locator(`[data-testid="machine-download-entry"][data-name="${name}"]`);

  // It opens in the home of the account exchange.conf names.
  await expect(dialog.getByRole("button", { name: "maker", exact: true })).toHaveAttribute("aria-current", "location");
  await expect(dialog.getByTestId("machine-download-save")).toBeDisabled();

  // A link is followed to what it names.
  await entry("bar").click();
  await expect(dialog.getByRole("alert")).toHaveText("bar points to nothing");
  await entry("baz").click();
  await expect(dialog.getByRole("alert")).toHaveText("baz does not point to a regular file");
  await expect(dialog.getByTestId("machine-download-save")).toBeDisabled();

  await entry("foo").click();
  await expect(dialog.getByText("Empty directory.")).toBeVisible();
  await dialog.getByRole("button", { name: "Parent directory" }).click();
  await expect(dialog.getByRole("button", { name: "maker", exact: true })).toHaveAttribute("aria-current", "location");

  // A double click downloads a file at once.
  const [quick] = await Promise.all([
    page.waitForEvent("download"),
    entry("notes.txt").dblclick(),
  ]);
  expect(readFileSync(await quick.path(), "utf8")).toBe("from the machine");
  await expect(dialog).toBeHidden();
  await page.getByTestId("machine-download-files").click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByTestId("machine-download-files").click();

  // Only a regular file can be selected.
  await dialog.getByRole("button", { name: "/", exact: true }).click();
  await entry("dev").click();
  await entry("null").click();
  await expect(dialog.getByRole("alert")).toHaveText("null is not a regular file");
  await expect(dialog.getByTestId("machine-download-save")).toBeDisabled();

  // A link to a directory opens like a directory.
  await dialog.getByRole("button", { name: "/", exact: true }).click();
  await entry("proc").click();
  await entry("self").click();
  await expect(dialog.getByRole("button", { name: "self", exact: true })).toHaveAttribute("aria-current", "location");

  await dialog.getByRole("button", { name: "/", exact: true }).click();
  await entry("home").click();
  await entry("maker").click();
  await entry("notes.txt").click();
  await expect(entry("notes.txt")).toHaveAttribute("aria-pressed", "true");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByTestId("machine-download-save").click(),
  ]);
  expect(download.suggestedFilename()).toBe("notes.txt");
  expect(readFileSync(await download.path(), "utf8")).toBe("from the machine");
  await expect(dialog).toBeHidden();
});
