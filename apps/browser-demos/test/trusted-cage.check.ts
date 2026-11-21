import { test } from "./support/persistent-page";
import { CageSession } from "./support/trusted-cage";
import { expect, type Page, type TestInfo } from "../playwright-test";

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
    await session.typeProofAndExitFoot();
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
