import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { test } from "./support/persistent-page";
import { machineUrl } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { clickDockTool, setInternalsOpen } from "./support/dock";
import { currentComputerMetadata, configureNewComputer } from "./support/computer-library";

async function shell(page: Page): Promise<void> {
  await page.goto(await machineUrl(page, "shell"));
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect(page.locator(".xterm-rows").first()).toBeVisible();
  await expect(page.locator(".xterm-rows").first()).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 120_000 });
}

async function server(page: Page): Promise<void> {
  await runTerminalCommand(page, `cat > /home/projects/preview-server.py <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(503 if self.path == '/failure' else 200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(('arbitrary guest service ' + self.path).encode())
HTTPServer(('0.0.0.0', 38467), Handler).serve_forever()
PY
python3 /home/projects/preview-server.py >/tmp/preview-server.log 2>&1 &
printf '%s%s\\n' PREVIEW_SERVER_ STARTED`, "PREVIEW_SERVER_STARTED");
  await expect.poll(async () => (await runTerminalCommand(page, "curl --fail --silent http://127.0.0.1:38467/; true")).output,
    { timeout: 120_000 }).toContain("arbitrary guest service");
}

test("the dock Temporary tag confirms retention and the same computer stays saved after reload", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await shell(page);
  const original = await currentComputerMetadata(page);
  expect(original.retention).toBe("temporary");
  const keep = page.getByRole("button", { name: "Keep this temporary computer", exact: true });
  let keepPrompt = "";
  page.once("dialog", dialog => { keepPrompt = dialog.message(); void dialog.dismiss(); });
  await keep.click();
  expect(keepPrompt).toContain("until you delete it");
  expect(keepPrompt).not.toMatch(/clear.*(?:browser|storage|site data)/i);
  const highlight = await keep.evaluate(element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(element);
    const bounds = text.getBoundingClientRect();
    return { background: style.backgroundColor, foreground: style.color, weight: style.fontWeight, alignment: style.alignItems,
      verticalOffset: Math.abs(bounds.y + bounds.height / 2 - box.y - box.height / 2) };
  });
  expect(highlight.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(highlight.foreground).not.toBe(highlight.background);
  expect(Number(highlight.weight)).toBeGreaterThanOrEqual(600);
  expect(highlight.alignment).toBe("center");
  expect(highlight.verticalOffset).toBeLessThanOrEqual(3);
  await page.locator(".kdock-status").screenshot({ path: resolve(import.meta.dirname, `../../../.context/temporary-badge-centered-${testInfo.project.name}.png`) });
  expect((await currentComputerMetadata(page)).retention).toBe("temporary");
  page.once("dialog", dialog => dialog.accept());
  await keep.click();
  await expect(keep).toHaveCount(0);
  expect(await currentComputerMetadata(page)).toMatchObject({ id: original.id, retention: "saved", expiresAt: null });
  await page.reload();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  expect(await currentComputerMetadata(page)).toMatchObject({ id: original.id, retention: "saved", expiresAt: null });
});

test("the normal shell lazily installs the guest preparer and SDK optimizer and reopens them", async ({ page }) => {
  test.setTimeout(360_000);
  await shell(page);
  const command = "set -e; wasm-fork-instrument --help > /home/projects/preparer-help.txt; head -n 1 /home/projects/preparer-help.txt; wasm-opt --version";
  const first = await runTerminalCommand(page, command, "Instrument a wasm module", 180_000);
  expect(first.output).toContain("wasm-opt version 126");
  await page.reload();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  const reopened = await runTerminalCommand(page, command, "Instrument a wasm module", 180_000);
  expect(reopened.output).toContain("wasm-opt version 126");
});

