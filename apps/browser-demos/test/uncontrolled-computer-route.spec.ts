import { expect, test } from "@playwright/test";

test("a computer route without service-worker control never serves the app shell", async ({ request, baseURL }) => {
  expect(baseURL).toBeTruthy();
  // Playwright's API request bypasses the browser service worker. If the
  // browser loses that worker, the static server must not mount Kandelo
  // inside the web preview and recursively boot another computer.
  for (const path of ["/computer", "/computer/", "/computer/missing/wp-admin/site-editor.php"]) {
    const response = await request.get(new URL(path, baseURL!).href);
    expect(response.status(), path).toBe(503);
    expect(await response.text()).toContain("service worker");
  }
});
