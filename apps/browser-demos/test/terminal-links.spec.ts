import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { encodeBootDescriptor } from "../../../web-libs/kandelo-session/src/boot-descriptor";
import { createInlineBootInput } from "../../../web-libs/kandelo-session/src/boot-inputs";
import type { BootDescriptor } from "../../../web-libs/kandelo-session/src/kernel-host";

/**
 * Links printed into the Shell pane's terminal must open in a new tab, and
 * must not hand this page's URL to anything that is not the current machine.
 * A Kandelo page URL can carry machine state (`#k1=` boot descriptors, share
 * links), so a leaked `Referer` is a leaked machine.
 *
 * All but the last test mount the shipped Shell pane over a fake PTY: real
 * xterm.js, real link wiring, real anchor navigation, so the `Referer` they
 * read is the one a browser actually sent. The last one boots a real machine
 * and clicks a URL a real process printed.
 *
 * One case is deliberately absent: a link to the hosting site's own origin.
 * The dev server this suite runs against is itself on loopback, and a loopback
 * URL printed by a program inside the machine names the machine's port, not
 * the developer's web server — so the policy reads it as the machine, exactly
 * as intended. Origin classification is covered by the unit tests in
 * `web-libs/kandelo-session/test/terminal-links.test.ts`, which can name a
 * non-loopback page origin.
 */

const fixtureModuleUrl = "/test/fixtures/terminal-links-fixture.ts";
const fixturePageUrl = "/test/fixtures/terminal-links-fixture.html";

const EXTERNAL_URL = "https://link-probe.example/external";
const BRIDGED_PORT = 8080;
/**
 * The shape the service worker mints for a machine's web surface:
 * `<scope>computer/<name>/`. The exact name is per-machine, so the
 * fixture names one rather than guessing what a live boot would pick.
 */
const MACHINE_PREFIX = "/computer/test-machine/";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

interface RowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Answer every probe URL with the `Referer` the browser sent, so a test can
 * read it out of the opened tab.
 */
