import { expect, test } from "../playwright-test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("the shell runs the Zig tree, loc and hexdump commands", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  if (process.env.KANDELO_ZIGCLI_PARTIAL_IMAGE === "1") {
    const image = encodeURIComponent("/@kandelo-partial/image.vfs.zst");
    await page.goto(`/?vfs=${image}&profile=shell`);
  } else {
    await gotoMachineOrSkip(page, "shell");
  }
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), {
    timeout: 120_000,
  }).toMatch(/maker@[^:\s]+:[^\r\n]*\$ ?/);

  const result = await runTerminalCommand(page, [
    "set -eu",
    "mkdir -p /tmp/zigcli-test",
    "printf 'const answer = 42;\\n// note\\n\\n' > /tmp/zigcli-test/main.zig",
    "tree -m ascii /tmp/zigcli-test",
    "loc -m ascii /tmp/zigcli-test",
    "hexdump --color never --length 5 /tmp/zigcli-test/main.zig",
  ].join("\n"));
  expect(result.output).toContain("main.zig");
  expect(result.output).toMatch(/Zig\s*\|\s*1\s*\|\s*3\s*\|\s*1\s*\|\s*1\s*\|\s*1/);
  expect(result.output).toContain("63 6f 6e 73 74");

  const manuals = await runTerminalCommand(page, "man -w tree loc hexdump");
  for (const name of ["tree", "loc", "hexdump"]) {
    expect(manuals.output).toContain(`/usr/share/man/man1/${name}.1`);
  }
});
