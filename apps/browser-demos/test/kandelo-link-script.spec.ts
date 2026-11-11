import { expect, type Page } from "../playwright-test";
import { test } from "./support/persistent-page";
import { encodeBootDescriptor } from "../../../web-libs/kandelo-session/src/boot-descriptor";
import { createInlineBootInput } from "../../../web-libs/kandelo-session/src/boot-inputs";
import type { BootDescriptor, BootInput } from "../../../web-libs/kandelo-session/src/kernel-host";
import { gotoMachine } from "./support/kandelo-machine";
import { clickDockTool } from "./support/dock";
import { terminalHistoryMatching } from "./support/terminal-history";

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate(
    (node) => node.textContent ?? "",
  );
}

/**
 * Build a #k1= fragment carrying `text` as the "script" boot input plus a
 * `runScript: "script"` boot parameter naming it — the same shape ShareDialog
 * authors. The script travels inline, gzip-transported, and is materialized
 * to /run/kandelo/inputs/script/kandelo-link.sh (manifest at
 * /run/kandelo/boot-input.json) before the initial shell starts.
 */
async function scriptFragment(text: string, extraInputs: BootInput[] = []): Promise<string> {
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
      argv: ["/bin/login"],
      cwd: "/root",
      env: {},
      inputs: [await createInlineBootInput({
        id: "script",
        filename: "kandelo-link.sh",
        bytes: new TextEncoder().encode(text),
        compression: "gzip",
      }), ...extraInputs],
      parameters: { runScript: "script" },
    },
  };
  return (await encodeBootDescriptor(descriptor)).fragment;
}

test("a #k1= boot link runs its script in the initial shell @slow", async ({ page }) => {
  test.setTimeout(300_000);
  // $((6 * 7)) proves the SCRIPT executed: the literal answer never appears
  // in the typed command line, only in the script's output. The script also
  // cats the materialization manifest to prove it was staged before boot.
  const fragment = await scriptFragment(
    'echo "link-script:$((6 * 7))"\ncat /run/kandelo/boot-input.json\n' +
    'cat /run/kandelo/inputs/data/message.txt\n' +
    'test -f /run/kandelo/inputs/empty/empty.txt && ' +
    'test ! -s /run/kandelo/inputs/empty/empty.txt && echo "empty-input:$((6 * 7))"\n',
    [await createInlineBootInput({
      id: "data",
      filename: "message.txt",
      bytes: new TextEncoder().encode("data-input:verified\n"),
      compression: "gzip",
    }), await createInlineBootInput({
      id: "empty",
      filename: "empty.txt",
      bytes: new Uint8Array(),
    })],
  );
  await gotoMachine(page, "shell", { hash: fragment });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect.poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("empty-input:42");
  // The multi-input manifest can scroll the invocation off screen. Read
  // rendered history through xterm's scrolling UI after the script finishes.
  const text = await terminalHistoryMatching(page.locator(".xterm:visible").first(),
    /cat "\/run\/kandelo\/inputs\/script\/kandelo-link.sh"/);
  expect(text).toContain("/run/kandelo/inputs/script/kandelo-link.sh");
  expect(text).toContain('echo "link-script:$((6 * 7))"');
  expect(text).toContain("link-script:42");
  expect(text).toContain("runScript");
  expect(text).toContain("data-input:verified");
  expect(text).not.toContain("No such file or directory");
});

/** The rows and columns the visible xterm (DOM renderer) is drawing. */
async function visibleTerminalSize(page: Page): Promise<{ rows: number; cols: number }> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm-rows > div").length;
    const screen = document.querySelector<HTMLElement>(".xterm-screen");
    const measure = document.querySelector<HTMLElement>(".xterm-char-measure-element");
    if (!screen || !measure?.textContent) return { rows, cols: 0 };
    const cellWidth = measure.getBoundingClientRect().width / measure.textContent.length;
    return { rows, cols: Math.round(screen.getBoundingClientRect().width / cellWidth) };
  });
}

test("a #k1= boot link script sees the visible terminal's size @slow", async ({ page }) => {
  test.setTimeout(300_000);
  // A link that opens vim or nano lays the editor out from TIOCGWINSZ. The
  // runner reaches the PTY without a terminal of its own; it must not shrink
  // the winsize the visible terminal set, or the editor draws in a corner.
  const fragment = await scriptFragment('echo "winsize:$(stty size)"\n');
  await gotoMachine(page, "shell", { hash: fragment });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toMatch(/winsize:\d+ \d+/);
  const [, rows, cols] = /winsize:(\d+) (\d+)/.exec(await terminalText(page))!;
  expect({ rows: Number(rows), cols: Number(cols) })
    .toEqual(await visibleTerminalSize(page));
});

test("a malformed #k1= fragment fails loudly instead of booting", async ({ page }) => {
  await gotoMachine(page, "shell", { hash: "k1=!!!not-base64url!!!" });
  await expect(
    page.getByText("Rejected #k1= boot link fragment", { exact: false }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".xterm-rows")).toHaveCount(0);
});

test("gallery navigation drops a boot-link fragment", async ({ page }) => {
  await gotoMachine(page, "shell");
  const next = await page.evaluate(async () => {
    const { galleryItemUrl } = await import("/pages/kandelo/url-state.ts");
    return galleryItemUrl(
      {
        id: "node",
        title: "Node.js",
        vfsImageUrl: "https://cdn.example.invalid/node.vfs.zst",
      },
      "https://kandelo.local/?demo=shell#k1=abc",
    );
  });
  expect(new URL(next).hash).toBe("");
  expect(new URL(next).searchParams.get("profile")).toBe("node");
  // The legacy selector on the link the visitor arrived with is dropped, not
  // carried forward: nothing reads it any more.
  expect(new URL(next).searchParams.get("demo")).toBeNull();
});

test("share dialog authors a script link that runs on open @slow", async ({ page, context }) => {
  test.setTimeout(300_000);
  await gotoMachine(page, "shell");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });

  await clickDockTool(page, "Share setup…");
  await page
    .locator(".kshare textarea")
    .fill('echo "shared-script:$((40 + 2))"');
  await expect
    .poll(async () =>
      page.locator(".kshare-url").getAttribute("data-share-url"),
    )
    .toMatch(/#k1=/);
  const sharedUrl = await page
    .locator(".kshare-url")
    .getAttribute("data-share-url");
  if (!sharedUrl) throw new Error("share dialog produced no URL");

  const opened = await context.newPage();
  await opened.goto(sharedUrl, { waitUntil: "domcontentloaded" });
  await expect(opened.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() => terminalText(opened), { timeout: 120_000 })
    .toContain("shared-script:42");
});
