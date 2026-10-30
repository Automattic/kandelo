import { expect, test, type Page } from "@playwright/test";
import { runTerminalCommand } from "./support/terminal-command";
import { PREVIEW_HOST_LAYOUTS, previewHostFromEnvironment } from "../vite/preview-origin";
import {
  gotoMachineOrSkip,
  machineAppPrefix,
  previewFrame,
  previewFrameSelector,
} from "./support/kandelo-machine";

/**
 * A guest web page must not be able to reach the Kandelo page that shows it.
 *
 * Guest pages (WordPress, nginx, any server inside a machine) are served from
 * a separate preview origin by its own service worker, and shown in a
 * sandboxed iframe. This boots the real nginx image, writes a probe page into
 * its document root through the machine's own shell, and loads it through the
 * app's preview URL bar. The probe's own script reports what it could reach;
 * the report arrives over postMessage, the only channel a guest has.
 *
 * The server's preview host decides the worker's script name:
 * `KANDELO_PREVIEW_HOST=php` runs the PHP bundle under `php -S`, and with a
 * cross-site `KANDELO_PREVIEW_ORIGIN` (`http://localhost:<port>` beside the
 * app's `127.0.0.1`) this proves the WP Cloud-style pair locally.
 *
 * See docs/browser-support.md, "Guest web previews run on their own origin".
 */

// The machine's own identity.title from its image's /etc/kandelo/demo.json.
const MACHINE_TITLE = "nginx";
const KANDELO_PROMPT = /kandelo(?:-bash-[0-9.]+)?\$ ?/;

