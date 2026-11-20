import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { writeVfsFile } from "../../../host/src/vfs/image-helpers";
import { DELO_VERBS } from "../pages/delo/src/command";
import { createDeloDraft } from "../pages/delo/src/draft";
import { planDeloAdd } from "../pages/delo/src/packages";
import { deloImages, findDeloImage, parseDeloRegistry } from "../pages/delo/src/registry";
import { appUrl, gotoMachine } from "./support/kandelo-machine";
import { assertTerminalCommandResult, buildTerminalCommand, parseTerminalCommandResult } from "./support/terminal-command";

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = parseDeloRegistry(readFileSync(new URL("../pages/delo/src/registry.json", import.meta.url), "utf8"));
const IMAGES = deloImages(REGISTRY);
const RAYTRACER = "@mho22/raytracer";
const RAYTRACER_SPACEFAST = "@mho22/raytracer-spacefast";

async function runDelo(page: import("@playwright/test").Page, line: string): Promise<void> {
  const input = page.getByRole("combobox", { name: "delo command" });
  await input.fill(line);
  await input.press("Enter");
}

const onComputerPage = (url: URL) => url.pathname.endsWith("/pages/delo/computer/") && url.searchParams.get("computer") !== null;

/** Answer `url` with an image Delo builds with base-files and bash, whose
 *  `/etc/kandelo/demo.json` declares `profile`. The page's service worker
 *  fetches an image through the dev server's CORS proxy, so both addresses
 *  are routed. */
async function routeImage(page: import("@playwright/test").Page, url: string, profile: string): Promise<void> {
  let draft = createDeloDraft("foo");
  for (const name of ["base-files", "bash"]) draft = { name: draft.name, ...planDeloAdd(REGISTRY, draft, name).configuration };
  const encoded = await page.evaluate(async ([client, registry, current]) => {
    const { buildDeloImage } = await import(client);
    const { image }: { image: Uint8Array } = await buildDeloImage(registry, current.name, { description: "", pipeline: current.pipeline, firstProcess: current.firstProcess, added: current.added });
    let binary = "";
    for (let at = 0; at < image.length; at += 0x8000) binary += String.fromCharCode(...image.subarray(at, at + 0x8000));
    return btoa(binary);
  }, [appUrl("/pages/delo/src/computer-image-client.ts"), REGISTRY, draft] as const);
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(Buffer.from(encoded, "base64")));
  writeVfsFile(fs, "/etc/kandelo/demo.json", `${JSON.stringify({ version: 1, defaultProfile: profile, profiles: { [profile]: {} } })}\n`, 0o644);
  const image = Buffer.from(fs.exportImage());
  await page.context().route((route) => route.href === url || route.searchParams.get("url") === url, (route) => route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: image }));
}

/** Open `delo config <title>` on its files pane, and return the view. */
async function openFiles(page: import("@playwright/test").Page, title: string) {
  await runDelo(page, `delo config ${title}`);
  const settings = page.getByRole("region", { name: "computer settings" });
  await settings.getByRole("button", { name: "files" }).click();
  return settings;
}

async function filesOfImageComputer(page: import("@playwright/test").Page, title: string): Promise<void> {
  const settings = await openFiles(page, title);
  const rows = settings.locator(".delo-list-row");
  await expect(settings.locator(".delo-view-status")).toHaveText("disk open", { timeout: 120_000 });
  const download = settings.locator(".delo-view-actions").getByRole("button");
  await expect(download).toHaveText(["download"]);
  await expect(settings.locator(".delo-files-read-only")).toHaveText("read-only");
  for (const folder of ["etc/", "delo/"]) await rows.filter({ hasText: new RegExp(`^${folder}$`) }).click();
  await rows.filter({ hasText: /^config\.json$/ }).click();
  const file = page.waitForEvent("download");
  await download.click();
  const downloaded = await file;
  expect(downloaded.suggestedFilename()).toBe("config.json");
  expect(Object.keys(JSON.parse(readFileSync(await downloaded.path(), "utf8")).written.steps)).toContain("/bin/bash");
  await settings.getByRole("button", { name: "close" }).click();
  await expect(settings).toBeHidden({ timeout: 60_000 });
}

async function runTerminalCommand(page: import("@playwright/test").Page, source: string, expected: string): Promise<void> {
  const protocol = buildTerminalCommand(source);
  await page.getByRole("textbox", { name: "Terminal input" }).focus();
  await page.keyboard.insertText(protocol.command);
  await page.keyboard.press("Enter");
  await expect.poll(async () => parseTerminalCommandResult(await page.locator("#delo-terminal .xterm-rows").innerText(), protocol) !== undefined, { timeout: 180_000 }).toBe(true);
  assertTerminalCommandResult(parseTerminalCommandResult(await page.locator("#delo-terminal .xterm-rows").innerText(), protocol)!, expected);
}

test("delo rejects a shape it does not accept, and a name it does not know", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  for (const line of ["delo load", "delo @mho22/raytracer"]) {
    await runDelo(page, line);
    await expect(page.locator("#delo-output")).toContainText("usage: delo run | list | config | init | save | destroy [name] · delo add | remove | enable | disable [thing] [computer]");
  }
  await runDelo(page, "delo run @foo/bar");
  await expect(page.locator("#delo-output")).toContainText("@foo/bar is not a computer, a registered image or an image URL");
  await runDelo(page, "delo add bash");
  await expect(page.locator("#delo-output")).toContainText("no computer accepts delo add bash");
  await runDelo(page, "delo add bash foo");
  await expect(page.locator("#delo-output")).toContainText("foo is not a computer on this device");
  await expect(page.getByRole("combobox", { name: "delo command" })).toHaveValue("delo add bash foo");
});

test("delo init creates a draft that add, remove, enable and disable change", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const output = page.locator("#delo-output");
  const draft = page.locator(".delo-computer.is-highlighted");
  await runDelo(page, "delo init foo");
  await expect(output).toContainText("foo computer created.");
  await expect(page.getByRole("combobox", { name: "delo command" })).toHaveValue("");
  await expect(draft).toHaveText(/^foonothing to run · no packagesdraft$/);
  await page.getByRole("combobox", { name: "delo command" }).pressSequentially("d");
  await expect(output).toHaveText(/^delo\s*tab completes · enter runs$/);

  await runDelo(page, "delo add login foo");
  await expect(output).toContainText("login to foo");
  await expect(output).toContainText("login is the first process");
  await expect(output).toContainText("login needs a shell. Add one: delo add bash or delo add dash");
  await expect(output).toContainText("login needs a user. Add one: delo add maker-account");
  expect(await output.evaluate((node) => ({ shown: node.clientHeight, scrolls: node.scrollHeight > node.clientHeight, top: node.scrollTop }))).toEqual({ shown: 18, scrolls: true, top: 0 });
  await runDelo(page, "delo add maker-account foo");
  await expect(output).toHaveText("addmaker-account is copied into the pipeline of foo");
  await runDelo(page, "delo add bash foo");
  await runDelo(page, "delo enable internals foo");
  await expect(draft).toHaveText(/^fooruns login · login base-files bash · internalsdraft$/);

  const input = page.getByRole("combobox", { name: "delo command" });
  await input.fill("delo add bash");
  await input.press("Tab");
  await expect(page.getByRole("option")).toHaveCount(0);
  await input.fill("delo add dash");
  await input.press("Tab");
  await expect(page.getByRole("option")).toHaveText([/^foodraft · runs login/]);
  await input.press("Escape");

  await runDelo(page, "delo remove bash foo");
  await expect(output).toContainText("login needs a shell. Add one: delo add bash or delo add dash");
  await runDelo(page, "delo disable internals foo");
  await expect(draft).toHaveText(/^fooruns login · login base-filesdraft$/);
  await runDelo(page, "delo remove base-files foo");
  await expect(output).toContainText("The computer's pipeline adds to /etc/passwd /etc/group /etc/shadow, which base-files writes.");
  await runDelo(page, "delo add base-files foo");
  await expect(output).toContainText("base-files is already installed");
  await runDelo(page, "delo remove maker-account foo");
  await expect(output).toContainText("maker-account is a pipeline the computer has a copy of. Remove its binaries one by one.");
  await runDelo(page, "delo remove login foo");
  await expect(output).toContainText("login from foo");
  await expect(output).toContainText("login is the first process. The computer will have nothing to run.");
  await expect(draft).toHaveText(/^foonothing to run · base-filesdraft$/);

  await runDelo(page, "delo init bar");
  await expect(output).toContainText("foo is still a draft.");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(draft).toHaveCount(0);
});

