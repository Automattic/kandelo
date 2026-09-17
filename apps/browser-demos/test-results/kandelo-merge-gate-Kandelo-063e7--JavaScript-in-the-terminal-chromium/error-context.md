# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: kandelo-merge-gate.spec.ts >> Kandelo Node.js demo evaluates JavaScript in the terminal
- Location: test/kandelo-merge-gate.spec.ts:331:1

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected substring: "Ready"
Received string:    "SYSLOG
[ 0.000590]
INFO
preparing service worker...
[ 0.034115]
INFO
service worker active and cross-origin isolated
[ 0.034150]
INFO
loading node profile...
[ 0.035335]
ERR
Failed to boot Node.js
[ 0.035335]
ERR
node-vfs.vfs.zst is not built. Run: ./run.sh fetch
Node.js
ERROR
New
Demo
Terminal
Internals
Theme
Guide"

Call Log:
- Timeout 180000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - main [ref=e4]:
    - generic [ref=e9]:
      - generic [ref=e10]: Syslog
      - generic [ref=e12]:
        - generic [ref=e13]:
          - generic [ref=e14]: "[ 0.000590]"
          - generic [ref=e15]: info
          - generic [ref=e16]: preparing service worker...
        - generic [ref=e17]:
          - generic [ref=e18]: "[ 0.034115]"
          - generic [ref=e19]: info
          - generic [ref=e20]: service worker active and cross-origin isolated
        - generic [ref=e21]:
          - generic [ref=e22]: "[ 0.034150]"
          - generic [ref=e23]: info
          - generic [ref=e24]: loading node profile...
        - generic [ref=e25]:
          - generic [ref=e26]: "[ 0.035335]"
          - generic [ref=e27]: err
          - generic [ref=e28]: Failed to boot Node.js
        - generic [ref=e29]:
          - generic [ref=e30]: "[ 0.035335]"
          - generic [ref=e31]: err
          - generic [ref=e32]: "node-vfs.vfs.zst is not built. Run: ./run.sh fetch"
  - navigation "Kandelo tools" [ref=e33]:
    - generic [ref=e34]:
      - generic "Dock layout controls" [ref=e37]:
        - link "View Kandelo on GitHub" [ref=e38] [cursor=pointer]:
          - /url: https://github.com/Automattic/kandelo
        - button "Hide dock tools" [expanded] [ref=e41] [cursor=pointer]
        - button "Use compact dock" [pressed] [ref=e44] [cursor=pointer]
      - generic [ref=e48]:
        - 'button "Current machine: Node.js, Error" [ref=e49] [cursor=pointer]':
          - generic [ref=e50]:
            - generic [ref=e51]: Node.js
            - generic [ref=e52]: Error
        - generic [ref=e54]:
          - generic "Machine tools" [ref=e55]:
            - button "New" [ref=e56] [cursor=pointer]
          - generic "Machine views" [ref=e62]:
            - button "Demo" [disabled] [ref=e63]
            - button "Terminal" [disabled] [ref=e69]
          - generic "Machine overlays" [ref=e75]:
            - button "Internals" [ref=e76] [cursor=pointer]
            - button "Theme" [ref=e84] [cursor=pointer]
            - button "Guide" [disabled] [ref=e90]
