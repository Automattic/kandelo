import { compactToolCatalog } from "../pages/kandelo/webmcp/discovery";
import { chromium, expect, test, type Page } from "@playwright/test";

type Result = { ok: boolean; [key: string]: any };

// Invoke the browser's native registration surface, never adapter internals.
async function call(page: Page, suffix: string, args: Record<string, unknown> = {}): Promise<Result> {
  return page.evaluate(async ({ name, args }) => {
    const context = (document as any).modelContext;
    const tool = (await context.getTools()).find((item: any) => item.name === name);
    if (!tool) throw new Error(`Registered WebMCP tool missing: ${name}`);
    const result = await context.executeTool(tool, args);
    return typeof result === "string" ? JSON.parse(result) : result;
  }, { name: `kandelo_${suffix}`, args });
}

async function open(page: Page, profile = "shell") {
  await page.goto(`/?demo=${profile}`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => typeof (document as any).modelContext?.getTools), {
    message: "Native document.modelContext is required; use webmcp.playwright.config.ts with current Chrome",
  }).toBe("function");
  await expect.poll(() => page.evaluate(async () =>
    (await (document as any).modelContext.getTools()).filter((tool: any) => tool.name.startsWith("kandelo_")).length,
  )).toBe(17);
  await expect.poll(async () => {
    try { return (await call(page, "get_computer_status")).status; }
    catch (error) {
      // Startup can replace the initial app host between discovery and invoke.
      if (String(error).includes("Registered WebMCP tool missing")) return "registering";
      throw error;
    }
  }, { timeout: 120_000 }).toBe("running");
}

async function output(page: Page, terminalId: string): Promise<string> {
  const result = await call(page, "read_terminal_output", { terminalId, byteLimit: 65536 });
  expect(result.ok).toBe(true);
  return result.output;
}

async function readyTerminal(page: Page, terminalId: string) {
  // Attachment readiness is explicitly weaker than shell/login readiness.
  await expect.poll(() => output(page, terminalId), { timeout: 60_000 }).toMatch(/\$\s|#\s/);
}

test("native discovery exposes only the agreed tools with useful schemas and read-only metadata", async ({ page }) => {
  await open(page);
  const tools = await page.evaluate(async () => (await (document as any).modelContext.getTools()).map((tool: any) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations,
  })));
  const expected = ["list_profiles", "launch_computer", "get_computer_status", "run_command", "read_job", "cancel_job", "list_terminals", "create_terminal", "switch_terminal", "send_terminal_input", "read_terminal_output", "list_files", "read_file", "write_file", "navigate_preview", "read_logs", "create_launch_link"];
  expect(tools.map((tool: any) => tool.name).sort()).toEqual(expected.map(name => `kandelo_${name}`).sort());
  for (const tool of tools) {
    expect(tool.description.length).toBeGreaterThan(50);
    const schema = typeof tool.inputSchema === "string" ? JSON.parse(tool.inputSchema) : tool.inputSchema;
    expect(schema.type).toBe("object");
  }
  expect(tools.find((tool: any) => tool.name === "kandelo_read_file").annotations.readOnlyHint).toBe(true);
  expect(tools.find((tool: any) => tool.name === "kandelo_write_file").annotations.readOnlyHint).toBe(false);
  const status = await call(page, "get_computer_status");
  const catalog = compactToolCatalog({ generationId: status.generationId, ...status.document }, tools);
  expect(catalog.documents).toHaveLength(1);
  expect(catalog.tools).toHaveLength(17);
  expect(catalog.tools.every(tool => tool.documentId === status.generationId)).toBe(true);
  expect(catalog.tools.every(tool => !('url' in tool))).toBe(true);
  const profiles = await call(page, "list_profiles");
  expect(profiles.ok).toBe(true);
  expect(profiles.profiles.some((profile: any) => profile.profileId === "shell" || profile.id === "shell")).toBe(true);
  expect((await call(page, "launch_computer", { profileId: "missing-webmcp-profile" })).error.code).toBe("UNKNOWN_PROFILE");
});

