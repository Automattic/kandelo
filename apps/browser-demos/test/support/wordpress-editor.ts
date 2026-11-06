import { expect, type FrameLocator } from "@playwright/test";

export async function expectWordPressEditor(frame: FrameLocator): Promise<void> {
  await expect(frame.locator("body.wp-admin")).toBeVisible({ timeout: 180_000 });
  await expect(frame.locator(".block-editor-no-js")).toBeHidden({ timeout: 120_000 });
  const canvas = frame.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.getByRole("textbox", { name: "Add title", exact: true }))
    .toBeVisible({ timeout: 120_000 });
  await expect.poll(() => frame.locator('link[rel="stylesheet"]').evaluateAll(links =>
    links.every(link => {
      const sheet = (link as HTMLLinkElement).sheet;
      return sheet !== null && sheet.cssRules.length > 0;
    }),
  ), { timeout: 120_000, message: "WordPress editor stylesheets must contain parsed CSS rules" }).toBe(true);
}

export async function publishWordPressPost(frame: FrameLocator, title: string): Promise<number> {
  const page = frame.owner().page();
  const welcome = frame.getByRole("dialog", { name: "Welcome to the editor" });
  await page.addLocatorHandler(welcome, async () => {
    await welcome.getByRole("button", { name: "Close", exact: true }).click({ timeout: 30_000 });
  });
  try {
    await expectWordPressEditor(frame);
    await frame.frameLocator('iframe[name="editor-canvas"]')
      .getByRole("textbox", { name: "Add title", exact: true }).fill(title, { timeout: 30_000 });
    await frame.getByRole("button", { name: "Publish", exact: true }).click({ timeout: 30_000 });
    const panel = frame.locator(".editor-post-publish-panel");
    await panel.getByRole("button", { name: "Publish", exact: true }).click({ timeout: 30_000 });
    await expect(panel).toContainText("is now live", { timeout: 120_000 });
  } finally {
    await page.removeLocatorHandler(welcome);
  }
  const postId = await frame.locator("body").evaluate(() => {
    const editor = (window as Window & {
      wp?: { data?: { select(store: string): { getCurrentPostId(): number; getCurrentPostAttribute(attribute: string): string } } };
    }).wp?.data?.select("core/editor");
    if (!editor || editor.getCurrentPostAttribute("status") !== "publish") {
      throw new Error("WordPress editor has not published its current post");
    }
    return editor.getCurrentPostId();
  });
  expect(Number.isSafeInteger(postId) && postId > 0).toBe(true);
  return postId;
}
