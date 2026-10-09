import { expect, test, type Page } from "@playwright/test";
import { appUrl, gotoMachine } from "./support/kandelo-machine";
import {
  closeDockPopovers,
  connectPeers,
  expectReplica,
  networkButton,
  openNetworkPopover,
  takeOverButton,
  typeIntoTerminal,
} from "./support/peer-pair";
import { runTerminalCommand } from "./support/terminal-command";

/**
 * A saved machine keeps its home directory in this browser: the running shell
 * is saved from the Machines pane without a restart, its later writes and
 * deletions are saved as the dock reports, the page is reloaded, and the
 * machine is opened again from the landing page with its files as it left
 * them. The list renames and deletes, a second tab is refused the machine a
 * running tab holds, and a deleted machine's files are gone from IndexedDB.
 * A machine handed to another computer stays saved by the browser that saved
 * it: the other computer sends its changes back over the peer link, and
 * hands the machine back when it disconnects.
 */

const MACHINES_BUTTON = { name: "Machines", exact: true } as const;
const MACHINES_PANE = { name: "Machines", exact: true } as const;
const SIGNALLING = "http://127.0.0.1:8787/";

async function waitForShell(page: Page): Promise<void> {
  await expect(page.locator(".kshell-host .xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
}

async function savedMachineName(page: Page): Promise<string> {
  await page.getByRole("button", MACHINES_BUTTON).click();
  const pane = page.getByRole("dialog", MACHINES_PANE);
  const name = await pane.locator(".kmachines-row[data-current] .kmachines-name").innerText();
  await pane.getByRole("button", { name: "Close" }).click();
  return name;
}

async function saveMachine(page: Page): Promise<void> {
  await page.getByRole("button", MACHINES_BUTTON).click();
  const pane = page.getByRole("dialog", MACHINES_PANE);
  await pane.getByRole("button", { name: "Save this machine" }).click();
  await expect(page.locator(".kdock-save-state")).toHaveText("Saved", { timeout: 180_000 });
  await expect(pane.getByRole("button", { name: "Save this machine" })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has("vfs")).toBe(false);
  await pane.getByRole("button", { name: "Close" }).click();
}

/** The dock reports a change, then reports it saved. */
async function expectChangeSaved(page: Page): Promise<void> {
  const state = page.locator(".kdock-save-state");
  await expect(state).toHaveText("Modified", { timeout: 10_000 });
  await expect(state).toHaveText("Saved", { timeout: 10_000 });
}

/**
 * Record every text the dock's save state shows from now on.
 *
 * A state can last one read of the home, about a second, which is as long
 * as the gap between two retries of an assertion. A record misses none.
 */
async function recordSaveStates(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { kandeloSaveStates: string[] }).kandeloSaveStates = seen;
    new MutationObserver(() => {
      const text = document.querySelector(".kdock-save-state")?.textContent ?? null;
      if (text !== null && seen.at(-1) !== text) seen.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { kandeloSaveStates: string[] }).kandeloSaveStates);
}

async function savedMachinePaths(page: Page, id: string): Promise<string[]> {
  return page.evaluate((machine) => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open("kandelo-saved-machines");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const keys = request.result.transaction("entries")
        .objectStore("entries")
        .getAllKeys(IDBKeyRange.bound([machine], [machine, []]));
      keys.onerror = () => reject(keys.error);
      keys.onsuccess = () => resolve(keys.result.map((key) => (key as [string, string])[1]));
    };
  }), id);
}

async function savedMachineText(page: Page, id: string, path: string): Promise<string | null> {
  return page.evaluate(([machine, file]) => new Promise<string | null>((resolve, reject) => {
    const request = indexedDB.open("kandelo-saved-machines");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const entry = request.result.transaction("entries").objectStore("entries").get([machine, file]);
      entry.onerror = () => reject(entry.error);
      entry.onsuccess = () => {
        const bytes = (entry.result as { bytes?: Uint8Array } | undefined)?.bytes;
        resolve(bytes === undefined ? null : new TextDecoder().decode(bytes));
      };
    };
  }), [id, path] as const);
}