test("boot has its own syslog and running WordPress services own their shortcuts", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  await shell(page);
  await clickDockTool(page, "Internals");
  const internals = page.getByRole("dialog", { name: "Internals", exact: true });
  await internals.getByRole("tab", { name: "Config", exact: true }).click();
  await setInternalsOpen(page, false);
  await expect(page.getByRole("button", { name: "Shortcuts", exact: true })).toHaveCount(0);
  await configureNewComputer(page, "wordpress-mariadb");
  await page.getByRole("button", { name: "Create and boot", exact: true }).click();
  await expect(page.getByRole("region", { name: "Boot log", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog", { name: "Computer Library", exact: true })).not.toBeVisible();
  await expect(page.getByRole("region", { name: "Boot log", exact: true }).locator(".ksys-line").first()).toBeVisible();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 240_000 });
  await clickDockTool(page, "Internals");
  await expect(internals.getByRole("tab", { name: "Config", exact: true })).toHaveAttribute("aria-selected", "true");
  await setInternalsOpen(page, false);
  const shortcuts = page.getByRole("button", { name: "Shortcuts", exact: true });
  await expect(shortcuts).toBeVisible({ timeout: 30_000 });
  await shortcuts.click();
  const actions = page.getByRole("dialog", { name: "Shortcuts", exact: true });
  await expect(actions.getByRole("button", { name: /^Log in as admin\b/ })).toBeVisible();
  await expect(actions.getByText("Service controls", { exact: true })).toHaveCount(0);
  await actions.getByRole("button", { name: "Close shortcuts", exact: true }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  const more = page.getByRole("dialog", { name: "More tools and help", exact: true });
  await expect(more.getByRole("button").first()).toHaveText("Share setup…");
  await expect(more.getByRole("button").nth(1)).toHaveText("Services");
  await more.getByRole("button", { name: "Services", exact: true }).click();
  const services = page.getByRole("dialog", { name: "Services", exact: true });
  const wordpress = services.locator('[data-service-id="wordpress-mariadb"]');
  await expect(wordpress).toContainText("State: running");
  const preview = page.locator("iframe.kweb-frame");
  await preview.evaluate(frame => { frame.setAttribute("data-stop-retention", "same-frame"); });
  await wordpress.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(wordpress).toContainText("State: stopped", { timeout: 120_000 });
  await expect(shortcuts).toHaveCount(0);
  await expect(page.locator(".kweb-service-notice")).toHaveText("Service stopped · Last loaded page");
  await expect(preview).toHaveAttribute("data-stop-retention", "same-frame");
  await services.getByRole("button", { name: "Close Services", exact: true }).click();
  await expect(page.locator(".kweb-service-notice")).toBeVisible();
  const warning = page.locator(".kdock-shell > .kweb-service-notice");
  await expect(warning.locator('svg[aria-hidden="true"]')).toBeVisible();
  const warningBounds = await warning.boundingBox();
  const dockBounds = await page.locator(".kdock-body").boundingBox();
  expect(warningBounds).not.toBeNull();
  expect(dockBounds).not.toBeNull();
  expect(Math.abs(warningBounds!.y + warningBounds!.height - dockBounds!.y)).toBeLessThanOrEqual(1);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/stopped-service-preview.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".kweb-service-notice")).toHaveCount(0);
  await expect(preview).toHaveAttribute("data-stop-retention", "same-frame");
  await page.getByRole("button", { name: "Web", exact: true }).click();
  await expect(warning).toBeVisible();
  await clickDockTool(page, "Services");
  await wordpress.getByRole("button", { name: "Start", exact: true }).click();
  await expect(wordpress).toContainText("State: running", { timeout: 120_000 });
  await expect(shortcuts).toBeVisible();
  await expect(page.locator(".kweb-service-notice")).toHaveCount(0);
  await wordpress.getByRole("checkbox", { name: "Start on boot", exact: true }).click();
  await expect(wordpress.getByRole("checkbox", { name: "Start on boot", exact: true })).not.toBeChecked({ timeout: 30_000 });
  await expect(shortcuts).toBeVisible();
  await wordpress.getByRole("checkbox", { name: "Start on boot", exact: true }).click();
  await expect(wordpress.getByRole("checkbox", { name: "Start on boot", exact: true })).toBeChecked({ timeout: 30_000 });
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/services-and-shortcuts.png"), animations: "disabled" });
  await services.getByRole("button", { name: "Close Services", exact: true }).click();
  await clickDockTool(page, "Internals");
  await internals.getByRole("tab", { name: "Syslog", exact: true }).click();
  await expect(internals).not.toContainText("KANDELO_SERVICES");
  await expect(internals).not.toContainText("connecting to socket");
  await setInternalsOpen(page, false);
});

