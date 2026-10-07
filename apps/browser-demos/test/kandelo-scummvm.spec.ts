// ScummVM on /dev/dri/card0, and the two channels that feed it.
//
// The demo carries no game data, so what these tests prove is the plumbing:
// the scummvm package's [[runtime_files]] reach /usr/share/scummvm as the
// shell image's lazy files, the guest owns the pointer, the config lands somewhere
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

/**
 * Show the Internals syslog, the demo canvas, or the machine's terminal.
 * Internals is an overlay toggle in the dock (aria-pressed); showing the demo
 * or the terminal means closing it and selecting that view.
 */
async function openSurface(page: Page, label: "Internals" | "Demo" | "Terminal") {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await internals.waitFor({ state: "visible", timeout: 30_000 });
  const open = (await internals.getAttribute("aria-pressed")) === "true";
  if (open !== (label === "Internals")) await internals.click();
  if (label !== "Internals") {
    const view = page
      .getByLabel("Computer views")
      .getByRole("button", { name: label, exact: true });
    if ((await view.getAttribute("aria-current")) !== "true") await view.click();
  }
}

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

/**
 * Boot the ScummVM machine the way a visitor does: through its gallery row.
 * The image declares /usr/local/bin/scummvm as the machine's command, which
 * execs the engine once SDL's environment and the user's config are set.
 */
async function bootScummvm(page: Page) {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
  await page
    .getByRole("button", { name: /^(New|Launch new computer)$/ })
    .first()
    .click();
  await expect(page.locator("tr.kgal-row").first()).toBeVisible();
  await page.locator("tr.kgal-row").filter({ hasText: /ScummVM/ }).first().click();

  await openSurface(page, "Internals");
  await expect
    .poll(() => syslogText(page), { timeout: 180_000 })
    .toMatch(/running \/usr\/local\/bin\/scummvm/);
  expect(await syslogText(page), "scummvm setup reported failure")
    .not.toMatch(/configured command failed/);

  await openSurface(page, "Demo");
  const canvas = canvasLocator(page);
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  // The pane drops the placeholder on the first flip the KMS stats SAB reports,
  // which is the earliest point ScummVM has actually presented a frame.
  await expect(page.getByText(/Waiting for PAGE_FLIP on CRTC/))
    .toBeHidden({ timeout: 120_000 });
  return canvas;
}

/** The screen of the shell the probes run in (the mounted terminal tab). */
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

/**
 * Run one command in a shell of its own and resolve with the screen text.
 * The machine's terminal is running ScummVM in the foreground, so the probes
 * open a second terminal ("New terminal" in the dock) the first time.
 */
