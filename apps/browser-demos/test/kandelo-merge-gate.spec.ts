import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { runTerminalCommand } from "./support/terminal-command";
import {
  gotoInPreview,
  gotoMachineOrSkip,
  machineAppPrefix,
} from "./support/kandelo-machine";

type BrowserDiagnostics = {
  console: string[];
  pageErrors: string[];
  requestFailures: string[];
};

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();
const MAX_LOG_LINES = 160;
// The plain shell demo's login boot env sets PS1 to the literal `kandelo$ `
// (images/vfs/products/browser-main-shell.toml), but PR #1403 ("Ship bash as
// the only shell") made bash the login shell for every dinit-service demo's
// terminal drawer (nginx, nginx-php, nginx-python) without a PS1 override, so
// those terminals fall back to bash's compiled-in default prompt, which
// includes the running bash's version. Confirmed against a real chromium run
// of the nginx demo terminal: the received prompt text is exactly
// `kandelo-bash-5.2$ `. Match both forms with one shared pattern instead of
// pinning to a specific bash version.
const KANDELO_PROMPT = /kandelo(?:-bash-[0-9.]+)?\$ ?/;
const sourceRootfsExpectation =
  process.env.KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL;
if (sourceRootfsExpectation !== undefined && sourceRootfsExpectation !== "1") {
  throw new Error(
    "KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL must be 1 when set",
  );
}
const expectSourceRootfsShell = sourceRootfsExpectation === "1";