test("Config shows the mounted filesystem and refreshes kernel memory counters and retention", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await shell(page);
  const computer = await currentComputerMetadata(page);
  await clickDockTool(page, "Internals");
  const internals = page.getByRole("dialog", { name: "Internals", exact: true });
  await internals.getByRole("tab", { name: "Config", exact: true }).click();
  const configuration = internals.getByRole("table", { name: "Filesystem configuration", exact: true });
  await expect(configuration.getByRole("rowheader", { name: "Storage format", exact: true }).locator("..")).toContainText(computer.storageFormat);
  await expect(configuration.getByRole("rowheader", { name: "OPFS directory", exact: true }).locator("..")).toContainText(`kandelo/computers/${computer.id}/filesystem`);
  await expect(configuration.getByRole("rowheader", { name: "Base checking", exact: true }).locator("..")).toContainText("CRC32C");
  await expect(configuration.getByRole("rowheader", { name: "Retention", exact: true }).locator("..")).toContainText("Temporary");
  const base = await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory();
    const kandelo = await root.getDirectoryHandle("kandelo");
    const computers = await kandelo.getDirectoryHandle("computers");
    const computer = await computers.getDirectoryHandle(id);
    const filesystem = await computer.getDirectoryHandle("filesystem");
    const metadata = JSON.parse(await (await (await filesystem.getFileHandle(`computer-${id}.base.json`)).getFile()).text());
    const file = await (await filesystem.getFileHandle(metadata.imageFileName ?? `computer-${id}.base`)).getFile();
    return { generation: metadata.generation ?? 0, file: file.name, size: file.size };
  }, computer.id);
  for (const [label, value] of [["Base generation", String(base.generation)], ["Mounted base file", base.file], ["Base file size", `${base.size.toLocaleString()} bytes`]]) {
    await expect(configuration.getByRole("rowheader", { name: label, exact: true }).locator("..")).toContainText(value);
  }
  await expect(internals.getByText("kandelo.image_hash", { exact: true })).toHaveCount(0);
  const memory = internals.getByRole("table", { name: "Filesystem memory admission", exact: true });
  await expect(memory.getByRole("rowheader", { name: "journal_writeback", exact: true })).toBeVisible();
  const namespace = memory.getByRole("rowheader", { name: "namespace", exact: true }).locator("..").getByRole("cell").first();
  const before = Number((await namespace.innerText()).replaceAll(",", ""));
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/internals-filesystem-config.png"), animations: "disabled" });
  await setInternalsOpen(page, false);
  await runTerminalCommand(page, "mkdir /home/projects/config-memory-test; for index in {1..96}; do : > /home/projects/config-memory-test/entry-$index; done; printf 'CONFIG_MEMORY_CHANGED\\n'", "CONFIG_MEMORY_CHANGED");
  await clickDockTool(page, "Internals");
  await internals.getByRole("button", { name: "Refresh filesystem details", exact: true }).click();
  await expect.poll(async () => Number((await namespace.innerText()).replaceAll(",", ""))).toBeGreaterThan(before);
  await setInternalsOpen(page, false);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator(`[data-computer-id="${computer.id}"]`).getByRole("button", { name: "Keep this computer", exact: true }).click();
  await expect(page.locator(`[data-computer-id="${computer.id}"]`).getByText("Saved on this device", { exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Computer Library", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await clickDockTool(page, "Internals");
  await expect(configuration.getByRole("rowheader", { name: "Retention", exact: true }).locator("..")).toContainText("Saved computer");
});

test("Kandelo Dark defaults consistently and saved theme choices survive reload", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const root = document.documentElement;
      if (root?.dataset.kTheme && root.dataset.kMode && root.dataset.kModePreference && !root.dataset.testInitialTheme) {
        root.dataset.testInitialTheme = `${root.dataset.kTheme}/${root.dataset.kMode}/${root.dataset.kModePreference}`;
      }
    });
    observer.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-k-theme", "data-k-mode", "data-k-mode-preference"] });
  });
  await shell(page);
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-k-theme", "kandelo");
  await expect(root).toHaveAttribute("data-k-mode", "dark");
  await expect(root).toHaveAttribute("data-k-mode-preference", "dark");
  await expect(root).toHaveAttribute("data-test-initial-theme", "kandelo/dark/dark");
  await clickDockTool(page, "About Kandelo");
  const about = page.getByRole("dialog", { name: "About Kandelo", exact: true });
  await expect(about.locator("p").first()).toHaveText(/^Kandelo runs real programs in your browser\. It is based on POSIX and aims to be POSIX-compatible\./);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/about-real-programs-dark.png"), animations: "disabled" });
  await about.getByRole("button", { name: "Close", exact: true }).click();
  await clickDockTool(page, "Appearance");
  const appearance = page.getByRole("dialog", { name: "Theme", exact: true });
  await appearance.getByRole("button", { name: "Light", exact: true }).click();
  await expect(root).toHaveAttribute("data-k-mode", "light");
  await appearance.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 120_000 });
  await expect(root).toHaveAttribute("data-k-mode", "light");
  await expect(root).toHaveAttribute("data-k-mode-preference", "light");
  await expect(root).toHaveAttribute("data-test-initial-theme", "kandelo/light/light");
});

