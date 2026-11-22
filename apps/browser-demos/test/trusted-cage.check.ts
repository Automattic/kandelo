import { test } from "./support/persistent-page";
import { CageSession } from "./support/trusted-cage";
import { expect, type Page, type TestInfo } from "../playwright-test";
import { setInternalsOpen } from "./support/dock";

async function inspectGroup(page: Page) {
  await setInternalsOpen(page, true);
  await page.getByRole("tab", { name: "Config", exact: true }).click();
  const key = (name: string) => page.locator(".ktable tbody tr").filter({
    has: page.locator("td:first-child", { hasText: new RegExp("^kandelo\\.memory_group\\." + name.replaceAll(".", "\\.") + "$") }),
  }).locator("td:last-child");
  await expect(key("backing.physicalExtentPages")).toBeVisible({ timeout: 30_000 });
  const values = Object.fromEntries(await page.locator(".ktable tbody tr").evaluateAll(rows => rows.flatMap(row => {
    const cells = row.querySelectorAll("td");
    const name = cells[0]?.textContent ?? "";
    return name.startsWith("kandelo.memory_group.") && cells.length === 2
      ? [[name.slice("kandelo.memory_group.".length), cells[1].textContent ?? ""]] : [];
  })));
  expect(Number(values.pageBytes)).toBe(65536);
  const group = Number(values["admission.group"]);
  expect(group).toBeGreaterThan(0);
  expect(Number(values["backing.group"])).toBe(group);
  expect(Number(values["backing.sharedPages"])).toBeLessThanOrEqual(Number(values["backing.allocatedPages"]));
  expect(Number(values["backing.allocatedPages"])).toBeLessThanOrEqual(Number(values["backing.physicalExtentPages"]));
  expect(Number(values["backing.physicalExtentPages"])).toBeLessThanOrEqual(Number(values["backing.maximumPages"]));
  return values;
}

// Explicit opt-in config only; ordinary browser discovery excludes *.check.ts.
async function check(page: Page, info: TestInfo, run: (session: CageSession) => Promise<void>) {
  const session = new CageSession(page, info);
  try {
    await session.boot();
    await run(session);
    await session.assertQuiet();
    session.record({ passed: true, stage: "complete" });
  } catch (error) {
    session.record({ passed: false, error: String(error) });
    throw error;
  } finally {
    // Preserve the primary phase/error before asking a failed page for pixels.
    // A closed or unresponsive page must not erase the original evidence.
    session.record({ finishedAt: new Date().toISOString() });
    await page.screenshot({ path: info.outputPath("last.png"), timeout: 5000 })
      .catch(error => session.record({ screenshotError: String(error) }));
  }
}

test("trusted Cage accepts physical Foot input and retires its graphical processes", async ({ page }, info) => {
  await check(page, info, async session => {
    const before = await inspectGroup(page);
    session.record({ memoryGroupBefore: before });
    await session.graphics();
    await session.typeProofAndExitFoot();
    const after = await inspectGroup(page);
    session.record({ memoryGroupAfter: after });
    expect(after["admission.group"]).toBe(before["admission.group"]);
    expect(Number(after["admission.processes"])).toBeLessThan(Number(before["admission.processes"]));
    expect(Number(after["admission.tasks"])).toBeLessThan(Number(before["admission.tasks"]));
    const names = session.preparedProgramRequests.map(url => new URL(url).pathname.split("/").at(-1));
    expect(names).toContain("bash.zip"); expect(names).toContain("cage.zip"); expect(names).toContain("foot.zip");
    expect(names).not.toContain("freeciv-client.zip"); expect(names).not.toContain("freeciv-server.zip");
    expect(names).not.toContain("scummvm-static.zip");
  });
});

test("trusted Cage runs a packaged Freeciv local game after quit and relaunch", async ({ page }, info) => {
  await check(page, info, async session => {
    await session.playFreeciv();
    await session.quitGame();
    await session.typeProofAndExitFoot();
  });
});
