import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appUrl } from "./support/kandelo-machine";

// Chrome exposes document.modelContext only behind this flag. These args
// replace the project's, so the two WebRTC switches of playwright.config.ts
// come along for the network session between two contexts.
test.use({ launchOptions: { args: ["--mute-audio", "--enable-experimental-web-platform-features", "--disable-features=MediaEngagementBypassAutoplayPolicies,WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection"] } });
test.skip(({ browserName }) => browserName !== "chromium", "WebMCP is a Chrome API");

type Result = { ok: boolean; [key: string]: any };

/** A line of `openComputer`: a command the computer's name ends, or the whole line from the name. */
type Line = string | ((title: string) => string);

/** A computer that starts Doom in its terminal's shell at boot. */
const DOOM = ["delo add doom"];

async function openComputer(page: Page, title: string, lines: Line[]): Promise<void> {
  const input = page.getByRole("combobox", { name: "delo command" });
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  for (const line of [`delo init ${title}`, ...lines.map((line) => typeof line === "string" ? `${line} ${title}` : line(title)), `delo run ${title}`]) {
    await input.fill(line);
    await input.press("Enter");
  }
  await page.waitForURL((url) => url.pathname.endsWith("/pages/delo/computer/") && url.searchParams.get("computer") !== null);
}

const tools = (page: Page) => page.evaluate(async () => (await (document as any).modelContext.getTools()).map((tool: any) => tool.name).sort());

async function call(page: Page, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(async ({ name, args }) => {
    const context = (document as any).modelContext;
    const tool = (await context.getTools()).find((item: any) => item.name === name);
    if (!tool) throw new Error(`Registered WebMCP tool missing: ${name}`);
    return JSON.parse(await context.executeTool(tool, JSON.stringify(args)));
  }, { name, args });
}

const description = (page: Page, name: string) => page.evaluate(async (name) => (await (document as any).modelContext.getTools()).find((tool: any) => tool.name === name)?.description, name);

const inputSchema = (page: Page, name: string) => page.evaluate(async (name) => {
  const found = (await (document as any).modelContext.getTools()).find((tool: any) => tool.name === name);
  return typeof found?.inputSchema === "string" ? JSON.parse(found.inputSchema) : found?.inputSchema;
}, name);

const ID_TOOL = {
  description: "Print the user and groups the tool runs as",
  inputSchema: { type: "object", properties: { flag: { type: "string" } } },
  command: ["/usr/bin/id", "{flag}"],
};

/** How many colors the PNG `data` holds: more than one means something is drawn. */
const colors = (page: Page, data: string) => page.evaluate(async (data) => {
  const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const pixels = new Uint32Array(context.getImageData(0, 0, image.width, image.height).data.buffer);
  return new Set(pixels).size;
}, data);