/** Take the other computer's machine and wait until it runs here. */
async function takeOver(taker: Page, giver: Page): Promise<void> {
  await openNetworkPopover(taker);
  await takeOverButton(taker).click();
  await closeDockPopovers([taker, giver]);
  await expect(taker.locator(".kdock-status")).toHaveAttribute("data-role", "user", { timeout: 300_000 });
  await expect(taker.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 300_000 });
}

async function savedMachineIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("kandelo.persistent-machines.v1");
    if (raw === null) return [];
    return (JSON.parse(raw) as { machines: Array<{ id: string }> }).machines.map((m) => m.id);
  });
}

/** Two computers in one browser need a loopback ICE pair. */
function skipWithoutPeers(browserName: string): void {
  test.skip(browserName !== "chromium", "only headless Chromium can form a loopback ICE pair");
}

test.describe("saved machines", () => {
  test("a saved shell keeps its home across a reload and reopens from the landing page @slow", async ({
    page,
    context,
  }) => {
    test.setTimeout(600_000);
    await gotoMachine(page, "shell", { search: { signalling: SIGNALLING } });
    await waitForShell(page);
    await runTerminalCommand(page, "echo world > hello.txt && echo qux > stale.txt && pwd", "/home/maker");

    // Save: the Machines pane says what it does, the button does it, and the
    // machine keeps running — the shell answers without booting again.
    await saveMachine(page);
    expect(new URL(page.url()).search).toBe(`?signalling=${encodeURIComponent(SIGNALLING)}`);
    await runTerminalCommand(page, "cat hello.txt", "world");

    const name = await savedMachineName(page);
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const [id] = await savedMachineIds(page);
    expect(id).toBeDefined();
    expect(await savedMachinePaths(page, id!)).toEqual(expect.arrayContaining(["hello.txt", "stale.txt"]));

    // Later writes and deletions are saved, and the dock says when.
    await runTerminalCommand(page, "mkdir -p notes && echo foo > notes/bar.md && ln -s notes/bar.md link && rm stale.txt");
    await expectChangeSaved(page);
    const paths = await savedMachinePaths(page, id!);
    expect(paths).toEqual(expect.arrayContaining(["hello.txt", "link", "notes", "notes/bar.md"]));
    expect(paths).not.toContain("stale.txt");

    // A named FIFO is not kept, and the Machines pane says so.
    await runTerminalCommand(page, "mkfifo pipe && test -p pipe && echo fifo", "fifo");
    await page.getByRole("button", MACHINES_BUTTON).click();
    await expect(page.getByRole("dialog", MACHINES_PANE).locator(".kmachines-failure"))
      .toContainText("are not kept: pipe", { timeout: 10_000 });
    await page.getByRole("dialog", MACHINES_PANE).getByRole("button", { name: "Close" }).click();
    expect(await savedMachinePaths(page, id!)).not.toContain("pipe");

    // A second tab is refused the machine while this one runs it.
    const other = await context.newPage();
    await other.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await expect(other.locator(".kempty-saved")).toContainText(name);
    await other.locator(".kmachines-row").filter({ hasText: name })
      .getByRole("button", { name: "Open" }).click();
    await expect(other.locator(".kmachines-failure")).toContainText("open in another tab");
    await other.close();

    // Reload: the landing page lists the machine; opening it brings the home
    // back as it was saved — the deleted file stays deleted, the owner stays.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".kempty-saved")).toContainText(name);
    await page.locator(".kmachines-row").filter({ hasText: name })
      .getByRole("button", { name: "Open" }).click();
    await waitForShell(page);
    await runTerminalCommand(page, "cat hello.txt link", /world\s*foo/);
    await runTerminalCommand(page, "test ! -e stale.txt && ls -ln notes/bar.md", / 1000 +1000 /);
    await expect(page.locator(".kdock-save-state")).toHaveText("Saved");
    expect(new URL(page.url()).search).toBe(`?signalling=${encodeURIComponent(SIGNALLING)}`);

    // Rename from the list.
    await page.getByRole("button", MACHINES_BUTTON).click();
    const pane = page.getByRole("dialog", MACHINES_PANE);
    await pane.getByRole("button", { name: "Rename" }).click();
    await pane.getByRole("textbox", { name: "Machine name" }).fill("foo bar");
    await page.keyboard.press("Enter");
    await expect(pane.locator(".kmachines-row")).toContainText("foo bar");
    const runningRow = pane.locator(".kmachines-row[data-current]");
    await expect(runningRow.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(runningRow.getByRole("button", { name: "Open" })).toHaveCount(0);
    await pane.getByRole("button", { name: "Close" }).click();
    expect(await savedMachineName(page)).toBe("foo bar");

    // The landing page only opens a machine. Delete from the Machines pane
    // while nothing runs: the list entry and the saved files both go.
    await page.reload({ waitUntil: "domcontentloaded" });
    const landingRow = page.locator(".kempty-saved .kmachines-row").filter({ hasText: "foo bar" });
    await expect(landingRow.getByRole("button", { name: "Open" })).toBeVisible();
    await expect(landingRow.getByRole("button")).toHaveCount(1);
    await page.getByRole("button", MACHINES_BUTTON).click();
    const row = page.getByRole("dialog", MACHINES_PANE).locator(".kmachines-row").filter({ hasText: "foo bar" });
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("dialog", MACHINES_PANE).locator(".kmachines-empty")).toBeVisible();
    await expect(page.locator(".kempty-saved")).toHaveCount(0);
    expect(await savedMachineIds(page)).toEqual([]);
    expect(await savedMachinePaths(page, id!)).toEqual([]);
  });

  test("a saved machine handed to the other computer stays saved by the browser that saved it @slow", async ({
    browser,
    browserName,
  }) => {
    skipWithoutPeers(browserName);
    test.setTimeout(900_000);
    const keeperContext = await browser.newContext();
    const takerContext = await browser.newContext();
    const keeper = await keeperContext.newPage();
    const taker = await takerContext.newPage();
    try {
      await gotoMachine(keeper, "shell");
      await waitForShell(keeper);
      await runTerminalCommand(keeper, "echo world > hello.txt");
      await saveMachine(keeper);
      const [id] = await savedMachineIds(keeper);
      expect(id).toBeDefined();
      await taker.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
      await connectPeers(keeper, taker, (reason) => test.skip(true, reason));
      await expectReplica(taker);
      await expect(keeper.locator(".kdock-save-state")).toHaveText("Saved");

      // The taker runs the machine and the keeper saves what it changes. The
      // save state stays with the browser that saves.
      await takeOver(taker, keeper);
      await expect(keeper.locator(".kdock-save-state")).toHaveText("Saved", { timeout: 60_000 });
      await expect(taker.locator(".kdock-save-state")).toHaveCount(0);
      // The keeper reports the change before it is sent. A keeper still
      // booting its replica handles both messages at once, so the record
      // starts once the replica runs.
      await expectReplica(keeper);
      const saveStates = await recordSaveStates(keeper);
      await typeIntoTerminal(taker, ".kshell-host", "echo foo > hello.txt");
      await expect.poll(() => savedMachineText(keeper, id!, "hello.txt"), { timeout: 30_000 }).toBe("foo\n");
      expect(await saveStates()).toContain("Modified");
      await expect(keeper.locator(".kdock-save-state")).toHaveText("Saved");
      await keeper.getByRole("button", MACHINES_BUTTON).click();
      const pane = keeper.getByRole("dialog", MACHINES_PANE);
      await expect(pane.locator(".kmachines-row[data-current]")).toContainText("Running on the other computer");
      await pane.getByRole("button", { name: "Close" }).click();
      await taker.getByRole("button", MACHINES_BUTTON).click();
      await expect(taker.getByRole("dialog", MACHINES_PANE).locator(".kmachines-elsewhere"))
        .toContainText("saved on the other computer");
      await expect(taker.getByRole("button", { name: "Save this machine" })).toHaveCount(0);
      await taker.getByRole("dialog", MACHINES_PANE).getByRole("button", { name: "Close" }).click();

      // The machine comes back and the keeper saves it as before.
      await takeOver(keeper, taker);
      await expect(keeper.locator(".kdock-save-state")).toHaveText("Saved", { timeout: 60_000 });
      await typeIntoTerminal(keeper, ".kshell-host", "echo bar > hello.txt");
      await expectChangeSaved(keeper);
      expect(await savedMachineText(keeper, id!, "hello.txt")).toBe("bar\n");

      // The taker takes it again and closes: what it saved stays saved.
      await takeOver(taker, keeper);
      await expect(keeper.locator(".kdock-save-state")).toHaveText("Saved", { timeout: 60_000 });
      await typeIntoTerminal(taker, ".kshell-host", "echo qux > hello.txt");
      await expect.poll(() => savedMachineText(keeper, id!, "hello.txt"), { timeout: 30_000 }).toBe("qux\n");
      await takerContext.close();

      await keeper.reload({ waitUntil: "domcontentloaded" });
      await keeper.locator(".kempty-saved .kmachines-row").getByRole("button", { name: "Open" }).click();
      await waitForShell(keeper);
      await runTerminalCommand(keeper, "cat hello.txt", "qux");
    } finally {
      await takerContext.close();
      await keeperContext.close();
    }
  });

  test("a saved machine handed back on disconnect is saved again by the browser that saved it @slow", async ({
    browser,
    browserName,
  }) => {
    skipWithoutPeers(browserName);
    test.setTimeout(900_000);
    const keeperContext = await browser.newContext();
    const takerContext = await browser.newContext();
    const keeper = await keeperContext.newPage();
    const taker = await takerContext.newPage();
    try {
      await gotoMachine(keeper, "shell");
      await waitForShell(keeper);
      await saveMachine(keeper);
      const [id] = await savedMachineIds(keeper);
      expect(id).toBeDefined();
      await taker.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
      await connectPeers(keeper, taker, (reason) => test.skip(true, reason));
      await expectReplica(taker);
      await takeOver(taker, keeper);
      await expectReplica(keeper);

      await openNetworkPopover(taker);
      await taker.getByRole("button", { name: "Disconnect" }).click();
      await expect(networkButton(taker)).not.toHaveClass(/is-connected/, { timeout: 60_000 });
      await expect(keeper.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 60_000 });
      await expect(keeper.locator(".kdock-status")).not.toHaveAttribute("data-role");
      await expect(keeper.locator(".kdock-save-state")).toHaveText("Saved", { timeout: 60_000 });
      await expect(taker.locator(".kdock-status-text")).not.toHaveAttribute("data-status", "running");

      await closeDockPopovers([keeper]);
      await typeIntoTerminal(keeper, ".kshell-host", "echo foo > hello.txt");
      await expectChangeSaved(keeper);
      expect(await savedMachineText(keeper, id!, "hello.txt")).toBe("foo\n");
    } finally {
      await takerContext.close();
      await keeperContext.close();
    }
  });

  test("a corrupt list of saved machines is reported, not shown as empty @slow", async ({ page }) => {
    test.setTimeout(600_000);
    await gotoMachine(page, "shell");
    await waitForShell(page);
    await saveMachine(page);

    await page.evaluate(() => window.localStorage.setItem("kandelo.persistent-machines.v1", "{bar"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".kmachines-failure")).toContainText(
      "The saved machine list in this browser could not be read",
    );
  });

  test("a share link for a saved machine names its image and carries no workspace @slow", async ({ page }) => {
    test.setTimeout(600_000);
    await gotoMachine(page, "shell");
    await waitForShell(page);
    await saveMachine(page);

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
  });
});
