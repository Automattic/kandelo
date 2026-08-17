import { expect, test } from "@playwright/test";

test("terminal close is explicit logical removal and cleanup is only detach", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  await page.goto(
    new URL("/test/fixtures/terminal-removal-ui.html", baseURL).href,
  );

  await page.getByRole("button", { name: "Close TTY2" }).click();
  expect(await page.evaluate(() => (window as unknown as {
    __terminalRemovalTest: { removals: string[]; stateRemovals: string[] };
  }).__terminalRemovalTest)).toMatchObject({
    removals: ["/dev/pts/1"],
    stateRemovals: ["tty-2"],
  });

  await page.evaluate(() => (window as unknown as {
    __terminalRemovalTest: { root: { unmount(): void } };
  }).__terminalRemovalTest.root.unmount());
  expect(await page.evaluate(() => (window as unknown as {
    __terminalRemovalTest: { removals: string[] };
  }).__terminalRemovalTest.removals)).toEqual(["/dev/pts/1"]);
});
