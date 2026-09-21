import { expect, test, type Page } from "@playwright/test";
import { encodeBootDescriptor } from "../../../web-libs/kandelo-session/src/boot-descriptor";
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
    boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} },
    script: { text },
  };
  return (await encodeBootDescriptor(descriptor)).fragment;
}

test("a #k1= boot link runs its script in the initial shell @slow", async ({ page }) => {
  test.setTimeout(300_000);
  // $((6 * 7)) proves the SCRIPT executed: the literal answer never appears
  // in the typed command line, only in the script's output.
  const fragment = await scriptFragment('echo "link-script:$((6 * 7))"\n');
  await page.goto(appUrl(`/?demo=shell#${fragment}`), {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  const text = expect.poll(() => terminalText(page), { timeout: 120_000 });
  await text.toContain("/tmp/kandelo-link.sh"); // visible invocation
  await text.toContain("link-script:42");       // script output
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
