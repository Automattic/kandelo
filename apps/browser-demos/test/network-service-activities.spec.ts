import { expect, test, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
test.use({ actionTimeout: 30_000 });
const running = async (p: Page) => {
  await expect(p.locator(".kdock-status-text")).toHaveAttribute("data-status", /^(running|error)$/, { timeout: 240_000 });
  if (await p.locator(".kdock-status-text").getAttribute("data-status") === "error") {
    console.error("Activity boot failure", p.url(), await p.locator("body").innerText());
    throw new Error("Activity computer failed to boot; see its native diagnostics above");
  }
};
const terminal = async (p: Page) => {
  await p.getByRole("button", { name: "Terminal", exact: true }).click();
  return p.locator(".kshell-host:visible .xterm-rows").innerText();
};
async function share(p: Page, activity: string, offer = "service") {
  await running(p);
  await p.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const form = p.getByRole("form", { name: "Host activity" });
  await form.getByLabel("Activity", { exact: true }).selectOption(`${activity}/${offer}`);
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  await form.getByRole("button", { name: "Show join link", exact: true }).click();
  await expect(p.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 90_000 });
  const link = (await p.locator("[data-network-link]").getAttribute("data-network-link"))!;
  // The package requests the standard client computer, without a demo profile.
  expect(new URL(link).searchParams.has("profile")).toBe(false);
  expect(new URL(link).searchParams.get("vfs")).not.toBe(new URL(p.url()).searchParams.get("vfs"));
  await p.locator(".knetwork .kshare-x").click();
  return link;
}
async function enter(p: Page, text: string) {
  await terminal(p);
  await p.locator(".kshell-host:visible .xterm-helper-textarea").focus();
  await p.keyboard.type(text); await p.keyboard.press("Enter");
}
test.beforeEach(async ({ context, browserName, page }) => {
  page.on("pageerror", error => console.error("Activity page error:", error.message));
  page.on("console", message => { if (message.type() === "error") console.error("Activity browser error:", message.text()); });
  test.skip(browserName !== "chromium", "the local WebRTC fixture needs Chromium loopback candidates");
  await context.grantPermissions(["microphone"]);
});
for (const [profile, pkg, title, marker] of [
  ["nginx", "nginx-vfs", "nginx website", "nginx"],
  ["nginx-php", "nginx-php-vfs", "nginx and PHP website", "Database schema"],
  ["nginx-python", "nginx-python-vfs", "nginx and Python website", "Python"],
  ["wordpress-sqlite", "wordpress", "WordPress website", "Hello world!"],
  ["wordpress-mariadb", "lamp", "WordPress with MariaDB", "Hello world!"],
  ["ruby-todo", "ruby-todo-vfs", "Ruby todo app", "todo"],
]) {
  test(`${title} invites a separate client without starting another service`, async ({ page, browser }) => {
    test.setTimeout(480_000);
    await gotoMachine(page, profile);
    const link = await share(page, pkg);
    const context = await browser.newContext({ permissions: ["microphone"] });
    const guest = await context.newPage();
    try {
      await guest.goto(link); await running(guest);
      const form = guest.getByRole("form", { name: "Join activity" });
      await form.getByRole("button", { name: `Join and open ${title}`, exact: true }).click();
      const frame = guest.frameLocator("iframe.kweb-frame");
      await expect(frame.locator("body")).toContainText(new RegExp(marker, "i"), { timeout: 150_000 });
      await expect(guest.getByRole("button", { name: "Web", exact: true })).toBeEnabled();
      if (pkg === "wordpress") {
        const address = guest.getByRole("textbox", { name: "Preview URL path" });
        await address.fill("/wp-login.php"); await address.press("Enter");
        await expect(frame.locator("#loginform")).toBeVisible({ timeout: 120_000 });
        await frame.locator("#user_login").fill("admin");
        await frame.locator("#user_pass").fill("password");
        await frame.locator("#wp-submit").click();
        await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({ timeout: 120_000 });
      }
      if (pkg === "ruby-todo-vfs") {
        await frame.getByPlaceholder("What needs doing?").fill("Added through a Kandelo invitation");
        await frame.getByRole("button", { name: "Add", exact: true }).click();
        await expect(frame.locator("body")).toContainText("Added through a Kandelo invitation");
        await page.getByRole("button", { name: "Web", exact: true }).click();
        await page.getByRole("button", { name: "Reload preview", exact: true }).click();
        await expect(page.frameLocator("iframe.kweb-frame").locator("body")).toContainText("Added through a Kandelo invitation");
      }
      await guest.screenshot({ path: `../../.context/activity-${pkg}-client.png` });
      await terminal(guest);
      await guest.getByRole("button", { name: "New terminal", exact: true }).click();
      await expect.poll(() => terminal(guest)).toContain("kandelo$");
      const processes = await runTerminalCommand(guest, "ps -A");
      expect(processes.exitCode).toBe(0);
      expect(processes.output).not.toMatch(/nginx|php-fpm|mariadbd|redis-server|server\.rb|elinks/);
    } finally { await context.close(); }
  });
}
test("Redis voting board shares real Redis data with a separate web client", async ({ page, browser }) => {
  test.setTimeout(480_000);
  await gotoMachine(page, "redis");
  await running(page);
  const hostBoard = page.frameLocator("iframe.kweb-frame");
  await expect(hostBoard.getByRole("heading", { name: "What should we do next?" })).toBeVisible();
  expect(await hostBoard.locator("body").evaluate(() =>
    Boolean((window as unknown as { __kandeloBlobIframePatched?: boolean }).__kandeloBlobIframePatched),
  )).toBe(true);
  const link = await share(page, "redis-vfs");
  const context = await browser.newContext({ permissions: ["microphone"] });
  const guest = await context.newPage();
  try {
    await guest.goto(link); await running(guest);
    await guest.getByRole("form", { name: "Join activity" }).getByRole("button", { name: "Join and open Redis voting board", exact: true }).click();
    const board = guest.frameLocator("iframe.kweb-frame");
    await board.getByRole("textbox", { name: "Your idea" }).fill("Ship a tiny shared website");
    await board.getByRole("button", { name: "Add idea", exact: true }).click();
    const vote = board.getByRole("button", { name: "Vote for Ship a tiny shared website", exact: true });
    await vote.click();
    await expect(vote.locator(".count")).toHaveText("1");
    await vote.click();
    await expect(vote.locator(".count")).toHaveText("2");
    await expect(hostBoard.getByRole("button", { name: "Vote for Ship a tiny shared website" }).locator(".count")).toHaveText("2", { timeout: 30_000 });
    await hostBoard.getByRole("button", { name: "Vote for Ship a tiny shared website" }).click();
    await expect(vote.locator(".count")).toHaveText("3", { timeout: 30_000 });
    const invalid = await board.locator("body").evaluate(async () => {
      const response = await fetch("./api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", title: "" }) });
      return { status: response.status, body: await response.json() };
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("nonempty");
    await guest.screenshot({ path: "../../.context/activity-redis-board-client.png" });
    // Exercise the actual upstream PHP application across the invited network,
    // including its session cookie/CSRF flow, command errors and real writes.
    await board.getByRole("link", { name: "Explore Redis", exact: true }).click();
    await expect(board.getByRole("heading", { name: "Console", exact: true })).toBeVisible({ timeout: 60_000 });
    expect(await board.locator("body").evaluate(() =>
      Boolean((window as unknown as { __kandeloBlobIframePatched?: boolean }).__kandeloBlobIframePatched),
    )).toBe(false);
    const command = board.getByRole("textbox", { name: "Command", exact: true });
    const reply = board.locator(".console-entry").last();
    await command.fill("HGETALL board:ideas");
    await command.press("Enter");
    await expect(reply).toContainText("Ship a tiny shared website");
    await command.fill("ZINCRBY board:votes 2 4");
    await command.press("Enter");
    await expect(reply).toContainText("5");
    await expect(hostBoard.getByRole("button", { name: "Vote for Ship a tiny shared website" }).locator(".count")).toHaveText("5", { timeout: 30_000 });
    await command.press("ArrowUp");
    await expect(command).toHaveValue("ZINCRBY board:votes 2 4");
    await command.fill("THIS_IS_NOT_A_REDIS_COMMAND");
    await command.press("Enter");
    await expect(reply).toContainText(/unknown command/i);
    // Keep the upstream policy effective while its own nonced console scripts
    // run. A new unapproved inline script must still be refused by the browser.
    const policy = await board.locator("body").evaluate(async () => new Promise<{ directive: string; ran: boolean }>(resolve => {
      document.addEventListener("securitypolicyviolation", event => resolve({
        directive: event.effectiveDirective,
        ran: Boolean((window as unknown as { __redisCspTest?: boolean }).__redisCspTest),
      }), { once: true });
      const script = document.createElement("script");
      script.textContent = "window.__redisCspTest = true";
      document.head.appendChild(script);
    }));
    expect(policy).toEqual({ directive: "script-src-elem", ran: false });
    await guest.screenshot({ path: "../../.context/activity-redis-command-console.png" });
    await board.getByRole("link", { name: "Keys", exact: true }).click();
    await expect(board.locator("body")).toContainText("board:ideas");
    await board.getByRole("link", { name: "Go to homepage", exact: true }).click();
    await expect(vote.locator(".count")).toHaveText("5", { timeout: 30_000 });
    const privateFiles = await board.locator("body").evaluate(async () => {
      return Promise.all(["config.php", "predis.phar", "templates/layout.twig"].map(async path =>
        (await fetch(`./admin/${path}`)).status));
    });
    expect(privateFiles).toEqual([404, 404, 404]);
    await terminal(guest);
    await guest.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect.poll(() => terminal(guest)).toContain("kandelo$");
    const ideas = await runTerminalCommand(guest, "redis-cli -h host HGET board:ideas 4");
    expect(ideas.exitCode).toBe(0);
    expect(ideas.output).toContain("Ship a tiny shared website");
    const votes = await runTerminalCommand(guest, "redis-cli --raw -h host ZSCORE board:votes 4");
    expect(votes.exitCode).toBe(0);
    expect(votes.output.trim()).toBe("5");
    const processes = await runTerminalCommand(guest, "ps -A");
    expect(processes.output).not.toMatch(/redis-server|php -n -S/);
  } finally { await context.close(); }
});