test.beforeEach(({ page }) => {
  const diagnostics: BrowserDiagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
  };
  diagnosticsByPage.set(page, diagnostics);

  page.on("console", (msg) => {
    diagnostics.console.push(`[${msg.type()}] ${msg.text()}`);
    trimLog(diagnostics.console);
  });
  page.on("pageerror", (err) => {
    diagnostics.pageErrors.push(err.stack || err.message);
    trimLog(diagnostics.pageErrors);
  });
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "failed"}`);
    trimLog(diagnostics.requestFailures);
  });
});

function trimLog(lines: string[]) {
  if (lines.length > MAX_LOG_LINES) {
    lines.splice(0, lines.length - MAX_LOG_LINES);
  }
}

async function waitForReady(page: Page, timeout = 180_000) {
  // "Ready" renders inside the demo guide panel, which no longer auto-opens.
  await ensureGuideOpen(page);
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout })
    .toContain("Ready");
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForTerminalContent(
  page: Page,
  expected: string | RegExp,
  timeout = 120_000,
) {
  const assertion = expect.poll(() => terminalText(page), { timeout });
  if (typeof expected === "string") {
    await assertion.toContain(expected);
  } else {
    await assertion.toMatch(expected);
  }
}

async function ensureGuideOpen(page: Page) {
  // The demo guide no longer auto-opens; open it from the dock on first use.
  if (await page.locator("aside.kdemo").count()) return;
  await page.getByRole("button", { name: "Demo guide" }).click({ timeout: 120_000 });
  await page.waitForSelector("aside.kdemo", { timeout: 30_000 });
}

async function runGuideScript(
  page: Page,
  script: string,
  expected: string | RegExp,
  timeout = 120_000,
) {
  await ensureGuideOpen(page);
  const runButton = page.locator(".kdemo-run").first();
  await page.locator(".kdemo textarea").first().fill(script);
  await runButton.click();
  await waitForTerminalContent(page, expected, timeout);
  await expect(runButton).toHaveText("Run script", { timeout });
  await expect(runButton).toBeEnabled();
}

async function openTerminalDrawer(page: Page) {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".kshell-host").first()).toBeVisible({ timeout: 120_000 });
}

function webFrame(page: Page, title: string): FrameLocator {
  return page.frameLocator(`iframe[title="${title}"]`);
}

async function failOnMachineError(
  page: Page,
  timeout: number,
): Promise<never> {
  await page
    .locator('.kdock-status-text[data-status="error"]')
    .waitFor({ state: "attached", timeout });
  const syslog = await page.locator(".ksys-line").allTextContents();
  throw new Error(
    `Kandelo machine failed while WordPress was loading:\n${syslog.slice(-40).join("\n")}`,
  );
}

async function waitForWordPressOrMachineError(
  page: Page,
  frame: FrameLocator,
  timeout: number,
): Promise<void> {
  const wordpress = expect(frame.locator("body")).toContainText(
    /WordPress on Kandelo|Hello world/i,
    { timeout },
  );
  await Promise.race([wordpress, failOnMachineError(page, timeout)]);
}

async function attachKandeloDiagnostics(page: Page, label: string) {
  const info = test.info();
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const diagnostics = diagnosticsByPage.get(page);

  await attachText(
    `${safeLabel}-browser-events.txt`,
    [
      "Console",
      ...(diagnostics?.console.length ? diagnostics.console : ["<none>"]),
      "",
      "Page errors",
      ...(diagnostics?.pageErrors.length ? diagnostics.pageErrors : ["<none>"]),
      "",
      "Request failures",
      ...(diagnostics?.requestFailures.length ? diagnostics.requestFailures : ["<none>"]),
    ].join("\n"),
  );

  const snapshot = await page.evaluate(() => {
    const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body.innerText,
      machineCurrent: text(document.querySelector(".kdock-status")),
      surfaceButtons: Array.from(document.querySelectorAll(".kdock-item")).map((button) => ({
        text: text(button),
        disabled: (button as HTMLButtonElement).disabled,
        ariaCurrent: button.getAttribute("aria-current"),
      })),
      dockPopovers: Array.from(document.querySelectorAll(".kdock-popover, .kdock-pane")).map(text),
      webPreviewMessages: Array.from(document.querySelectorAll(".kpane-body")).map(text)
        .filter((value) => /waiting|starting|ready|error|bridge|service|http/i.test(value)),
      iframes: Array.from(document.querySelectorAll("iframe")).map((iframe) => {
        const rect = iframe.getBoundingClientRect();
        return {
          title: iframe.title,
          src: iframe.src,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0,
        };
      }),
      syslog: Array.from(document.querySelectorAll(".ksys-line"))
        .slice(-120)
        .map((line) => line.textContent ?? ""),
    };
  }).catch((err) => ({
    error: err instanceof Error ? err.stack || err.message : String(err),
  }));

  await attachText(`${safeLabel}-page-state.json`, JSON.stringify(snapshot, null, 2));
  await page.screenshot({ fullPage: true })
    .then((body) => info.attach(`${safeLabel}-screenshot.png`, { body, contentType: "image/png" }))
    .catch(() => undefined);
}

async function attachText(name: string, body: string) {
  await test.info().attach(name, {
    body,
    contentType: "text/plain",
  }).catch(() => undefined);
}

async function runWordPressPreinstalledLogin(page: Page, demo: string, title: string) {
  test.setTimeout(420_000);

  try {
    // WHY: the deployed regression this protects against happened only when
    // Gallery resolved an optional VFS asset and navigated to it. Arriving on
    // a ready-made `?vfs=` URL would bypass that product path and could pass
    // while Launch still assigned the image an undersized custom-image
    // capacity profile.
    await gotoMachineOrSkip(page, "shell");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Launch New Computer" }))
      .toBeVisible();
    await page
      .locator(".kgal-row", {
        has: page.locator(".kgal-machine-title", { hasText: title }),
      })
      .getByRole("button", { name: "Launch" })
      .click();
    // Launch writes both profile channels: the image URL carries the profile
    // in its own fragment, and `&profile=` repeats it so the selection stays
    // visible in the address bar and survives a hand-edited link.
    await expect
      .poll(
        () => new URL(page.url()).searchParams.get("profile"),
        { timeout: 60_000 },
      )
      .toBe(demo);
    await expect
      .poll(
        () => new URL(page.url()).searchParams.get("vfs"),
        { timeout: 60_000 },
      )
      .toContain(`#${demo}`);
    expect(new URL(page.url()).searchParams.get("demo")).toBeNull();
    await expect(page.locator(".kdock-status-title")).toHaveText(title, {
      timeout: 60_000,
    });

    await Promise.race([
      page.waitForSelector(`iframe[title="${title}"]`, { timeout: 240_000 }),
      failOnMachineError(page, 240_000),
    ]);
    const frame = webFrame(page, title);

    await waitForWordPressOrMachineError(page, frame, 240_000);
    await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

    if (demo === "wordpress-mariadb") {
      for (let probe = 0; probe < 4; probe += 1) {
        const readiness = await frame.locator("body").evaluate(
          async (_body, sequence) => {
            const url = new URL("kandelo-ready.php", window.location.href);
            url.searchParams.set("probe", String(sequence));
            const response = await fetch(url, { cache: "no-store" });
            return {
              status: response.status,
              body: (await response.text()).trim(),
            };
          },
          probe,
        );
        expect(readiness).toEqual({ status: 200, body: "ready" });
        await page.waitForTimeout(750);
      }

      await frame.locator("body").evaluate(() => window.location.reload());
      await waitForWordPressOrMachineError(page, frame, 120_000);
      await expect(page.locator(".kdock-status-text")).toHaveAttribute(
        "data-status",
        "running",
      );
    }

    // "Log in as admin" is a guide ACTION the image declares in its own
    // demo.json, so it lives in the demo guide panel — which no longer opens
    // by itself (same reason waitForReady has to open it).
    await ensureGuideOpen(page);
    await page.getByRole("button", { name: /Log in as admin/i }).click();

    await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({
      timeout: 180_000,
    });
    await expect(frame.locator("body")).toContainText(/Dashboard|WordPress/i, {
      timeout: 60_000,
    });
  } catch (err) {
    await attachKandeloDiagnostics(page, `${demo}-${title}`);
    throw err;
  }
}

