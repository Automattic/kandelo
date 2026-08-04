import { expect, test } from "@playwright/test";
import { isLegacyShellProgramFetch } from "./homebrew-shell-request";

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
  stdin?: string;
  pty?: boolean;
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

test("the exact Homebrew VFS boots in Chromium", async ({
  page,
  baseURL,
}) => {
  const vfsUrl = process.env.KANDELO_HOMEBREW_ACCEPTANCE_VFS_URL;
  const imageSha256 = process.env.KANDELO_HOMEBREW_ACCEPTANCE_VFS_SHA256;
  const kernelSha256 = process.env.KANDELO_HOMEBREW_ACCEPTANCE_KERNEL_SHA256;
  const executable = process.env.KANDELO_HOMEBREW_ACCEPTANCE_EXECUTABLE;
  const argvJson = process.env.KANDELO_HOMEBREW_ACCEPTANCE_ARGV_JSON;
  const expectedStdout = process.env.KANDELO_HOMEBREW_ACCEPTANCE_EXPECTED_STDOUT;
  const shellPath = process.env.KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_PATH;
  const shellArgvJson = process.env.KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_ARGV_JSON;
  const shellExpectedStdout = "kandelo-homebrew-default-shell";
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
  const shellConfigured = [shellPath, shellArgvJson]
    .some((value) => value !== undefined);
  if (shellConfigured && (!shellPath || !shellArgvJson)) {
    throw new Error("all Homebrew default-shell acceptance inputs are required together");
  }
  const shellArgv: unknown = shellArgvJson === undefined
    ? undefined
    : JSON.parse(shellArgvJson);
  if (
    shellConfigured &&
    (
      !Array.isArray(shellArgv) ||
      shellArgv.length === 0 ||
      shellArgv.some((value) => typeof value !== "string")
    )
  ) {
    throw new Error(
      "KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_ARGV_JSON must be a non-empty string array",
    );
  }
  if (!baseURL) throw new Error("Playwright baseURL is required");
  if (shellConfigured) test.setTimeout(360_000);
  const legacyShellFetches: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (isLegacyShellProgramFetch(request.resourceType(), url)) {
      legacyShellFetches.push(url);
    }
  });

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

  if (shellConfigured) {
    const shellResult = await page.evaluate(
      async ({ url, program, args, expected }) =>
        window.__runHomebrewVfsAcceptance({
          vfsUrl: url,
          executable: program,
          argv: args,
          // WHY: PTYs are interactive streams, not finite stdin buffers, so
          // they have no implicit EOF after this write. Make the shell exit
          // explicitly and require its clean status below.
          stdin: `printf '${expected}\\n'\nexit\n`,
          pty: true,
          timeoutMs: 180_000,
        }),
      {
        url: vfsUrl!,
        program: shellPath!,
        args: shellArgv as string[],
        expected: shellExpectedStdout!,
      },
    ) as AcceptanceResult;

    expect(shellResult.imageSha256).toBe(imageSha256);
    expect(shellResult.kernelSha256).toBe(kernelSha256);
    expect(shellResult.exitCode, shellResult.stderr).toBe(0);
    expect(shellResult.stdout).toContain(shellExpectedStdout!);
    expect(legacyShellFetches).toEqual([]);
  }
});
