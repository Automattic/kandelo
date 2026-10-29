import { expect, test } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

// This acceptance downloads a large proprietary upstream artifact. Keep the
// normal suite offline; opt in explicitly alongside the synthetic Bun tests.
test("npm installs the real Claude payload and bun-run starts it cold", async ({ page }) => {
  test.skip(process.env.KANDELO_TEST_CLAUDE_NPM !== "1", "set KANDELO_TEST_CLAUDE_NPM=1 for the large registry download");
  test.setTimeout(600_000);
  await gotoMachine(page, "shell");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 }).toContain("kandelo$");
  const result = await runTerminalCommand(page, `
set -eu
npm install --fetch-retries=0 --cpu=x64 --libc=glibc @anthropic-ai/claude-code-linux-x64@2.1.300
bun-run ./node_modules/@anthropic-ai/claude-code-linux-x64/claude --version
bun-run ./node_modules/@anthropic-ai/claude-code-linux-x64/claude --help
printf '%s  %s\\n' 1f3998a66cb37e54a4d377e18f4995905e6d5b9b73b176b65b44cfad06691ba3424f6858d1cedaccf483f9bf61168176c27c0f67da89c7ab4223267f0d2d1287 ./node_modules/@anthropic-ai/claude-code-linux-x64/claude | sha512sum -c -
printf 'claude-npm-complete\\n'
`, "claude-npm-complete", 540_000);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("2.1.300 (Claude Code)");
  expect(result.output).toContain("Usage: claude");
  expect(result.output).toContain("/claude: OK");
  console.log(result.output);
});