test("the delo page registers a delo_ tool for each verb, which runs the command a visitor types", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const output = page.locator("#delo-output");
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await expect.poll(() => tools(page)).toEqual(["delo_add", "delo_config", "delo_destroy", "delo_disable", "delo_enable", "delo_init", "delo_list", "delo_remove", "delo_run", "delo_save", "delo_write"]);
  expect((await call(page, "delo_list", { tab: "binaries" })).entries.map((entry: { name: string }) => entry.name)).toContain("bash");
  expect(await call(page, "delo_init", { name: title })).toMatchObject({ ok: true, lines: [{ label: "init", text: `${title} computer created.` }], computers: [{ name: title, state: "draft" }] });
  await expect(output).toHaveText(`init${title} computer created.`);
  expect((await call(page, "delo_add", { name: "bash", computer: title })).computers[0].configuration.pipeline.use).toContain("bash");
  expect((await call(page, "delo_add", { name: "foo", computer: title })).error.code).toBe("OPERATION_FAILED");
  expect((await call(page, "delo_config", { computer: title, description: "foo" })).settings).toMatchObject({ name: title, description: "foo", state: "draft" });
  expect((await call(page, "delo_config", { computer: title, name: title.toUpperCase() })).error.code).toBe("INVALID_ARGUMENT");
  expect((await call(page, "delo_config", { computer: title, name: `${title}-foo` })).settings).toMatchObject({ name: `${title}-foo` });
  expect((await call(page, "delo_config", { computer: `${title}-foo`, name: title })).settings).toMatchObject({ name: title });
  expect((await call(page, "delo_config", { computer: title, pipelineName: "foo-pipeline", pipelineDescription: "bar" })).settings.configuration.pipeline).toMatchObject({ name: "foo-pipeline", description: "bar" });
  expect((await call(page, "delo_config", { computer: title, pipelineName: "bash" })).error).toMatchObject({ code: "INVALID_ARGUMENT", message: "bash is already the name of a registry entry" });
  expect((await call(page, "delo_config", { computer: title, pipelineDescription: "a".repeat(501) })).error.code).toBe("INVALID_ARGUMENT");

  expect((await call(page, "delo_enable", { name: "internals", computer: title })).computers[0].configuration.pipeline.enable).toEqual(["internals"]);
  expect((await call(page, "delo_write", { computer: title, file: { to: "/etc/mcp/pipeline_id.json", content: JSON.stringify(ID_TOOL) } })).lines).toEqual([{ label: "write", text: `/etc/mcp/pipeline_id.json written to the pipeline of ${title}` }]);

  const destroyed = call(page, "delo_destroy", { computer: title });
  await expect(output).toHaveText(`destroyconfirm you want to destroy ${title} ? (Y/N)`);
  expect((await call(page, "delo_init", {})).error.code).toBe("NOT_READY");
  await page.keyboard.press("n");
  expect((await destroyed).lines).toEqual([{ label: "destroy", text: `${title} kept.` }]);

  const ran = await call(page, "delo_run", { name: title });
  expect(ran.lines).toEqual([{ label: "open", text: `${title} · draft` }]);
  expect(ran.computers.map((computer: { name: string }) => computer.name)).toContain(title);
  await page.waitForURL((url) => url.pathname.endsWith("/pages/delo/computer/"));
  await expect.poll(() => tools(page), { timeout: 120_000 }).toEqual(["delo_page", "device_terminal_read", "device_terminal_type", "option_internals_read", "unofficial_pipeline_id"]);
});

test("a computer registers the tools of its terminal, which type and read", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, ["delo add base-files", "delo add bash", "delo enable mcp"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toEqual(["delo_page", "device_terminal_read", "device_terminal_type"]);
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen, { timeout: 120_000 }).toContain("bash-5.2#");
  expect(await call(page, "device_terminal_type", { text: "echo DELO_$((6*7))\n" })).toEqual({ ok: true, delivered: true });
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen).toMatch(/^DELO_42$/m);
  expect((await call(page, "device_terminal_type", { text: "x", foo: 1 })).error.code).toBe("INVALID_ARGUMENT");
});

test("the framebuffer tools take a PNG of /dev/fb0 and send keys and the mouse to its process", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, [...DOOM, "delo enable mcp"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toEqual(["delo_page", "device_framebuffer_screenshot", "device_keyboard_press", "device_pointer_click", "device_pointer_move", "device_terminal_read", "device_terminal_type"]);
  await expect.poll(async () => (await call(page, "device_framebuffer_screenshot")).width, { timeout: 120_000 }).toBe(640);
  const screenshot = await call(page, "device_framebuffer_screenshot");
  expect(screenshot).toMatchObject({ mimeType: "image/png", width: 640, height: 400 });
  expect(await colors(page, screenshot.data)).toBeGreaterThan(1);
  expect(await call(page, "device_keyboard_press", { keys: ["Enter"] })).toEqual({ ok: true, pressed: ["Enter"] });
  expect((await call(page, "device_keyboard_press", { keys: ["Foo"] })).error.code).toBe("INVALID_ARGUMENT");
  expect(await call(page, "device_pointer_move", { dx: 300, dy: -20 })).toEqual({ ok: true, dx: 300, dy: -20 });
  expect(await call(page, "device_pointer_click", { button: "right" })).toEqual({ ok: true, button: "right" });
  expect((await call(page, "device_pointer_move", { dx: 5000, dy: 0 })).error.code).toBe("INVALID_ARGUMENT");
});

