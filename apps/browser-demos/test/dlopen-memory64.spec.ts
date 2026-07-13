import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
let buildDir = "";
let mainPath = "";
let sidePath = "";

function hasCompiler(): boolean {
  try {
    execFileSync("wasm64posix-cc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasPrerequisites =
  hasCompiler() &&
  existsSync(join(repoRoot, "sysroot64", "lib", "libc.a")) &&
  (
    existsSync(join(repoRoot, "local-binaries", "kernel.wasm")) ||
    existsSync(join(repoRoot, "binaries", "kernel.wasm"))
  );

test.beforeAll(() => {
  if (!hasPrerequisites) return;
  buildDir = mkdtempSync(join(tmpdir(), "kandelo-browser-dlopen-memory64-"));
  mainPath = join(buildDir, "dlopen-memory64.wasm");
  sidePath = join(buildDir, "libmemory64.so");

  const sideSource = join(buildDir, "side.c");
  writeFileSync(sideSource, `
    extern int main_value;
    int side_value = 17;
    int add(int a, int b) { return a + b; }
    int read_main_value(void) { return main_value; }
  `);
  execFileSync(
    "wasm64posix-cc",
    ["-shared", "-fPIC", "-O2", sideSource, "-o", sidePath],
    { stdio: "pipe" },
  );

  const mainSource = join(buildDir, "main.c");
  writeFileSync(mainSource, `
    #include <dlfcn.h>
    #include <stdio.h>

    int main_value = 41;

    int main(void) {
      void *lib = dlopen("/libmemory64.so", RTLD_NOW);
      if (!lib) {
        fprintf(stderr, "dlopen: %s\\n", dlerror());
        return 1;
      }

      int (*add)(int, int) = (int (*)(int, int))dlsym(lib, "add");
      int (*read_main_value)(void) = (int (*)(void))dlsym(lib, "read_main_value");
      int *side_value = (int *)dlsym(lib, "side_value");
      if (!add || !read_main_value || !side_value) {
        fprintf(stderr, "dlsym: %s\\n", dlerror());
        return 2;
      }

      printf(
        "DLOPEN_MEMORY64_PASS add=%d main=%d side=%d\\n",
        add(3, 4), read_main_value(), *side_value
      );
      return dlclose(lib) == 0 ? 0 : 3;
    }
  `);
  execFileSync(
    "wasm64posix-cc",
    ["-O2", "-Wl,--export-all", mainSource, "-ldl", "-o", mainPath],
    { stdio: "pipe" },
  );
});

test.afterAll(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

test("memory64 dlopen uses pointer-width imports and table64 in Chromium", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.skip(!hasPrerequisites, "memory64 SDK artifacts are required");
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

  const mainUrl = new URL("/__test-fixtures__/dlopen-memory64.wasm", baseURL).href;
  await page.route(mainUrl, async (route) => {
    await route.fulfill({
      path: mainPath,
      contentType: "application/wasm",
    });
  });
  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  const sideBytes = [...readFileSync(sidePath)];
  const result = await page.evaluate(
    async ({ mainUrl, sideBytes }) => {
      const response = await fetch(mainUrl);
      if (!response.ok) {
        throw new Error(`program fetch failed: ${response.status} ${response.url}`);
      }
      return (window as any).__runTest(
        await response.arrayBuffer(),
        ["dlopen-memory64"],
        30_000,
        {
          dataFiles: [
            { path: "/libmemory64.so", data: sideBytes },
          ],
        },
      );
    },
    { mainUrl, sideBytes },
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("DLOPEN_MEMORY64_PASS add=7 main=41 side=17\n");
  expect(result.stderr).toBe("");
  expect(runtimeErrors).toEqual([]);
});
