import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "../playwright-test";
import { test } from "./support/persistent-page";
import { runTerminalCommand } from "./support/terminal-command";

const manifestPath = resolve(import.meta.dirname, "../../../local-binaries/partial/partial.json");
const manifest: { selection: string[] } | null = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : null;
const available = ["rust-docs", "mandoc-browser-bundle"].every(
  (name) => manifest?.selection.includes(name),
);
if (!available && process.env.KANDELO_REQUIRE_RUST_MANUALS === "1") {
  throw new Error("Build a partial shell with rust-docs and mandoc-browser-bundle before Rust manual acceptance");
}

test("Rust manuals render through the installed shell man command", async ({ page }) => {
  test.skip(!available, "Requires the partial Rust manuals shell");
  test.setTimeout(240_000);
  await page.goto("/?vfs=%2F%40kandelo-partial%2Fimage.vfs.zst&profile=shell");
  await expect(page.locator(".kdock-status-text")).toHaveAttribute(
    "data-status", "running", { timeout: 180_000 },
  );
  await expect(page.locator(".kshell-host:visible .xterm-rows").first()).toContainText(
    /maker@[^:\s]+:[^\r\n]*\$ ?/, { timeout: 120_000 },
  );
  for (const name of ["cargo", "cargo-test", "rustc", "rustdoc"]) {
    // The terminal transport reads visible rows. Keep the excerpt short enough
    // that its start marker remains visible alongside the rendered headings.
    const result = await runTerminalCommand(
      page,
      `MANPAGER=cat man 1 ${name} > /tmp/rust-man-${name}.txt && head -n 12 /tmp/rust-man-${name}.txt`,
    );
    expect(result.output, name).toContain("NAME");
    expect(result.output, name).toContain("SYNOPSIS");
    expect(result.output, name).not.toContain(".TH");
    expect(result.output, name).not.toContain(".SH");
  }
});