test("the display tools take a PNG of the scanout and click inside it", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, ["delo add base-files", "delo add bash", "delo add modeset", "delo enable mcp"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toEqual(["delo_page", "device_display_screenshot", "device_keyboard_press", "device_pointer_click", "device_pointer_move", "device_terminal_read", "device_terminal_type"]);
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen, { timeout: 120_000 }).toContain("bash-5.2#");
  expect((await call(page, "device_display_screenshot")).error.code).toBe("NOT_READY");
  await call(page, "device_terminal_type", { text: "modeset\n" });
  await expect.poll(async () => (await call(page, "device_display_screenshot")).ok, { timeout: 60_000 }).toBe(true);
  const screenshot = await call(page, "device_display_screenshot");
  expect(screenshot).toMatchObject({ mimeType: "image/png", width: screenshot.scanout.width, height: screenshot.scanout.height });
  expect(await colors(page, screenshot.data)).toBeGreaterThan(1);
  expect(await call(page, "device_pointer_click", { x: 10, y: 10 })).toEqual({ ok: true, x: 10, y: 10 });
  expect((await call(page, "device_pointer_move", { x: screenshot.scanout.width, y: 0 })).error.code).toBe("INVALID_ARGUMENT");
});

test("device_web_open shows a guest path in the web frame and device_web_read reads it", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, ["delo add web-static", "delo enable mcp"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toEqual(["delo_page", "device_web_open", "device_web_read"]);
  await expect.poll(async () => (await call(page, "device_web_open", { path: "/index.html?foo=bar" })).ok, { timeout: 120_000 }).toBe(true);
  await expect(page.locator("#delo-web iframe")).toHaveAttribute("src", /\/index\.html\?foo=bar$/);
  expect((await call(page, "device_web_open", { path: "//example.com/" })).error.code).toBe("INVALID_ARGUMENT");
  await expect.poll(async () => (await call(page, "device_web_read")).loaded, { timeout: 60_000 }).toBe(true);
  expect(await call(page, "device_web_read")).toMatchObject({ ok: true, path: "/index.html?foo=bar", title: "nginx on Delo", truncated: false });
  expect((await call(page, "device_web_read")).text).toContain("nginx serves this page");
});

test("a tool file in /etc/mcp registers an unofficial_ tool named after the file that runs its program as root on a computer with no login", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, ["delo add base-files", "delo add bash", "delo add coreutils", "delo enable mcp"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toContain("device_terminal_read");
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen, { timeout: 120_000 }).toContain("bash-5.2#");
  await call(page, "device_terminal_type", { text: `mkdir -p /etc/mcp && cat > /etc/mcp/binary_id.json <<'EOF'\n${JSON.stringify(ID_TOOL)}\nEOF\n` });
  await expect.poll(() => tools(page), { timeout: 60_000 }).toContain("unofficial_binary_id");
  expect(await call(page, "unofficial_binary_id")).toMatchObject({ ok: true, stdout: expect.stringMatching(/^uid=0\(root\) gid=0\(root\)/), exitCode: 0 });
  expect(await call(page, "unofficial_binary_id", { flag: "-u" })).toMatchObject({ ok: true, stdout: "0\n", exitCode: 0 });
  await call(page, "device_terminal_type", { text: "rm /etc/mcp/binary_id.json\n" });
  await expect.poll(() => tools(page), { timeout: 60_000 }).not.toContain("unofficial_binary_id");
});