test("two live terminals preserve independent shell state, retry keys, selection and incremental output", async ({ page }) => {
  await open(page);
  const first = (await call(page, "list_terminals")).terminals[0].terminalId;
  await readyTerminal(page, first);
  const created = await call(page, "create_terminal", { requestId: "create-second", activate: false });
  expect(created.ok).toBe(true);
  const second = created.terminalId;
  expect((await call(page, "create_terminal", { requestId: "create-second", activate: false })).terminalId).toBe(second);
  expect((await call(page, "list_terminals")).terminals).toHaveLength(2);
  await readyTerminal(page, second);
  await call(page, "send_terminal_input", { terminalId: first, text: "WEBMCP_VALUE=alpha; printf 'first:%s\\n' \"$WEBMCP_VALUE\"\n" });
  await call(page, "send_terminal_input", { terminalId: second, text: "WEBMCP_VALUE=beta; printf 'second:%s\\n' \"$WEBMCP_VALUE\"\n" });
  await expect.poll(() => output(page, first)).toContain("first:alpha");
  await expect.poll(() => output(page, second)).toContain("second:beta");
  await call(page, "switch_terminal", { terminalId: second });
  await expect(page.getByRole("tab", { name: "TTY2", exact: true })).toHaveAttribute("aria-selected", "true");
  await call(page, "switch_terminal", { terminalId: first });
  await expect(page.getByRole("tab", { name: "TTY1", exact: true })).toHaveAttribute("aria-selected", "true");
  await call(page, "send_terminal_input", { terminalId: first, text: "printf 'preserved:%s\\n' \"$WEBMCP_VALUE\"\n" });
  await expect.poll(() => output(page, first)).toContain("preserved:alpha");
  const read = await call(page, "read_terminal_output", { terminalId: second, byteLimit: 65536 });
  const empty = await call(page, "read_terminal_output", { terminalId: second, cursor: read.nextCursor });
  expect(empty.output).toBe("");
  expect((await call(page, "send_terminal_input", { terminalId: first, text: "a", key: "enter" })).error.code).toBe("INVALID_ARGUMENT");
  expect((await call(page, "switch_terminal", { terminalId: "old-generation:tty-1" })).error.code).toBe("STALE_SESSION");
});

test("real guest text and binary files round-trip with explicit bounds and missing-file errors", async ({ page }) => {
  await open(page);
  const path = "/tmp/webmcp-roundtrip.txt";
  expect((await call(page, "write_file", { path, content: "hello λ\n", overwrite: true })).ok).toBe(true);
  const text = await call(page, "read_file", { path });
  expect(text.ok).toBe(true);
  expect(text.content).toBe("hello λ\n");
  const binaryPath = "/tmp/webmcp-roundtrip.bin";
  expect((await call(page, "write_file", { path: binaryPath, content: "AAECf4D/", encoding: "base64", overwrite: true })).ok).toBe(true);
  expect((await call(page, "read_file", { path: binaryPath, encoding: "base64" })).content).toBe("AAECf4D/");
  const limited = await call(page, "read_file", { path: binaryPath, encoding: "base64", offset: 2, byteLimit: 2 });
  expect(limited.content).toBe("An8=");
  expect(limited.eof).toBe(false);
  expect((await call(page, "read_file", { path: "/tmp/no-such-webmcp-file" })).error.code).toBe("FILE_NOT_FOUND");
  expect((await call(page, "read_file", { path: "/tmp/../etc/passwd" })).error.code).toBe("INVALID_ARGUMENT");
});

test("directory listing, exclusive writes, structured output and bounded log cursors", async ({ page }) => {
  await open(page);
  const listing = await call(page, "list_files", { path: "/tmp" });
  expect(listing.ok).toBe(true);
  const exclusive = await call(page, "write_file", { path: "/tmp/webmcp-exclusive", content: "x", overwrite: false });
  expect(exclusive.ok).toBe(true);
  expect((await call(page, "write_file", { path: "/tmp/webmcp-exclusive", content: "replacement", overwrite: false })).error.code).toBe("FILE_EXISTS");
  expect((await call(page, "read_file", { path: "/tmp/webmcp-exclusive" })).content).toBe("x");
  expect((await call(page, "list_files", { path: "/tmp" })).entries.some((entry: any) => entry.name === "webmcp-exclusive" && entry.type === "file")).toBe(true);
  const job = await call(page, "run_command", { script: "printf stdout; printf stderr >&2; exit 7", waitMs: 10000 });
  expect(job.ok).toBe(true);
  expect(job.stdout).toBe("stdout");
  expect(job.stderr).toBe("stderr");
  expect(job.exitCode).toBe(7);
  expect(job.terminationObserved).toBe(true);
  const logs = await call(page, "read_logs", { limit: 1 });
  expect(logs.ok).toBe(true);
  expect(logs.entries.length).toBeLessThanOrEqual(1);
  const next = await call(page, "read_logs", { cursor: logs.nextCursor, limit: 1 });
  expect(next.ok).toBe(true);
  expect(next.entries.length).toBeLessThanOrEqual(1);
  if (logs.entries.length && next.entries.length) expect(next.entries[0]).not.toEqual(logs.entries[0]);
});

