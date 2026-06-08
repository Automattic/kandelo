import { expect, test, type Page } from "@playwright/test";

test.skip(
  process.env.KANDELO_BROWSER_NODE_MEMORY_DIAGNOSTICS !== "1",
  "opt-in SpiderMonkey Node memory diagnostics",
);

const DEFAULT_MEMORY_PAGES = [4096, 8192, 16384];
const DIAGNOSTIC_STYLE = process.env.KANDELO_SM_NODE_DIAG_STYLE ?? "fresh";

type DiagCase = {
  name: string;
  command: string;
  timeout?: number;
};

function selectedMemoryPages(): number[] {
  const raw = process.env.KANDELO_SM_NODE_MEMORY_PAGES;
  if (!raw) return DEFAULT_MEMORY_PAGES;
  return raw
    .split(/[,\s]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function selectedCaseNames(): Set<string> | null {
  const raw = process.env.KANDELO_SM_NODE_DIAG_CASES;
  if (!raw) return null;
  const names = raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
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

async function gotoReadyDiagnosticPage(page: Page, memoryPages: number): Promise<void> {
  const params = new URLSearchParams({
    demo: "node",
    smNodeSkipSmoke: "1",
    smNodeMemoryPages: String(memoryPages),
  });
  await page.goto(`/?${params}`, { waitUntil: "domcontentloaded" });
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 180_000 })
    .toContain("Ready");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(page, /spidermonkey-node\$ ?/, 120_000);
}

async function gotoCiStyleDiagnosticPage(page: Page, memoryPages: number): Promise<void> {
  const params = new URLSearchParams({
    demo: "node",
    smNodeMemoryPages: String(memoryPages),
  });
  await page.goto(`/?${params}`, { waitUntil: "domcontentloaded" });
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 180_000 })
    .toContain("Ready");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(
    page,
    /(worker\s+42|Segmentation fault)[\s\S]*spidermonkey-node\$ ?/,
    240_000,
  );
}

async function runTerminalCommand(
  page: Page,
  command: string,
  expected: RegExp,
  timeout = 120_000,
) {
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) {
    await terminalInput.focus();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForTerminalContent(page, expected, timeout);
}

function nodeEval(source: string): string {
  return `node -e ${JSON.stringify(source)}`;
}

function statusPattern(name: string): RegExp {
  return new RegExp(`DIAG_STATUS_${name}:\\d+[\\s\\S]*spidermonkey-node\\$ ?`);
}

async function runStatusCase(page: Page, diagCase: DiagCase): Promise<number> {
  await runTerminalCommand(
    page,
    `${diagCase.command} ; echo DIAG_STATUS_${diagCase.name}:$?`,
    statusPattern(diagCase.name),
    diagCase.timeout ?? 120_000,
  );
  const text = await terminalText(page);
  const matches = [...text.matchAll(new RegExp(`DIAG_STATUS_${diagCase.name}:(\\d+)`, "g"))];
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch) {
    throw new Error(`missing DIAG_STATUS_${diagCase.name}`);
  }
  return Number(lastMatch[1]);
}

function workerSource(options: { terminate: boolean; exitListener: boolean }): string {
  return [
    "const {Worker}=require('worker_threads');",
    "const sab=new SharedArrayBuffer(8);",
    "const view=new Int32Array(sab);",
    "const worker=new Worker('const view=new Int32Array(workerData); Atomics.store(view,0,42); Atomics.store(view,1,1); Atomics.notify(view,1);',{eval:true,workerData:sab});",
    "if(Atomics.load(view,1)===0) Atomics.wait(view,1,0,5000);",
    "if(Atomics.load(view,1)!==1) throw new Error('worker did not finish');",
    "console.log('DIAG_WORKER_VALUE', Atomics.load(view,0));",
    options.exitListener ? "worker.on('exit', code => console.log('DIAG_WORKER_EXIT', code));" : "",
    options.terminate ? "console.log('DIAG_TERMINATE_BEFORE');" : "",
    options.terminate ? "const terminateResult=worker.terminate();" : "",
    options.terminate ? "console.log('DIAG_TERMINATE_AFTER', terminateResult);" : "",
    "console.log('DIAG_WORKER_DONE');",
  ].filter(Boolean).join(" ");
}