const PROBE_INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>Kandelo preview probe</title>
<link rel="stylesheet" href="probe.css"><script src="probe.js" defer></script></head>
<body><h1 id="probe-title">Kandelo preview probe</h1>
<button id="escape" type="button">Leave Kandelo</button>
<p id="escape-result">not tried</p></body></html>
`;

// The escape button fills the frame, so a real click anywhere on it is a
// user activation inside the guest.
const PROBE_CSS = "body { background-color: rgb(1, 2, 3); color: white; }\n" +
  "#escape { position: fixed; inset: 0; width: 100%; height: 100%; opacity: 0.2; }\n";

// External script on purpose: its report proves guest JavaScript loaded
// through the preview origin. Every probe records a value instead of
// throwing, so one report shows every boundary at once.
const PROBE_JS = `(function () {
  var report = { type: "kandelo-preview-probe" };
  function attempt(name, read) {
    try { read(); report[name] = "READABLE"; }
    catch (error) { report[name] = "threw " + error.name; }
  }
  attempt("parentDocument", function () { return window.parent.document.body; });
  attempt("parentElement", function () {
    return window.parent.document.querySelector("body").textContent;
  });
  attempt("topHref", function () { return String(window.top.location.href); });
  var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
  report.controller = controller ? controller.scriptURL : null;
  report.origin = location.origin;
  report.path = location.pathname;

  document.getElementById("escape").addEventListener("click", function () {
    var result = "no exception";
    try {
      window.top.location.href = location.href;
    } catch (error) {
      result = "threw " + error.name;
    }
    document.getElementById("escape-result").textContent = result;
    window.parent.postMessage({ type: "kandelo-preview-escape", result: result }, "*");
  });
  // After load, so every stylesheet has applied (or failed).
  function send() {
    report.background = getComputedStyle(document.body).backgroundColor;
    window.parent.postMessage(report, "*");
  }
  if (document.readyState === "complete") send();
  else window.addEventListener("load", send);
})();
`;

interface ProbeReport {
  origin: string;
  data: {
    parentDocument: string;
    parentElement: string;
    topHref: string;
    controller: string | null;
    origin: string;
    path: string;
    background: string;
  };
}

async function writeProbePages(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".kshell-host").first()).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toMatch(KANDELO_PROMPT);
  // Bash builtins only (printf and redirection): the probe does not depend
  // on fetching any lazily loaded program.
  const write = (name: string, content: string) => {
    if (content.includes("'")) throw new Error(`${name} must not contain a single quote`);
    return `printf '%s' '${content}' > /var/www/html/${name}`;
  };
  await runTerminalCommand(
    page,
    [
      "set -eu",
      write("probe.html", PROBE_INDEX),
      write("probe.css", PROBE_CSS),
      write("probe.js", PROBE_JS),
      "printf 'KANDELO_PROBE_%s\\n' WRITTEN",
    ].join("\n"),
    "KANDELO_PROBE_WRITTEN",
  );
  // Back to the web preview surface. It mounts a fresh frame; let its first
  // page finish loading before navigating it again.
  await page.getByRole("button", { name: "Demo", exact: true }).click();
  await expect(previewFrame(page, MACHINE_TITLE).locator("body")).toContainText(
    "Hello from nginx on WebAssembly!",
    { timeout: 60_000 },
  );
}

// The guest's own reports, posted to its parent. Observed this way rather
// than through Playwright's frame access, which the Firefox driver loses
// intermittently for a cross-origin frame after it navigates.
function recordProbeReports(): void {
  const target = window as typeof window & { __probeReports?: unknown[] };
  target.__probeReports = [];
  window.addEventListener("message", (event) => {
    const type = (event.data as { type?: unknown })?.type;
    if (type !== "kandelo-preview-probe" && type !== "kandelo-preview-escape") return;
    target.__probeReports!.push({ origin: event.origin, data: event.data });
  });
}

async function nextReport(page: Page, type: string): Promise<ProbeReport> {
  const find = () => page.evaluate((wanted) =>
    ((window as typeof window & { __probeReports?: ProbeReport[] }).__probeReports ?? [])
      .filter((report) => (report.data as { type?: string }).type === wanted).at(-1) ?? null, type);
  await expect.poll(find, { timeout: 120_000 }).not.toBeNull();
  return (await find())!;
}

test("preview cannot reach the Kandelo page", async ({ page, context }) => {
  test.setTimeout(360_000);

  await gotoMachineOrSkip(page, "nginx");
  const frame = previewFrame(page, MACHINE_TITLE);
  await expect(frame.locator("body")).toContainText(
    "Hello from nginx on WebAssembly!",
    { timeout: 180_000 },
  );
  const kandeloUrl = page.url();
  const kandeloOrigin = new URL(kandeloUrl).origin;

  await writeProbePages(page);
  await page.evaluate(recordProbeReports);
  const address = page.getByRole("textbox", { name: "Preview URL path" });
  // The dock controls can remount just after the pane does; type until the
  // address bar holds the path, as a user would see it.
  await expect(async () => {
    await address.fill("/probe.html");
    await expect(address).toHaveValue("/probe.html", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await address.press("Enter");

  const report = await nextReport(page, "kandelo-preview-probe");
  test.info().annotations.push({
    type: "preview",
    description: `guest ${report.origin} controlled by ${report.data.controller}`,
  });
  // The guest runs on an origin of its own...
  expect(report.origin).not.toBe(kandeloOrigin);
  expect(report.data.origin).toBe(report.origin);
  // ...so it cannot read or drive the Kandelo document...
  expect(report.data.parentDocument).toBe("threw SecurityError");
  expect(report.data.parentElement).toBe("threw SecurityError");
  expect(report.data.topHref).toBe("threw SecurityError");
  // ...and its pages are served by the preview origin's own service worker,
  // never by Kandelo's.
  expect(report.data.controller).toBe(
    `${report.origin}${new URL(kandeloUrl).pathname.replace(/[^/]*$/, "")}${
      PREVIEW_HOST_LAYOUTS[previewHostFromEnvironment()].workerFile
    }`,
  );
  // Its own subresources still load: the stylesheet applied, and the report
  // itself came from its external script.
  expect(report.data.background).toBe("rgb(1, 2, 3)");
  expect(report.data.path).toMatch(/\/computer\/[a-z]+-[a-z]+-[a-z]+-[a-z2-7]{20}\/probe\.html$/);

  // A guest cannot navigate the Kandelo tab away, even with the user's click.
  const box = (await page.locator(previewFrameSelector(MACHINE_TITLE)).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // The guest really ran its handler, with the user's activation.
  await nextReport(page, "kandelo-preview-escape");
  await page.waitForTimeout(1_000);
  expect(page.url()).toBe(kandeloUrl);
  await expect(page.locator(previewFrameSelector(MACHINE_TITLE))).toBeVisible();

  // The address users share opens a Kandelo viewer that shows the same
  // machine through its owner's bridge.
  const prefix = await machineAppPrefix(page, MACHINE_TITLE);
  const viewer = await context.newPage();
  try {
    await viewer.addInitScript(recordProbeReports);
    await viewer.goto(`${kandeloOrigin}${prefix}probe.html`, { waitUntil: "domcontentloaded" });
    expect(new URL(viewer.url()).origin).toBe(kandeloOrigin);
    const shown = await nextReport(viewer, "kandelo-preview-probe");
    expect(shown.origin).toBe(report.origin);
    expect(shown.data.path).toBe(report.data.path);
    expect(shown.data.background).toBe("rgb(1, 2, 3)");
    expect(shown.data.parentDocument).toBe("threw SecurityError");
  } finally {
    await viewer.close();
  }
});
