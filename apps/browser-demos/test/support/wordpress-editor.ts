import { expect, type FrameLocator } from "../../playwright-test";

type WordPressEntityWindow = Window & {
  wp: { data: { select(store: "core"): {
    isSavingEntityRecord(kind: string, name: string, id: string): boolean;
    hasEditsForEntityRecord(kind: string, name: string, id: string): boolean;
    getEntityRecord(kind: string, name: string, id: string): { content?: { raw?: string } } | undefined;
  } } };
};

type WordPressPostWindow = Window & {
  wp?: { data?: { select(store: string): {
    getCurrentPostId(): number;
    getCurrentPostAttribute(attribute: string): string;
    getEditedPostAttribute(attribute: string): string;
  } } };
};

export async function saveWordPressTemplateHeading(frame: FrameLocator, heading: string, templateId: string): Promise<void> {
  const canvas = frame.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator("[data-block]").first()).toBeVisible({ timeout: 180_000 });
  const page = frame.owner().page();
  const getStarted = frame.getByRole("button", { name: "Get started", exact: true });
  await page.addLocatorHandler(getStarted, () => getStarted.click({ timeout: 30_000 }));
  try {
    // A Query Loop's editable post title belongs to a post, not the template.
    // Select the template's Blog heading first: WordPress can retain a post
    // content insertion point from an earlier editing session.
    // The welcome dialog can leave rich text inactive. Target the real
    // heading block so actionability checks can dismiss that dialog first.
    await canvas.locator('[data-type="core/heading"]').first()
      .click({ timeout: 30_000 });
    await frame.getByRole("button", { name: "Block Inserter", exact: true }).click({ timeout: 30_000 });
    await frame.getByRole("searchbox").fill("Heading", { timeout: 30_000 });
    await frame.getByRole("option", { name: "Heading", exact: true }).click({ timeout: 30_000 });
    const editable = canvas.locator(
      '[data-type="core/heading"][contenteditable="true"], [data-type="core/heading"] [contenteditable="true"]',
    ).last();
    await editable.fill(heading, { timeout: 30_000 });
    await expect(editable).toContainText(heading);
    await expect.poll(() => frame.locator("body").evaluate((_body, templateId) =>
      (window as WordPressEntityWindow).wp.data.select("core")
        .hasEditsForEntityRecord("postType", "wp_template", templateId),
    templateId), { timeout: 30_000, message: "The inserted block must change the template entity" }).toBe(true);
    await frame.getByRole("button", { name: "Save", exact: true }).click({ timeout: 30_000 });
    await expect.poll(() => frame.locator("body").evaluate((_body, { heading, templateId }) => {
      const core = (window as WordPressEntityWindow).wp?.data?.select("core");
      if (!core) throw new Error("WordPress entity store is unavailable");
      return {
        saving: core.isSavingEntityRecord("postType", "wp_template", templateId),
        dirty: core.hasEditsForEntityRecord("postType", "wp_template", templateId),
        saved: core.getEntityRecord("postType", "wp_template", templateId)?.content?.raw?.includes(heading) ?? false,
      };
    }, { heading, templateId }), { timeout: 120_000, message: "WordPress must finish saving the template" })
      .toEqual({ saving: false, dirty: false, saved: true });
  } finally {
    await page.removeLocatorHandler(getStarted);
  }
}

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
    const titleInput = frame.frameLocator('iframe[name="editor-canvas"]')
      .getByRole("textbox", { name: "Add title", exact: true });
    // Unlike fill, click requires the field to receive pointer events. Let
    // the welcome handler dismiss its overlay before entering the title.
    await titleInput.click({ timeout: 30_000 });
    await titleInput.fill(title, { timeout: 30_000 });
    await expect.poll(() => frame.locator("body").evaluate(() =>
      (window as WordPressPostWindow).wp?.data?.select("core/editor").getEditedPostAttribute("title")),
    { timeout: 30_000, message: "WordPress must receive the entered post title" }).toBe(title);
    await frame.getByRole("button", { name: "Publish", exact: true }).click({ timeout: 30_000 });
    const panel = frame.locator(".editor-post-publish-panel");
    await panel.getByRole("button", { name: "Publish", exact: true }).click({ timeout: 30_000 });
    await expect(panel).toContainText("is now live", { timeout: 120_000 });
  } finally {
    await page.removeLocatorHandler(welcome);
  }
  const postId = await frame.locator("body").evaluate(() => {
    const editor = (window as WordPressPostWindow).wp?.data?.select("core/editor");
    if (!editor || editor.getCurrentPostAttribute("status") !== "publish") {
      throw new Error("WordPress editor has not published its current post");
    }
    return editor.getCurrentPostId();
  });
  expect(Number.isSafeInteger(postId) && postId > 0).toBe(true);
  return postId;
}
