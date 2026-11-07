import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import { runTerminalCommand } from "./support/terminal-command";

// A computer made from the worktree's partial image keeps its files across
// reloads but not across rebuilds (docs/browser-support.md "Computer library
// and retention"). This test rebuilds the partial image itself, so it runs
// only when KANDELO_PARTIAL_REBUILD names the packages for the rebuild, e.g.
//   KANDELO_PARTIAL_REBUILD="shell tmux" npx playwright test partial-image-reset
const repo = resolve(import.meta.dirname, "../../..");
const manifestPath = join(repo, "local-binaries/partial/partial.json");
const rebuild = process.env.KANDELO_PARTIAL_REBUILD?.split(/\s+/).filter(Boolean);
test.skip(!existsSync(manifestPath) || rebuild === undefined, "set KANDELO_PARTIAL_REBUILD to run");

async function ready(page: Page) {
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 240_000 });
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toMatch(/[@#$] ?/);
}

test("rebuilding the partial image resets its computer's saved state", async ({ baseURL }) => {
  test.setTimeout(1_800_000);
  const profile = mkdtempSync(join(tmpdir(), "kandelo-partial-reset-"));
  try {
    const context = await chromium.launchPersistentContext(profile, { baseURL });
    try {
      const page = await context.newPage();
      const before = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256: string };
      await page.goto(`/?vfs=${encodeURIComponent("/@kandelo-partial/image.vfs.zst")}`);
      await ready(page);
      const computerUrl = page.url();
      expect(new URL(computerUrl).searchParams.get("computer")).not.toBeNull();
      await runTerminalCommand(page, "echo kept > ~/partial-marker && sync");
      expect((await runTerminalCommand(page, "cat ~/partial-marker")).output).toContain("kept");

      // A reload keeps the saved state.
      await page.reload();
      await ready(page);
      expect((await runTerminalCommand(page, "cat ~/partial-marker")).output).toContain("kept");
      await page.screenshot({ path: join(repo, ".context/partial-reset-before.png") });

      // A rebuild does not.
      execFileSync(join(repo, "run.sh"), ["partial", ...rebuild!], { cwd: repo, stdio: "inherit" });
      const after = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256: string };
      expect(after.sha256).not.toBe(before.sha256);
      await page.goto(computerUrl);
      await ready(page);
      expect((await runTerminalCommand(page, "cat ~/partial-marker 2>&1; true")).output).toMatch(/No such file/);
      await page.screenshot({ path: join(repo, ".context/partial-reset-after.png") });
      // The computer now records the build it was copied from.
      const recorded = await page.evaluate(() => navigator.locks.request("kandelo-computer-library", async () => {
        const id = new URL(location.href).searchParams.get("computer")!;
        const root = await navigator.storage.getDirectory();
        const directory = await (await (await root.getDirectoryHandle("kandelo")).getDirectoryHandle("computers")).getDirectoryHandle(id);
        return JSON.parse(await (await (await directory.getFileHandle("computer.json")).getFile()).text()).partialImageSha256;
      }));
      expect(recorded).toBe(after.sha256);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