test.describe.configure({ mode: "serial" });

test("Kandelo shell demo runs bash, vim, and NetHack", async ({ page }) => {
  test.setTimeout(360_000);

  await gotoMachineOrSkip(page, "shell");
  await waitForReady(page);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  // Input typed before bash's first prompt is legitimately discarded by the
  // boot chain's startup typeahead flush (tcflush), so wait for the prompt
  // like the other terminal tests do.
  await waitForTerminalContent(page, KANDELO_PROMPT, 120_000);

  await runGuideScript(
    page,
    "vals=(alpha beta)\n" +
      "if [[ ${vals[1]} == beta ]]; then\n" +
      "  printf 'KANDELO_BASH_OK:%s:%s\\n' \"$BASH_VERSION\" \"$PWD\"\n" +
      "else\n" +
      "  printf 'KANDELO_BASH_FAIL:%s\\n' \"$PWD\"\n" +
      "fi",
    /KANDELO_BASH_OK:[0-9][^\r\n]*:\/home\/maker/,
  );
  await runGuideScript(
    page,
    "vim --version >/tmp/kandelo-vim.out 2>&1\n" +
      "vim_version=$(</tmp/kandelo-vim.out)\n" +
      "marker=VIM\n" +
      "if [[ \"$vim_version\" == *'VIM - Vi IMproved'* ]]; then\n" +
      "  printf 'KANDELO_%s_OK\\n' \"$marker\"\n" +
      "else\n" +
      "  printf 'KANDELO_%s_FAIL\\n' \"$marker\"\n" +
      "  cat /tmp/kandelo-vim.out\n" +
      "fi",
    "KANDELO_VIM_OK",
  );
  await runGuideScript(
    page,
    "touch /home/.nethack/record\n" +
      "nethack -s all >/tmp/kandelo-nethack.out 2>&1\n" +
      "status=$?\n" +
      "if (( status == 0 )); then\n" +
      "  printf 'KANDELO_NETHACK_OK:%s\\n' \"$status\"\n" +
      "else\n" +
      "  printf 'KANDELO_NETHACK_BAD:%s\\n' \"$status\"\n" +
      "  cat /tmp/kandelo-nethack.out\n" +
      "fi",
    /KANDELO_NETHACK_(?:OK:0|BAD:[0-9]+)/,
    180_000,
  );
  expect(await terminalText(page)).toContain("KANDELO_NETHACK_OK:0");
});

