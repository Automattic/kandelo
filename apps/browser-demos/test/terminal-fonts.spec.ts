import { expect, test } from "../playwright-test";
import { gotoApp } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("the shell loads a script font on first use and reuses it", async ({ page }) => {
  test.setTimeout(180_000);
  const fonts: string[] = [];
  const catalogs: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.resourceType() === "font") fonts.push(path);
    if (path.includes("virtual:kandelo-terminal-fonts") || path.includes("virtual_kandelo-terminal-fonts")) {
      catalogs.push(path);
    }
  });

  await gotoApp(page, "/");
  const terminal = page.locator(".kshell-host:visible .xterm-rows").first();
  await expect(terminal).toContainText(/maker@[^:\s]+:[^\r\n]*\$ ?/, { timeout: 120_000 });
  await runTerminalCommand(page, "printf '%s\\n' 'ASCII font probe'", "ASCII font probe");
  await runTerminalCommand(page, "printf '%s\\n' 'café résumé'", "café résumé");
  expect(fonts).toHaveLength(1);
  expect(catalogs).toHaveLength(0);
  expect(fonts[0]).toContain("noto-sans-mono-latin-wght-normal");

  await runTerminalCommand(page, "printf '%s\\n' '๏ first'", "๏ first");
  await expect.poll(() => terminal.evaluate(element => getComputedStyle(element).fontFamily))
    .toContain("Kandelo Terminal Font");
  await runTerminalCommand(page, "printf '%s\\n' '๏ again'", "๏ again");
  expect(fonts.filter(url => url.includes("noto-sans-thai-thai-wght-normal"))).toHaveLength(1);
});