test("the list shows a stored computer that delo save keeps and delo run opens", async ({ page }) => {
  await gotoMachine(page, "shell");
  await expect(page.locator(".kshell-surface")).toBeVisible({ timeout: 120_000 });
  const id = new URL(page.url()).searchParams.get("computer");
  expect(id).not.toBeNull();

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const computer = page.locator(".delo-computer").first();
  await expect(computer.locator(".delo-label")).toHaveText("draft");
  const title = await computer.locator(".delo-computer-name").innerText();
  await runDelo(page, `delo save ${title}`);
  await expect(page.locator("#delo-output")).toContainText(`${title} is saved.`);
  await expect(computer.locator(".delo-label")).toHaveText("saved");
  await expect(computer.locator(".delo-label")).toHaveClass(/\bis-saved\b/);
  await runDelo(page, `delo save ${title}`);
  await expect(page.locator("#delo-output")).toContainText(`${title} is already saved`);
  await runDelo(page, `delo add bash ${title}`);
  await expect(page.locator("#delo-output")).toContainText(`${title} has no delo record on this device, so delo cannot add it`);

  await runDelo(page, `delo config ${title}`);
  const settings = page.getByRole("region", { name: "computer settings" });
  await expect(settings).toContainText("delo did not make this computer, so it has no description");
  await expect(settings.getByRole("region", { name: "settings", exact: true })).toContainText("started from");
  await settings.getByRole("button", { name: "binaries" }).click();
  await expect(settings.getByRole("region", { name: "binaries" })).toContainText("delo did not make this computer, so it has no binaries delo knows");
  await settings.getByRole("button", { name: "settings" }).click();
  await settings.getByLabel("title").fill(`${title}-renamed`);
  await expect(settings.locator(".delo-view-title")).toHaveText(title);
  await settings.getByRole("button", { name: "save" }).click();
  await expect(page.locator("#delo-output")).toContainText(`${title} renamed to ${title}-renamed.`);
  await expect(computer.locator(".delo-computer-name")).toHaveText(`${title}-renamed`);

  await runDelo(page, `delo run ${title}-renamed`);
  await page.waitForURL((url) => onComputerPage(url) && url.searchParams.get("computer") === id);
});

