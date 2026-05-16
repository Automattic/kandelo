import { chromium } from "playwright";

const URL = "http://localhost:5180/pages/node/";
const CMD = process.argv[2] || "npm install lodash --loglevel=verbose";
const WAIT_MS = 180_000;

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleLines: string[] = [];
  page.on("console", (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.stack || err}`));
  page.on("requestfailed", (r) =>
    consoleLines.push(`[reqfail] ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`),
  );
  page.on("worker", (worker) => {
    consoleLines.push(`[worker started] ${worker.url()}`);
    worker.on("console", (m) => consoleLines.push(`[worker:${m.type()}] ${m.text()}`));
  });

  await page.goto(URL, { waitUntil: "load" });
  // Wait for the xterm prompt to be visible.
  await page.waitForSelector("#terminal", { timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelector(".xterm-rows")?.textContent?.includes("$"),
    { timeout: 10_000 },
  );
  await page.locator(".xterm").click();

  // Type and Enter.
  console.log(`>>> typing "${CMD}"`);
  await page.keyboard.type(CMD);
  await page.keyboard.press("Enter");
  const t0 = Date.now();

  // Poll the xterm rows for `[exit ` or stop after WAIT_MS.
  let exitLineSeen = false;
  while (Date.now() - t0 < WAIT_MS) {
    const text = await page.evaluate(() => {
      const rows = document.querySelector(".xterm-rows");
      return rows?.textContent ?? "";
    });
    if (text.includes("[exit ")) {
      exitLineSeen = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  // Final dump.
  const finalText = await page.evaluate(() => {
    const rows = document.querySelector(".xterm-rows");
    return rows?.textContent ?? "";
  });

  console.log("\n=== TERMINAL TEXT ===");
  console.log(finalText.replace(/\$\s+/g, "\n$ "));
  console.log("\n=== CONSOLE LINES ===");
  for (const l of consoleLines) console.log(l);
  console.log(`\n=== exitLineSeen=${exitLineSeen} elapsed=${elapsedSec}s ===`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
