/**
 * Site editor performance measurement module.
 *
 * Adapted from WordPress Playground's
 * packages/playground/cli/perf/measure-site-editor.ts
 * to work with wasm-posix-kernel's WordPress server (WP 6.7.2).
 *
 * Runs a single benchmark pass: launches Chromium, logs in,
 * navigates through the site editor, and returns raw timing
 * values for each metric.
 */

import { chromium } from "@playwright/test";
import type { Page, Frame } from "@playwright/test";

export const METRIC_NAMES = [
  "login",
  "siteEditorLoad",
  "templatesViewLoad",
  "templateOpen",
  "blockAdd",
  "templateSave",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export type MeasurementResult = Partial<Record<MetricName, number>>;

export interface MeasureOptions {
  url: string;
  username: string;
  password: string;
  headed?: boolean;
}

export async function measureSiteEditor(
  options: MeasureOptions,
): Promise<MeasurementResult> {
  let baseUrl = options.url.replace(/\/$/, "");

  const result: MeasurementResult = {};

  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Step 0: Log in and measure it
    const loginStart = Date.now();

    await page.goto(`${baseUrl}/wp-login.php`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});

    await page.getByRole("textbox", { name: "Username or Email Address" }).fill(options.username);
    await page.getByRole("textbox", { name: "Password" }).fill(options.password);
    await page.getByRole("button", { name: "Log In" }).click();

    // Wait for dashboard
    await page.getByRole("heading", { name: "Dashboard" }).waitFor({
      state: "visible",
      timeout: 60_000,
    });

    result.login = Date.now() - loginStart;

    // Step 1: Navigate to site editor and wait for it to be interactive
    const siteEditorStart = Date.now();

    await page.goto(`${baseUrl}/wp-admin/site-editor.php`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    await dismissWelcomeModal(page);

    // Wait for the navigation panel buttons to appear (editor shell is ready)
    await page.getByRole("button", { name: "Templates" }).waitFor({
      state: "visible",
      timeout: 120_000,
    });

    result.siteEditorLoad = Date.now() - siteEditorStart;

    // Step 2: Open Templates panel
    const templatesViewStart = Date.now();

    await page.getByRole("button", { name: "Templates" }).click();

    // WP 6.7.2: Templates panel shows categories; "All templates" appears
    await page.getByRole("heading", { name: "Templates", level: 1 }).waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "All templates" }).waitFor({
      state: "visible",
      timeout: 60_000,
    });

    result.templatesViewLoad = Date.now() - templatesViewStart;

    // Step 3: Open a specific template for editing
    const templateOpenStart = Date.now();

    // Navigate directly to the Index template in edit mode
    await page.goto(
      `${baseUrl}/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfive//index&canvas=edit`,
      { waitUntil: "domcontentloaded", timeout: 120_000 },
    );

    await dismissWelcomeModal(page);

    await page.locator('iframe[name="editor-canvas"]').waitFor({
      state: "visible",
      timeout: 120_000,
    });

    const templateFrame = await findEditorCanvasFrame(page);
    if (!templateFrame) throw new Error("Template editor frame not found");

    await waitForBlocksRendered(templateFrame);
    result.templateOpen = Date.now() - templateOpenStart;

    // Step 4: Add blocks
    const blockAddStart = Date.now();

    // Click on the canvas iframe to focus the editor
    await page.locator('iframe[name="editor-canvas"]').click();
    await page.keyboard.press("Escape");

    // Open block inserter
    const inserterButton = page.getByRole("button", { name: /Block Inserter|Toggle block inserter/i });
    await inserterButton.click();

    const searchInput = page.getByPlaceholder("Search");
    await searchInput.waitFor({ state: "visible", timeout: 15_000 });
    await searchInput.fill("Paragraph");
    await page
      .getByRole("option", { name: "Paragraph", exact: true })
      .click();
    await templateFrame.waitForSelector("p[data-block]", {
      timeout: 15_000,
    });

    await searchInput.fill("Heading");
    await page
      .locator(".block-editor-block-types-list__item")
      .filter({ hasText: /^Heading$/ })
      .click();
    await templateFrame.waitForSelector(
      "h1[data-block], h2[data-block], h3[data-block]",
      { timeout: 15_000 },
    );

    result.blockAdd = Date.now() - blockAddStart;

    // Step 5: Save the template
    const templateSaveStart = Date.now();

    // WP 6.7.2: The save button in the header toolbar. It might say "Save"
    // when there are unsaved changes.
    const saveButton = page.locator('button').filter({ hasText: /^Save$/ }).first();
    await saveButton.waitFor({ state: "visible", timeout: 10_000 });
    await saveButton.click();

    // WP 6.7.2 may show a "Save" confirmation panel. If so, click
    // the final save button in that panel.
    const panelSaveButton = page.locator('.entities-saved-states__save-button, .editor-entities-saved-states__save-button');
    const hasSavePanel = await panelSaveButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasSavePanel) {
      await panelSaveButton.click();
    }

    // Wait for save to complete: the button becomes disabled with text "Saved"
    // or the save panel disappears
    await page.waitForFunction(
      () => {
        // Check for disabled "Saved" button
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if ((text === 'Saved' || text === 'Save') &&
              (btn.getAttribute('aria-disabled') === 'true' || btn.disabled)) {
            return true;
          }
        }
        // Check if save panel closed
        const panel = document.querySelector('.entities-saved-states__panel, .editor-entities-saved-states__panel');
        return panel === null;
      },
      { timeout: 30_000 },
    );

    result.templateSave = Date.now() - templateSaveStart;
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  return result;
}

async function findEditorCanvasFrame(
  page: Page,
  timeoutMs = 30_000,
): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frame({ name: "editor-canvas" });
    if (frame) return frame;
    await page.waitForTimeout(200);
  }
  return null;
}

async function dismissWelcomeModal(page: Page): Promise<void> {
  // WP 6.7.2 welcome guide blocks pointer events with an overlay.
  // Wait for it to appear, then dismiss it via the "Get started" button.
  // Use multiple strategies since the dialog takes time to render.
  for (let i = 0; i < 20; i++) {
    // Try clicking the "Get started" button via CSS selector
    const dismissed = await page.evaluate(() => {
      const overlay = document.querySelector('.components-modal__screen-overlay');
      if (!overlay) return false;
      const buttons = overlay.querySelectorAll('button');
      for (const btn of buttons) {
        if (/get started/i.test(btn.textContent || '')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (dismissed) {
      // Wait for overlay to disappear
      await page.waitForTimeout(500);
      return;
    }
    await page.waitForTimeout(500);
  }
  // No welcome modal appeared — that's fine
}

async function waitForBlocksRendered(frame: Frame): Promise<void> {
  await frame.waitForLoadState("domcontentloaded");
  await frame.waitForSelector("[data-block]", { timeout: 60_000 });
  await frame.waitForFunction(
    () => {
      const blocks = document.querySelectorAll("[data-block]");
      return (
        blocks.length > 0 &&
        Array.from(blocks).some((block) => block.clientHeight > 0)
      );
    },
    { timeout: 60_000 },
  );
}