test("More exposes secondary tools and community links with keyboard dismissal", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await shell(page);
  await expect(page.getByRole("button", { name: "Shortcuts", exact: true })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Feedback invitation" })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 120_000 });
  await expect(page.locator(".kshell-host:visible .xterm-rows").first()).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 120_000 });
  await expect(page.getByRole("complementary", { name: "Feedback invitation" })).toHaveCount(0);
  const moreButton = page.getByRole("button", { name: "More", exact: true });
  await page.locator(".kdock-more-popover").evaluate(popup => {
    if (!(popup instanceof HTMLElement)) throw new Error("The More popup must be an HTML element");
    popup.addEventListener("beforetoggle", () => queueMicrotask(() => {
      popup.dataset.openingX = popup.style.getPropertyValue("--kdock-popover-x");
      popup.dataset.openingBottom = popup.style.getPropertyValue("--kdock-popover-bottom");
    }), { once: true });
  });
  await moreButton.focus();
  await page.keyboard.press("Space");
  const more = page.getByRole("dialog", { name: "More tools and help", exact: true });
  await expect(more).toBeVisible();
  await expect(more.getByRole("button", { name: "Internals", exact: true })).toBeEnabled();
  await expect(more.getByRole("link", { name: "Send feedback", exact: true })).toHaveAttribute("href", "https://github.com/Automattic/kandelo/issues/new?template=feedback.yml");
  await expect(more.getByRole("link", { name: "Follow the blog", exact: true })).toHaveAttribute("href", "https://kandelo.blog/");
  await expect(more.getByRole("link", { name: "GitHub repository", exact: true })).toHaveAttribute("href", "https://github.com/Automattic/kandelo");
  const popupBounds = await more.boundingBox();
  const buttonBounds = await moreButton.boundingBox();
  const openingBounds = await more.evaluate(popup => ({ centerX: parseFloat(popup.getAttribute("data-opening-x")!), bottom: parseFloat(popup.getAttribute("data-opening-bottom")!) }));
  expect(popupBounds).not.toBeNull(); expect(buttonBounds).not.toBeNull();
  expect(Math.abs(openingBounds.centerX - (popupBounds!.x + popupBounds!.width / 2))).toBeLessThan(1);
  expect(Math.abs(openingBounds.bottom - (page.viewportSize()!.height - popupBounds!.y - popupBounds!.height))).toBeLessThan(1);
  expect(popupBounds!.y + popupBounds!.height).toBeLessThanOrEqual(buttonBounds!.y);
  expect(popupBounds!.x).toBeLessThan(buttonBounds!.x + buttonBounds!.width / 2);
  expect(popupBounds!.x + popupBounds!.width).toBeGreaterThan(buttonBounds!.x + buttonBounds!.width / 2);
  await page.keyboard.press("Escape");
  await expect(more).not.toBeVisible(); await expect(moreButton).toBeFocused();
  await page.keyboard.press("Space");
  await expect(more).toBeVisible();
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/more-menu-positioned.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await clickDockTool(page, "Internals");
  await expect(page.getByRole("checkbox", { name: "Show raw log", exact: true })).toBeVisible();
  await setInternalsOpen(page, false);
  await expect(page.getByRole("dialog", { name: "Internals", exact: true })).not.toBeVisible();
  await clickDockTool(page, "Appearance");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await clickDockTool(page, "Appearance");
  await clickDockTool(page, "About Kandelo");
  const about = page.getByRole("dialog", { name: "About Kandelo", exact: true });
  await expect(about).toBeVisible();
  await expect(about.locator("p")).toHaveCount(2);
  await expect(about.locator("p").first()).toHaveText(/^Kandelo runs real programs in your browser\. It is based on POSIX and aims to be POSIX-compatible\./);
  await expect(about).not.toContainText("Linux");
  await expect(about.getByRole("link", { name: "GitHub repository", exact: true })).toHaveAttribute("href", "https://github.com/Automattic/kandelo");
  await about.getByRole("button", { name: "Close", exact: true }).click();
  await expect(moreButton).toBeFocused();
  await clickDockTool(page, "Share setup…");
  await expect(page.getByText("Shares the starting image, not this computer’s saved files. Use an image export to transfer your changes.")).toBeVisible();
});