```

# Test source

```ts
  1   | import { expect, test, type FrameLocator, type Page } from "@playwright/test";
  2   | import { runTerminalCommand } from "./support/terminal-command";
  3   | 
  4   | type BrowserDiagnostics = {
  5   |   console: string[];
  6   |   pageErrors: string[];
  7   |   requestFailures: string[];
  8   | };
  9   | 
  10  | const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();
  11  | const MAX_LOG_LINES = 160;
  12  | const sourceRootfsExpectation =
  13  |   process.env.KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL;
  14  | if (sourceRootfsExpectation !== undefined && sourceRootfsExpectation !== "1") {
  15  |   throw new Error(
  16  |     "KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL must be 1 when set",
  17  |   );
  18  | }
  19  | const expectSourceRootfsShell = sourceRootfsExpectation === "1";
  20  | 
  21  | const appUrl = (path: string): string => {
  22  |   const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  23  |   return baseUrl ? new URL(path, baseUrl).href : path;
  24  | };
  25  | 
  26  | test.beforeEach(({ page }) => {
  27  |   const diagnostics: BrowserDiagnostics = {
  28  |     console: [],
  29  |     pageErrors: [],
  30  |     requestFailures: [],
  31  |   };
  32  |   diagnosticsByPage.set(page, diagnostics);
  33  | 
  34  |   page.on("console", (msg) => {
  35  |     diagnostics.console.push(`[${msg.type()}] ${msg.text()}`);
  36  |     trimLog(diagnostics.console);
  37  |   });
  38  |   page.on("pageerror", (err) => {
  39  |     diagnostics.pageErrors.push(err.stack || err.message);
  40  |     trimLog(diagnostics.pageErrors);
  41  |   });
  42  |   page.on("requestfailed", (request) => {
  43  |     diagnostics.requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "failed"}`);
  44  |     trimLog(diagnostics.requestFailures);
  45  |   });
  46  | });
  47  | 
  48  | function trimLog(lines: string[]) {
  49  |   if (lines.length > MAX_LOG_LINES) {
  50  |     lines.splice(0, lines.length - MAX_LOG_LINES);
  51  |   }
  52  | }
  53  | 
  54  | async function gotoOrSkip(page: Page, path: string) {
  55  |   await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  56  |   await page.waitForTimeout(2_000);
  57  |   if (await page.locator("vite-error-overlay").count()) {
  58  |     test.skip(true, "Required binary not built - Vite import error");
  59  |   }
  60  | }
  61  | 
  62  | async function waitForReady(page: Page, timeout = 180_000) {
  63  |   await expect
  64  |     .poll(() => page.evaluate(() => document.body.innerText), { timeout })
> 65  |     .toContain("Ready");
      |      ^ Error: expect(received).toContain(expected) // indexOf
  66  | }
  67  | 
  68  | async function terminalText(page: Page): Promise<string> {
  69  |   return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
  70  | }
  71  | 
  72  | async function waitForTerminalContent(
  73  |   page: Page,
  74  |   expected: string | RegExp,
  75  |   timeout = 120_000,
  76  | ) {
  77  |   const assertion = expect.poll(() => terminalText(page), { timeout });
  78  |   if (typeof expected === "string") {
  79  |     await assertion.toContain(expected);
  80  |   } else {
  81  |     await assertion.toMatch(expected);
  82  |   }
  83  | }
  84  | 
  85  | async function runGuideScript(
  86  |   page: Page,
  87  |   script: string,
  88  |   expected: string | RegExp,
  89  |   timeout = 120_000,
  90  | ) {
  91  |   const runButton = page.locator(".kdemo-run").first();
  92  |   await page.locator(".kdemo textarea").first().fill(script);
  93  |   await runButton.click();
  94  |   await waitForTerminalContent(page, expected, timeout);
  95  |   await expect(runButton).toHaveText("Run script", { timeout });
  96  |   await expect(runButton).toBeEnabled();
  97  | }
  98  | 
  99  | async function openTerminalDrawer(page: Page) {
  100 |   await page.getByRole("button", { name: "Terminal", exact: true }).click();
  101 |   await expect(page.locator(".kshell-host").first()).toBeVisible({ timeout: 120_000 });
  102 | }
  103 | 
  104 | function webFrame(page: Page, title: string): FrameLocator {
  105 |   return page.frameLocator(`iframe[title="${title}"]`);
  106 | }
  107 | 
  108 | async function failOnMachineError(
  109 |   page: Page,
  110 |   timeout: number,
  111 | ): Promise<never> {
  112 |   await page
  113 |     .locator('.kdock-status-text[data-status="error"]')
  114 |     .waitFor({ state: "attached", timeout });
  115 |   const syslog = await page.locator(".ksys-line").allTextContents();
  116 |   throw new Error(
  117 |     `Kandelo machine failed while WordPress was loading:\n${syslog.slice(-40).join("\n")}`,
  118 |   );
  119 | }
  120 | 
  121 | async function waitForWordPressOrMachineError(
  122 |   page: Page,
  123 |   frame: FrameLocator,
  124 |   timeout: number,
  125 | ): Promise<void> {
  126 |   const wordpress = expect(frame.locator("body")).toContainText(
  127 |     /WordPress on Kandelo|Hello world/i,
  128 |     { timeout },
  129 |   );
  130 |   await Promise.race([wordpress, failOnMachineError(page, timeout)]);
  131 | }
  132 | 
  133 | async function attachKandeloDiagnostics(page: Page, label: string) {
  134 |   const info = test.info();
  135 |   const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  136 |   const diagnostics = diagnosticsByPage.get(page);
  137 | 
  138 |   await attachText(
  139 |     `${safeLabel}-browser-events.txt`,
  140 |     [
  141 |       "Console",
  142 |       ...(diagnostics?.console.length ? diagnostics.console : ["<none>"]),
  143 |       "",
  144 |       "Page errors",
  145 |       ...(diagnostics?.pageErrors.length ? diagnostics.pageErrors : ["<none>"]),
  146 |       "",
  147 |       "Request failures",
  148 |       ...(diagnostics?.requestFailures.length ? diagnostics.requestFailures : ["<none>"]),
  149 |     ].join("\n"),
  150 |   );
  151 | 
  152 |   const snapshot = await page.evaluate(() => {
  153 |     const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  154 |     return {
  155 |       url: window.location.href,
  156 |       title: document.title,
  157 |       readyState: document.readyState,
  158 |       bodyText: document.body.innerText,
  159 |       machineCurrent: text(document.querySelector(".kdock-status")),
  160 |       surfaceButtons: Array.from(document.querySelectorAll(".kdock-item")).map((button) => ({
  161 |         text: text(button),
  162 |         disabled: (button as HTMLButtonElement).disabled,
  163 |         ariaCurrent: button.getAttribute("aria-current"),
  164 |       })),
  165 |       dockPopovers: Array.from(document.querySelectorAll(".kdock-popover, .kdock-pane")).map(text),
```