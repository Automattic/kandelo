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
  // The multi-input manifest can scroll the source off screen. Read rendered
  // history through xterm's scrolling UI after the script finishes.
  const text = await terminalHistoryMatching(page.locator(".xterm:visible").first(),
    /Welcome to Kandelo/);
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
  await expect.poll(() => terminalText(opened)).toMatch(/maker@localhost:.*\$ /);
  const startup = await terminalHistoryMatching(opened.locator(".xterm:visible").first(),
    /Welcome to Kandelo/);
  expect(startup).toContain('echo "shared-script:$((40 + 2))"');
  expect(startup).not.toContain("kandelo-link.sh");
  expect(startup).not.toContain("PROMPT_COMMAND");
  const terminalRows = opened.locator(".xterm:visible .xterm-rows > div");
  const lines = await terminalRows.allTextContents();
  const sourceLine = lines.findIndex(line => line.includes('echo "shared-script:'));
  expect(lines[sourceLine - 1]?.trim()).toBe("Running script:");
  expect(lines[sourceLine + 1]?.trim()).toBe("");
  expect(lines[sourceLine + 2]?.trim()).toBe("shared-script:42");

  // Source uses an existing indexed ANSI color: retained scrollback follows
  // every theme, while script output keeps the normal foreground color.
  const source = terminalRows.filter({ hasText: 'echo "shared-script:' }).locator("span").first();
  const output = terminalRows.filter({ hasText: /^shared-script:42$/ }).locator("span").first();
  for (const family of ["wordpress", "ubuntu", "kandelo"]) {
    for (const mode of ["light", "dark"]) {
      await opened.evaluate(({ family, mode }) => {
        document.documentElement.dataset.kTheme = family;
        document.documentElement.dataset.kMode = mode;
      }, { family, mode });
      const expected = await opened.locator(".xterm:visible").first().evaluate(node => {
        const style = getComputedStyle(node);
        const resolve = (token: string) => {
          const sample = document.createElement("span");
          sample.style.color = style.getPropertyValue(token).trim();
          node.append(sample);
          const color = getComputedStyle(sample).color;
          sample.remove();
          return color;
        };
        return { source: resolve("--k-shell-ansi-bright-blue"), output: resolve("--k-shell-text") };
      });
      await expect.poll(() => source.evaluate(node => getComputedStyle(node).color))
        .toBe(expected.source);
      await expect.poll(() => output.evaluate(node => getComputedStyle(node).color))
        .toBe(expected.output);
      expect(expected.source).not.toBe(expected.output);
    }
  }

  // Recall the real invocation through Bash itself, then execute it again.
  const input = opened.locator(".xterm:visible .xterm-helper-textarea").first();
  await input.press("ArrowUp");
  await expect.poll(() => terminalText(opened))
    .toContain("bash '/run/kandelo/inputs/script/kandelo-link.sh'");
  await input.press("Enter");
  await expect.poll(async () => (await terminalText(opened)).match(/shared-script:42/g)?.length)
    .toBe(2);

  // The startup hook was removed before running; nested shells inherit none.
  await input.pressSequentially('test "${PROMPT_COMMAND+x}" != x && test "$TERM" = xterm-256color && test "$LANG" = en_US.UTF-8 && echo "hook-cleared:$((40 + 2))"');
  await input.press("Enter");
  await expect.poll(() => terminalText(opened)).toContain("hook-cleared:42");

  await opened.getByRole("button", { name: "New terminal", exact: true }).click();
  const other = opened.locator(".xterm:visible").first();
  await expect.poll(() => other.locator(".xterm-rows").textContent())
    .toMatch(/maker@localhost:.*\$ /);
  expect(await other.locator(".xterm-rows").textContent()).not.toContain("shared-script");
});