test("popin dialogs use icon close controls and dismiss only on outside clicks", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await shell(page);
  await clickDockTool(page, "About Kandelo");
  const about = page.getByRole("dialog", { name: "About Kandelo", exact: true });
  await expect(about.getByRole("button", { name: "Close", exact: true })).toHaveText("×");
  await about.click({ position: { x: 4, y: 4 } });
  await expect(about).toBeVisible();
  const heading = await about.locator("h2").boundingBox();
  expect(heading).not.toBeNull();
  await page.mouse.move(heading!.x + 4, heading!.y + 4);
  await page.mouse.down();
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await expect(about).toBeVisible();
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/about-posix-dialog.png"), animations: "disabled" });
  await page.mouse.click(1, 1);
  await expect(about).not.toBeVisible();
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Web", exact: true }).click();
  const website = page.getByRole("dialog", { name: "Open website", exact: true });
  await expect(website.getByRole("button", { name: "Close", exact: true })).toHaveText("×");
  await expect(website.locator(".kcomputer-actions").getByRole("button")).toHaveCount(1);
  await website.click({ position: { x: 4, y: 4 } });
  await expect(website).toBeVisible();
  await page.mouse.click(1, 1);
  await expect(website).not.toBeVisible();
  await page.getByRole("button", { name: "Web", exact: true }).click();
  await website.getByRole("button", { name: "Close", exact: true }).click();
  await expect(website).not.toBeVisible();
  await page.getByRole("button", { name: "Web", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(website).not.toBeVisible();

  await clickDockTool(page, "Share setup…");
  const sharing = page.locator(".kshare[role='dialog']:not(.knetwork)");
  await expect(sharing.locator(".kshare-actions").getByRole("button", { name: /Close|Cancel/ })).toHaveCount(0);
  await expect(sharing.getByRole("button", { name: "Close", exact: true })).toHaveText("✕");
  await page.mouse.click(1, 1);
  await expect(sharing).not.toBeVisible();

  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const network = page.locator(".knetwork[role='dialog']");
  await expect(network.locator(".kshare-actions").getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
  await expect(network.getByRole("button", { name: "Close", exact: true })).toHaveText("✕");
  await page.mouse.click(1, 1);
  await expect(network).not.toBeVisible();

  for (const tool of ["Library", "Activities"] as const) {
    await page.getByRole("button", { name: tool, exact: true }).click();
    const pane = page.locator(".kdock-pane");
    await expect(pane.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await page.mouse.click(1, 1);
    await expect(pane).not.toBeVisible();
  }
  for (const tool of ["Internals", "Appearance"] as const) {
    const pane = page.getByRole("dialog", { name: tool === "Appearance" ? "Theme" : tool, exact: true });
    await clickDockTool(page, tool);
    await pane.getByRole("button", { name: "Close", exact: true }).click();
    await expect(pane).not.toBeVisible();
    await clickDockTool(page, tool);
    await page.mouse.click(1, 1);
    await expect(pane).not.toBeVisible();
  }
});

test("the full-width dock centers tools independently of the computer label", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await shell(page);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const computerId = new URL(page.url()).searchParams.get("computer");
  if (!computerId) throw new Error("The shell must have a computer identity");
  const entry = page.locator(`[data-computer-id="${computerId}"]`);
  await entry.getByRole("button", { name: "Rename", exact: true }).click();
  const name = "An unusually long computer name that must not offset the dock buttons";
  await entry.getByRole("textbox", { name: "Computer name" }).fill(name);
  await entry.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(entry.locator("strong")).toHaveText(name);
  await page.getByRole("dialog", { name: "Computer Library", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  for (const width of [1280, 960, 700]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.locator(".kdock").evaluate(strip => {
      const buttons = strip.querySelectorAll(".kdock-item");
      const first = buttons[0]!.getBoundingClientRect();
      const last = buttons[buttons.length - 1]!.getBoundingClientRect();
      return Math.abs((first.left + last.right) / 2 - innerWidth / 2);
    })).toBeLessThan(2);
    expect(await page.locator(".kdock-status").evaluate(label => {
      const status = label.getBoundingClientRect();
      const tool = document.querySelector(".kdock-item")!.getBoundingClientRect();
      return status.left < tool.right && status.right > tool.left && status.top < tool.bottom && status.bottom > tool.top;
    })).toBe(false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator(".kdock").evaluate(strip => Math.abs(strip.getBoundingClientRect().left + strip.getBoundingClientRect().width / 2 - innerWidth / 2))).toBeLessThan(2);
  await expect(page.locator(".kdock-temporary-badge")).toBeVisible();
  await page.getByRole("button", { name: "Hide dock tools", exact: true }).click();
  await expect(page.getByRole("button", { name: "Library", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show dock tools", exact: true }).click();
  await expect(page.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/dock-centered-mobile.png"), animations: "disabled" });
});

test("the website picker opens an undeclared port and preserves the preview on failure", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  await shell(page); await server(page);
  await page.getByRole("button", { name: "Web", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open website", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Protocol", exact: true }).locator("option")).toHaveText(["http://"]);
  await expect(dialog.getByRole("combobox", { name: "Protocol", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "Computer", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Port", { exact: true })).toBeFocused();
  await expect(dialog.getByRole("combobox", { name: "Computer", exact: true }).locator("option")).toHaveText(["This computer (localhost)"]);
  await dialog.getByRole("button", { name: "Open website", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("No in-kernel listener for port 3000");
  await expect(dialog.getByRole("alert")).toHaveClass("kopen-website-warning");
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/preview-origin-warning.png"), animations: "disabled" });
  await dialog.getByLabel("Port", { exact: true }).fill("38467");
  await dialog.getByLabel("Path", { exact: true }).fill("//example.com/");
  await dialog.getByRole("button", { name: "Open website", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("single /");
  await dialog.getByLabel("Path", { exact: true }).fill("/picker");
  await dialog.getByRole("button", { name: "Open website", exact: true }).click();
  const frame = page.frameLocator("iframe.kweb-frame");
  await expect(frame.locator("body")).toContainText("arbitrary guest service /picker", { timeout: 120_000 });
  const origin = page.getByRole("button", { name: "Change website target (http://localhost:38467)", exact: true });
  await expect(origin).toHaveText("http://localhost:38467");
  await expect(page.getByRole("button", { name: "Open website", exact: true })).toHaveCount(0);
  const widths = await page.locator(".kweb-urlbar").evaluate(toolbar => ({
    toolbar: toolbar.getBoundingClientRect().width,
    origin: toolbar.querySelector(".kweb-origin")!.getBoundingClientRect().width,
    path: toolbar.querySelector("input")!.getBoundingClientRect().width,
  }));
  expect(widths.origin).toBeLessThan(widths.toolbar * .4);
  expect(widths.path).toBeGreaterThan(widths.origin);
  await page.getByRole("textbox", { name: "Preview URL path", exact: true }).fill("/picker-next");
  await page.getByRole("textbox", { name: "Preview URL path", exact: true }).press("Enter");
  await expect(frame.locator("body")).toContainText("arbitrary guest service /picker-next");
  const original = await page.locator("iframe.kweb-frame").getAttribute("src");
  await origin.click();
  await expect(dialog.getByRole("combobox", { name: "Computer", exact: true })).toHaveValue("localhost");
  await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("38467");
  await expect(dialog.getByLabel("Path", { exact: true })).toHaveValue("/picker-next");
  await dialog.getByLabel("Path", { exact: true }).fill("/failure");
  await dialog.getByRole("button", { name: "Open website", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("HTTP 503");
  await expect(dialog.getByRole("alert")).toHaveClass("kopen-website-warning");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(frame.locator("body")).toContainText("arbitrary guest service /picker-next");
  expect(await page.locator("iframe.kweb-frame").getAttribute("src")).toBe(original);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => origin.evaluate(button => button.getBoundingClientRect().width / button.closest("form")!.getBoundingClientRect().width)).toBeLessThan(.6);
  await expect.poll(() => page.locator(".kweb-urlbar input").evaluate(input => input.getBoundingClientRect().width)).toBeGreaterThan(100);
  await expect.poll(() => origin.evaluate(button => button.getBoundingClientRect().width)).toBeGreaterThan(140);
  await expect(origin).toBeVisible();
  if (testInfo.project.name === "chromium") await page.screenshot({ path: resolve(import.meta.dirname, "../../../.context/preview-origin-mobile.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Hide dock tools", exact: true }).click();
  await expect(origin).toBeVisible();
  await page.getByRole("button", { name: "Show dock tools", exact: true }).click();
  await expect.poll(() => origin.evaluate(button => button.getBoundingClientRect().width)).toBeGreaterThan(140);
  if (viewport) await page.setViewportSize(viewport);
});

test("kandelo-preview selects Web and leaves the command and terminal usable", async ({ page }) => {
  test.setTimeout(360_000);
  await shell(page); await server(page);
  await page.getByRole("textbox", { name: "Terminal input" }).first().focus();
  await page.keyboard.insertText("kandelo-preview 'http://localhost:38467/command?q=yes#anchor'; printf 'PREVIEW_COMMAND_EXIT:%s\\n' \"$?\"");
  await expect(page.locator(".kshell-host:visible .xterm-rows").first()).toContainText("http://localhost:38467/command?q=yes#anchor");
  await page.keyboard.press("Enter");
  await expect(page.frameLocator("iframe.kweb-frame").locator("body")).toContainText("arbitrary guest service /command?q=yes", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Web", exact: true })).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".kshell-host:visible .xterm-rows").first()).toContainText("PREVIEW_COMMAND_EXIT:0");
  await runTerminalCommand(page, "kandelo-preview 'http://localhost:38467/failure'; printf '%s%s\\n' FAILED_PREVIEW_ SENT", "FAILED_PREVIEW_SENT");
  await expect(page.getByRole("alert")).toContainText("Preview failed: Web server returned HTTP 503");
  await page.getByRole("button", { name: "Dismiss preview error", exact: true }).click();
  await runTerminalCommand(page, "kandelo-preview --help; printf '%s%s\\n' PREVIEW_HELP_ OK", "PREVIEW_HELP_OK");
  await page.getByRole("button", { name: "Web", exact: true }).click();
  await expect(page.frameLocator("iframe.kweb-frame").locator("body")).toContainText("arbitrary guest service /command?q=yes");
});

test("structured image progress coalesces while raw syslog retains every update", async ({ page }) => {
  test.setTimeout(240_000);
  await shell(page); await clickDockTool(page, "Internals");
  const operations = page.locator(".ksys-line[data-progress-operation]");
  const ids = await operations.evaluateAll(rows => rows.map(row => row.getAttribute("data-progress-operation")));
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  const writing = page.locator('.ksys-line[data-progress-operation$="/persistent-image/write"]');
  const verifying = page.locator('.ksys-line[data-progress-operation$="/persistent-image/verify"]');
  await expect(writing).toHaveCount(1);
  await expect(verifying).toHaveCount(1);
  await expect(writing).toContainText("persistent image write:");
  await expect(verifying).toContainText("persistent image verify:");
  await page.getByRole("checkbox", { name: "Show raw log", exact: true }).check();
  expect(await operations.count()).toBeGreaterThan(ids.length);
  expect(await writing.count()).toBeGreaterThan(1);
  expect(await verifying.count()).toBeGreaterThan(1);
  await page.getByRole("checkbox", { name: "Show raw log", exact: true }).uncheck();
  expect(await operations.count()).toBe(ids.length);
});

test("the picker previews an undeclared service on another connected Kandelo", async ({ page, browser, context, browserName }) => {
  test.skip(browserName !== "chromium", "the local peer fixture requires Chromium loopback candidates");
  test.setTimeout(480_000);
  await context.grantPermissions(["microphone"]);
  await shell(page); await server(page);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const form = page.getByRole("form", { name: "Host activity", exact: true });
  await form.getByRole("combobox", { name: "Activity", exact: true }).selectOption("");
  await form.getByRole("button", { name: "Start network session", exact: true }).click();
  const link = page.locator("[data-network-link]");
  await expect(link).toHaveAttribute("data-network-link", /[?&]network=[a-z]+/, { timeout: 120_000 });
  const invite = (await link.getAttribute("data-network-link"))!;
  const peerContext = await browser.newContext({ permissions: ["microphone"] });
  try {
    const peer = await peerContext.newPage();
    await peer.goto(invite);
    await expect(peer.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
    await peer.getByRole("button", { name: "Join session", exact: true }).click();
    await expect(peer.getByRole("button", { name: "Network session: connected", exact: true })).toBeVisible({ timeout: 120_000 });
    await peer.locator(".knetwork .kshare-x").click();
    await peer.getByRole("button", { name: "Web", exact: true }).click();
    const picker = peer.getByRole("dialog", { name: "Open website", exact: true });
    await expect(picker.getByRole("combobox", { name: "Computer", exact: true }).locator('option[value="10.89.0.1"]')).toContainText("Host");
    await expect(picker.getByRole("combobox", { name: "Computer", exact: true })).toBeEnabled();
    await picker.getByRole("combobox", { name: "Computer", exact: true }).selectOption("10.89.0.1");
    await picker.getByLabel("Port", { exact: true }).fill("38467");
    await picker.getByLabel("Path", { exact: true }).fill("/remote");
    await picker.getByRole("button", { name: "Open website", exact: true }).click();
    await expect(peer.frameLocator("iframe.kweb-frame").locator("body")).toContainText("arbitrary guest service /remote", { timeout: 120_000 });
    await peer.getByRole("button", { name: "Change website target (http://10.89.0.1:38467)", exact: true }).click();
    await expect(picker.getByRole("combobox", { name: "Computer", exact: true })).toHaveValue("10.89.0.1");
    await expect(picker.getByLabel("Port", { exact: true })).toHaveValue("38467");
    await expect(picker.getByLabel("Path", { exact: true })).toHaveValue("/remote");
  } finally { await peerContext.close(); }
});
