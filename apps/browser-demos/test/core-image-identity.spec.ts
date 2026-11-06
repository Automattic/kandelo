import { expect } from "@playwright/test";
import { resolve } from "node:path";
import { test } from "./support/persistent-page";
import { machineUrl } from "./support/kandelo-machine";
import { runParentShellProbe, runTerminalCommand } from "./support/terminal-command";

for (const profile of ["nginx", "wordpress-sqlite"]) {
  test(`${profile} inherits maker sudo access and the dynamic Bash prompt`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await page.goto(await machineUrl(page, profile));
    await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
    // Service readiness opens the initial web view. Let it finish before
    // selecting Terminal so that it cannot hide the terminal during a probe.
    const preview = page.locator("iframe.kweb-frame");
    await expect(preview).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => preview.evaluate((element: HTMLIFrameElement) =>
      element.contentDocument?.body?.innerText ?? ""), { timeout: 180_000 },
    ).toMatch(profile === "nginx" ? /Hello from nginx/ : /WordPress on Kandelo|Hello world/i);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const terminal = page.locator(".kshell-host:visible .xterm-rows").first();
    await expect(terminal).toContainText(/maker@[^:\s]+:~\$ /, { timeout: 120_000 });
    await runTerminalCommand(page,
      "printf 'kandelo\\n' | sudo -S -p '' /bin/bash -c 'test \"$UID\" = 0 && printf \"SUDO_ROOT_UID=%s\\n\" \"$UID\"'",
      "SUDO_ROOT_UID=0");
    await runParentShellProbe(page, "cd /var/tmp");
    await expect(terminal).toContainText(/maker@[^:\s]+:tmp\$ /);
    await page.screenshot({ path: resolve(import.meta.dirname, `../../../.context/core-identity-${profile}-${testInfo.project.name}.png`) });
  });
}
