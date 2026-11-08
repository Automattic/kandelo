import type { Page } from "../../playwright-test";

export async function dockTool(page: Page, name: "Internals" | "Appearance" | "Share setup…" | "About Kandelo" | "Services", options?: { timeout?: number }) {
  const more = page.getByRole("dialog", { name: "More tools and help", exact: true });
  if (!await more.isVisible()) await page.getByRole("button", { name: "More", exact: true }).click(options);
  return more.getByRole("button", { name, exact: true });
}

export async function clickDockTool(page: Page, name: "Internals" | "Appearance" | "Share setup…" | "About Kandelo" | "Services", options?: { timeout?: number }) {
  await (await dockTool(page, name, options)).click(options);
}

export async function setInternalsOpen(page: Page, open: boolean) {
  if (await page.getByRole("dialog", { name: "Internals", exact: true }).isVisible() !== open) await clickDockTool(page, "Internals");
}
