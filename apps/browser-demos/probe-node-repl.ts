/**
 * Drives the node browser demo end-to-end: bare `node` → REPL banner →
 * evaluate `1+2` → `\q` exit → shell prompt → `node --version`. Run with
 * the dev server up: `npx tsx probe-node-repl.ts`.
 */
import { chromium, type Page } from "playwright";

const URL = "http://localhost:5180/pages/node/";

async function readTerm(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
}

async function waitFor(
  page: Page,
  predicate: (text: string) => boolean,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    last = await readTerm(page);
    if (predicate(last)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out waiting for ${label} after ${timeoutMs}ms. last terminal text:\n${last}`,
  );
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(URL, { waitUntil: "load" });
  await page.waitForSelector("#terminal", { timeout: 10_000 });
  await waitFor(page, (t) => t.includes("$"), "initial $ prompt", 10_000);
  await page.locator(".xterm").click();

  await page.keyboard.type("node");
  await page.keyboard.press("Enter");
  await waitFor(page, (t) => t.includes("QuickJS-ng"), "QuickJS-ng banner", 30_000);
  await waitFor(page, (t) => t.includes("qjs >"), "qjs > prompt", 10_000);

  await page.keyboard.type("1+2");
  await page.keyboard.press("Enter");
  // xterm-rows textContent strips spaces, so `qjs > 1+2` is followed by
  // `3` then a second `qjs >` — match that sequence.
  await waitFor(
    page,
    (t) => /1\+2[\s\S]*?3[\s\S]*?qjs >/.test(t),
    "evaluation result `3`",
    10_000,
  );

  await page.keyboard.type("\\q");
  await page.keyboard.press("Enter");
  await waitFor(page, (t) => t.includes("[exit "), "[exit ...] line", 10_000);
  await waitFor(
    page,
    (t) => /\[exit [\s\S]*\$\s*$/.test(t.trimEnd() + "\n$"),
    "fresh shell $ prompt after exit",
    5_000,
  );

  await page.keyboard.type("node --version");
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    (t) => /node --version[\s\S]*?v\d+\.\d+/.test(t),
    "node --version output",
    30_000,
  );

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
