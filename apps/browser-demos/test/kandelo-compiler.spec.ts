import { expect, test, type Page } from "@playwright/test";
import { guestCompileCommand, guestCompilerCases } from "../../../host/test/fixtures/in-guest-compiler";

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

let scriptNumber = 0;
async function runScript(page: Page, script: string, expected: string): Promise<void> {
  const completion = `compiler-script-complete:${++scriptNumber}`;
  // A subshell preserves set -e within the program while allowing the outer
  // script to report completion after failure. Separate printf arguments keep
  // the completion marker out of the echoed source. Fail promptly on a real
  // compiler error instead of spending four minutes waiting for success.
  const action = `(\n${script}\n)\nprintf '%s%s%s\\n' compiler-script- complete: '${scriptNumber}'`;
  const run = page.locator(".kdemo-run").first();
  await page.locator(".kdemo textarea").first().fill(action);
  await run.click();
  await expect.poll(() => terminalText(page), { timeout: 240_000 }).toContain(completion);
  expect(await terminalText(page)).toContain(expected);
  await expect(run).toHaveText("Run script", { timeout: 240_000 });
  await expect(run).toBeEnabled();
}

test("base shell lazily fetches one SDK, compiles C/C++, and reports engine limits", async ({ page, browserName }, testInfo) => {
  test.setTimeout(900_000);
  const requests: string[] = [];
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("request", (request) => {
    // WebKit also labels Vite's JavaScript URL modules as fetch requests.
    // Exclude module queries; only the archive transport carries ZIP bytes.
    const url = new URL(request.url());
    if (["fetch", "xhr"].includes(request.resourceType()) &&
        !url.searchParams.has("import") && !url.searchParams.has("url") &&
        url.pathname.includes("kandelo-sdk") &&
        url.pathname.endsWith(".zip")) requests.push(request.url());
  });
  try {
    await page.goto("/?profile=shell", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Demo guide" }).click({ timeout: 180_000 });
    await expect.poll(() => page.locator("aside.kdemo").innerText(), { timeout: 180_000 }).toContain("Ready");
    await runScript(page, "printf '%s %s\\n' 'compiler baseline' 'ready'", "compiler baseline ready");
    expect(requests).toEqual([]);

    for (const sample of guestCompilerCases) {
      if (browserName === "webkit" && sample.name === "cpp-entropy") {
        // The bundled engine exhausts its native Wasm call stack in Clang's
        // recursive template instantiation. Check that exact boundary, rather
        // than accepting another failure or claiming this program compiled.
        const script = `${guestCompileCommand(sample)}\ncompiler_status=$?\n` +
          `printf '%s %s %s %s %s\\n' compiler boundary ${sample.name} status "$compiler_status"`;
        await runScript(page, script, `compiler boundary ${sample.name} status 139`);
        expect(diagnostics.some((line) =>
          line.includes("[process-worker] Kernel worker failed: Maximum call stack size exceeded") &&
          // Instrumented programs omit function names. The worker's argv
          // identifies the compiler and source that exhausted the stack.
          line.includes('argv=["/usr/lib/llvm/bin/clang++"') &&
          line.includes('"/tmp/cpp-entropy.cpp"')), "WebKit must report the diagnosed native stack exhaustion").toBe(true);
        expect(requests).toHaveLength(1);
        continue;
      }
      const marker = `compiler verified ${sample.name} status ${sample.exitCode}`;
      const script = `set -e\n${guestCompileCommand(sample)}\n` +
        `set +e\nactual=$(/tmp/${sample.name}${sample.args})\nstatus=$?\n` +
        `if [ "$status" -eq ${sample.exitCode} ] && [ "$actual" = "${sample.output}" ]; then\n` +
        `  printf '%s\\n' "$actual"\n` +
        `  printf '%s %s %s %s %s\\n' compiler verified ${sample.name} status "$status"\n` +
        `else\n  printf 'compiler failed: %s\\n' "$status"\nfi`;
      // The marker is assembled by the running shell; it cannot match a pasted
      // command or source line before compilation/execution actually finishes.
      try {
        await runScript(page, script, marker);
      } catch (error) {
        // SpiderMonkey's fixed code arena can fill after repeated large LLVM
        // compilations. Accept only the engine's exact allocation diagnostic
        // together with the shell's real failed compiler launch. A different
        // failure still rejects this test. The fresh-session test below proves
        // template-heavy C++ independently of this sequential stress boundary.
        if (browserName === "firefox" &&
            diagnostics.some(line => line.includes("failed to allocate executable memory for module")) &&
            /\/usr\/lib\/llvm\/bin\/clang(?:\+\+)?: I\/O error/.test(await terminalText(page))) {
          testInfo.annotations.push({
            type: "engine-boundary",
            description: `Firefox exhausted its executable-code arena before ${sample.name}; compilation failed`,
          });
          expect(requests).toHaveLength(1);
          return;
        }
        throw error;
      }
      expect(await terminalText(page)).toContain(sample.output);
      expect(requests).toHaveLength(1);
    }
  } finally {
    await testInfo.attach("compiler-console", {
      body: diagnostics.join("\n"), contentType: "text/plain",
    });
  }
});

// A fresh machine bounds this proof to one compiler invocation sequence;
// the test above records the persistent-session executable-code boundary.
test("Firefox compiles template-heavy C++ in a fresh base shell", async ({ page, browserName }) => {
  test.skip(browserName !== "firefox", "Firefox executable-code boundary companion");
  test.setTimeout(360_000);
  const sample = guestCompilerCases.find(sample => sample.name === "cpp-entropy")!;
  await page.goto("/?profile=shell", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Demo guide" }).click({ timeout: 180_000 });
  await expect.poll(() => page.locator("aside.kdemo").innerText(), { timeout: 180_000 }).toContain("Ready");
  const script = `set -e\n${guestCompileCommand(sample)}\n` +
    `actual=$(/tmp/${sample.name})\n` +
    `if [ "$actual" = "${sample.output}" ]; then\n` +
    `printf '%s %s %s\\n' 'fresh' 'compiler' 'verified'\nfi`;
  await runScript(page, script, "fresh compiler verified");
});
