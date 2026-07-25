import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guests = [
  {
    name: "wasm32",
    programPath: resolve(
      __dirname,
      "../../../local-binaries/programs/wasm32/scm-rights-semantics.wasm",
    ),
  },
  {
    name: "wasm64",
    programPath: resolve(
      __dirname,
      "../../../local-binaries/programs/wasm64/scm-rights-semantics.wasm",
    ),
  },
] as const;

const semanticCases = [
  {
    name: "stream",
    markers: ["SCM_RIGHTS_STREAM_BARRIER_PASS"],
  },
  {
    name: "peek",
    markers: ["SCM_RIGHTS_STREAM_PEEK_PASS"],
  },
  {
    name: "datagram",
    markers: ["SCM_RIGHTS_DGRAM_ZERO_AND_PEEK_PASS"],
  },
  {
    name: "trunc",
    markers: ["SCM_RIGHTS_DGRAM_TRUNC_PASS"],
  },
  {
    name: "domain",
    markers: ["SCM_RIGHTS_NON_UNIX_REJECTION_PASS"],
  },
  {
    name: "representability",
    markers: ["SCM_RIGHTS_UNREPRESENTABLE_REJECTION_PASS"],
  },
  {
    name: "zero-iov-stream",
    markers: ["SCM_RIGHTS_STREAM_ZERO_IOV_PASS"],
  },
  {
    name: "cloexec",
    markers: [
      "SCM_RIGHTS_CLOEXEC_FLAG_PASS",
      "SCM_RIGHTS_CLOEXEC_EXEC_PASS",
      "SCM_RIGHTS_SEMANTICS_PASS",
    ],
  },
] as const;

for (const guest of guests) {
  for (const semanticCase of semanticCases) {
    test(`SCM_RIGHTS ${semanticCase.name} semantics use the actual ${guest.name} binary in Chromium`, async ({
      page,
      baseURL,
      browserName,
    }) => {
      test.skip(
        browserName !== "chromium",
        "the aggregate browser gate uses Chromium",
      );
      expect(baseURL).toBeTruthy();

      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => {
        runtimeErrors.push(`pageerror: ${error.message}`);
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          runtimeErrors.push(`console: ${message.text()}`);
        }
      });
      page.on("requestfailed", (request) => {
        runtimeErrors.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
        );
      });

      await page.goto(
        new URL("/pages/test-runner/?minimal=1", baseURL).href,
      );
      await page.waitForFunction(
        () => (window as any).__testRunnerReady === true,
      );

      const programUrl = new URL(`/@fs/${guest.programPath}`, baseURL).href;
      const result = await page.evaluate(
        async ({ programUrl, caseName }) => {
          const response = await fetch(programUrl);
          if (!response.ok) {
            throw new Error(
              `program fetch failed: ${response.status} ${response.url}`,
            );
          }
          return (window as any).__runTest(
            await response.arrayBuffer(),
            ["/bin/scm-rights-semantics", "--case", caseName],
            30_000,
            {
              dataFiles: [
                {
                  path: "/bin/scm-rights-semantics",
                  useWasmBytes: true,
                },
              ],
            },
          );
        },
        { programUrl, caseName: semanticCase.name },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      for (const marker of semanticCase.markers) {
        expect(result.stdout).toContain(marker);
      }
      expect(result.stderr).toBe("");
      expect(runtimeErrors).toEqual([]);
    });
  }
}
