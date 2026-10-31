import { clickDockTool } from "./support/dock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { machineUrl } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { installPcmRetirementTrace } from "./support/pcm-retirement-trace";

const shellImageReady = [
  "programs/wasm32/bash.wasm",
  "programs/wasm32/shell.vfs.zst",
].every((path) => {
  try {
    return tryResolveBinary(path) !== null;
  } catch {
    return false;
  }
});

test.skip(!shellImageReady && process.env.KANDELO_TEST_MACHINE_URLS === undefined, "ABI-matched browser shell product is required");

async function waitForShell(page: Page): Promise<void> {
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => {
    const failure = await page.locator('.kdock-status-text[data-status="error"]').count();
    if (failure > 0) {
      const lines = await page.locator(".ksys-line").allTextContents();
      throw new Error(`persistent shell boot failed:\n${lines.join("\n")}`);
    }
    return page.locator(".xterm-rows").first().textContent();
  }, { timeout: 120_000 }).toMatch(/kandelo(?:-bash-[0-9.]+)?\$ ?/);
}

test("Kandelo shell-created files survive OPFS reload and checkpoint", async ({ playwright, browserName }, testInfo) => {
  test.setTimeout(360_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-persistent-shell-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      await context.addInitScript(() => { window.confirm = () => true; });
      if (process.env.KANDELO_TRACE_PCM_RETIREMENT === "1") await installPcmRetirementTrace(context);
      const page = context.pages()[0] ?? await context.newPage();
      if (process.env.KANDELO_TRACE_PCM_RETIREMENT === "1") page.on("console", message => {
        if (message.text().startsWith("pcm-retirement-trace ")) console.log(browserName, message.text());
      });
      const target = await machineUrl(page, "shell", {
        search: {
          experimentalPersistence: `shell-${crypto.randomUUID()}`,
          experimentalPersistenceMode: "resizable",
        },
      });
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await waitForShell(page);
      await runTerminalCommand(page,
        `set -eu
read -r filesystem total used_before free_before percent mount < <(df -P -k / | tail -n 1)
test "$total" -gt 0
test "$total" -lt 1048576
mkdir -p /home/projects/persist-check
printf 'one\\n' > /home/projects/persist-check/note
sync
read -r filesystem total_after used_after free_after percent mount < <(df -P -k / | tail -n 1)
test "$total_after" -eq "$total"
test "$free_after" -lt "$free_before"
printf 'PERSIST_CREATED\\n'`,
        "PERSIST_CREATED");

      const imageUrl = new URL(target, page.url()).searchParams.get("vfs");
      if (imageUrl === null) throw new Error("shell machine URL has no image");
      await page.route(imageUrl, (route) => route.abort("failed"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(page);
      await runTerminalCommand(page,
        "set -eu; IFS= read -r value < /home/projects/persist-check/note; test \"$value\" = one; printf 'PERSIST_RELOADED\\n'",
        "PERSIST_RELOADED");
      await runTerminalCommand(page,
        "set -eu; printf 'two\\n' >> /home/projects/persist-check/note; sync; printf 'PERSIST_APPENDED\\n'",
        "PERSIST_APPENDED");

      await clickDockTool(page, "Internals");
      await page.getByRole("button", { name: "Checkpoint image" }).click();
      await page.locator('.kdock-status-text[data-status="booting"]').waitFor({ timeout: 120_000 });
      await expect.poll(async () => {
        const status = await page.locator(".kdock-status-text").getAttribute("data-status");
        if (status === "error") {
          throw new Error(`persistent shell checkpoint failed:\n${(await page.locator(".ksys-line").allTextContents()).join("\n")}`);
        }
        return status;
      }, { timeout: 120_000 }).toBe("running");
      await waitForShell(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(page);
      await runTerminalCommand(page,
        "set -eu; mapfile -t lines < /home/projects/persist-check/note; test \"${lines[0]}:${lines[1]}\" = one:two; printf 'PERSIST_CHECKPOINTED\\n'",
        "PERSIST_CHECKPOINTED");
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Kandelo shell reopens synced files after a browser-process crash", async ({ playwright, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "browser-process crash requires Chromium CDP");
  test.setTimeout(240_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const launchOptions = {
    channel: projectUse.channel,
    proxy: projectUse.proxy as never,
    extraHTTPHeaders: projectUse.extraHTTPHeaders,
    ...(projectUse.launchOptions ?? {}),
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-persistent-shell-crash-"));
  try {
    const context = await playwright.chromium.launchPersistentContext(userDataDir, launchOptions);
    let recoveryContext: typeof context | null = null;
    try {
      await context.addInitScript(() => { window.confirm = () => true; });
      const page = context.pages()[0] ?? await context.newPage();
      const target = await machineUrl(page, "shell", {
        search: {
          experimentalPersistence: `shell-crash-${crypto.randomUUID()}`,
          experimentalPersistenceMode: "resizable",
        },
      });
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await waitForShell(page);
      await runTerminalCommand(page,
        "set -eu; printf 'crash-safe\\n' > /home/projects/crash-proof; sync; printf 'PERSIST_SYNCED\\n'",
        "PERSIST_SYNCED");
      const imageUrl = new URL(target, page.url()).searchParams.get("vfs");
      if (imageUrl === null) throw new Error("shell machine URL has no image");

      const session = await context.newCDPSession(page);
      const closed = context.waitForEvent("close", { timeout: 15_000 });
      void session.send("Browser.crash").catch(() => {});
      await closed;

      recoveryContext = await playwright.chromium.launchPersistentContext(userDataDir, launchOptions);
      await recoveryContext.addInitScript(() => { window.confirm = () => true; });
      const recoveryPage = recoveryContext.pages()[0] ?? await recoveryContext.newPage();
      await recoveryPage.route(imageUrl, (route) => route.abort("failed"));
      await recoveryPage.goto(target, { waitUntil: "domcontentloaded" });
      await waitForShell(recoveryPage);
      await runTerminalCommand(recoveryPage,
        "set -eu; IFS= read -r value < /home/projects/crash-proof; test \"$value\" = crash-safe; printf 'PERSIST_CRASH_RECOVERED\\n'",
        "PERSIST_CRASH_RECOVERED");
    } finally {
      if (recoveryContext !== null) await recoveryContext.close();
      else await context.close().catch(() => {});
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
