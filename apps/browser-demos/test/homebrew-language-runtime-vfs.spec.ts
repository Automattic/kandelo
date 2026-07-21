import { expect, test } from "@playwright/test";

import { LANGUAGE_RUNTIME_INVOCATIONS } from "../../../scripts/homebrew-language-runtime-contract";

interface RuntimeRequest {
  vfsUrl: string;
  executable: string;
  argv: string[];
  timeoutMs: number;
}

interface RuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  imageSha256: string;
  kernelSha256: string;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewVfsAcceptance: (
      request: RuntimeRequest,
    ) => Promise<RuntimeResult>;
  }
}

test("installed Python and Erlang commands run from an exact Homebrew VFS in Chromium", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(600_000);

  const vfsUrl = process.env.KANDELO_HOMEBREW_LANGUAGE_RUNTIME_VFS_URL;
  const imageSha256 = process.env.KANDELO_HOMEBREW_LANGUAGE_RUNTIME_VFS_SHA256;
  const kernelSha256 =
    process.env.KANDELO_HOMEBREW_LANGUAGE_RUNTIME_KERNEL_SHA256;
  const configured = [vfsUrl, imageSha256, kernelSha256].some(
    (value) => value !== undefined,
  );
  test.skip(
    !configured,
    "Homebrew language-runtime VFS inputs are not configured",
  );

  for (const [name, value] of Object.entries({
    KANDELO_HOMEBREW_LANGUAGE_RUNTIME_VFS_URL: vfsUrl,
    KANDELO_HOMEBREW_LANGUAGE_RUNTIME_VFS_SHA256: imageSha256,
    KANDELO_HOMEBREW_LANGUAGE_RUNTIME_KERNEL_SHA256: kernelSha256,
  })) {
    if (!value)
      throw new Error(
        `${name} is required when the language-runtime smoke is configured`,
      );
  }
  if (
    !/^[0-9a-f]{64}$/.test(imageSha256!) ||
    !/^[0-9a-f]{64}$/.test(kernelSha256!)
  ) {
    throw new Error(
      "Homebrew language-runtime digests must be lowercase SHA-256 values",
    );
  }
  if (!baseURL) throw new Error("Playwright baseURL is required");

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect
    .poll(() => page.evaluate(() => window.__homebrewVfsTestReady), {
      timeout: 120_000,
    })
    .toBe(true);

  const run = async (
    executable: string,
    argv: string[],
    expectedStdout: string,
  ) => {
    const result = (await page.evaluate(
      async ({ url, program, args }) =>
        window.__runHomebrewVfsAcceptance({
          vfsUrl: url,
          executable: program,
          argv: args,
          timeoutMs: 180_000,
        }),
      { url: vfsUrl!, program: executable, args: argv },
    )) as RuntimeResult;

    expect(result.imageSha256).toBe(imageSha256);
    expect(result.kernelSha256).toBe(kernelSha256);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expectedStdout);
  };

  for (const invocation of LANGUAGE_RUNTIME_INVOCATIONS) {
    await run(
      invocation.executable,
      invocation.argv,
      invocation.expectedStdout,
    );
  }
});