let probeTerminalOpen = false;
async function runInShell(page: Page, command: string): Promise<string> {
  await openSurface(page, "Terminal");
  if (!probeTerminalOpen) {
    // The dock mounts one terminal at a time: the new tab replaces the
    // machine's terminal in the view, so wait for its own login prompt
    // rather than for a second terminal element.
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect
      .poll(() => terminalText(page), { timeout: 60_000 })
      .toMatch(/kandelo\$\s*$/);
    expect(await terminalText(page), "the probe shell is ScummVM's terminal")
      .not.toMatch(/\/usr\/local\/bin\/scummvm/);
    probeTerminalOpen = true;
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

test.beforeEach(() => {
  probeTerminalOpen = false;
});

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

  await openSurface(page, "Demo");
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

// The freeware menu's Beneath a Steel Sky: Ctrl+C ends the running ScummVM,
// and the in-machine `scummvm-play` fetches the game through the guest's
// normal HTTPS path (the CORS proxy in a browser), verifies its pinned
// SHA-256, and starts it, loading the Sky engine plugin. @slow: it downloads
// 69 MB from downloads.scummvm.org through the proxy.
test("Beneath a Steel Sky from the freeware menu fetches the game and starts it @slow", async ({ page }) => {
  test.setTimeout(600_000);
  await bootScummvm(page);

  await openSurface(page, "Demo");
  const play = page.getByTestId("kms-dock-action-freeware");
  await expect(play).toHaveText("Play a freeware game ▾");
  // The image's action comes before the generic upload control.
  await expect(page.locator(".kdemo-surface-action").first())
    .toHaveAttribute("data-testid", "kms-dock-action-freeware");

  await play.click();
  await page.getByTestId("kms-dock-menu-entry-steel-sky").click();
  // While the display is dark the stage shows what the script says it is
  // doing, then clears once the replacement engine is presenting frames.
  // A failure to stop ScummVM, or a script that exits, is an error toast.
  await expect(page.getByTestId("kms-dock-action-status"))
    .toHaveText(/Downloading Beneath a Steel Sky/, { timeout: 60_000 });
  // The script reports the download against the archive's catalog size.
  await expect(page.getByTestId("kms-dock-action-status"))
    .toHaveText(/Downloading Beneath a Steel Sky.* \d+%/, { timeout: 120_000 });
  await expect(page.getByTestId("kms-dock-action-progress"))
    .toBeHidden({ timeout: 300_000 });
  await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);
  await expect(play).toHaveText("Play a freeware game ▾");

  // The machine's own terminal carries the script's progress.
  await openSurface(page, "Terminal");
  await expect
    .poll(() => terminalText(page), { timeout: 300_000 })
    .toMatch(/scummvm-play: Starting Beneath a Steel Sky/);
  // The screen text has no line breaks, so name the script's failure lines
  // exactly; ScummVM's own start-up output contains the word "Failed".
  expect(await terminalText(page)).not.toMatch(
    /scummvm-play: (Download failed|Checksum mismatch|Unpacking failed)/,
  );

  // The engine now running is the one the script started, on the target
  // ScummVM detected in the verified data, which kept its licence readme.
  await runInShell(
    page,
    "G=/usr/share/scummvm-games/steel-sky"
      + " && T=$(cat $G/.targets)"
      + " && for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f; echo; done"
      + " | grep -q -- \"^/usr/bin/scummvm .* $T \""
      + " && test -s \"$(find $G -name sky.dsk | head -n1)\""
      + " && test -s \"$(find $G -name readme.txt | head -n1)\""
      + ` && ${marker("STEEL_SKY", "RUNNING")}`,
  );
  await expect.poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("STEEL_SKY_RUNNING");

  // A running process is not a running game: the display must be receiving
  // frames. The dock badge reports the KMS page-flip count, which the
  // replacement engine drives once its intro starts.
  await openSurface(page, "Demo");
  const badge = page.locator(".kdemo-surface-badge").first();
  await expect.poll(async () => {
    const flips = /(\d+) flips/i.exec(await badge.innerText());
    return flips ? Number(flips[1]) : 0;
  }, { timeout: 180_000, intervals: [2_000, 5_000] }).toBeGreaterThan(50);
});

test("Flight of the Amazon Queen runs from its single MP3 talkie ZIP @slow", async ({ page }) => {
  test.setTimeout(600_000);
  await page.addInitScript(() => {
    const connect = AudioWorkletNode.prototype.connect;
    Object.defineProperty(AudioWorkletNode.prototype, "connect", {
      configurable: true,
      value: function (this: AudioWorkletNode, ...args: unknown[]) {
        const result = Reflect.apply(connect, this, args);
        if (args[0] instanceof AudioDestinationNode) {
          const analyser = this.context.createAnalyser();
          const mute = this.context.createGain();
          mute.gain.value = 0;
          this.connect(analyser);
          analyser.connect(mute);
          mute.connect(this.context.destination);
          const samples = new Float32Array(analyser.fftSize);
          window.setInterval(() => {
            analyser.getFloatTimeDomainData(samples);
            if (samples.some((sample) => Math.abs(sample) > 0.001)) {
              (window as Window & { queenAudioSawSignal?: boolean }).queenAudioSawSignal = true;
            }
          }, 50);
        }
        return result;
      },
    });
  });
  await bootScummvm(page);

  await openSurface(page, "Demo");
  await page.getByTestId("kms-dock-action-freeware").click();
  await page.evaluate(() => {
    (window as Window & { queenAudioSawSignal?: boolean }).queenAudioSawSignal = false;
  });
  await page.getByTestId("kms-dock-menu-entry-fotaq").click();
  await expect(page.getByTestId("kms-dock-action-status"))
    .toHaveText(/Downloading Flight of the Amazon Queen.* \d+%/, { timeout: 120_000 });
  await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);

  await openSurface(page, "Terminal");
  await expect.poll(() => terminalText(page), { timeout: 300_000 })
    .toMatch(/scummvm-play: Starting Flight of the Amazon Queen|Illegal instruction/);
  const launchText = await terminalText(page);
  expect(launchText).toMatch(/scummvm-play: Starting Flight of the Amazon Queen/);
  expect(launchText).not.toContain("Illegal instruction");
  await runInShell(page, `test -s /usr/share/scummvm-games/fotaq/queen.1c && test ! -e /usr/share/scummvm-games/fotaq/queen.tbl && ${marker("QUEEN_DATA", "PRESENT")}`);
  await expect.poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("QUEEN_DATA_PRESENT");

  await openSurface(page, "Demo");
  await expect(page.locator("[data-audio-state]").first()).toHaveAttribute(
    "data-audio-state",
    "running",
    { timeout: 30_000 },
  );
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { queenAudioSawSignal?: boolean }).queenAudioSawSignal ?? false
  ), { timeout: 90_000 }).toBe(true);
  const badge = page.locator(".kdemo-surface-badge").first();
  await expect.poll(async () => {
    const flips = /(\d+) flips/i.exec(await badge.innerText());
    return flips ? Number(flips[1]) : 0;
  }, { timeout: 180_000, intervals: [2_000, 5_000] }).toBeGreaterThan(50);
});

