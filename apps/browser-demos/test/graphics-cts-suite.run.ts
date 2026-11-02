/**
 * Chunked upstream dEQP (GLES2 or EGL) in one headless browser engine.
 *
 * Run through scripts/run-graphics-cts.sh, which plans the chunks
 * (tests/graphics/cts-run.mjs plan), selects the Playwright project and
 * summarizes the per-chunk results. Each chunk is its own Playwright test
 * and page: a page crash loses at most that chunk. Inside a chunk, a guest
 * crash or deadline is attributed to the open case and the chunk resumes
 * after it in a fresh kernel. Upstream outcomes are recorded verbatim; this
 * test fails only when its own evidence cannot be written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { chunkFileName } from "../../../tests/graphics/cts-plan.mjs";
import { runChunk } from "../../../tests/graphics/cts-accounting.mjs";
import { ctsAttemptCeilingMs, ctsDeadlineConfig } from "../../../tests/graphics/cts-progress.mjs";
import { buildCtsGuest, ctsArguments, ctsCaselist, CTS_CASELIST_PATH, CTS_QPA_MAX_BYTES,
  CTS_QPA_PATH, type CtsGuest } from "../../../tests/graphics/cts-guest";

const planPath = process.env.KANDELO_CTS_PLAN, outDir = process.env.KANDELO_CTS_OUT;
if (!planPath || !outDir) throw new Error("KANDELO_CTS_PLAN and KANDELO_CTS_OUT are set by scripts/run-graphics-cts.sh");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const maxAttempts = Number(process.env.KANDELO_CTS_MAX_ATTEMPTS ?? 8);
const deadlines = ctsDeadlineConfig();
let guestPromise: Promise<CtsGuest> | undefined;

test.use({ headless: true, serviceWorkers: "block" });
test.describe.configure({ mode: "default", retries: 0 });

for (const chunk of plan.chunks) {
  test(chunk.id, async ({ page, browser, browserName, baseURL }, testInfo) => {
    // Each attempt's deadline follows dEQP's case lines on stdout
    // (tests/graphics/cts-progress.mjs); the ceiling bounds an attempt in
    // which every case used its whole per-case limit.
    const ceiling = ctsAttemptCeilingMs(chunk.cases.length, deadlines);
    test.setTimeout((ceiling + 60_000) * maxAttempts + 120_000);
    const guest = await (guestPromise ??= buildCtsGuest(plan.suite));
    const engineDir = resolve(outDir, browserName), qpaDir = join(engineDir, "qpa");
    mkdirSync(qpaDir, { recursive: true });
    const kernelUrl = new URL("/__cts_suite_kernel", baseURL).href;
    const imageUrl = new URL("/__cts_suite_image", baseURL).href;
    await page.route(kernelUrl, route => route.fulfill({ body: Buffer.from(guest.kernel) }));
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(guest.image) }));
    const pageErrors: string[] = [], consoleErrors: string[] = [];
    page.on("pageerror", error => { if (pageErrors.length < 256) pageErrors.push(error.message.slice(0, 4096)); });
    page.on("console", message => {
      if (message.type() === "error" && consoleErrors.length < 256) consoleErrors.push(message.text().slice(0, 4096));
    });
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const moduleUrl = new URL(`/@fs${fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url))}`, baseURL).href;
    const progressUrl = new URL(`/@fs${fileURLToPath(new URL("../../../tests/graphics/cts-progress.mjs", import.meta.url))}`, baseURL).href;

    const result = await runChunk(chunk, async (cases: string[], attempt: number) => {
      await page.evaluate(async ({ moduleUrl, progressUrl, deadlines, kernelUrl, imageUrl, path, args, caselist, caselistPath }) => {
        const scope = globalThis as any;
        const { CaseProgress } = await import(progressUrl);
        const progress = new CaseProgress(deadlines), decoder = new TextDecoder();
        const state = { exit: null as number | null, error: null as string | null, diagnostics: [] as unknown[],
          output: "", outputBytes: 0, progress };
        scope.__ctsSuiteState = state;
        const append = (bytes: Uint8Array) => {
          state.outputBytes += bytes.byteLength;
          const text = decoder.decode(bytes, { stream: true });
          progress.feed(text);
          if (state.output.length < 65536) state.output += text.slice(0, 65536 - state.output.length);
        };
        const { BrowserKernel } = await import(moduleUrl);
        const kernel = new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 4, onStdout: append, onStderr: append,
          onHostDiagnostic: (diagnostic: unknown) => { if (state.diagnostics.length < 64) state.diagnostics.push(diagnostic); } });
        scope.__ctsSuiteKernel = kernel;
        await kernel.initFromImage({ kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()) });
        await kernel.writeFileToVfs(caselistPath, new Uint8Array(caselist), 0o644);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        document.body.replaceChildren(canvas);
        kernel.kmsSetDisplaySize(1, 16, 16);
        kernel.kmsAttachCanvas(1, canvas.transferControlToOffscreen(), new SharedArrayBuffer(32), { mode: "webgl2-scanout" });
        const child = await kernel.spawnFromVfs(path, args, { env: [], uid: 1000, gid: 1000 });
        child.exit.then((code: number) => { state.exit = code; }, (error: unknown) => { state.error = String(error); });
      }, { moduleUrl, progressUrl, deadlines, kernelUrl, imageUrl, path: guest.guestPath, args: ctsArguments(plan.suite),
        caselist: [...ctsCaselist(cases)], caselistPath: CTS_CASELIST_PATH });
      let outcome: Record<string, unknown>;
      const deadlineEvidence: unknown[] = [];
      try {
        // Settles on exit, error or a stalled case. The outer timeout only
        // guards a page that stops evaluating; it is never the case deadline.
        const settled = await page.waitForFunction(() => {
          const state = (globalThis as any).__ctsSuiteState;
          if (!state) return false;
          if (state.exit !== null || state.error !== null) return { exit: state.exit, error: state.error };
          return state.progress.expired() ? { stalled: state.progress.snapshot() } : false;
        }, undefined, { timeout: ceiling + 60_000, polling: 250 });
        const result = await settled.jsonValue() as { exit?: number | null; error?: string | null; stalled?: unknown };
        if (result.stalled) { outcome = { kind: "timeout" }; deadlineEvidence.push({ deadline: result.stalled }); }
        else outcome = result.error !== null && result.error !== undefined ? { kind: "error", message: result.error }
          : { kind: "exit", code: result.exit };
      } catch (error) {
        if (page.isClosed()) throw error;
        outcome = { kind: "timeout" };
        deadlineEvidence.push({ deadline: "page did not settle within the attempt ceiling" });
      }
      // The kernel stays alive across a deadline, so the open case's begin
      // marker is still readable before teardown.
      // Bounded so a wedged kernel cannot hold the page past its test.
      let qpa = "", qpaError: string | null = null;
      try {
        qpa = await page.evaluate(async ({ qpaPath, maxBytes }) => {
          const kernel = (globalThis as any).__ctsSuiteKernel;
          const bytes: Uint8Array | null = kernel ? await Promise.race([kernel.readFileFromVfs(qpaPath),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("QPA read timed out")), 30_000))]) : null;
          if (bytes && bytes.length > maxBytes) throw new Error(`CTS QPA exceeds ${maxBytes} bytes`);
          return bytes ? new TextDecoder().decode(bytes) : "";
        }, { qpaPath: CTS_QPA_PATH, maxBytes: CTS_QPA_MAX_BYTES });
      } catch (error) {
        if (page.isClosed()) throw error;
        qpaError = String(error);
      }
      const state = await page.evaluate(async () => {
        const scope = globalThis as any;
        try {
          await Promise.race([scope.__ctsSuiteKernel?.destroy(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("kernel destroy timed out")), 30_000))]);
        } catch (error) { scope.__ctsSuiteState.destroyError = String(error); }
        finally { scope.__ctsSuiteKernel = null; }
        const { progress: _progress, ...state } = scope.__ctsSuiteState;
        return state;
      });
      writeFileSync(join(qpaDir, `${chunkFileName(chunk.id)}.attempt${attempt}.qpa`), qpa);
      return { qpa, outcome, output: state?.output ?? "",
        diagnostics: [...(state?.diagnostics ?? []), ...deadlineEvidence, ...(qpaError ? [{ qpaError }] : []),
          ...(state?.destroyError ? [{ destroyError: state.destroyError }] : [])] };
    }, { maxAttempts });

    const record = { ...result, engine: browserName, version: browser.version(), suite: plan.suite,
      args: ctsArguments(plan.suite), artifacts: guest.artifacts, pageErrors, consoleErrors };
    writeFileSync(join(engineDir, `${chunkFileName(chunk.id)}.json`), JSON.stringify(record) + "\n");
    const counts: Record<string, number> = {};
    for (const row of result.rows) counts[String(row.status)] = (counts[String(row.status)] ?? 0) + 1;
    testInfo.annotations.push({ type: "cts", description: JSON.stringify(counts) });
  });
}