test("a generated launch link has no immediate side effect and executes its script when opened", async ({ page, context }) => {
  await open(page);
  const before = await call(page, "get_computer_status");
  const link = await call(page, "create_launch_link", { profileId: "shell", startupScript: "printf 'webmcp-link:%s\\n' \"$((20 + 22))\"\n" });
  expect(link.ok).toBe(true);
  expect(link.url).toContain("#k1=");
  expect((await call(page, "get_computer_status")).generationId).toBe(before.generationId);
  const original = (await call(page, "list_terminals")).terminals[0].terminalId;
  expect(await output(page, original)).not.toContain("webmcp-link:42");
  const linked = await context.newPage();
  await linked.goto(link.url, { waitUntil: "domcontentloaded" });
  await linked.waitForFunction(async () => (await (document as any).modelContext?.getTools())?.length === 17);
  await expect.poll(async () => {
    try {
      const terminals = await call(linked, "list_terminals");
      return terminals.terminals?.[0] ? await output(linked, terminals.terminals[0].terminalId) : "";
    } catch { return ""; }
  }, { timeout: 120_000 }).toContain("webmcp-link:42");
  await linked.close();
});


test("unsupported browsers retain the manual terminal workflow", async ({ baseURL }) => {
  const browser = await chromium.launch({ channel: "chrome", args: [] });
  try {
    const page = await browser.newPage();
    await page.goto(new URL("/?demo=shell", baseURL).href, { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => typeof (document as any).modelContext)).toBe("undefined");
    await expect(page.getByRole("tab", { name: "TTY1", exact: true })).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 }).toContain("-bash-");
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect(page.getByRole("tab", { name: "TTY2", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally {
    await browser.close();
  }
});

test("terminal overflow, conflicting retries, removed IDs and native aborts are deliberate", async ({ page }) => {
  await open(page);
  const first = (await call(page, "list_terminals")).terminals[0].terminalId;
  await readyTerminal(page, first);
  const baseline = await call(page, "read_terminal_output", { terminalId: first, byteLimit: 65536 });
  await call(page, "send_terminal_input", { terminalId: first, text: "printf '%270000s' x\n" });
  await expect.poll(async () => (await call(page, "read_terminal_output", { terminalId: first })).truncated).toBe(true);
  const expired = await call(page, "read_terminal_output", { terminalId: first, cursor: baseline.nextCursor });
  expect(expired.error.code).toBe("OUTPUT_EXPIRED");
  expect((await call(page, "read_terminal_output", { terminalId: first, cursor: expired.error.oldestCursor })).ok).toBe(true);
  const second = await call(page, "create_terminal", { requestId: "conflict", activate: false });
  expect((await call(page, "create_terminal", { requestId: "conflict", activate: true })).error.code).toBe("REQUEST_CONFLICT");
  const before = (await call(page, "list_terminals")).terminals.length;
  const cancellation = await page.evaluate(async () => {
    const context = (document as any).modelContext;
    const tool = (await context.getTools()).find((tool: any) => tool.name === "kandelo_create_terminal");
    const controller = new AbortController();
    controller.abort();
    try { return await context.executeTool(tool, {}, { signal: controller.signal }); }
    catch (error) { return { name: (error as Error).name }; }
  });
  expect(cancellation.name).toBe("AbortError");
  expect((await call(page, "list_terminals")).terminals).toHaveLength(before);
  await page.getByRole("button", { name: "Close TTY2", exact: true }).click();
  expect((await call(page, "switch_terminal", { terminalId: second.terminalId })).error.code).toBe("UNKNOWN_TERMINAL");
});

test("gallery launch acknowledges navigation and destination tools reject previous IDs", async ({ page }) => {
  await open(page);
  const previous = (await call(page, "list_terminals")).terminals[0].terminalId;
  const navigation = page.waitForURL(url => url.searchParams.get("demo") === "nginx");
  const acknowledgement = await call(page, "launch_computer", { profileId: "nginx", requestId: "launch-nginx" });
  if (acknowledgement !== null) {
    expect(acknowledgement.ok).toBe(true);
    expect(acknowledgement.initiated).toBe(true);
    expect(acknowledgement.destinationUrl).toContain("demo=nginx");
  }
  await navigation;
  await page.waitForFunction(async () => (await (document as any).modelContext?.getTools())?.length === 17);
  await expect.poll(async () => {
    try { return (await call(page, "get_computer_status")).status; } catch { return "registering"; }
  }, { timeout: 120_000 }).toBe("running");
  expect((await call(page, "get_computer_status")).profile.profileId).toBe("nginx");
  expect((await call(page, "switch_terminal", { terminalId: previous })).error.code).toBe("STALE_SESSION");
});

test("nginx serves a guest file through the preview and rejects external or traversing paths", async ({ page }) => {
  await open(page, "nginx");
  const configuration = await call(page, "read_file", { path: "/etc/nginx/nginx.conf" });
  expect(configuration.content).toContain("root /var/www/html");
  expect((await call(page, "write_file", {
    path: "/var/www/html/webmcp-proof.html", content: "<!doctype html><h1 id='proof'>WebMCP served proof</h1>", overwrite: true,
  })).ok).toBe(true);
  await expect.poll(async () => (await call(page, "get_computer_status")).capabilities.preview, { timeout: 60_000 }).toBe(true);
  const navigated = await call(page, "navigate_preview", { path: "/webmcp-proof.html?test=1#proof" });
  expect(navigated.ok).toBe(true);
  expect(navigated.requestedPath).toBe("/webmcp-proof.html?test=1#proof");
  await expect(page.frameLocator('iframe.kweb-frame').getByRole("heading", { name: "WebMCP served proof" })).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await call(page, "get_computer_status")).previewProgress?.rendered).toBe(true);
  const progress = (await call(page, "get_computer_status")).previewProgress;
  expect(progress.http).toEqual({ state: "received", status: 200 });
  expect(progress.documentLoaded).toBe(true);
  await expect(page.getByText("Loading...", { exact: true })).not.toBeVisible();
  await call(page, "navigate_preview", { path: "/webmcp-proof.html?test=1#another" });
  await expect.poll(async () => (await call(page, "get_computer_status")).previewProgress?.rendered).toBe(true);
  expect((await call(page, "get_computer_status")).previewProgress.http.state).toBe("not_requested");
  await expect(page.getByText("Loading...", { exact: true })).not.toBeVisible();
  expect((await call(page, "write_file", {
    path: "/var/www/html/webmcp-proof.html", content: "<!doctype html><h1>Updated WebMCP proof</h1>", overwrite: true,
  })).ok).toBe(true);
  await call(page, "navigate_preview", { path: "/webmcp-proof.html?test=1#another" });
  await expect(page.frameLocator('iframe.kweb-frame').getByRole("heading", { name: "Updated WebMCP proof" })).toBeVisible();
  await expect.poll(async () => (await call(page, "get_computer_status")).previewProgress?.http).toEqual({ state: "received", status: 200 });
  for (const path of ["https://example.com/", "//example.com/", "/%2e%2e/etc/passwd", "/foo\\bar", "/%252e%252e/"]) {
    expect((await call(page, "navigate_preview", { path })).error.code).toBe("INVALID_ARGUMENT");
  }
  const exposed = await page.locator('iframe.kweb-frame').evaluate((element: HTMLIFrameElement) => {
    return (element.contentDocument as any)?.modelContext?.getTools().then((tools: any[]) => tools.filter(tool => tool.name.startsWith("kandelo_") && tool.window === element.contentWindow).length);
  });
  // Same-origin discovery may include parent tools, but the guest registers none.
  expect(exposed === undefined || exposed === 0).toBe(true);
});


