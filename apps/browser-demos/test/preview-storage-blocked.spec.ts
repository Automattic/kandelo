import { expect, firefox, test } from "@playwright/test";
import {
  gotoMachineOrSkip,
  previewFrame,
  previewFrameSelector,
} from "./support/kandelo-machine";

/**
 * A browser that blocks storage for the preview origin must say so in the
 * preview pane, not leave an empty pane and a disabled Demo button.
 *
 * Firefox's opt-in "All cross-site cookies" setting
 * (`network.cookie.cookieBehavior=1`) denies storage, service workers
 * included, to a third-party frame. The preview relay is such a frame when
 * the preview origin is on another site than Kandelo, so registering the
 * preview worker fails there with `SecurityError` ("The operation is
 * insecure."). A preview origin on Kandelo's own site is not third-party, so
 * the same setting leaves previews working.
 *
 * Run it against both layouts of the dev server:
 *
 * - same-site (the default): app `http://127.0.0.1:<port>`, preview origin
 *   `http://127.0.0.1:<port+1>`. The preview renders.
 * - cross-site: the same with
 *   `KANDELO_PREVIEW_ORIGIN=http://localhost:<port+1>`; `127.0.0.1` and
 *   `localhost` are different sites. The pane names the blocked origin.
 *
 * The test launches its own Firefox with that one preference added to the
 * firefox project's launch options, so it runs only in that project.
 * See docs/browser-support.md, "Choosing a preview origin".
 */

const MACHINE_TITLE = "nginx";

/** The preview origin the dev server under test serves (see vite/preview-origin.ts). */
function previewOriginFor(appOrigin: string): string | null {
  const configured = process.env.KANDELO_PREVIEW_ORIGIN?.trim();
  if (configured === "off") return null;
  if (configured) return new URL(configured).origin;
  const app = new URL(appOrigin);
  return `${app.protocol}//${app.hostname}:${Number(app.port) + 1}`;
}

test("a preview origin whose storage the browser blocks is named in the preview pane", async ({
  browserName,
  baseURL,
}, testInfo) => {
  test.skip(browserName !== "firefox", "launches its own Firefox with cookieBehavior=1");
  test.setTimeout(300_000);
  const appOrigin = new URL(baseURL!).origin;
  const previewOrigin = previewOriginFor(appOrigin);
  test.skip(previewOrigin === null, "this server has no preview origin");
  // Both test layouts are loopback pairs, where the host alone decides the
  // site (127.0.0.1 and localhost are different sites; ports do not count).
  const sameSite = new URL(previewOrigin!).hostname === new URL(appOrigin).hostname;
  testInfo.annotations.push({
    type: "layout",
    description: `${sameSite ? "same-site" : "cross-site"}: app ${appOrigin}, preview ${previewOrigin}`,
  });

  const projectLaunch = testInfo.project.use.launchOptions ?? {};
  const browser = await firefox.launch({
    ...projectLaunch,
    firefoxUserPrefs: {
      ...(projectLaunch.firefoxUserPrefs ?? {}),
      // Settings > Privacy & Security > Custom > Cookies: "All cross-site cookies".
      "network.cookie.cookieBehavior": 1,
    },
  });
  try {
    const page = await (await browser.newContext({ baseURL })).newPage();
    await gotoMachineOrSkip(page, "nginx");
    if (sameSite) {
      await expect(previewFrame(page, MACHINE_TITLE).locator("body")).toContainText(
        "Hello from nginx on WebAssembly!",
        { timeout: 180_000 },
      );
      return;
    }
    const error = page.getByTestId("web-preview-error");
    await expect(error).toContainText(
      `This browser blocks storage for the preview origin ${previewOrigin}, so web previews can't start.`,
      { timeout: 180_000 },
    );
    await expect(error).toContainText(`Allow cookies and site data for ${previewOrigin}`);
    // The browser's own words stay visible beside the explanation.
    await expect(error).toContainText("The operation is insecure.");
    await expect(page.locator(previewFrameSelector(MACHINE_TITLE))).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("storage-blocked-pane.png") });
  } finally {
    await browser.close();
  }
});
