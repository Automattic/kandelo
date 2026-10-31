import { expect, type Page } from "@playwright/test";

export async function configureNewComputer(page: Page, profileId: string, title?: string): Promise<void> {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "+ New computer", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find images" }).fill(profileId);
  const image = page.locator("[data-image-id]");
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
  await page.locator(`[data-computer-id="${id}"]`).getByRole("button", { name: /^(Open|Boot options)$/ }).click();
  if (profileId) await page.getByRole("combobox", { name: "Boot profile", exact: true }).selectOption(profileId);
  await page.getByRole("button", { name: /^(Boot computer|Reboot computer)$/ }).click();
  await expect(page.getByRole("form", { name: "Boot options", exact: true })).toHaveCount(0, { timeout: 240_000 });
}
