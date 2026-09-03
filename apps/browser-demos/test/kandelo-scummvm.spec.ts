// ScummVM on /dev/dri/card0, and the two channels that feed it.
//
// The demo carries no game data, so what these tests prove is the plumbing:
// the scummvm package's [[runtime_files]] reach /usr/share/scummvm through the
// resolver mirror, the guest owns the pointer, the config lands somewhere
// ScummVM can rewrite, and the "Load game data" upload extracts into the
// directory the launcher browses. Reading the guest filesystem through the
// demo's own shell keeps the assertions on real system state rather than on
// pixels the offscreen KMS canvas makes unreliable to sample.

import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

/** The [[runtime_files]] packages/registry/scummvm/package.toml declares. */
const RUNTIME_FILE_NAMES = [
  "scummremastered.zip",
  "scummmodern.zip",
  "scummclassic.zip",
  "gui-icons.dat",
  "fonts.dat",
];

let zipDir = "";
let zipPath = "";

test.beforeAll(() => {
  // Metasyntactic payload: the chain under test is upload → write → extract,
  // and nothing in it reads what the bytes mean.
  zipDir = mkdtempSync(join(tmpdir(), "kandelo-scummvm-ingest-"));
  const gameDir = join(zipDir, "foo");
  execFileSync("mkdir", ["-p", gameDir]);
  writeFileSync(join(gameDir, "bar.000"), "baz\n");
  writeFileSync(join(gameDir, "bar.001"), "qux\n");
  zipPath = join(zipDir, "foo.zip");
  execFileSync("zip", ["-qr", zipPath, "foo"], { cwd: zipDir });
});

test.afterAll(() => {
  if (zipDir) rmSync(zipDir, { recursive: true, force: true });
});

async function bootScummvm(page: Page) {
  await page.goto(appUrl("/?demo=scummvm"), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
  const canvas = page.locator(".kmodeset-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  // The pane drops the placeholder on the first flip the KMS stats SAB reports,
  // which is the earliest point ScummVM has actually presented a frame.
  await expect(page.getByText(/Waiting for PAGE_FLIP on CRTC/))
    .toBeHidden({ timeout: 120_000 });
  return canvas;
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate(
    (node) => node.textContent ?? "",
  );
}

/**
 * A success marker the terminal can only show as command OUTPUT.
 *
 * The screen holds the echoed command line as well as its output, so a plain
 * `echo GUI_DATA_OK` would satisfy `toContain("GUI_DATA_OK")` even when the
 * test failed. Splitting the word across a printf format and an argument keeps
 * the joined string out of the echoed line.
 */
function marker(prefix: string, suffix: string): string {
  return `printf '${prefix}_%s\\n' ${suffix}`;
}

/** Run one command in the demo's shell and resolve with the screen text. */
async function runInShell(page: Page, command: string): Promise<string> {
  // `exact` separates the dock's view tab from its "New terminal" icon button.
  const terminal = page.getByRole("button", { name: "Terminal", exact: true });
  if ((await terminal.getAttribute("aria-current")) !== "true") {
    await terminal.click();
  }
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.locator(".xterm-screen").first().click();
  // insertText, not type: keyboard.type drops spaces into this terminal.
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
  return terminalText(page);
}

test("the packaged GUI data reaches the guest and the guest owns the pointer", async ({ page }) => {
  test.setTimeout(300_000);
  const canvas = await bootScummvm(page);

  // ScummVM draws its own cursor, so the browser must not draw a second one.
  await expect(canvas).toHaveCSS("cursor", "none");

  // Every declared runtime file is installed at the guest path the manifest
  // names. `test -s` also rejects a zero-length file, which is what a broken
  // staging path produced before the package declared these artifacts.
  const probe = RUNTIME_FILE_NAMES
    .map((name) => `test -s /usr/share/scummvm/${name}`)
    .join(" && ");
  await runInShell(page, `${probe} && ${marker("GUI_DATA", "OK")}`);
  await expect.poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("GUI_DATA_OK");

  // ScummVM rewrites its config whenever the launcher changes, so the file it
  // reports using must be writable by the demo user it runs as.
  await runInShell(
    page,
    `test -w /home/maker/scummvm.ini && ${marker("CONFIG", "WRITABLE")}`,
  );
  await expect.poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("CONFIG_WRITABLE");
});

test("Load game data extracts an upload into the directory the launcher browses", async ({ page }) => {
  test.setTimeout(300_000);
  await bootScummvm(page);

  const button = page.getByTestId("kms-ingest-button");
  await expect(button).toBeVisible();
  await expect(button).toHaveText(/load game data/i);

  await page.getByTestId("kms-ingest-input").setInputFiles(zipPath);
  await page.getByTestId("kms-ingest-busy")
    .waitFor({ state: "detached", timeout: 90_000 })
    .catch(() => { /* the write may finish before we look */ });
  await expect(page.getByTestId("kms-ingest-error")).toHaveCount(0);

  // The extraction runs in the demo's shell after the write lands, so poll.
  await expect.poll(async () => {
    await runInShell(
      page,
      "test -s /usr/share/scummvm-games/foo/bar.001"
        + ` && ${marker("EXTRACTED", "OK")}`,
    );
    return terminalText(page);
  }, { timeout: 90_000, intervals: [2_000, 3_000, 5_000] })
    .toContain("EXTRACTED_OK");

  // The archive itself is gone, so the launcher's browser shows a game
  // directory rather than a zip it cannot open.
  await runInShell(
    page,
    `test -e /usr/share/scummvm-games/upload.zip || ${marker("ARCHIVE", "REMOVED")}`,
  );
  await expect.poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("ARCHIVE_REMOVED");
});
