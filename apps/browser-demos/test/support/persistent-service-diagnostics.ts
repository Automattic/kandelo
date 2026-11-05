import { clickDockTool } from "./dock";
import type { Page, TestInfo } from "@playwright/test";

export async function capturePersistentServiceLogs(page: Page, testInfo: TestInfo) {
  const observations: { path: string; text?: string; error?: string }[] = [];
  const panel = page.locator(".kinternals-surface:visible").first();
  if (await panel.count() === 0) {
    await clickDockTool(page, "Internals", { timeout: 5000 });
  }
  for (const path of ["/var/log/php-fpm.log", "/var/log/nginx.log", "/data/error.log"]) {
    try {
      await page.getByRole("tab", { name: "Syslog", exact: true }).click({ timeout: 5000 });
      await page.getByRole("tab", { name: "VFS", exact: true }).click({ timeout: 5000 });
      const components = path.split("/").filter(Boolean);
      for (const [index, component] of components.entries()) {
        const name = index === components.length - 1 ? component : `${component}/`;
        await panel.getByRole("cell", { name, exact: true }).click({ timeout: 5000 });
      }
      await panel.getByText(path, { exact: true }).waitFor({ state: "visible", timeout: 5000 });
      observations.push({ path, text: (await panel.locator("pre").first().innerText({ timeout: 5000 })).slice(-65536) });
    } catch (error) {
      observations.push({ path, error: String(error).slice(0, 2000) });
    }
  }
  await testInfo.attach("inspector-service-logs", { body: JSON.stringify(observations, null, 2), contentType: "application/json" });
  return observations;
}
