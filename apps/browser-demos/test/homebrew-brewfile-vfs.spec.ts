import { expect, test } from "@playwright/test";

interface AcceptanceResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  imageSha256: string;
  kernelSha256: string;
}

interface AcceptanceRequest {
  vfsUrl: string;
  executable: string;
  argv: string[];
  timeoutMs: number;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewVfsAcceptance: (
      request: AcceptanceRequest,
    ) => Promise<AcceptanceResult>;
  }
}

test("the exact dependency-bearing Brewfile VFS boots in Chromium", async ({
  page,
  baseURL,
}) => {
  const vfsUrl = process.env.KANDELO_HOMEBREW_ACCEPTANCE_VFS_URL;
  const imageSha256 = process.env.KANDELO_HOMEBREW_ACCEPTANCE_VFS_SHA256;
  const kernelSha256 = process.env.KANDELO_HOMEBREW_ACCEPTANCE_KERNEL_SHA256;
  const executable = process.env.KANDELO_HOMEBREW_ACCEPTANCE_EXECUTABLE;
  const argvJson = process.env.KANDELO_HOMEBREW_ACCEPTANCE_ARGV_JSON;
  const expectedStdout = process.env.KANDELO_HOMEBREW_ACCEPTANCE_EXPECTED_STDOUT;
  const configured = [
    vfsUrl,
    imageSha256,
    kernelSha256,
    executable,
    argvJson,
    expectedStdout,
  ].some((value) => value !== undefined);
  test.skip(!configured, "Homebrew Brewfile acceptance inputs are not configured");

  for (const [name, value] of Object.entries({
    KANDELO_HOMEBREW_ACCEPTANCE_VFS_URL: vfsUrl,
    KANDELO_HOMEBREW_ACCEPTANCE_VFS_SHA256: imageSha256,
    KANDELO_HOMEBREW_ACCEPTANCE_KERNEL_SHA256: kernelSha256,
    KANDELO_HOMEBREW_ACCEPTANCE_EXECUTABLE: executable,
    KANDELO_HOMEBREW_ACCEPTANCE_ARGV_JSON: argvJson,
    KANDELO_HOMEBREW_ACCEPTANCE_EXPECTED_STDOUT: expectedStdout,
  })) {
    if (!value) throw new Error(`${name} is required when the Brewfile acceptance smoke is configured`);
  }
  if (!/^[0-9a-f]{64}$/.test(imageSha256!) || !/^[0-9a-f]{64}$/.test(kernelSha256!)) {
    throw new Error("Homebrew acceptance digests must be lowercase SHA-256 values");
  }
  const argv: unknown = JSON.parse(argvJson!);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string")) {
    throw new Error("KANDELO_HOMEBREW_ACCEPTANCE_ARGV_JSON must be a non-empty string array");
  }
  if (!baseURL) throw new Error("Playwright baseURL is required");

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__homebrewVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const result = await page.evaluate(
    async ({ url, program, args }) => window.__runHomebrewVfsAcceptance({
      vfsUrl: url,
      executable: program,
      argv: args,
      timeoutMs: 180_000,
    }),
    { url: vfsUrl!, program: executable!, args: argv as string[] },
  ) as AcceptanceResult;

  expect(result.imageSha256).toBe(imageSha256);
  expect(result.kernelSha256).toBe(kernelSha256);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(expectedStdout!);
});
