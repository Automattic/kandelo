import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { runTerminalCommand } from "./support/terminal-command";

const strict = process.env.KANDELO_SOURCE_ROOTFS_SHELL_STRICT === "1";
const expectedImageSha256 = process.env.KANDELO_MAIN_SHELL_SHA256;

async function runShellScript(
  page: Page,
  script: string,
  expected: string | RegExp,
  timeout = 120_000,
): Promise<void> {
  await runTerminalCommand(page, script, expected, timeout);
}

test("the exact source-rootfs product shell runs Bash, Vim, and NetHack", async ({
  page,
  baseURL,
}) => {
  test.skip(!strict, "source-rootfs activation CI configures this acceptance test");
  if (!expectedImageSha256 || !/^[0-9a-f]{64}$/.test(expectedImageSha256)) {
    throw new Error(
      "KANDELO_MAIN_SHELL_SHA256 must be the exact lowercase image digest",
    );
  }
  test.setTimeout(360_000);

  if (!baseURL) throw new Error("Playwright baseURL is required");
  const productBase = new URL(
    process.env.KANDELO_TEST_BASE_URL ?? baseURL,
  );
  const imageResponse = await page.request.get(
    new URL("shell.vfs.zst", productBase).href,
  );
  expect(imageResponse.ok()).toBe(true);
  const image = await imageResponse.body();
  expect(createHash("sha256").update(image).digest("hex")).toBe(
    expectedImageSha256,
  );

  const fetchedAssets: string[] = [];
  page.on("response", (response) => {
    if (response.ok()) fetchedAssets.push(response.url());
  });
  // `&profile=` names a profile THIS image declares. No `?vfs=` is needed:
  // with none, the app boots the gallery roster's first product, which is the
  // main shell image this deployment serves.
  await page.goto(new URL("?profile=shell", productBase).href, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect(page.getByRole("button", { name: "Shortcuts", exact: true })).toHaveCount(0);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".xterm-rows").first()).toContainText(/kandelo(?:-bash-[0-9.]+)?\$ ?/, { timeout: 120_000 });

  await runShellScript(
    page,
    "vals=(alpha beta)\n" +
      "if [[ ${vals[1]} == beta ]]; then\n" +
      "  printf 'SOURCE_ROOTFS_BASH_OK:%s:%s\\n' \"$BASH_VERSION\" \"$PWD\"\n" +
      "else\n" +
      "  printf 'SOURCE_ROOTFS_BASH_FAIL:%s\\n' \"$PWD\"\n" +
      "fi",
    /SOURCE_ROOTFS_BASH_OK:[0-9][^\r\n]*:\/home\/maker/,
  );
  await runShellScript(
    page,
    "printf 'rootfs-lazy\\n' | grep -q '^rootfs-lazy$' && " +
      "printf 'SOURCE_ROOTFS_GREP_OK\\n'",
    "SOURCE_ROOTFS_GREP_OK",
  );
  await runShellScript(
    page,
    "less --version >/tmp/source-rootfs-less.out 2>&1 && " +
      "printf 'SOURCE_ROOTFS_LESS_OK\\n'",
    "SOURCE_ROOTFS_LESS_OK",
  );
  await runShellScript(
    page,
    "vim --version >/tmp/source-rootfs-vim.out 2>&1\n" +
      "vim_version=$(</tmp/source-rootfs-vim.out)\n" +
      "if [[ \"$vim_version\" == *'VIM - Vi IMproved'* ]]; then\n" +
      "  printf 'SOURCE_ROOTFS_VIM_OK\\n'\n" +
      "else\n" +
      "  printf 'SOURCE_ROOTFS_VIM_FAIL\\n'\n" +
      "  cat /tmp/source-rootfs-vim.out\n" +
      "fi",
    "SOURCE_ROOTFS_VIM_OK",
  );
  await runShellScript(
    page,
    "nethack -s all >/tmp/source-rootfs-nethack.out 2>&1\n" +
      "status=$?\n" +
      "nethack_out=$(</tmp/source-rootfs-nethack.out)\n" +
      "if [[ \"$nethack_out\" == *'Cannot open record file'* ]]; then\n" +
      "  printf 'SOURCE_ROOTFS_NETHACK_BAD:%s\\n' \"$status\"\n" +
      "  cat /tmp/source-rootfs-nethack.out\n" +
      "else\n" +
      "  printf 'SOURCE_ROOTFS_NETHACK_OK:%s\\n' \"$status\"\n" +
      "fi",
    "SOURCE_ROOTFS_NETHACK_OK:0",
    180_000,
  );

  const fetchedNames = fetchedAssets.map((url) =>
    new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? ""
  );
  const assetCount = (name: string, extension: "wasm" | "zip"): number =>
    fetchedNames.filter((candidate) =>
      new RegExp(`^${name}(?:-[A-Za-z0-9_-]+)?\\.${extension}$`).test(candidate)
    ).length;
  expect(assetCount("grep", "wasm")).toBe(1);
  expect(assetCount("less", "wasm")).toBe(1);
  expect(assetCount("vim", "zip")).toBe(1);
  expect(assetCount("nethack", "zip")).toBe(1);
  expect(assetCount("bash", "wasm")).toBe(0);
});