test("Kandelo Node.js demo evaluates JavaScript in the terminal", async ({ page }) => {
  test.setTimeout(240_000);
  const standaloneShellRuntimeFetches: Array<{
    name: "bash" | "dash" | "coreutils";
    url: string;
  }> = [];
  page.on("request", (request) => {
    const url = request.url();
    const match = url.match(
      /\/(bash|dash|coreutils)(?:-[^/?]+)?\.wasm(?:\?|$)/,
    );
    if (
      request.resourceType() === "fetch" &&
      match !== null &&
      !url.includes("?import&url")
    ) {
      standaloneShellRuntimeFetches.push({
        name: match[1] as "bash" | "dash" | "coreutils",
        url,
      });
    }
  });

  await gotoMachineOrSkip(page, "node");
  await waitForReady(page);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(
    page,
    /spidermonkey-node\$ ?/,
  );
  expect(await terminalText(page)).not.toContain("Segmentation fault");

  const nodeContractCommand = [
    "node -e \"console.log('KANDELO_NODE_OK:' + (6 * 7))\"",
    "[ \"$(id -u)\" = 1000 ]",
    "[ \"$HOME\" = /home/maker ]",
    "[ \"$PWD\" = /home/maker ]",
    "[ \"$npm_config_cache\" = /tmp/.npm-cache ]",
    "[ \"$npm_config_registry\" = https://registry.npmjs.org/ ]",
    "spidermonkey-node -e \"console.log('KANDELO_NODE_ALIAS_OK')\"",
    "printf 'KANDELO_NODE_CONTRACT_OK\\n'",
  ].join(" && ");
  const nodeContractResult = await runTerminalCommand(
    page,
    nodeContractCommand,
    "KANDELO_NODE_CONTRACT_OK",
    180_000,
  );
  expect(nodeContractResult.output).toContain("KANDELO_NODE_OK:42");
  expect(nodeContractResult.output).toContain("KANDELO_NODE_ALIAS_OK");
  expect(nodeContractResult.output).not.toContain("Segmentation fault");
  // WHY: the package-backed Node image boots login eagerly, then resolves the
  // maker account's /bin/sh and the `id` utility through the image's declared
  // lazy Dash and Coreutils identities. Bash is not part of this login path.
  // The suite runner sets this expectation only after validating the exact
  // source-only composition.
  expect(
    standaloneShellRuntimeFetches.filter(({ name }) => name === "bash"),
  ).toEqual([]);
  expect(
    standaloneShellRuntimeFetches.filter(({ name }) => name === "dash"),
  ).toHaveLength(expectSourceRootfsShell ? 1 : 0);
  expect(
    standaloneShellRuntimeFetches.filter(({ name }) => name === "coreutils"),
  ).toHaveLength(expectSourceRootfsShell ? 1 : 0);
});

test("Kandelo nginx demo serves its web preview", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoMachineOrSkip(page, "nginx");
  await page.waitForSelector('iframe[title="nginx"]', { timeout: 180_000 });

  await expect(webFrame(page, "nginx").locator("body")).toContainText(
    "Hello from nginx on WebAssembly!",
    { timeout: 120_000 },
  );

  await openTerminalDrawer(page);
  await waitForTerminalContent(page, KANDELO_PROMPT, 120_000);
  await runTerminalCommand(
    page,
    "set -eu; test \"$(id -u):$HOME:$(pwd)\" = '1000:/home/maker:/home/maker'; " +
      "printf 'KANDELO_NGINX_TERMINAL_OK\\n'",
    "KANDELO_NGINX_TERMINAL_OK",
  );
  await runTerminalCommand(
    page,
    "set -eu; printf '%s\\n' '<!doctype html><title>Kandelo nginx</title><h1>KANDELO_EDIT_OK</h1>' > /var/www/html/index.html; " +
      "printf 'KANDELO_NGINX_EDIT_OK\\n'",
    "KANDELO_NGINX_EDIT_OK",
  );
  await webFrame(page, "nginx").locator("body").evaluate(() => {
    window.location.reload();
  });
  await expect(webFrame(page, "nginx").locator("body")).toContainText("KANDELO_EDIT_OK", {
    timeout: 120_000,
  });
});

