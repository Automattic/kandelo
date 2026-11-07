import { expect, type Locator, type Page } from "../../playwright-test";

/** The dialog asking whether to keep a computer, with its warning already checked. */
export async function keepComputerDialog(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: /^Keep “.*” on this device\?$/ });
  await expect(dialog.getByRole("note", { name: "Release compatibility warning" })).toBeVisible();
  return dialog;
}

export async function confirmKeepComputer(page: Page): Promise<void> {
  await (await keepComputerDialog(page)).getByRole("button", { name: "Keep on this device", exact: true }).click();
}

export async function configureNewComputer(page: Page, profileId: string, title?: string): Promise<void> {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "+ New computer", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find starting computers" }).fill(profileId);
  // A worktree's partial image (`./run.sh partial`) is listed too; these
  // helpers start from the canonical images.
  const image = page.locator('[data-image-id]:not([data-image-id^="partial-"])');
  await expect(image).toHaveCount(1);
  await image.getByRole("button").click();
  await page.getByRole("combobox", { name: "Boot profile", exact: true }).selectOption(profileId);
  if (title) await page.getByLabel("Computer name", { exact: true }).fill(title);
}

export async function currentComputerMetadata(page: Page): Promise<{ id: string; title: string; storageFormat: string; retention: "saved" | "temporary"; expiresAt: number | null; profileId: string | null; filesystemProfileId?: string | null; descriptor: { mounts: { path: string; ref?: string }[] } }> {
  return page.evaluate(() => navigator.locks.request("kandelo-computer-library", async () => {
    const id = new URL(location.href).searchParams.get("computer");
    if (!id) throw new Error("Expected a managed computer URL");
    const root = await navigator.storage.getDirectory();
    const directory = await (await (await root.getDirectoryHandle("kandelo")).getDirectoryHandle("computers")).getDirectoryHandle(id);
    return JSON.parse(await (await (await directory.getFileHandle("computer.json")).getFile()).text());
  }));
}

export async function bootStoredComputer(page: Page, id: string, profileId?: string): Promise<void> {
  const entry = page.locator(`[data-computer-id="${id}"]`);
  if (profileId) {
    await entry.getByRole("button", { name: "Options", exact: true }).click();
    const options = page.getByRole("dialog", { name: "Boot options", exact: true });
    await options.getByRole("combobox", { name: "Boot profile", exact: true }).selectOption(profileId);
    await options.getByRole("button", { name: "Save and Boot", exact: true }).click();
    await expect(options).toHaveCount(0, { timeout: 240_000 });
  } else {
    await entry.getByRole("button", { name: /^(Open|Restart)$/ }).click();
  }
}
