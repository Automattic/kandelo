import { test, expect } from "../playwright-test";
import { clickDockTool } from "./support/dock";

test("the app server serves its public fixtures", async ({ request }) => {
  const response = await request.get("/trap-signal-test.html");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  expect(await response.text()).toContain("<title>Wasm trap signal test</title>");
});

test("dock diagnostics bound the initial More click", async ({ page }) => {
  test.setTimeout(5_000);
  await page.setContent("<main>No dock is available</main>");
  await expect(clickDockTool(page, "Internals", { timeout: 100 })).rejects.toThrow(/Timeout/);
});

test("dock tools open the menu before selecting the tool", async ({ page }) => {
  await page.setContent(`
    <button onclick="document.querySelector('dialog').show()">More</button>
    <dialog aria-label="More tools and help">
      <button onclick="document.querySelector('output').textContent = 'opened'">Internals</button>
    </dialog>
    <output></output>
  `);
  await clickDockTool(page, "Internals", { timeout: 1_000 });
  await expect(page.locator("output")).toHaveText("opened");
});