async function installRefererProbe(context: BrowserContext, origin: string): Promise<void> {
  const respond = async (route: Parameters<Parameters<BrowserContext["route"]>[1]>[0]) => {
    const headers = await route.request().allHeaders();
    const referer = headers.referer ?? "";
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>probe</title><pre id="referer">${referer}</pre>`,
    });
  };
  await context.route("https://link-probe.example/**", respond);
  await context.route(`${origin}/computer/**`, respond);
}

/**
 * Mount the Shell fixture, print one URL per line, and report where each line
 * landed on screen. Column 0 of row N is the first character of line N, which
 * is where these tests click.
 */
async function printLines(page: Page, lines: string[]): Promise<(RowRect | null)[]> {
  return page.evaluate(
    async ({ moduleUrl, lines, bridgedPort, machinePrefix }) => {
      const { mountLinkShell } = await import(/* @vite-ignore */ moduleUrl);
      const root = document.createElement("div");
      root.style.width = "900px";
      root.style.height = "400px";
      document.body.append(root);
      const fixture = mountLinkShell(root, {
        label: "Web",
        url: machinePrefix,
        status: "running",
        port: bridgedPort,
      });
      await fixture.write(lines.map((line) => `${line}\r\n`).join(""));
      return lines.map((_line, index) => fixture.rowRect(index));
    },
    {
      moduleUrl: fixtureModuleUrl,
      lines,
      bridgedPort: BRIDGED_PORT,
      machinePrefix: MACHINE_PREFIX,
    },
  );
}

/** Click the first character of a printed line. */
async function clickLine(page: Page, rect: RowRect): Promise<void> {
  const x = rect.x + 3;
  const y = rect.y + rect.height / 2;
  // xterm resolves links on hover and only activates an already-resolved one,
  // so move first and give the linkifier a turn before clicking.
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
}

async function openedBy(
  context: BrowserContext,
  page: Page,
  rect: RowRect,
): Promise<Page> {
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    clickLine(page, rect),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  return popup;
}

/**
 * Index of the last rendered row that begins with `text`. The shell echoes the
 * command that printed the URL, so the last match is the program's output
 * rather than the command line.
 */
async function outputRowStartingWith(page: Page, text: string): Promise<number> {
  const find = () =>
    page.evaluate((probe) => {
      const rows = Array.from(document.querySelectorAll(".xterm-rows > div"));
      for (let i = rows.length - 1; i >= 0; i--) {
        if ((rows[i].textContent ?? "").startsWith(probe)) return i;
      }
      return -1;
    }, text);
  await expect.poll(find, { timeout: 240_000 }).not.toBe(-1);
  return find();
}

async function rowRectAt(page: Page, index: number): Promise<RowRect> {
  return page.evaluate((i) => {
    const row = document.querySelectorAll(".xterm-rows > div")[i];
    const rect = row.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, index);
}

/**
 * A `#k1=` fragment that stages `text` as a boot script and runs it in the
 * initial shell — the same shape ShareDialog authors.
 */
async function bootScriptFragment(text: string): Promise<string> {
  const descriptor: BootDescriptor = {
    version: 1,
    id: "shell",
    title: "Shell",
    base: "kandelo:shell@abi8",
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: 2048,
      features: [],
      time: "real",
    },
    packages: [],
    mounts: [{ path: "/", source: "image", ref: "shell.vfs@local" }],
    boot: {
      argv: ["/usr/bin/login"],
      cwd: "/root",
      env: {},
      inputs: [
        await createInlineBootInput({
          id: "script",
          filename: "kandelo-link.sh",
          bytes: new TextEncoder().encode(text),
          compression: "gzip",
        }),
      ],
      parameters: { runScript: "script" },
    },
  };
  return (await encodeBootDescriptor(descriptor)).fragment;
}

test.describe("terminal links", () => {
  test("open a third-party URL in a new tab without a referrer", async ({
    context,
    page,
  }) => {
    await page.goto(fixturePageUrl);
    await installRefererProbe(context, new URL(page.url()).origin);

    const rects = await printLines(page, [EXTERNAL_URL]);
    expect(rects[0]).not.toBeNull();

    const external = await openedBy(context, page, rects[0]!);
    expect(external.url()).toBe(EXTERNAL_URL);
    await expect(external.locator("#referer")).toHaveText("");
    await external.close();
  });

  test("route a loopback URL on the bridged port to the machine, with a referrer", async ({
    context,
    page,
  }) => {
    await page.goto(fixturePageUrl);
    const origin = new URL(page.url()).origin;
    await installRefererProbe(context, origin);

    const rects = await printLines(page, [
      `http://localhost:${BRIDGED_PORT}/wp-admin/?x=1`,
    ]);
    expect(rects[0]).not.toBeNull();

    const opened = await openedBy(context, page, rects[0]!);
    // The machine's port 8080 is reachable only through the service worker's
    // app prefix, so that is where the link goes.
    expect(opened.url()).toBe(`${origin}${MACHINE_PREFIX}wp-admin/?x=1`);
    // Same-origin destination: this is the machine, so it may see the
    // referrer. That is the half of the policy the third-party test cannot
    // prove — a handler that always set rel="noreferrer" would pass that one.
    await expect(opened.locator("#referer")).toHaveText(page.url());
    await opened.close();
  });

  test("leave a loopback URL the bridge does not forward unlinked", async ({
    context,
    page,
  }) => {
    await page.goto(fixturePageUrl);
    await installRefererProbe(context, new URL(page.url()).origin);

    const rects = await printLines(page, ["http://localhost:3000/not-bridged"]);
    expect(rects[0]).not.toBeNull();

    let opened: Page | null = null;
    context.on("page", (candidate) => {
      opened = candidate;
    });
    await clickLine(page, rects[0]!);
    // Nothing forwards port 3000, so offering a click that lands on the user's
    // own computer would be worse than no link at all.
    await page.waitForTimeout(1_500);
    expect(opened).toBeNull();
  });

  test("follow an OSC 8 hyperlink only after confirming, and without a referrer", async ({
    context,
    page,
  }) => {
    await page.goto(fixturePageUrl);
    await installRefererProbe(context, new URL(page.url()).origin);

    // OSC 8: the visible text is "click me", the destination is the probe.
    const osc8 = `\u001b]8;;${EXTERNAL_URL}\u001b\\click me\u001b]8;;\u001b\\`;

    // Without a confirmation there is no navigation. Playwright dismisses
    // dialogs by default, which exercises exactly that path.
    let rects = await printLines(page, [osc8]);
    let opened: Page | null = null;
    context.on("page", (candidate) => {
      opened = candidate;
    });
    await clickLine(page, rects[0]!);
    await page.waitForTimeout(1_000);
    expect(opened).toBeNull();

    // Confirming opens it — and xterm's own handler, which this replaces,
    // would have sent this page's URL as the referrer.
    await page.goto(fixturePageUrl);
    page.on("dialog", (dialog) => {
      expect(dialog.message()).toContain(EXTERNAL_URL);
      void dialog.accept();
    });
    rects = await printLines(page, [osc8]);
    const external = await openedBy(context, page, rects[0]!);
    expect(external.url()).toBe(EXTERNAL_URL);
    await expect(external.locator("#referer")).toHaveText("");
    await external.close();
  });

  test("a URL printed by a real process in a booted machine is clickable @slow", async ({
    context,
    page,
  }) => {
    test.setTimeout(400_000);
    const probe = "https://link-probe.example/from-a-real-kernel";
    await installRefererProbe(context, "http://boot-probe.invalid");

    const fragment = await bootScriptFragment(`printf '%s\\n' '${probe}'\n`);
    await page.goto(appUrl(`/?demo=shell#${fragment}`), {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-rows").first()).toBeVisible({
      timeout: 240_000,
    });

    const row = await outputRowStartingWith(page, probe);
    const opened = await openedBy(context, page, await rowRectAt(page, row));
    expect(opened.url()).toBe(probe);
    await expect(opened.locator("#referer")).toHaveText("");
    await opened.close();
  });
});