test("a tool runs as the user who logs in", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await openComputer(page, title, ["delo add login", "delo add maker-account", "delo add bash", "delo add coreutils", "delo enable mcp"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toContain("device_terminal_read");
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen, { timeout: 120_000 }).toContain("login:");

  const input = page.getByRole("combobox", { name: "delo command" });
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await input.fill(`delo config ${title}`);
  await input.press("Enter");
  const settings = page.getByRole("region", { name: "computer settings" });
  await settings.getByRole("button", { name: "files" }).click();
  await expect(settings.locator(".delo-view-status")).toHaveText("disk open", { timeout: 120_000 });
  await settings.locator(".delo-list-row").filter({ hasText: /^etc\/$/ }).click();
  await expect(settings.locator(".delo-files-path")).toHaveText("/etc");
  const tree = mkdtempSync(join(tmpdir(), "delo-mcp-"));
  mkdirSync(join(tree, "mcp"));
  writeFileSync(join(tree, "mcp", "binary_id.json"), JSON.stringify(ID_TOOL));
  const pane = await settings.locator(".delo-files-pane").boundingBox();
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { type: type as "dragEnter", x: pane!.x + pane!.width / 2, y: pane!.y + pane!.height / 2, data: { items: [], files: [join(tree, "mcp")], dragOperationsMask: 1 } });
  }
  await expect(settings.locator(".delo-files-message")).toHaveText("1 file uploaded into /etc. delo saves the disk when the settings close.");
  await settings.getByRole("button", { name: "close" }).click();
  await expect(settings).toBeHidden({ timeout: 120_000 });
  await input.fill(`delo run ${title}`);
  await input.press("Enter");
  await page.waitForURL((url) => url.pathname.endsWith("/pages/delo/computer/"));

  await expect.poll(() => tools(page), { timeout: 120_000 }).toContain("unofficial_binary_id");
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen, { timeout: 120_000 }).toContain("login:");
  expect(await call(page, "unofficial_binary_id", { flag: "-u" })).toMatchObject({ ok: true, stdout: "0\n" });
  await call(page, "device_terminal_type", { text: "maker\n" });
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen).toContain("Password:");
  await call(page, "device_terminal_type", { text: "kandelo\n" });
  await expect.poll(async () => (await call(page, "unofficial_binary_id")).stdout, { timeout: 60_000 }).toMatch(/^uid=1000\(maker\) gid=1000\(maker\)/);
});