const fullSmokeSource = [
  "const assert=require('node:assert');",
  "const path=require('path');",
  "const {Worker}=require('worker_threads');",
  "const b=Buffer.from('Kandelo');",
  "assert.strictEqual(path.basename('/usr/bin/node'),'node');",
  "console.log('SpiderMonkey Node', process.version, process.arch);",
  "console.log(b.toString('hex'));",
  "console.log(new Intl.NumberFormat('de-DE').format(1234567.89));",
  "const sab=new SharedArrayBuffer(8);",
  "const view=new Int32Array(sab);",
  "const worker=new Worker('const view=new Int32Array(workerData); Atomics.store(view,0,42); Atomics.store(view,1,1); Atomics.notify(view,1);',{eval:true,workerData:sab});",
  "if(Atomics.load(view,1)===0) Atomics.wait(view,1,0,5000);",
  "if(Atomics.load(view,1)!==1) throw new Error('worker did not finish');",
  "console.log('worker', Atomics.load(view,0));",
  "worker.terminate();",
].join(" ");

const ALL_CASES: DiagCase[] = [
  {
    name: "SIMPLE",
    command: nodeEval("console.log('DIAG_SIMPLE_BODY')"),
  },
  {
    name: "SAB_ONLY",
    command: nodeEval("const sab=new SharedArrayBuffer(8); console.log('DIAG_SAB_ONLY', sab.byteLength);"),
  },
  {
    name: "SAB_STORE",
    command: nodeEval("const sab=new SharedArrayBuffer(8); const view=new Int32Array(sab); Atomics.store(view,0,42); console.log('DIAG_SAB_STORE', Atomics.load(view,0));"),
  },
  {
    name: "SAB_NOTIFY",
    command: nodeEval("const sab=new SharedArrayBuffer(8); const view=new Int32Array(sab); Atomics.store(view,1,1); Atomics.notify(view,1); console.log('DIAG_SAB_NOTIFY');"),
  },
  {
    name: "WORKER_NO_TERMINATE",
    command: nodeEval(workerSource({ terminate: false, exitListener: false })),
  },
  {
    name: "WORKER_TERMINATE",
    command: nodeEval(workerSource({ terminate: true, exitListener: false })),
  },
  {
    name: "WORKER_TERMINATE_LISTENER",
    command: nodeEval(workerSource({ terminate: true, exitListener: true })),
  },
  {
    name: "FULL_SMOKE",
    command: `${nodeEval(fullSmokeSource)} && npm --version`,
    timeout: 180_000,
  },
];

test.describe.configure({ mode: "serial" });

const caseFilter = selectedCaseNames();
const diagCases = caseFilter
  ? ALL_CASES.filter((diagCase) => caseFilter.has(diagCase.name))
  : ALL_CASES;

function attachDiagnosticLogging(page: Page, memoryPages: number, label: string) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" || /Centralized worker failed|memory access out of bounds|Segmentation fault/i.test(text)) {
      console.log(`DIAG_CONSOLE ${memoryPages} ${label} ${msg.type()} ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    console.log(`DIAG_PAGEERROR ${memoryPages} ${label} ${error.message}`);
  });
}

if (DIAGNOSTIC_STYLE === "fresh" || DIAGNOSTIC_STYLE === "both") {
  for (const memoryPages of selectedMemoryPages()) {
    for (const diagCase of diagCases) {
      test(`SpiderMonkey Node ${diagCase.name} with ${memoryPages} memory pages`, async ({ page }) => {
        test.setTimeout(360_000);
        attachDiagnosticLogging(page, memoryPages, diagCase.name);

        await gotoReadyDiagnosticPage(page, memoryPages);
        const status = await runStatusCase(page, diagCase);
        console.log(`DIAG_RESULT ${memoryPages} ${diagCase.name} ${status}`);
      });
    }
  }
}

if (DIAGNOSTIC_STYLE === "ci" || DIAGNOSTIC_STYLE === "both") {
  for (const memoryPages of selectedMemoryPages()) {
    test(`SpiderMonkey Node CI startup matrix with ${memoryPages} memory pages`, async ({ page }) => {
      test.setTimeout(360_000);
      attachDiagnosticLogging(page, memoryPages, "CI_MATRIX");

      await gotoCiStyleDiagnosticPage(page, memoryPages);
      const results: Array<{ name: string; status: number }> = [];
      for (const diagCase of diagCases) {
        const status = await runStatusCase(page, diagCase);
        results.push({ name: diagCase.name, status });
        console.log(`DIAG_RESULT ${memoryPages} ${diagCase.name} ${status}`);
      }
      console.log(`DIAG_SUMMARY ${memoryPages} ${JSON.stringify(results)}`);
    });
  }
}