test("owned jobs isolate env/cwd, retry safely, cancel descendants and time out", async ({ page }) => {
  await open(page);
  const args = { script: 'printf "%s:%s" "$PWD" "$JOB_VALUE"; (printf child; sleep 60) & wait', cwd: "/tmp", env: { JOB_VALUE: "test" }, waitMs: 1000, requestId: "owned" };
  const unrelated = await call(page, "run_command", { script: "sleep 2; printf unrelated", waitMs: 0 });
  const job = await call(page, "run_command", args);
  expect(job.ok).toBe(true);
  expect((await call(page, "run_command", args)).jobId).toBe(job.jobId);
  expect(job.stdout).toContain("/tmp:test");
  expect((await call(page, "cancel_job", { jobId: job.jobId })).ok).toBe(true);
  await expect.poll(async () => (await call(page, "read_job", { jobId: job.jobId })).status).toBe("cancelled");
  const done = await call(page, "read_job", { jobId: job.jobId });
  expect(done.terminationObserved).toBe(true);
  expect(done.stdout).toContain("child");
  expect((await call(page, "read_job", { jobId: job.jobId, cursor: done.nextCursor })).stdout).toBe("");
  const timeout = await call(page, "run_command", { script: "sleep 60 & wait", timeoutMs: 100, waitMs: 1000 });
  expect(timeout.ok).toBe(true);
  await expect.poll(async () => (await call(page, "read_job", { jobId: timeout.jobId })).status).toBe("timed_out");
  const next = await call(page, "run_command", { script: 'printf "%s:%s" "$PWD" "${JOB_VALUE-unset}"', waitMs: 10000 });
  expect(next.stdout).toBe("/:unset");
  await expect.poll(async () => (await call(page, "read_job", { jobId: unrelated.jobId })).status).toBe("completed");
  expect((await call(page, "read_job", { jobId: unrelated.jobId })).stdout).toBe("unrelated");
  const orphaned = await call(page, "run_command", { script: "sleep 60 & exit 7", waitMs: 1000 });
  expect(orphaned.exitCode).toBe(7);
  expect(orphaned.terminationObserved).toBe(false);
  await call(page, "cancel_job", { jobId: orphaned.jobId });
  await expect.poll(async () => (await call(page, "read_job", { jobId: orphaned.jobId })).terminationObserved).toBe(true);
});