test("redis-board registers pipeline_ tools that use the board through PHP and Redis", async ({ page }) => {
  await openComputer(page, `delo-${Date.now()}`, ["delo add redis-board"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toEqual(expect.arrayContaining(["pipeline_redis-board-add", "pipeline_redis-board-ideas", "pipeline_redis-board-vote"]));
  await expect.poll(async () => (await call(page, "pipeline_redis-board-ideas")).exitCode, { timeout: 120_000 }).toBe(0);
  const added = await call(page, "pipeline_redis-board-add", { title: "foo" });
  expect(added).toMatchObject({ ok: true, exitCode: 0 });
  const foo = JSON.parse(added.stdout).ideas.find((idea: { title: string }) => idea.title === "foo");
  expect(foo).toMatchObject({ votes: 0 });
  const voted = await call(page, "pipeline_redis-board-vote", { id: foo.id });
  expect(JSON.parse(voted.stdout).ideas).toContainEqual({ id: foo.id, title: "foo", votes: 1 });
  expect(await call(page, "pipeline_redis-board-vote", { id: "999" })).toMatchObject({ ok: true, exitCode: 1, stdout: expect.stringContaining("That idea no longer exists") });
});

test("an agent's first input and an untrusted tool file wait for the visitor's acceptance, once per page session", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await openComputer(page, title, ["delo add base-files", "delo add bash", "delo add coreutils"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toContain("device_terminal_read");
  await expect.poll(async () => (await call(page, "device_terminal_read")).screen, { timeout: 120_000 }).toContain("bash-5.2#");
  const refused = call(page, "device_terminal_type", { text: "echo foo\n" });
  await expect(dialog).toContainText("An agent calls device_terminal_type");
  await dialog.getByRole("button", { name: "Refuse" }).click();
  expect((await refused).error.code).toBe("PERMISSION_DENIED");

  const typed = call(page, "device_terminal_type", { text: `mkdir -p /etc/mcp && cat > /etc/mcp/binary_id.json <<'EOF'\n${JSON.stringify(ID_TOOL)}\nEOF\n` });
  await dialog.getByRole("button", { name: "Accept" }).click();
  expect(await typed).toEqual({ ok: true, delivered: true });
  await expect.poll(() => tools(page), { timeout: 60_000 }).toContain("unofficial_binary_id");
  expect(await description(page, "unofficial_binary_id")).toBe(`Unofficial tool from /etc/mcp/binary_id.json on the delo computer ${title}. Calling it asks the user to accept it.`);

  const id = call(page, "unofficial_binary_id", { flag: "-u" });
  await expect(dialog).toContainText(ID_TOOL.description);
  await expect(dialog).toContainText("/usr/bin/id {flag}");
  await dialog.getByRole("button", { name: "Accept" }).click();
  expect(await id).toMatchObject({ ok: true, stdout: "0\n", exitCode: 0 });
  await expect.poll(() => description(page, "unofficial_binary_id")).toBe(ID_TOOL.description);
  expect(await call(page, "unofficial_binary_id", { flag: "-u" })).toMatchObject({ ok: true, stdout: "0\n" });
  expect(await call(page, "device_terminal_type", { text: "\n" })).toEqual({ ok: true, delivered: true });
  await expect(dialog).toBeHidden();

  const flagTool = { ...ID_TOOL, inputSchema: { type: "object", properties: { Flag: { type: "string" } } }, command: ["/usr/bin/id", "{Flag}"] };
  await call(page, "device_terminal_type", { text: `cat > /etc/mcp/binary_id.json <<'EOF'\n${JSON.stringify(flagTool)}\nEOF\n` });
  await expect.poll(() => description(page, "unofficial_binary_id")).toBe(`Unofficial tool from /etc/mcp/binary_id.json on the delo computer ${title}. Calling it asks the user to accept it.`);
  expect(await inputSchema(page, "unofficial_binary_id")).toEqual({ type: "object" });
  const escaped = call(page, "unofficial_binary_id", {});
  await expect(dialog).toContainText("/usr/bin/id {Flag}");
  await page.keyboard.press("Escape");
  expect((await escaped).error.code).toBe("PERMISSION_DENIED");
  const unready = call(page, "unofficial_binary_id", {});
  await dialog.getByRole("button", { name: "Accept" }).click();
  expect((await unready).error.code).toBe("NOT_READY");
  await expect.poll(() => inputSchema(page, "unofficial_binary_id")).toEqual(flagTool.inputSchema);
  expect(await call(page, "unofficial_binary_id", { Flag: "-u" })).toMatchObject({ ok: true, stdout: "0\n" });
});

test("a tool file delo write puts in the computer's pipeline is trusted: it registers as unofficial_ with its own text and runs without asking", async ({ page }) => {
  const content = JSON.stringify(JSON.stringify(ID_TOOL)).slice(1, -1);
  await openComputer(page, `delo-${Date.now()}`, ["delo add base-files", "delo add bash", "delo add coreutils", (title) => `delo write /etc/mcp/pipeline_id.json ${title} --content "${content}"`]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toContain("unofficial_pipeline_id");
  expect(await description(page, "unofficial_pipeline_id")).toBe(ID_TOOL.description);
  await expect.poll(async () => (await call(page, "unofficial_pipeline_id", { flag: "-u" })).stdout, { timeout: 120_000 }).toBe("0\n");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("no delo tool turns on mcp, which accepts every tool without asking", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await page.goto(appUrl("/pages/delo/"), { waitUntil: "domcontentloaded" });
  await expect.poll(() => tools(page)).toContain("delo_enable");
  await call(page, "delo_init", { name: title });
  expect((await call(page, "delo_enable", { name: "mcp", computer: title })).error).toMatchObject({ code: "PERMISSION_DENIED", message: `An agent cannot turn on mcp: it accepts every WebMCP tool without asking the visitor. The visitor can type delo enable mcp <computer>.` });
  expect((await call(page, "delo_enable", { name: "internals", computer: title })).computers[0].configuration.pipeline.enable).toEqual(["internals"]);
  expect((await call(page, "delo_config", { computer: title, folder: "/" })).error).toMatchObject({ code: "INVALID_ARGUMENT", message: `${title} is a draft, so it has no disk yet. Run it with delo run first.` });
});

test("the option tools read the processes and the share link and set the sound, and delo_page goes back to delo, whose delo_config lists the disk", async ({ page }) => {
  const title = `delo-${Date.now()}`;
  await openComputer(page, title, ["delo add base-files", "delo add bash", "delo enable internals", "delo enable share", "delo enable sound", "delo enable mcp"]);
  await expect.poll(() => tools(page), { timeout: 120_000 }).toEqual(["delo_page", "device_terminal_read", "device_terminal_type", "option_internals_read", "option_share_read", "option_sound_set"]);
  await expect.poll(async () => (await call(page, "option_internals_read")).processes?.map((process: { command: string }) => process.command) ?? [], { timeout: 120_000 }).toContain("-bash");
  expect((await call(page, "option_share_read")).link).toContain("/pages/delo/");
  expect(await call(page, "option_sound_set", { on: true })).toMatchObject({ ok: true, on: true });
  await expect(page.locator("#delo-option-sound")).toHaveAttribute("aria-pressed", "true");
  await call(page, "delo_page").catch(() => null);
  await page.waitForURL((url) => url.pathname.endsWith("/pages/delo/"));
  await expect.poll(() => tools(page)).toContain("delo_config");
  const etc = await call(page, "delo_config", { computer: title, folder: "/etc" });
  expect(etc.settings).toMatchObject({ name: title });
  expect(etc.files).toEqual(expect.arrayContaining([expect.objectContaining({ name: "passwd", path: "/etc/passwd", kind: "file" })]));
  expect((await call(page, "delo_config", { computer: title, folder: "/usr/bin" })).files.map((file: { name: string }) => file.name)).toContain("bash");
  expect((await call(page, "delo_config", { computer: title, folder: "etc" })).error.code).toBe("INVALID_ARGUMENT");
});

test("two computers meet in a network session through the network tools", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const guest = await browser.newContext();
  const other = await guest.newPage();
  const lines = ["delo add base-files", "delo add bash", "delo enable network", "delo enable mcp"];
  await openComputer(page, `delo-${Date.now()}-host`, lines);
  await openComputer(other, `delo-${Date.now()}-peer`, lines);
  for (const computer of [page, other]) await expect.poll(() => tools(computer), { timeout: 120_000 }).toEqual(expect.arrayContaining(["device_terminal_read", "option_network_create"]));
  for (const computer of [page, other]) await expect.poll(async () => (await call(computer, "device_terminal_read")).screen, { timeout: 120_000 }).toContain("bash-5.2#");
  expect(await call(page, "option_network_read")).toMatchObject({ ok: true, phase: "offline", link: null });
  const created = await call(page, "option_network_create");
  expect(created).toMatchObject({ ok: true, phase: "connected" });
  expect(created.link).toContain("network=");
  expect(await call(other, "option_network_join", { link: created.link })).toMatchObject({ ok: true, phase: "connected" });
  await expect.poll(async () => (await call(page, "option_network_read")).members.length, { timeout: 60_000 }).toBe(2);
  expect((await call(page, "option_network_read")).address).toBe("10.89.0.1");
  await expect.poll(async () => (await call(other, "option_network_read")).address, { timeout: 60_000 }).toBe("10.89.0.2");
  expect((await call(other, "option_network_join", { link: "https://foo.test/" })).error.code).toBe("INVALID_ARGUMENT");
  expect(await call(other, "option_network_leave")).toMatchObject({ ok: true, phase: "offline" });
  await guest.close();
});