test("delo config opens the settings of a draft, whose Save renames it and describes it and whose Cancel writes nothing, and panes for its packages and options", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  const settings = page.getByRole("region", { name: "computer settings" });
  await runDelo(page, "delo init foo");
  await runDelo(page, "delo add login foo");
  await runDelo(page, "delo add maker-account foo");
  await runDelo(page, "delo add bash foo");
  await runDelo(page, "delo enable theme foo");
  await runDelo(page, "delo config foo");
  await expect(settings).toBeVisible();
  await expect(input).toBeHidden();
  await expect(settings.locator(".delo-view-header")).toHaveText(/^foo\s*×$/);
  await expect(settings.getByRole("navigation", { name: "sections" })).toHaveText(/^settings\s*pipeline\s*binaries\s*files\s*options$/);
  const header = (await settings.locator(".delo-view-header").boundingBox())!;
  const close = (await settings.getByRole("button", { name: "close" }).boundingBox())!;
  expect(header.x + header.width - close.x - close.width).toBeLessThan(30);
  await expect(settings.getByRole("button", { name: "settings" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(settings.getByRole("button", { name: "pipeline", exact: true })).toBeFocused();
  await expect(settings.locator(".delo-view-pane-header")).toHaveText(/^pipeline\s*draft$/);
  await page.keyboard.press("ArrowUp");
  await expect(settings.locator(".delo-view-pane-header")).toHaveText(/^settings\s*draft$/);
  await expect(settings.locator(".delo-view-pane-header .delo-label")).toHaveClass(/\bis-draft\b/);
  const facts = settings.getByRole("region", { name: "settings", exact: true }).locator(".delo-list-section");
  await expect(facts.filter({ hasText: /^first process/ })).toHaveText("first processlogin");
  await expect(facts.filter({ hasText: /^user/ })).toHaveText("userroot");
  await settings.getByRole("button", { name: "binaries" }).click();
  await expect(settings.getByRole("button", { name: "binaries" })).toHaveAttribute("aria-current", "page");
  await expect(settings.locator(".delo-view-pane-header")).toHaveText(/^binaries\s*draft$/);
  await expect(settings.getByLabel("title")).toBeHidden();
  const binaries = settings.getByRole("region", { name: "binaries" });
  await expect(binaries.locator(".delo-list-row")).toHaveText(["login", "base-files", "bash"]);
  await binaries.getByRole("button", { name: "login", exact: true }).click();
  await expect(binaries.locator(".delo-list-details:visible .delo-list-section").filter({ hasText: "files it adds" })).toContainText("/usr/bin/login");
  await settings.getByRole("button", { name: "pipeline", exact: true }).click();
  const pipeline = settings.getByRole("region", { name: "pipeline", exact: true });
  await expect(pipeline.getByLabel("name")).toHaveValue("foo-pipeline");
  await expect(pipeline.getByLabel("description")).toHaveValue("");
  await expect(pipeline.locator(".delo-list-section").filter({ hasText: /^files it adds/ })).toContainText("/etc/passwd");
  await expect(pipeline.locator(".delo-list-section").filter({ hasText: /^what it provides/ })).toHaveText("what it providesuser");
  await expect(pipeline.locator(".delo-list-section").filter({ hasText: /^copied from/ })).toHaveText("copied frommaker-account");
  await expect(settings.getByRole("button", { name: "save" })).toBeDisabled();
  await pipeline.getByLabel("name").fill("bash");
  await expect(pipeline.getByRole("alert")).toBeHidden();
  await settings.getByRole("button", { name: "save" }).click();
  await expect(pipeline.getByRole("alert")).toHaveText("bash is already the name of a registry entry");
  await pipeline.getByLabel("name").fill("foo-desk");
  await expect(pipeline.getByRole("alert")).toBeHidden();
  await pipeline.getByLabel("description").fill("a desk");
  await settings.getByRole("button", { name: "options" }).click();
  const options = settings.getByRole("region", { name: "options" });
  await expect(options.locator(".delo-list-row")).toHaveText(["theme"]);
  await options.getByRole("button", { name: "theme", exact: true }).click();
  await expect(options.locator(".delo-list-details:visible .delo-list-section").filter({ hasText: /^description/ })).toBeVisible();
  await settings.getByRole("button", { name: "files" }).click();
  await expect(settings.getByRole("region", { name: "files" })).toHaveText("foo is a draft, so it has no disk yet. Run it with delo run first.");
  await expect(settings.getByRole("button", { name: "save" })).toHaveCount(0);
  const labels = settings.locator(".delo-view-tab-label");
  await settings.getByRole("button", { name: "Collapse the sidebar" }).click();
  await expect(labels).toHaveCount(5);
  for (const label of await labels.all()) await expect(label).toBeHidden();
  await settings.getByRole("button", { name: "settings" }).click();
  await expect(settings.locator(".delo-view-pane-header")).toHaveText(/^settings\s*draft$/);
  await settings.getByRole("button", { name: "Expand the sidebar" }).click();
  for (const label of await labels.all()) await expect(label).toBeVisible();

  const name = settings.getByLabel("title");
  await name.fill("foo bar");
  await settings.getByRole("button", { name: "save" }).click();
  await expect(settings.getByRole("alert")).toHaveText("a computer name is kebab-case: lowercase letters and digits, joined by single hyphens, such as brave-cookie-otter");
  await name.fill("bar");
  await expect(settings.getByRole("alert")).toBeHidden();
  await expect(settings.locator(".delo-view-title")).toHaveText("foo");
  await settings.getByRole("textbox", { name: "description" }).fill("qux");
  await settings.getByRole("button", { name: "save" }).click();
  await expect(settings).toBeHidden();
  await expect(input).toBeVisible();
  await expect(page.locator("#delo-output")).toContainText("foo renamed to bar.");
  await expect(page.locator(".delo-computer.is-highlighted .delo-computer-name")).toHaveText("bar");
  await runDelo(page, "delo config bar");
  await expect(settings.getByRole("textbox", { name: "description" })).toHaveValue("qux");
  await settings.getByRole("button", { name: "pipeline", exact: true }).click();
  await expect(settings.getByRole("region", { name: "pipeline", exact: true }).getByLabel("name")).toHaveValue("foo-desk");
  await expect(settings.getByRole("region", { name: "pipeline", exact: true }).getByLabel("description")).toHaveValue("a desk");
  await settings.getByRole("region", { name: "pipeline", exact: true }).getByLabel("description").fill("a bench");
  await settings.getByRole("button", { name: "cancel" }).click();
  await expect(input).toBeVisible();
  await expect(page.locator("#delo-output")).toHaveText(/^config\s*bar not saved\.$/);
  await runDelo(page, "delo config bar");
  await settings.getByRole("button", { name: "pipeline", exact: true }).click();
  await expect(settings.getByRole("region", { name: "pipeline", exact: true }).getByLabel("description")).toHaveValue("a desk");
  await settings.getByRole("button", { name: "close" }).click();
  await expect(input).toBeVisible();
  await expect(page.locator("#delo-output")).not.toContainText("not saved");
});

test("Escape returns from delo list and delo config to the input", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  await runDelo(page, "delo list");
  const registry = page.getByRole("region", { name: "registry" });
  await expect(registry.getByRole("button", { name: "pipelines" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(registry).toBeHidden();
  await expect(input).toBeFocused();
  await runDelo(page, "delo list");
  await registry.getByRole("button", { name: "pipelines" }).click();
  await page.keyboard.press("Escape");
  await expect(registry).toBeHidden();
  await expect(input).toBeFocused();
  await runDelo(page, "delo init foo");
  await runDelo(page, "delo config foo");
  const settings = page.getByRole("region", { name: "computer settings" });
  await settings.getByRole("heading", { name: "foo" }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(input).toBeFocused();
  await expect(page).toHaveURL(/\/pages\/delo\/$/);
});

test("delo list opens the registry, whose rows open to the whole entry", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  const registryView = page.getByRole("region", { name: "registry" });
  await runDelo(page, "delo list zzz");
  await expect(page.locator("#delo-output")).toContainText("zzz is not a list: pipelines binaries options images apps");

  await runDelo(page, "delo list images");
  await expect(input).toBeHidden();
  await expect(registryView.getByRole("navigation", { name: "sections" })).toHaveText(/^pipelines\s*binaries\s*options\s*images\s*apps$/);
  await expect(registryView.getByRole("region", { name: "images" })).toBeVisible();
  await expect(registryView.getByRole("region", { name: "images" })).toContainText("@mho22/raytracer");
  await registryView.getByRole("button", { name: "close" }).click();
  await expect(input).toBeVisible();

  await runDelo(page, "delo list");
  await expect(registryView.getByRole("region", { name: "pipelines" })).toBeVisible();
  await expect(registryView.getByRole("button", { name: "pipelines" })).toBeFocused();
  await expect(registryView.locator(".delo-view-heading")).toHaveCount(0);
  await registryView.getByRole("button", { name: "binaries" }).click();
  const binaries = registryView.getByRole("region", { name: "binaries" });
  await expect(binaries).toBeVisible();
  const search = registryView.getByRole("searchbox", { name: "search" });
  await search.fill("zzz");
  await expect(binaries.locator(".delo-list-entry:visible")).toHaveCount(0);
  await expect(binaries).toContainText("no binaries match");
  await search.fill("DOOM");
  await expect(binaries.locator(".delo-list-entry:visible .delo-list-row")).toHaveText(["fbdoom"]);
  await expect(binaries.getByText("no binaries match")).toBeHidden();
  await search.fill("");
  await search.press("ArrowDown");
  const first = binaries.locator(".delo-list-row").first();
  await expect(first).toBeFocused();
  await first.press("ArrowDown");
  await expect(binaries.locator(".delo-list-row").nth(1)).toBeFocused();
  const entry = binaries.locator(".delo-list-entry").filter({ has: page.getByRole("button", { name: "fbdoom", exact: true }) });
  const fbdoom = entry.locator(".delo-list-row");
  await expect(fbdoom).toHaveText("fbdoom");
  const details = entry.locator(".delo-list-details");
  await expect(details).toBeHidden();
  await fbdoom.click();
  await expect(fbdoom).toHaveAttribute("aria-expanded", "true");
  const section = (label: string) => details.locator(".delo-list-section").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
  await expect(section("devices it opens")).toContainText("fb0");
  await expect(section("files it adds").locator(".delo-list-box > div")).toHaveText(["/usr/bin/fbdoom"]);
  await expect(section("what it requires")).toHaveCount(0);
  await fbdoom.press("ArrowLeft");
  await expect(details).toBeHidden();
  await fbdoom.press("ArrowRight");
  await expect(details).toBeVisible();
  await fbdoom.press("ArrowDown");
  await expect(section("description")).toBeFocused();
  await expect(section("description").locator(".delo-list-box")).toHaveCSS("background-color", "rgba(24, 24, 27, 0.05)");
  await expect(section("description")).toHaveCSS("outline-style", "none");
  await page.keyboard.press("ArrowDown");
  await expect(section("files it adds")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(fbdoom).toBeFocused();
  await expect(details).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(fbdoom).not.toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(fbdoom).toBeFocused();
  const bash = binaries.getByRole("button", { name: "bash", exact: true });
  await bash.click();
  await expect(bash).toHaveAttribute("aria-expanded", "true");
  await expect(fbdoom).toHaveAttribute("aria-expanded", "false");
  await expect(details).toBeHidden();
  await bash.press("ArrowLeft");
  await expect(bash).toHaveAttribute("aria-expanded", "false");
  await expect(bash).toBeFocused();
  await bash.press("ArrowLeft");
  const tabs = registryView.getByRole("navigation", { name: "sections" });
  await expect(tabs.getByRole("button", { name: "binaries" })).toBeFocused();
  await expect(tabs.getByRole("button", { name: "binaries" })).toHaveCSS("outline-style", "none");
  await expect(tabs.getByRole("button", { name: "binaries" })).toHaveCSS("background-color", "rgba(24, 24, 27, 0.05)");
  await page.keyboard.press("ArrowUp");
  await expect(tabs.getByRole("button", { name: "pipelines" })).toHaveAttribute("aria-current", "page");
  await expect(binaries).toBeHidden();
  await page.keyboard.press("ArrowUp");
  await expect(tabs.getByRole("button", { name: "apps" })).toBeFocused();
  await expect(registryView.getByRole("region", { name: "apps" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(registryView.getByRole("region", { name: "pipelines" }).locator(".delo-list-row").first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(binaries.locator(".delo-list-row").first()).toBeFocused();

  await registryView.getByRole("button", { name: "pipelines" }).click();
  const pipelines = registryView.getByRole("region", { name: "pipelines" });
  const webStatic = pipelines.locator(".delo-list-entry").filter({ has: page.getByRole("button", { name: "web-static", exact: true }) });
  await webStatic.locator(".delo-list-row").click();
  await expect(webStatic.locator(".delo-list-section").filter({ hasText: "what it requires" })).toHaveText(/base-files\s*dinit\s*nginx/);
  const doomMultiplayer = pipelines.locator(".delo-list-entry").filter({ has: page.getByRole("button", { name: "doom-multiplayer", exact: true }) });
  await doomMultiplayer.locator(".delo-list-row").click();
  await expect(doomMultiplayer.locator(".delo-list-section").filter({ hasText: "options it enables" })).toHaveText(/network$/);
  const redisBoard = pipelines.locator(".delo-list-entry").filter({ has: page.getByRole("button", { name: "redis-board", exact: true }) });
  await redisBoard.locator(".delo-list-row").click();
  const tools = redisBoard.locator(".delo-list-section").filter({ has: page.getByRole("heading", { name: "tools it adds", exact: true }) });
  await expect(tools.locator(".delo-list-tool")).toHaveText(["pipeline_redis-board-ideas", "pipeline_redis-board-add", "pipeline_redis-board-vote"]);
  const add = tools.getByRole("button", { name: "pipeline_redis-board-add" });
  const addDetails = tools.locator(".delo-list-tool-details").nth(1);
  await expect(addDetails).toBeHidden();
  await add.click();
  await expect(add).toHaveAttribute("aria-expanded", "true");
  await expect(addDetails.locator("> *")).toHaveText(["Add an idea to the voting board, then list the ideas.", "title (string, required): The idea, up to 160 bytes", "/usr/local/bin/redis-board add {title}"]);
  await expect(tools.locator(".delo-list-tool-details").nth(0).locator("div")).toHaveText(["no inputs"]);
  await add.press("ArrowUp");
  await expect(tools.getByRole("button", { name: "pipeline_redis-board-ideas" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(redisBoard.locator(".delo-list-section").filter({ hasText: /^what it provides/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(redisBoard.locator(".delo-list-row")).toBeFocused();
  await registryView.getByRole("button", { name: "options" }).click();
  await expect(registryView.getByRole("region", { name: "options" })).toContainText("theme");
  await page.goBack();
  await expect(input).toBeVisible();
});

test("the arrows in delo list scroll a hidden row just into view, one row at a time, and stop at both ends", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, "delo list binaries");
  const binaries = page.getByRole("region", { name: "registry" }).getByRole("region", { name: "binaries" });
  const rows = binaries.locator(".delo-list-row");
  const count = await rows.count();
  const height = (await rows.first().boundingBox())!.height;
  const scrolled = () => binaries.evaluate((pane) => pane.scrollTop);
  await page.keyboard.press("ArrowRight");
  await expect(rows.first()).toBeFocused();
  let moves = 0;
  for (let index = 1; index < count; index += 1) {
    const before = await scrolled();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(index)).toBeFocused();
    const delta = await scrolled() - before;
    expect(delta).toBeLessThanOrEqual(height + 4);
    if (delta > 0) moves += 1;
  }
  expect(moves).toBeGreaterThan(0);
  const pane = (await binaries.boundingBox())!;
  const last = (await rows.last().boundingBox())!;
  expect(pane.y + pane.height - last.y - last.height).toBeCloseTo(6, 0);
  await page.keyboard.press("ArrowDown");
  await expect(rows.last()).toBeFocused();
  for (let index = 1; index < count; index += 1) await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();
});

test("delo destroy deletes a draft or a saved computer on Y, keeps it on N, and the key never reaches the input", async ({ page }) => {
  await gotoMachine(page, "shell");
  await expect(page.locator(".kshell-surface")).toBeVisible({ timeout: 120_000 });
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  const output = page.locator("#delo-output");
  const computers = page.locator(".delo-computer");
  const title = await computers.first().locator(".delo-computer-name").innerText();
  await runDelo(page, `delo save ${title}`);
  await expect(output).toContainText(`${title} is saved.`);

  await runDelo(page, "delo destroy foo");
  await expect(output).toContainText("foo is not a computer on this device");
  await runDelo(page, "delo init foo");
  await runDelo(page, "delo destroy foo");
  await expect(output).toContainText("confirm you want to destroy foo ? (Y/N)");
  await input.press("x");
  await input.press("Enter");
  await expect(output).toContainText("confirm you want to destroy foo ? (Y/N)");
  await input.press("y");
  await expect(output).toContainText("foo destroyed.");
  await expect(input).toHaveValue("");
  await expect(computers).toHaveCount(1);

  await runDelo(page, `delo destroy ${title}`);
  await input.press("n");
  await expect(output).toContainText(`${title} kept.`);
  await expect(input).toHaveValue(`delo destroy ${title}`);
  await expect(computers).toHaveCount(1);
  await runDelo(page, `delo destroy ${title}`);
  await input.press("Y");
  await expect(output).toContainText(`${title} destroyed.`);
  await expect(computers).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(computers).toHaveCount(0);
});

test("a draft builds into a disk that mounts, in a worker", async ({ page }) => {
  let draft = createDeloDraft("foo");
  for (const name of ["dash", "ncurses"]) draft = { name: draft.name, ...planDeloAdd(REGISTRY, draft, name).configuration };
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const encoded = await page.evaluate(async ([client, registry, current]) => {
    const { buildDeloImage } = await import(client);
    const { image }: { image: Uint8Array } = await buildDeloImage(registry, current.name, { description: "", pipeline: current.pipeline, firstProcess: current.firstProcess, added: current.added });
    let binary = "";
    for (let at = 0; at < image.length; at += 0x8000) binary += String.fromCharCode(...image.subarray(at, at + 0x8000));
    return btoa(binary);
  }, [appUrl("/pages/delo/src/computer-image-client.ts"), REGISTRY, draft] as const);

  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(Buffer.from(encoded, "base64")));
  const text = (path: string) => new TextDecoder().decode(fs.readFile(path));
  expect(fs.readlink("/usr/bin/dash")).toBe("/bin/dash");
  expect(fs.stat("/bin/dash").mode & 0o777).toBe(0o755);
  expect(fs.stat("/usr/share/terminfo/x/xterm").size).toBeGreaterThan(0);
  expect(JSON.parse(text("/etc/kandelo/experimental-terminal-session.json")).initial.path).toBe("/bin/dash");
});

test("delo run <draft> stores a draft computer that boots the disk Delo built", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  const prompt = page.locator("#delo-terminal .xterm-rows");
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, `test -s /etc/delo/config.json && printf '%s%s\\n' DELO_ BUILT`, "DELO_BUILT");
  const id = new URL(page.url()).searchParams.get("computer")!;
  const entries = await page.evaluate(async (computerId) => {
    const root = await navigator.storage.getDirectory();
    const directory = await (await (await root.getDirectoryHandle("kandelo")).getDirectoryHandle("computers")).getDirectoryHandle(computerId);
    const names: string[] = [];
    for await (const name of directory.keys()) names.push(name);
    return names.sort();
  }, id);
  expect(entries).not.toContain("provisioning");
  expect(entries).not.toContain("disk.vfs");
  expect(entries).toContain("filesystem");
  expect(entries).toContain("delo.json");

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const computer = page.locator(".delo-computer").filter({ hasText: title });
  await expect(computer.locator(".delo-label")).toHaveText("draft");
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, "printf '%s%s\\n' DELO_ REOPENED", "DELO_REOPENED");

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const settings = page.getByRole("region", { name: "computer settings" });
  await runDelo(page, `delo config ${title}`);
  await expect(settings.locator(".delo-view-pane-header .delo-label")).toHaveText("draft");
  await expect(settings.locator(".delo-view-pane-header .delo-label")).toHaveClass(/\bis-draft\b/);
  await settings.getByRole("textbox", { name: "description" }).fill("foo");
  await settings.getByRole("button", { name: "pipeline", exact: true }).click();
  const pipeline = settings.getByRole("region", { name: "pipeline", exact: true });
  await expect(pipeline.getByLabel("name")).toHaveValue(`${title}-pipeline`);
  await pipeline.getByLabel("name").fill("bash");
  await settings.getByRole("button", { name: "save" }).click();
  await expect(pipeline.getByRole("alert")).toHaveText("bash is already the name of a registry entry");
  await pipeline.getByLabel("name").fill("bar-pipeline");
  await pipeline.getByLabel("description").fill("baz");
  await settings.getByRole("button", { name: "save" }).click();
  await expect(page.locator("#delo-output")).toContainText(`${title} saved.`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(computer.locator(".delo-label")).toHaveText("draft");
  await runDelo(page, `delo config ${title}`);
  await expect(settings.getByRole("textbox", { name: "description" })).toHaveValue("foo");
  await settings.getByRole("button", { name: "pipeline", exact: true }).click();
  await expect(pipeline.getByLabel("name")).toHaveValue("bar-pipeline");
  await expect(pipeline.getByLabel("description")).toHaveValue("baz");
});

test("a change to a stored computer waits for the next delo run, which writes it to the disk and keeps its data", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const output = page.locator("#delo-output");
  const prompt = page.locator("#delo-terminal .xterm-rows");
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, "printf foo > /foo && printf '%s%s\\n' DELO_ HUMAN", "DELO_HUMAN");

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const computer = page.locator(".delo-computer").filter({ hasText: title });
  await runDelo(page, `delo enable internals ${title}`);
  await expect(output).toHaveText(new RegExp(`^enable\\s*internals is enabled on ${title}\\s*pending\\s*delo run ${title} writes it to the disk$`));
  await expect(computer.locator(".delo-label")).toHaveText("draft");
  await runDelo(page, `delo disable internals ${title}`);
  await runDelo(page, `delo add dash ${title}`);
  await expect(output).toContainText(`delo run ${title} writes it to the disk`);
  await expect(computer).toContainText("runs bash · base-files bash dash");

  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, `test -x /bin/dash && test -e /foo && printf '%s%s\\n' DELO_ WRITTEN`, "DELO_WRITTEN");
});

test("leaving a running computer asks first, and the link back to delo halts it, so a write no program synced is on its disk at the next run", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const prompt = page.locator("#delo-terminal .xterm-rows");
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, `printf foo > /root/foo && printf '%s%s\\n' DELO_ WROTE`, "DELO_WROTE");
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.evaluate(() => window.location.assign("../"));
  await expect.poll(() => dialogs).toEqual(["beforeunload"]);
  expect(onComputerPage(new URL(page.url()))).toBe(true);
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  await page.getByRole("link", { name: "Save and go back to delo" }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/pages/delo/"));
  expect(dialogs).toEqual(["beforeunload"]);
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, `read -r value < /root/foo; test "$value" = foo && printf '%s%s\\n' DELO_ KEPT`, "DELO_KEPT");
});

test("a computer whose delo.json is lost still boots, and delo refuses to change it", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const output = page.locator("#delo-output");
  const prompt = page.locator("#delo-terminal .xterm-rows");
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  const id = new URL(page.url()).searchParams.get("computer")!;
  const hasRecord = () => page.evaluate(async (computerId) => {
    const root = await navigator.storage.getDirectory();
    const directory = await (await (await root.getDirectoryHandle("kandelo")).getDirectoryHandle("computers")).getDirectoryHandle(computerId);
    return directory.getFileHandle("delo.json").then(() => true, () => false);
  }, id);

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await page.evaluate(async (computerId) => {
    const root = await navigator.storage.getDirectory();
    const directory = await (await (await root.getDirectoryHandle("kandelo")).getDirectoryHandle("computers")).getDirectoryHandle(computerId);
    await directory.removeEntry("delo.json");
  }, id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await runDelo(page, `delo enable internals ${title}`);
  await expect(output).toHaveText(`error${title} has no delo record on this device, so delo cannot enable it`);

  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  expect(await hasRecord()).toBe(false);
});

test("delo write puts a file in a computer's pipeline, opens a typed line without a source in the editor, asks Y/N before it replaces another kind, and delo remove deletes it", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const input = page.getByRole("combobox", { name: "delo command" });
  const output = page.locator("#delo-output");
  const prompt = page.locator("#delo-terminal .xterm-rows");
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo write /etc/foo ${title} --content "foo bar\\n" --mode 600`);
  await expect(output).toHaveText(new RegExp(`^write\\s*/etc/foo written to the pipeline of ${title}$`));
  await runDelo(page, `delo write /etc/bar ${title} --type symlink --from /etc/foo`);
  const text = page.getByRole("textbox", { name: "the content of /etc/baz" });
  await runDelo(page, `delo write /etc/baz ${title}`);
  await expect(page.getByRole("button", { name: "content" })).toBeFocused();
  await expect(text).toHaveValue("");
  await page.getByRole("button", { name: "cancel" }).click();
  await expect(output).toHaveText(/^write\s*\/etc\/baz not written\.$/);
  await runDelo(page, `delo write /etc/baz ${title}`);
  await text.fill("baz\n");
  await page.getByRole("button", { name: "save" }).click();
  await expect(output).toHaveText(new RegExp(`^write\\s*/etc/baz written to the pipeline of ${title}$`));
  await runDelo(page, `delo write /etc/baz ${title}`);
  await expect(text).toHaveValue("baz\n");
  await page.keyboard.press("Escape");
  await expect(output).toHaveText(/^write\s*\/etc\/baz not written\.$/);
  await runDelo(page, `delo write /etc/baz ${title}`);
  await page.getByRole("button", { name: "mode" }).click();
  await page.getByRole("textbox", { name: "the mode of /etc/baz" }).fill("600");
  await page.getByRole("button", { name: "type" }).click();
  await page.getByRole("combobox", { name: "the type of /etc/baz" }).selectOption("symlink");
  await expect(page.getByRole("button", { name: "mode" })).toHaveCount(0);
  await page.getByRole("button", { name: "save" }).click();
  await expect(page.getByRole("alert")).toContainText("/etc/baz.from");
  await page.getByRole("combobox", { name: "the type of /etc/baz" }).selectOption("file");
  await page.getByRole("button", { name: "save" }).click();
  await expect(output).toHaveText(new RegExp(`^write\\s*/etc/baz written to the pipeline of ${title}$`));
  await runDelo(page, `delo write /etc/baz ${title}`);
  await page.getByRole("button", { name: "mode" }).click();
  await expect(page.getByRole("textbox", { name: "the mode of /etc/baz" })).toHaveValue("600");
  await page.getByRole("button", { name: "cancel" }).click();
  await runDelo(page, `delo remove /etc/baz ${title}`);
  await expect(output).toHaveText(new RegExp(`^remove\\s*/etc/baz from the pipeline of ${title}$`));
  await runDelo(page, `delo write /usr/bin/bash ${title}`);
  await expect(output).toContainText("bash writes /usr/bin/bash. Write another path, or remove bash.");
  await expect(page.getByRole("textbox", { name: "the content of /usr/bin/bash" })).toHaveCount(0);
  await runDelo(page, `delo write /etc/foo ${title} --from https://example.com/foo`);
  await expect(output).toContainText(`confirm you want to replace /etc/foo on ${title} ? (Y/N)`);
  await input.press("n");
  await expect(output).toContainText("/etc/foo kept.");

  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, `[[ $(</etc/bar) == "foo bar" && -L /etc/bar && ! -e /etc/baz ]] && printf '%s%s\\n' DELO_ WRITTEN`, "DELO_WRITTEN");

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo write /etc/foo ${title} --content qux`);
  await expect(output).toContainText(`delo run ${title} writes it to the disk`);
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, `[[ $(</etc/foo) == qux ]] && printf '%s%s\\n' DELO_ CHANGED`, "DELO_CHANGED");
});

test("Tab after delo write's computer offers the flags of the file's kind, and --type says its values", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const input = page.getByRole("combobox", { name: "delo command" });
  const output = page.locator("#delo-output");
  const options = page.getByRole("option");
  const offered = async (line: string, flags: string[]) => {
    await input.fill(line);
    await input.press("Tab");
    await expect(options.locator(".delo-option-name")).toHaveText(flags);
    await input.press("Escape");
  };
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await offered(`delo write /etc/foo ${title} `, ["--type", "--content", "--from"]);
  await input.fill(`delo write /etc/foo ${title} `);
  await input.press("Tab");
  await expect(options.nth(0)).toContainText("file (the default), directory or symlink");
  await input.press("Enter");
  await expect(input).toHaveValue(`delo write /etc/foo ${title} --type`);
  await input.press(" ");
  await expect(output).toHaveText(/^type\s*file · directory · symlink$/);
  await offered(`delo write /etc/foo ${title} --type directory `, ["--from", "--mode", "--owner"]);
  await offered(`delo write /etc/foo ${title} --content "foo bar" `, ["--mode"]);
  await runDelo(page, `delo write /etc/foo ${title} --content foo`);
  await offered(`delo write /etc/foo ${title} `, ["--content", "--mode"]);
});

test("while the line is delo run and at most its word, the output says Tab lists what runs and an image URL boots", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  const output = page.locator("#delo-output");
  const hint = /^delo\s*tab lists computers and images · enter on an image URL boots it$/;
  await input.fill("delo r");
  await expect(output).toHaveText(/^delo\s*tab completes · enter runs$/);
  for (const line of ["delo run", "delo run ", "  delo  run  https://foo.test/bar.vfs "]) {
    await input.fill(line);
    await expect(output).toHaveText(hint);
  }
  await input.fill("delo run foo bar");
  await expect(output).toHaveText(/^delo\s*tab completes · enter runs$/);
  await input.fill("delo running");
  await expect(output).toHaveText(/^delo\s*tab completes · enter runs$/);
});

test("the files pane of delo config shows a computer's files, downloads them, and saves uploads when the settings close", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const prompt = page.locator("#delo-terminal .xterm-rows");
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo config ${title}`);
  const settings = page.getByRole("region", { name: "computer settings" });
  const status = settings.locator(".delo-view-status");
  const rows = settings.getByRole("region", { name: "files" }).locator(".delo-list-row");
  const fileActions = settings.locator(".delo-view-actions").getByRole("button", { name: /^(download|upload)$/, includeHidden: true });
  await expect(fileActions).toHaveText(["upload", "download"]);
  for (const action of await fileActions.all()) await expect(action).toBeHidden();
  await expect(status).toBeHidden();
  const panel = settings.locator(".delo-view-panel");
  const before = await panel.boundingBox();
  await settings.getByRole("button", { name: "files" }).click();
  await expect(settings.locator(".delo-view-header .delo-view-status + .delo-view-close")).toHaveCount(1);
  await expect(status).toHaveText("disk open", { timeout: 120_000 });
  expect(await panel.boundingBox()).toEqual(before);
  await rows.filter({ hasText: /^etc\/$/ }).press("ArrowRight");
  await expect(settings.locator(".delo-files-path")).toHaveText("/etc");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect(settings.locator(".delo-files-path")).toHaveText("/etc");
  await expect(rows.filter({ hasText: /^\.\.\/$/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(settings.locator(".delo-files-path")).toHaveText("/");
  await expect(rows.filter({ hasText: /^etc\/$/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(settings.locator(".delo-files-path")).toHaveText("/etc");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(settings.locator(".delo-files-path")).toHaveText("/");
  await expect(rows.filter({ hasText: /^etc\/$/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(settings.getByRole("button", { name: "files" })).toBeFocused();
  for (const folder of ["etc", "delo"]) await rows.filter({ hasText: new RegExp(`^${folder}/$`) }).click();
  await expect(settings.locator(".delo-files-path")).toHaveText("/etc/delo");
  await expect(rows.filter({ hasText: /^\.\.\/$/ }).locator(".delo-view-icon path")).toHaveAttribute("d", "m10 4-4 4 4 4");
  await expect(rows.filter({ hasText: /^config\.json$/ }).locator(".delo-view-icon")).toHaveCount(0);
  await rows.filter({ hasText: /^config\.json$/ }).click();
  const details = settings.locator(".delo-list-details:not([hidden])");
  await expect(details).toContainText("/etc/delo/config.json");
  await expect(details).toContainText("-rw-r--r--");
  await expect(details).toContainText("root (0) · root (0)");
  await expect(details.getByRole("button")).toHaveCount(0);
  const config = rows.filter({ hasText: /^config\.json$/ });
  await config.press("ArrowDown");
  await expect(details.locator(".delo-list-section").filter({ hasText: /^path/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(details.locator(".delo-list-section").filter({ hasText: /^type/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(config).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(details).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(details).toContainText("/etc/delo/config.json");
  const download = settings.locator(".delo-view-actions").getByRole("button", { name: "download" });
  const file = page.waitForEvent("download");
  await download.click();
  const downloaded = await file;
  expect(downloaded.suggestedFilename()).toBe("config.json");
  expect(Object.keys(JSON.parse(readFileSync(await downloaded.path(), "utf8")).written.steps)).toEqual(expect.arrayContaining(["/etc/passwd", "/bin/bash"]));
  await rows.filter({ hasText: /^config\.json$/ }).click();
  const zip = page.waitForEvent("download");
  await download.click();
  expect((await zip).suggestedFilename()).toBe("delo.zip");
  for (const parent of ["/etc", "/"]) {
    await rows.filter({ hasText: /^\.\.\/$/ }).click();
    await expect(settings.locator(".delo-files-path")).toHaveText(parent);
  }
  await rows.filter({ hasText: /^bin\/$/ }).click();
  await rows.filter({ hasText: /^sh$/ }).click();
  await download.click();
  await expect(settings.locator(".delo-files-message")).toHaveText("/bin/sh is a symlink: it has no bytes to download");
  await rows.filter({ hasText: /^\.\.\/$/ }).click();
  await expect(settings.locator(".delo-files-path")).toHaveText("/");
  await rows.filter({ hasText: /^root\/$/ }).click();
  await expect(settings.locator(".delo-files-path")).toHaveText("/root");

  const files = settings.locator("input[type=file]");
  const upload = page.waitForEvent("filechooser");
  await settings.locator(".delo-view-actions").getByRole("button", { name: "upload" }).click();
  await (await upload).setFiles({ name: "bar", mimeType: "text/plain", buffer: Buffer.from("bar") });
  await expect(settings.locator(".delo-files-message")).toHaveText("1 file uploaded into /root. delo saves the disk when the settings close.");
  await expect(rows.filter({ hasText: /^bar$/ })).toBeVisible();
  const tree = mkdtempSync(join(tmpdir(), "delo-files-"));
  mkdirSync(join(tree, "baz", "qux"), { recursive: true });
  writeFileSync(join(tree, "baz", "qux", "quux"), "quux");
  // A real drop, through Chrome's input pipeline: a folder dropped on the
  // pane uploads with everything in it.
  const pane = await settings.locator(".delo-files-pane").boundingBox();
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { type: type as "dragEnter", x: pane!.x + pane!.width / 2, y: pane!.y + pane!.height / 2, data: { items: [], files: [join(tree, "baz")], dragOperationsMask: 1 } });
  }
  await expect(settings.locator(".delo-files-message")).toHaveText("1 file uploaded into /root. delo saves the disk when the settings close.");
  await expect(rows.filter({ hasText: /^baz\/$/ })).toBeVisible();
  await files.setInputFiles({ name: "bar", mimeType: "text/plain", buffer: Buffer.from("corge") });
  await expect(settings.locator(".delo-files-message")).toHaveText("replace bar ? (Y/N)");
  await page.keyboard.press("n");
  await expect(settings.locator(".delo-files-message")).toHaveText("nothing uploaded");

  await settings.getByRole("button", { name: "close" }).click();
  await expect(settings).toBeHidden({ timeout: 120_000 });
  await runDelo(page, `delo run ${title}`);
  await expect(prompt).toContainText("bash-5.2#", { timeout: 120_000 });
  await runTerminalCommand(page, `test "$(</root/bar)" = bar && test "$(</root/baz/qux/quux)" = quux && printf '%s%s\\n' DELO_ UPLOADED`, "DELO_UPLOADED");
});

test("the files pane refuses a computer that is open in another tab", async ({ page, context }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await expect(page.locator("#delo-terminal .xterm-rows")).toContainText("bash-5.2#", { timeout: 120_000 });

  const other = await context.newPage();
  await other.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const settings = await openFiles(other, title);
  await expect(settings.locator(".delo-view-status")).toHaveText("error");
  await expect(settings.locator(".delo-files-message")).toHaveText(`${title} is open in another tab. Close it, then open its files.`);
  await expect(settings.getByRole("button", { name: "upload" })).toBeDisabled();
});

test("delo run <draft> boots a draft with nothing to run, and reopens it", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  const idle = page.getByRole("status").filter({ hasText: "nothing is running" });
  await expect(idle).toBeVisible({ timeout: 120_000 });

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".delo-computer").filter({ hasText: title }).locator(".delo-label")).toHaveText("draft");
  await runDelo(page, `delo run ${title}`);
  await expect(idle).toBeVisible({ timeout: 120_000 });
});

test("the floating Kandelo button unfolds into the toolbar, which folds back", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.localStorage.setItem("delo.theme", "wordpress-dark"));
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  await expect(page.locator("html")).toHaveAttribute("data-delo-theme", "wordpress-light");
  const fab = page.getByRole("button", { name: "Open the delo toolbar" });
  const toolbar = page.getByRole("toolbar", { name: "delo toolbar" });
  await expect(fab).toBeVisible();
  await expect(fab).toHaveCSS("right", "20px");
  await expect(fab).toHaveCSS("bottom", "20px");
  await expect(toolbar).toBeHidden();

  await fab.click();
  await expect(fab).toBeHidden();
  await expect(toolbar).toBeVisible();
  await expect(page.locator("#delo-terminal .xterm-rows")).toContainText("bash-5.2#", { timeout: 120_000 });
  await expect(toolbar.getByRole("group", { name: "devices" }).getByRole("button", { name: "Terminal" })).toBeVisible();
  await expect(toolbar.getByRole("group", { name: "options" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-delo-theme", "wordpress-light");
  await expect(toolbar.getByRole("link", { name: "View Kandelo on GitHub" })).toHaveAttribute("href", "https://github.com/Automattic/kandelo");

  await toolbar.getByRole("button", { name: "Fold the delo toolbar" }).click();
  await expect(toolbar).toBeHidden();
  await expect(fab).toBeFocused();
  await fab.press("Enter");
  await expect(toolbar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();
  await expect(fab).toBeVisible();
});

test("the theme and internals options show their tools on the computer page", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.localStorage.removeItem("delo.theme"));
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add base-files ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo enable theme ${title}`);
  await runDelo(page, `delo enable internals ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  await expect(page.locator("#delo-terminal .xterm-rows")).toContainText("bash-5.2#", { timeout: 120_000 });
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  const options = page.getByRole("toolbar", { name: "delo toolbar" }).getByRole("group", { name: "options" });

  await options.getByRole("button", { name: "Theme: WordPress light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-delo-theme", "wordpress-dark");
  await expect(page.locator("#delo-terminal .xterm-viewport")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  expect(await page.evaluate(() => window.localStorage.getItem("delo.theme"))).toBe("wordpress-dark");
  await options.getByRole("button", { name: "Theme: WordPress dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-delo-theme", "wordpress-light");

  const internals = options.getByRole("button", { name: "Internals" });
  const panel = page.getByRole("region", { name: "Internals" });
  await internals.click();
  await expect(internals).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("row").filter({ hasText: "bash" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Fold the delo toolbar" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  await expect(internals).toHaveAttribute("aria-pressed", "false");
});

/** A computer that starts Doom in its terminal's shell at boot. */
const DOOM = ["delo add doom"];

async function openComputer(page: import("@playwright/test").Page, title: string, lines: string[]): Promise<void> {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  for (const line of lines) await runDelo(page, `${line} ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
}

test("a computer lists the devices of the packages on its disk", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, ["delo add fbdoom"]);
  await expect(page.getByRole("status").filter({ hasText: "nothing is running" })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  const devices = page.getByRole("toolbar", { name: "delo toolbar" }).getByRole("group", { name: "devices" });
  await expect(devices.getByRole("button", { name: "Framebuffer" })).toHaveAttribute("aria-pressed", "true");
  await expect(devices.getByRole("button", { name: "Terminal" })).toBeHidden();
  await expect(page.locator("#delo-framebuffer")).toBeVisible();
});

test("a package command runs in the terminal's shell, which keeps it running", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, [...DOOM, "delo enable internals"]);
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  const toolbar = page.getByRole("toolbar", { name: "delo toolbar" });
  await toolbar.getByRole("group", { name: "options" }).getByRole("button", { name: "Internals" }).click();
  const doom = page.getByRole("region", { name: "Internals" }).getByRole("row").filter({ hasText: "fbdoom -iwad /usr/share/doom/doom1.wad" });
  await expect(doom).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(5_000);
  await expect(doom).toBeVisible();
  await toolbar.getByRole("group", { name: "devices" }).getByRole("button", { name: "Framebuffer" }).click();
  await expect(page.locator("#delo-framebuffer")).toHaveJSProperty("width", 640);
});

test("the share option copies a link that opens the same draft", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await openComputer(page, title, ["delo add base-files", "delo add bash", "delo enable share"]);
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  await page.getByRole("button", { name: "Share" }).click();
  const link = await page.getByRole("textbox", { name: "Share link" }).inputValue();
  expect(new URL(link).pathname).toMatch(/\/pages\/delo\/$/);

  const output = page.locator("#delo-output");
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await expect(output).toHaveText("inittrust this link and its options ? (Y/N)");
  await page.keyboard.press("n");
  await expect(output).toHaveText("initshare link not opened.");
  await expect(page.locator(".delo-computer.is-highlighted")).toHaveCount(0);

  await page.goto(link, { waitUntil: "domcontentloaded" });
  await expect(output).toContainText("trust this link and its options ?");
  await page.keyboard.press("y");
  await expect(output).toContainText("computer created from a share link");
  await expect(page.locator(".delo-computer.is-highlighted")).toContainText("runs bash · base-files bash · share");
  expect(new URL(page.url()).searchParams.has("draft")).toBe(false);
});

test("upload sends files to ~/Downloads, and download saves what the computer publishes", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo enable upload ${title}`);
  await expect(page.locator("#delo-output")).toContainText(`base-files kandelo-exchange to ${title}`);
  await runDelo(page, `delo enable download ${title}`);
  await runDelo(page, `delo add bash ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  await expect(page.locator("#delo-terminal .xterm-rows")).toContainText("bash-5.2#", { timeout: 120_000 });

  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  await page.getByRole("button", { name: "Upload" }).click();
  await page.locator("#delo-upload input[type=file]").setInputFiles({ name: "foo.txt", mimeType: "text/plain", buffer: Buffer.from("foo") });
  await expect(page.getByRole("region", { name: "Upload" })).toContainText("saved to ~/Downloads/foo.txt", { timeout: 60_000 });
  await runTerminalCommand(page, `test "$(</root/Downloads/foo.txt)" = foo && printf '%s%s\\n' DELO_ UPLOADED`, "DELO_UPLOADED");

  await runTerminalCommand(page, `kandelo-publish --name bar.txt /root/Downloads/foo.txt > /dev/null && printf '%s%s\\n' DELO_ PUBLISHED`, "DELO_PUBLISHED");
  const download = page.getByRole("button", { name: "Download (1)" });
  await download.click();
  const saved = page.waitForEvent("download");
  await page.getByRole("region", { name: "Download" }).getByRole("button", { name: "Save" }).click();
  expect((await saved).suggestedFilename()).toBe("bar.txt");
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
});

test("the network option creates a session whose link another browser opens, runs and joins", async ({ page, browser }) => {
  const title = `delo-${Date.now()}`;
  await openComputer(page, title, ["delo enable network"]);
  await expect(page.getByRole("status").filter({ hasText: "nothing is running" })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  await page.getByRole("button", { name: "Network" }).click();
  const panel = page.getByRole("region", { name: "Network" });
  await expect(panel).toContainText("not in a network session");
  await panel.getByRole("button", { name: "Create a session" }).click();
  const field = panel.getByRole("textbox", { name: "Session link to share" });
  await expect(field).toHaveValue(/[?&]network=/, { timeout: 60_000 });
  const link = new URL(await field.inputValue());
  expect(link.pathname).toMatch(/\/pages\/delo\/$/);
  expect(link.searchParams.get("draft")).not.toBeNull();
  expect(link.searchParams.get("networkName")).toBe(title);

  const guest = await browser.newContext();
  try {
    const other = await guest.newPage();
    await other.goto(link.href, { waitUntil: "domcontentloaded" });
    await expect(other.locator("#delo-output")).toContainText("trust this link and its options ?");
    await other.keyboard.press("y");
    await expect(other.locator("#delo-output")).toContainText(`delo run ${title} joins the network session ${title}.`);
    expect(new URL(other.url()).search).toBe("");
    await runDelo(other, `delo run ${title}`);
    await other.waitForURL(onComputerPage);
    const joined = other.getByRole("region", { name: "Network" });
    await expect(joined).toContainText("connected", { timeout: 120_000 });
    await expect(joined).toContainText("2 members", { timeout: 60_000 });
    expect(new URL(other.url()).searchParams.get("network")).toBeNull();
    await expect(panel).toContainText("2 members", { timeout: 60_000 });
  } finally {
    await guest.close();
  }
  await panel.getByRole("button", { name: "Leave" }).click();
  await expect(panel).toContainText("not in a network session");
});

test("a computer with dinit shows dinit on the draft line as what it runs", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add web-static ${title}`);
  await expect(page.locator(".delo-computer.is-highlighted")).toHaveText(new RegExp(`^${title}runs dinit · base-files dinit nginxdraft$`));
});

test("doom-multiplayer turns on the network option, and two computers in one session play one game", async ({ page, browser }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add doom-multiplayer ${title}`);
  await expect(page.locator("#delo-output")).toHaveText("addadd doom-multiplayer and its options ? (Y/N)");
  await page.keyboard.press("n");
  await expect(page.locator("#delo-output")).toHaveText("adddoom-multiplayer not added.");
  await expect(page.locator(".delo-computer.is-highlighted")).toContainText("nothing to run · no packages");
  await runDelo(page, `delo add doom-multiplayer ${title}`);
  await page.keyboard.press("y");
  await expect(page.locator("#delo-output")).toHaveText(`adddoom-multiplayer is copied into the pipeline of ${title}`);
  await runDelo(page, `delo disable network ${title}`);
  await expect(page.locator("#delo-output")).toContainText(`network is disabled on ${title}`);
  await runDelo(page, `delo enable network ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  const host = page.locator("#delo-terminal .xterm-rows");
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(host).toContainText("bash-5.2#", { timeout: 120_000 });
  await page.getByRole("button", { name: "Network" }).click();
  const panel = page.getByRole("region", { name: "Network" });
  await panel.getByRole("button", { name: "Create a session" }).click();
  const field = panel.getByRole("textbox", { name: "Session link to share" });
  await expect(field).toHaveValue(/[?&]network=/, { timeout: 60_000 });
  await expect(panel).toContainText(/address \S+/, { timeout: 60_000 });
  const address = /address (\S+)/.exec(await panel.innerText())![1];

  const guest = await browser.newContext();
  try {
    const other = await guest.newPage();
    await other.goto(await field.inputValue(), { waitUntil: "domcontentloaded" });
    await expect(other.locator("#delo-output")).toContainText("trust this link and its options ?");
    await other.keyboard.press("y");
    await runDelo(other, `delo run ${title}`);
    await other.waitForURL(onComputerPage);
    await expect(other.getByRole("region", { name: "Network" })).toContainText("2 members", { timeout: 120_000 });
    await other.getByRole("button", { name: "Open the delo toolbar" }).click();
    await other.getByRole("button", { name: "Terminal" }).click();
    await expect(other.locator("#delo-terminal .xterm-rows")).toContainText("bash-5.2#", { timeout: 120_000 });

    await page.getByRole("textbox", { name: "Terminal input" }).focus();
    await page.keyboard.insertText("doom-host 2");
    await page.keyboard.press("Enter");
    await expect(host).toContainText("1 of 2 players have joined", { timeout: 120_000 });
    await other.getByRole("textbox", { name: "Terminal input" }).focus();
    await other.keyboard.insertText(`doom-join ${address}`);
    await other.keyboard.press("Enter");
    await expect(host).toContainText("player 1 of 2 (2 nodes)", { timeout: 120_000 });
    await expect(other.locator("#delo-terminal .xterm-rows")).toContainText("player 2 of 2 (2 nodes)", { timeout: 120_000 });
  } finally {
    await guest.close();
  }
});

test("a computer with nothing to run has no device in its toolbar", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo run ${title}`);
  await page.waitForURL(onComputerPage);
  await expect(page.getByRole("status").filter({ hasText: "nothing is running" })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Open the delo toolbar" }).click();
  const toolbar = page.getByRole("toolbar", { name: "delo toolbar" });
  await expect(toolbar.getByRole("button", { name: "Terminal" })).toBeHidden();
  await toolbar.getByRole("link", { name: "Save and go back to delo" }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/pages/delo/"));
  await expect(page.getByRole("combobox", { name: "delo command" })).toBeVisible();
});

test("delo run <name> opens the registered image on the delo computer page", async ({ page }) => {
  const entry = findDeloImage(REGISTRY, RAYTRACER);
  if (entry === null) throw new Error(`${RAYTRACER} is not a registered image`);
  // The registered image lives on another host. The spec asserts the URL the
  // page navigates to, not that image's boot: answer the computer page with a
  // stub so the run stays local.
  await page.route(
    (url) => url.searchParams.has("vfs"),
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>stub</title>" }),
  );
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo run ${RAYTRACER}`);
  await page.waitForURL((url) => url.searchParams.has("vfs"));
  const url = new URL(page.url());
  expect(url.pathname).toBe(new URL(appUrl("/pages/delo/computer/"), url).pathname);
  expect(url.searchParams.get("vfs")).toBe(entry.vfs);
  expect(url.searchParams.get("profile")).toBe(entry.profile);
});

test("a computer whose image fails to load says why it did not boot", async ({ page }) => {
  // `.invalid` never resolves (RFC 2606), so the fetch fails for real.
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, "delo run https://foo.invalid/bar.vfs");
  await page.waitForURL(onComputerPage);
  const status = page.locator("#delo-status");
  await expect(status).toHaveText(/^Failed to boot .+ · .*bar\.vfs/, { timeout: 60_000 });
  await expect(status).toHaveClass(/\bis-error\b/);
});

test("the files pane opens a computer that boots a registered image read only, and delo config refuses an app", async ({ page }) => {
  const entry = findDeloImage(REGISTRY, RAYTRACER);
  if (entry === null) throw new Error(`${RAYTRACER} is not a registered image`);
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await routeImage(page, entry.vfs, entry.profile);
  await runDelo(page, `delo config ${RAYTRACER_SPACEFAST}`);
  await expect(page.locator("#delo-output")).toContainText(`${RAYTRACER_SPACEFAST} is not a computer on this device`);
  await runDelo(page, `delo run ${RAYTRACER}`);
  await page.waitForURL(onComputerPage);
  await expect(page.locator("#delo-status")).toHaveText("nothing is running", { timeout: 120_000 });

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const title = await page.locator(".delo-computer").filter({ hasText: RAYTRACER }).locator(".delo-computer-name").textContent();
  await filesOfImageComputer(page, title!);
});

test("delo run <image URL> boots the image on a new computer, whose files pane opens read only", async ({ page }) => {
  const url = "https://foo.test/bar.vfs";
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await routeImage(page, url, "foo");
  await runDelo(page, `delo run ${url}`);
  await page.waitForURL(onComputerPage);
  await expect(page.locator("#delo-status")).toHaveText("nothing is running", { timeout: 120_000 });

  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const row = page.locator(".delo-computer").filter({ hasText: "image" });
  await expect(row).toHaveCount(1);
  await filesOfImageComputer(page, (await row.locator(".delo-computer-name").textContent())!);
});

test("the list says a computer boots an image, and names its registered image", async ({ page }) => {
  const entry = findDeloImage(REGISTRY, RAYTRACER);
  if (entry === null) throw new Error(`${RAYTRACER} is not a registered image`);
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const store = "/@fs/" + join(here, "../../../web-libs/kandelo-session/src/browser-computer-store.ts");
  const title = `image-${Date.now()}`;
  await page.evaluate(async ({ store, title, vfs, profile }) => {
    const { BrowserComputerStore } = await import(store);
    await new BrowserComputerStore().create({
      version: 1,
      id: profile,
      title: "Raytracer",
      base: "kandelo:shell@abi1",
      runtime: { arch: "wasm32", kernel: "kernel@local", memoryPages: 2048, features: ["shared-array-buffer", "pty"], time: "real" },
      packages: [],
      mounts: [{ path: "/", source: "image", ref: vfs, readonly: false }, { path: "/tmp", source: "scratch", ephemeral: true }],
      boot: { argv: ["sh"], cwd: "/", env: {} },
    }, "temporary", profile, title);
  }, { store, title, vfs: entry.vfs, profile: entry.profile });
  await page.reload({ waitUntil: "domcontentloaded" });
  const row = page.locator(".delo-computer").filter({ hasText: title });
  await expect(row.locator(".delo-text")).toHaveText([RAYTRACER, "image"]);
  await expect(row.locator(".delo-label")).toHaveText(["draft"]);
});

test("the files pane says why it cannot read a computer that delo did not make and that boots no image", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const store = "/@fs/" + join(here, "../../../web-libs/kandelo-session/src/browser-computer-store.ts");
  const title = `foo-${Date.now()}`;
  await page.evaluate(async ({ store, title }) => {
    const { BrowserComputerStore } = await import(store);
    await new BrowserComputerStore().create({
      version: 1,
      id: "foo",
      title: "Foo",
      base: "kandelo:shell@abi1",
      runtime: { arch: "wasm32", kernel: "kernel@local", memoryPages: 2048, features: ["shared-array-buffer", "pty"], time: "real" },
      packages: [],
      mounts: [{ path: "/", source: "opfs", readonly: false }, { path: "/tmp", source: "scratch", ephemeral: true }],
      boot: { argv: ["sh"], cwd: "/", env: {} },
    }, "temporary", "foo", title, new Uint8Array([1, 2]));
  }, { store, title });
  await page.reload({ waitUntil: "domcontentloaded" });
  const settings = await openFiles(page, title);
  await expect(settings.getByRole("region", { name: "files" })).toHaveText(`delo did not make ${title} and it boots no image, so delo cannot read its disk`);
});

test("delo run refuses a registered app, which delo list links to", async ({ page }) => {
  const app = REGISTRY.entries.find((entry) => entry.name === RAYTRACER_SPACEFAST);
  if (app?.type !== "app") throw new Error(`${RAYTRACER_SPACEFAST} is not a registered app`);
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo run ${RAYTRACER_SPACEFAST}`);
  await expect(page.locator("#delo-output")).toContainText(`${RAYTRACER_SPACEFAST} is an app on its own deployment · open it from delo list apps`);
  await expect(page).toHaveURL(/\/pages\/delo\/$/);
  await runDelo(page, "delo list apps");
  const apps = page.getByRole("region", { name: "apps" });
  const entry = apps.locator(".delo-list-entry").filter({ has: page.getByRole("button", { name: RAYTRACER_SPACEFAST, exact: true }) });
  await entry.locator(".delo-list-row").click();
  await expect(entry.getByRole("link", { name: app.url })).toHaveAttribute("href", app.url);
});

test("Tab completes the command, the verb, and a registered name", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  await input.fill("de");
  await input.press("Tab");
  await expect(input).toHaveValue("delo ");
  await input.fill("delo ru");
  await input.press("Tab");
  await expect(input).toHaveValue("delo run");
  await input.fill("delo run @storytold/p");
  await input.press("Tab");
  await expect(input).toHaveValue("delo run @storytold/photocraft");
  await expect(input).toBeFocused();
});

test("Tab after delo run opens a dropdown the arrow keys explore", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  await input.fill("delo run");
  await input.press("Tab");
  const options = page.getByRole("option");
  await expect(options).toHaveCount(IMAGES.length);
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  await input.press("ArrowUp");
  await input.press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(input).toHaveValue(`delo run ${IMAGES[IMAGES.length - 1].name}`);
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(page).toHaveURL(/\/pages\/delo\/$/);
});

test("the output shows one line and scrolls to the next one every 2 seconds, until the last, a pointer on it pauses it, and a scroll by hand stops it", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const output = page.locator("#delo-output");
  const top = () => output.evaluate((node) => node.scrollTop);
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await runDelo(page, `delo init ${title}`);
  await runDelo(page, `delo add login ${title}`);
  await expect(output.locator(".delo-line")).toHaveCount(4);
  expect(await top()).toBe(0);
  await page.clock.runFor(2000);
  expect(await top()).toBe(26);
  await output.hover();
  await page.clock.runFor(4000);
  expect(await top()).toBe(26);
  await page.mouse.move(0, 0);
  await page.clock.runFor(2000);
  expect(await top()).toBe(52);
  await page.clock.runFor(10_000);
  expect(await top()).toBe(78);

  await runDelo(page, `delo remove login ${title}`);
  await expect(output.locator(".delo-line")).toHaveCount(2);
  expect(await top()).toBe(0);
  await output.dispatchEvent("wheel");
  await page.clock.runFor(4000);
  expect(await top()).toBe(0);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await runDelo(page, `delo add login ${title}`);
  await expect(output.locator(".delo-line")).toHaveCount(4);
  await page.clock.runFor(2000);
  await expect.poll(top).toBe(26);
});

test("Escape closes the dropdown without changing the line", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  await input.fill("delo");
  await input.press("Tab");
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(input).toHaveValue("delo ");
});

test("Tab or Enter on delo offers every verb with what it does", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  const options = page.getByRole("option");
  await input.fill("delo");
  await input.press("Tab");
  await expect(options).toHaveCount(DELO_VERBS.length);
  await input.press("Escape");
  await runDelo(page, "delo");
  await expect(options).toHaveCount(DELO_VERBS.length);
  for (const [index, verb] of DELO_VERBS.entries()) await expect(options.nth(index).locator(".delo-option-name")).toHaveText(verb);
  await expect(options.nth(0)).toContainText("open a computer or an image");
  await input.press("Enter");
  await expect(input).toHaveValue("delo run");
});

test("Tab or Enter on delo run offers every image and no app", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  const options = page.getByRole("option");
  await input.fill("delo run");
  await input.press("Tab");
  await expect(options).toHaveCount(IMAGES.length);
  await input.press("Escape");
  await runDelo(page, "delo run");
  await expect(options).toHaveCount(IMAGES.length);
  for (const [index, entry] of IMAGES.entries()) {
    await expect(options.nth(index)).toContainText(entry.name);
    await expect(options.nth(index)).toContainText("image");
  }
  await input.press("Enter");
  await expect(input).toHaveValue(`delo run ${IMAGES[0].name}`);
  await expect(page).toHaveURL(/\/pages\/delo\/$/);
});

test("a click on the page outside anything interactive puts the cursor back in the input", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  const input = page.getByRole("combobox", { name: "delo command" });
  await input.blur();
  await expect(input).not.toBeFocused();
  const size = page.viewportSize()!;
  await page.mouse.click(size.width - 5, size.height - 5);
  await expect(input).toBeFocused();
});

test("returning from the back-forward cache shows the idle line again", async ({ page }) => {
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await page.locator("#delo-output").evaluate((output) => {
    output.textContent = "open @mho22/raytracer";
  });
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.locator("#delo-output")).toHaveText(/^delotab completes · enter runs$/);
});
