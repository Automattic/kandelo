import { expect, test, type Page } from "@playwright/test";
import { appUrl, gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

/**
 * A saved machine keeps its home directory in this browser: the running shell
 * is saved from the dock, the page is reloaded, and the machine is opened
 * again from the landing page with the file it wrote still there. The list
 * renames and deletes, a second tab is refused the workspace a running machine
 * holds, and a deleted machine's workspace is gone from origin storage.
 */

const SAVE_BUTTON = { name: "Save", exact: true } as const;
const MACHINES_BUTTON = { name: "Machines", exact: true } as const;

async function waitForShell(page: Page): Promise<void> {
  await expect(page.locator(".kshell-host .xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
}

async function savedMachineName(page: Page): Promise<string> {
  const button = page.getByRole("button", SAVE_BUTTON);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const name = await page.locator(".ksave-name-input").inputValue();
  await button.click();
  return name;
}

async function workspaceExists(page: Page, name: string): Promise<boolean> {
  return page.evaluate(async (workspace) => {
    const root = await navigator.storage.getDirectory();
    const container = await root.getDirectoryHandle("kandelo-opfs", { create: true });
    try {
      await container.getDirectoryHandle(workspace);
      return true;
    } catch {
      return false;
    }
  }, name);
}

async function savedMachineIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("kandelo.persistent-machines.v1");
    if (raw === null) return [];
    return (JSON.parse(raw) as { machines: Array<{ id: string }> }).machines.map((m) => m.id);
  });
}

test.describe("saved machines", () => {
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName !== "chromium",
      "OPFS sync access handles are Chromium-only here",
    );
  });

  test("a saved shell keeps hello.txt across a reload and reopens from the landing page @slow", async ({
    page,
    context,
  }) => {
    test.setTimeout(600_000);
    await gotoMachine(page, "shell");
    await waitForShell(page);
    await runTerminalCommand(page, "echo world > hello.txt && pwd", "/home/maker");

    // Save: the popup says what it does, the button does it, the dock lights
    // up once the machine runs on its workspace.
    await page.getByRole("button", SAVE_BUTTON).click();
    const popup = page.getByRole("dialog", { name: "Save", exact: true });
    await expect(popup).toContainText("Files under /home/maker vanish");
    await popup.getByRole("button", { name: "Save this machine" }).click();
    await expect(page.locator(".kdock-item.is-saved")).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => new URL(page.url()).search).toBe("");
    await waitForShell(page);
    await runTerminalCommand(page, "cat hello.txt", "world");

    const name = await savedMachineName(page);
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const [id] = await savedMachineIds(page);
    expect(id).toBeDefined();
    expect(await workspaceExists(page, id!)).toBe(true);

    // A second tab is refused the workspace while this one runs the machine.
    const other = await context.newPage();
    await other.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await expect(other.locator(".kempty-saved")).toContainText(name);
    await other.locator(".kmachines-row").filter({ hasText: name })
      .getByRole("button", { name: "Open" }).click();
    await expect(other.locator(".kdock-status-text")).toHaveText("Error", { timeout: 180_000 });
    await other.close();

    // Reload: the landing page lists the machine; opening it brings the file back.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".kempty-saved")).toContainText(name);
    await page.locator(".kmachines-row").filter({ hasText: name })
      .getByRole("button", { name: "Open" }).click();
    await waitForShell(page);
    await runTerminalCommand(page, "cat hello.txt", "world");
    await expect(page.locator(".kdock-item.is-saved")).toBeVisible();

    // Rename from the Machines pane; the new name shows in the Save popup too.
    await page.getByRole("button", MACHINES_BUTTON).click();
    const pane = page.getByRole("dialog", { name: "Saved Machines" });
    await pane.getByRole("button", { name: "Rename" }).click();
    await pane.getByRole("textbox", { name: "Machine name" }).fill("foo bar");
    await page.keyboard.press("Enter");
    await expect(pane.locator(".kmachines-row")).toContainText("foo bar");
    await expect(pane.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await pane.getByRole("button", { name: "Close" }).click();
    expect(await savedMachineName(page)).toBe("foo bar");

    // Delete from the landing page, where nothing runs: the list entry and the
    // workspace both go.
    await page.reload({ waitUntil: "domcontentloaded" });
    const row = page.locator(".kmachines-row").filter({ hasText: "foo bar" });
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.getByRole("button", { name: "Delete for good" }).click();
    await expect(page.locator(".kempty-saved")).toHaveCount(0);
    expect(await savedMachineIds(page)).toEqual([]);
    expect(await workspaceExists(page, id!)).toBe(false);
  });

  test("a share link for a saved machine names its image and carries no workspace @slow", async ({ page }) => {
    test.setTimeout(600_000);
    await gotoMachine(page, "shell");
    await waitForShell(page);
    await page.getByRole("button", SAVE_BUTTON).click();
    await page.getByRole("dialog", { name: "Save", exact: true })
      .getByRole("button", { name: "Save this machine" }).click();
    await expect(page.locator(".kdock-item.is-saved")).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => new URL(page.url()).search).toBe("");

    // The address bar is bare, so the link names the image itself.
    await page.getByRole("button", { name: "Share this computer as a link" }).click();
    const shareUrl = page.locator(".kshare-url");
    await expect.poll(() => shareUrl.getAttribute("data-share-url")).toMatch(/\?vfs=[^#&]+&profile=shell$/);

    // A script makes the link carry the descriptor, which is the machine on memory.
    await page.locator(".kshare textarea").fill("echo foo");
    await expect.poll(() => shareUrl.getAttribute("data-share-url")).toMatch(/\?vfs=[^#&]+&profile=shell#k1=/);
    const url = await shareUrl.getAttribute("data-share-url");
    const { decodeBootDescriptor } = await import(
      "../../../web-libs/kandelo-session/src/boot-descriptor"
    );
    const descriptor = await decodeBootDescriptor(new URL(url!).hash);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.mounts.some((mount) => mount.source === "opfs")).toBe(false);
    expect(descriptor!.caps?.persistence).toBeUndefined();
  });
});
