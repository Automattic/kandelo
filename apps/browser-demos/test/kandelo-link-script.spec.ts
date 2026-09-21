import { expect, test, type Page } from "@playwright/test";
import { encodeBootDescriptor } from "../../../web-libs/kandelo-session/src/boot-descriptor";
import { createInlineBootInput } from "../../../web-libs/kandelo-session/src/boot-inputs";
import type { BootDescriptor } from "../../../web-libs/kandelo-session/src/kernel-host";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

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
async function scriptFragment(text: string): Promise<string> {
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
      inputs: [await createInlineBootInput({
        id: "script",
        filename: "kandelo-link.sh",
        bytes: new TextEncoder().encode(text),
        compression: "gzip",
      })],
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
    'echo "link-script:$((6 * 7))"\ncat /run/kandelo/boot-input.json\n',
  );
  await page.goto(appUrl(`/?demo=shell#${fragment}`), {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  const text = expect.poll(() => terminalText(page), { timeout: 120_000 });
  await text.toContain("/run/kandelo/inputs/script/kandelo-link.sh"); // visible invocation
  await text.toContain('echo "link-script:$((6 * 7))"'); // script contents shown via cat
  await text.toContain("link-script:42");       // script output
  await text.toContain("runScript");            // manifest content, proves materialization ran
});

test("a malformed #k1= fragment fails loudly instead of booting", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell#k1=!!!not-base64url!!!"), {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByText("Rejected #k1= boot link fragment", { exact: false }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".xterm-rows")).toHaveCount(0);
});

test("gallery navigation drops a boot-link fragment", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
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
  expect(new URL(next).searchParams.get("demo")).toBe("node");
});

test("share dialog authors a script link that runs on open @slow", async ({ page, context }) => {
  test.setTimeout(300_000);
  await page.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });

  await page
    .getByRole("button", { name: "Share this machine as a link" })
    .click();
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