// The freeware menu lists the image's catalog: every game the machine can
// fetch, plus the ones this build cannot run, disabled with the reason.
test("the freeware menu lists the catalog and marks unrunnable games", async ({ page }) => {
  test.setTimeout(300_000);
  await bootScummvm(page);

  await openSurface(page, "Demo");
  const menuButton = page.getByTestId("kms-dock-action-freeware");
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await menuButton.click();
  const menu = page.getByTestId("kms-dock-menu-freeware");
  await expect(menu.getByRole("menuitem")).toHaveCount(28);
  await expect(page.getByTestId("kms-dock-menu-entry-steel-sky"))
    .toContainText("69 MB");
  const unrunnable = page.getByTestId("kms-dock-menu-entry-broken-sword-25");
  await expect(unrunnable).toBeDisabled();
  await expect(unrunnable).toContainText("Theora");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

// A menu entry end to end, on the smallest catalog game (59 KB): ScummVM's
// own detection adds it, and starting it loads the ADL engine plugin from
// /usr/lib/scummvm. @slow: it downloads from downloads.scummvm.org through
// the proxy.
test("a freeware menu entry fetches its game and starts it on its engine plugin @slow", async ({ page }) => {
  test.setTimeout(600_000);
  await bootScummvm(page);

  await openSurface(page, "Demo");
  await page.getByTestId("kms-dock-action-freeware").click();
  await page.getByTestId("kms-dock-menu-entry-mystery-house").click();
  await expect(page.getByTestId("kms-dock-action-progress"))
    .toBeHidden({ timeout: 300_000 });
  await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);

  await openSurface(page, "Terminal");
  await expect
    .poll(() => terminalText(page), { timeout: 300_000 })
    .toMatch(/scummvm-play: Starting Hi-Res Adventure #1: Mystery House/);

  // The game, not the launcher it replaced, is presenting frames.
  await openSurface(page, "Demo");
  const badge = page.locator(".kdemo-surface-badge").first();
  const flips = async () => {
    const match = /(\d+) flips/i.exec(await badge.innerText());
    return match ? Number(match[1]) : 0;
  };
  const started = await flips();
  await expect.poll(flips, { timeout: 180_000, intervals: [2_000, 5_000] })
    .toBeGreaterThan(started + 20);
});