test("WordPress MySQL connection opens a real interactive client on the website database", async ({ page, browser }) => {
  test.setTimeout(480_000);
  await gotoMachine(page, "wordpress-mariadb");
  const link = await share(page, "lamp", "database");
  const context = await browser.newContext({ permissions: ["microphone"] });
  const guest = await context.newPage();
  try {
    await guest.goto(link); await running(guest);
    await guest.getByRole("form", { name: "Join activity" }).getByRole("button", { name: "Join and open WordPress MySQL connection", exact: true }).click();
    await expect.poll(() => terminal(guest), { timeout: 120_000 }).toContain("MariaDB [wordpress]>");
    await enter(guest, "SELECT CONCAT('remote-', option_name) AS proof FROM wp_options WHERE option_name = 'blogname';");
    await expect.poll(() => terminal(guest)).toContain("remote-blogname");
    await enter(guest, "SELECT CONCAT('history-result-', @history_count := COALESCE(@history_count, 0) + 1);");
    await expect.poll(() => terminal(guest)).toContain("history-result-1");
    // Readline's non-incremental reverse search (Alt-P) must recall and run
    // the query, including freeing the temporary history entry it saved.
    await guest.locator(".kshell-host:visible .xterm-helper-textarea").focus();
    await guest.keyboard.press("Escape"); await guest.keyboard.press("p");
    await guest.keyboard.type("history-result-");
    await guest.keyboard.press("Enter"); await guest.keyboard.press("Enter");
    await expect.poll(() => terminal(guest)).toContain("history-result-2");
    await enter(guest, "UPDATE wp_options SET option_value = 'Shared SQL website' WHERE option_name = 'blogname';");
    await expect.poll(() => terminal(guest)).toContain("Query OK");
    await page.getByRole("button", { name: "Web", exact: true }).click();
    await page.getByRole("button", { name: "Reload preview", exact: true }).click();
    await expect(page.frameLocator("iframe.kweb-frame").locator("body")).toContainText("Shared SQL website", { timeout: 120_000 });
    await guest.screenshot({ path: "../../.context/activity-wordpress-mysql-client.png" });
    await enter(guest, "quit");
    await expect.poll(() => terminal(guest)).toContain("Bye");
    const room = new URL(link).searchParams.get("network");
    await guest.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await guest.getByRole("button", { name: "Change activity", exact: true }).click();
    const activities = guest.getByLabel("Activity", { exact: true });
    await expect(activities.locator("option")).toHaveText(["Keep current activity", "WordPress with MariaDB"]);
    await expect(guest.getByRole("form", { name: "Host activity" })).toHaveCount(0);
    await activities.selectOption("lamp/service");
    await guest.screenshot({ path: "../../.context/session-remote-activities.png" });
    await guest.getByRole("button", { name: "Join and open WordPress with MariaDB", exact: true }).click();
    await expect(guest.frameLocator("iframe.kweb-frame").locator("body")).toContainText("Shared SQL website", { timeout: 120_000 });
    await guest.getByRole("button", { name: "Network session: connected", exact: true }).click();
    expect(new URL((await guest.locator("[data-network-link]").getAttribute("data-network-link"))!).searchParams.get("network")).toBe(room);
    await guest.getByRole("button", { name: "Change activity", exact: true }).click();
    await expect(activities.locator("option")).toHaveText(["Keep current activity", "WordPress MySQL connection"]);
  } finally { await context.close(); }
});