test("Kandelo nginx + PHP demo serves dynamic PHP through the web preview", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoMachineOrSkip(page, "nginx-php");
  const appPrefix = await machineAppPrefix(page, "nginx + PHP");
  const frame = webFrame(page, "nginx + PHP");

  // This demo's landing page is Adminer, auto-connected to the SQLite database
  // PHP-FPM seeds on the first request — reaching the seeded tables already
  // proves the FastCGI stack served a dynamic page.
  await expect(frame.locator("body")).toContainText("authors", {
    timeout: 180_000,
  });
  // The phpinfo-style status page exercises the same stack on a second
  // request, through the app prefix this machine's bridge minted.
  await gotoInPreview(frame, appPrefix, "info.php");
  await expect(frame.locator("body")).toContainText("PHP-FPM on WebAssembly", {
    timeout: 180_000,
  });

  await openTerminalDrawer(page);
  await waitForTerminalContent(page, KANDELO_PROMPT, 120_000);
  await runTerminalCommand(
    page,
    "set -eu; test \"$(id -u):$HOME:$(pwd)\" = '1000:/home/maker:/home/maker'; " +
      "printf 'KANDELO_NGINX_PHP_TERMINAL_OK\\n'",
    "KANDELO_NGINX_PHP_TERMINAL_OK",
  );
});

// Evidence for the nginx-python-vfs product: nginx reverse-proxies the
// static Notes API page and its live /api/* JSON endpoints to a Python
// (wsgiref) app over SQLite, all inside the same Kandelo machine. This is
// the browser counterpart to the Node-host
// "nginx-python-vfs-node-startup" test in node-host-counterparts.spec.ts,
// and is the evidence test named by images/vfs/products/browser-nginx-python
// .toml's [evidence.browser].
test("nginx-python-vfs-browser-startup: Kandelo nginx + Python demo serves the Notes API through the web preview", async ({ page }) => {
  // PARTIALLY-CLOSED BROWSER PLATFORM GAP. notes-app's startup
  // (`python3 /var/www/notes/app.py`) imports a large slice of the stdlib
  // (wsgiref -> http.server -> ... -> email.quoprimime). On first import
  // CPython used to compile each of those modules from *source* — a deeply
  // recursive pass (tokenizer -> parser -> AST -> symtable -> code generator).
  // Inside the browser's dedicated kernel Worker — whose V8 stack is a fixed,
  // small default because the `new Worker()` API exposes no stack-size knob —
  // that recursion, amplified by the fork-instrument transport trampoline
  // (__wpk_fork_unwind_transport_indirect_0_*) that wraps each fork-reaching
  // guest indirect call, threw "RangeError: Maximum call stack size exceeded"
  // and took the whole kernel worker (not just the one process) down, so dinit
  // lost notes-app and nginx together and every /api/* request returned
  // nginx's HTML error page instead of JSON. The Node host survives because
  // NodeKernelHost gives its worker a 32 MB stack (nodeWorkerStackSizeMb() in
  // host/src/worker-adapter.ts); the browser has no equivalent knob (confirmed:
  // even chromium --js-flags=--stack-size does not enlarge a Worker's stack).
  //
  // FIXED (build-time bytecode prewarm): the nginx-python image builder now
  // precompiles the stdlib and the app to .pyc at build time
  // (images/vfs/scripts/python-bytecode-prewarm.ts) using the Kandelo CPython
  // under the kernel, with unchecked-hash invalidation so import uses the baked
  // bytecode verbatim. At runtime the browser loads bytecode via marshal
  // instead of compiling from source, which removes the deepest recursion and
  // is verified by syscall trace (import opens the baked .pyc, no compile).
  //
  // ALSO FIXED alongside it: the Python service was not actually getting
  // PYTHONDONTWRITEBYTECODE / PYTHONHOME despite
  // images/vfs/products/browser-nginx-python.toml's [boot.env] declaring
  // them. They now live in the IMAGE, as notes-app's own dinit env-file
  // (images/vfs/scripts/build-nginx-python-vfs-image.ts), which is where a
  // dinit-target machine's per-service environment belongs: the browser host
  // hands pid 1 only what no baked artifact can know.
  //
  // BROWSER OVERFLOW GAP CLOSED by fork PR #1402 (spill switch-dispatch locals
  // to a shadow-stack scratch frame). Measured on Node with
  // KANDELO_NODE_WORKER_STACK_SIZE_MB: the fork-instrumented stdlib import
  // chain now needs ~0.3 MB of worker stack (PASS at 0.3, OVERFLOW at 0.27),
  // down from the pre-#1402 ~0.82 MB, landing at the no-fork ~0.27 MB baseline.
  // In a real chromium Worker the Notes API now works end to end: the static
  // page renders, GET /api/notes returns the seeded rows, and POST creates a
  // row (verified 2026-09-22 on this merge).
  test.setTimeout(300_000);

  await gotoMachineOrSkip(page, "nginx-python");
  await page.waitForSelector('iframe[title="nginx + Python"]', { timeout: 180_000 });

  const frame = webFrame(page, "nginx + Python");
  await expect(frame.locator("body")).toContainText(
    "Python Notes API on Kandelo",
    { timeout: 180_000 },
  );
  await expect(frame.locator("body")).toContainText("wsgiref", { timeout: 30_000 });

  // "GET /api/notes" button: the seeded rows must already be present. nginx
  // (static page) comes up before notes-app finishes its first Python stdlib
  // import, so a single early click can hit nginx's proxy error page. Re-click
  // until the live JSON answers.
  await expect(async () => {
    await frame.locator("#load").click();
    await expect(frame.locator("#out")).toContainText("Welcome to Kandelo", {
      timeout: 5_000,
    });
  }).toPass({ timeout: 180_000 });
  const seeded = await frame.locator("#out").evaluate((node) =>
    JSON.parse(node.textContent ?? "[]"),
  );
  expect(Array.isArray(seeded)).toBe(true);
  expect(seeded.length).toBeGreaterThanOrEqual(2);

  // "POST a note" button: the live API must accept writes and echo a
  // created row with an assigned id.
  await frame.locator("#add").click();
  await expect(frame.locator("#out")).toContainText("From the browser", {
    timeout: 60_000,
  });
  const created = await frame.locator("#out").evaluate((node) =>
    JSON.parse(node.textContent ?? "{}"),
  );
  expect(created).toMatchObject({ title: "From the browser" });
  expect(typeof created.id).toBe("number");

  await openTerminalDrawer(page);
  await waitForTerminalContent(page, KANDELO_PROMPT, 120_000);
  await runTerminalCommand(
    page,
    "set -eu; test \"$(id -u):$HOME:$(pwd)\" = '1000:/home/maker:/home/maker'; " +
      "printf 'KANDELO_NGINX_PYTHON_TERMINAL_OK\\n'",
    "KANDELO_NGINX_PYTHON_TERMINAL_OK",
  );
});