test("completed job families leave no process records after timeout or cancellation", async ({ page }) => {
  await open(page);
  expect((await call(page, "navigate_preview", { path: "/" })).error.code).toBe("UNSUPPORTED_CAPABILITY");
  for (const mode of ["timeout", "cancel", "timeout"]) {
    const job = await call(page, "run_command", {
      script: 'sleep 120 & printf "%s\\n" "$!"; wait',
      timeoutMs: mode === "timeout" ? 1000 : 30000,
      waitMs: mode === "timeout" ? 10000 : 500,
    });
    expect(job.ok).toBe(true);
    if (mode === "cancel") await call(page, "cancel_job", { jobId: job.jobId });
    await expect.poll(async () => (await call(page, "read_job", { jobId: job.jobId })).terminationObserved).toBe(true);
    const done = await call(page, "read_job", { jobId: job.jobId });
    expect(done.status).toBe(mode === "timeout" ? "timed_out" : "cancelled");
    const child = Number(done.stdout.trim());
    expect(child).toBeGreaterThan(job.pid);
    const check = await call(page, "run_command", {
      script: `test ! -e /proc/${job.pid}/status && test ! -e /proc/${child}/status`, waitMs: 10000,
    });
    expect(check.exitCode).toBe(0);
  }
});


test("exclusive creation rejects symlinks and concurrent creators cannot clobber each other", async ({ page }) => {
  await open(page);
  const created = await Promise.all(["first", "second"].map(content => call(page, "write_file", { path: "/tmp/exclusive-race", content, overwrite: false })));
  expect(created.filter(result => result.ok)).toHaveLength(1);
  expect(created.find(result => !result.ok)?.error.code).toBe("FILE_EXISTS");
  const winner = created[0].ok ? "first" : "second";
  expect((await call(page, "read_file", { path: "/tmp/exclusive-race" })).content).toBe(winner);
  const linked = await call(page, "run_command", { script: "ln -s /tmp/exclusive-race /tmp/exclusive-link", waitMs: 10000 });
  expect(linked.exitCode).toBe(0);
  expect((await call(page, "write_file", { path: "/tmp/exclusive-link", content: "clobber", overwrite: false })).error.code).toBe("FILE_EXISTS");
  expect((await call(page, "read_file", { path: "/tmp/exclusive-race" })).content).toBe(winner);
});