test("Kandelo WordPress SQLite demo is preinstalled and logs into wp-admin", async ({ page }) => {
  await runWordPressPreinstalledLogin(page, "wordpress-sqlite", "WordPress SQLite");
});

test("Kandelo WordPress MariaDB demo is preinstalled and logs into wp-admin", async ({ page }) => {
  await runWordPressPreinstalledLogin(page, "wordpress-mariadb", "WordPress MariaDB");
});

test("Kandelo fbDOOM demo renders and starts the OSS audio sink", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoMachineOrSkip(page, "doom");
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });

  await canvas.click({ position: { x: 8, y: 8 } });
  await expect(page.locator("[data-audio-state]").first()).toHaveAttribute(
    "data-audio-state",
    "running",
    { timeout: 10_000 },
  );

  await expect
    .poll(async () => {
      return canvas.evaluate((canvas: HTMLCanvasElement) => {
        if (canvas.width === 0 || canvas.height === 0) return false;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        const sample = ctx.getImageData(0, 0, Math.min(canvas.width, 64), Math.min(canvas.height, 64)).data;
        for (let i = 0; i < sample.length; i += 4) {
          if (sample[i] !== 0 || sample[i + 1] !== 0 || sample[i + 2] !== 0) return true;
        }
        return false;
      });
    }, { timeout: 180_000 })
    .toBe(true);
});
