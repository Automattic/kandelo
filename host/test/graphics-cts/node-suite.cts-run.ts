/**
 * Chunked upstream dEQP (GLES2 or EGL) on the Node host.
 *
 * Run through scripts/run-graphics-cts.sh <suite> node <selector>, which
 * plans the chunks, runs this file with vitest.graphics-cts.config.ts and
 * summarizes. Each chunk is one test; each attempt is a fresh NodeKernelHost
 * over the same image. A guest crash or deadline is attributed to the open
 * case and the chunk resumes after it. Upstream outcomes are recorded
 * verbatim; a test fails only when its own evidence cannot be written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "vitest";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { chunkFileName } from "../../../tests/graphics/cts-plan.mjs";
import { runChunk } from "../../../tests/graphics/cts-accounting.mjs";
import { CaseProgress, ctsAttemptCeilingMs, ctsDeadlineConfig, waitForExitOrStall } from "../../../tests/graphics/cts-progress.mjs";
import { buildCtsGuest, ctsArguments, ctsCaselist, CTS_CASELIST_PATH, CTS_QPA_MAX_BYTES,
  CTS_QPA_PATH, type CtsGuest } from "../../../tests/graphics/cts-guest";

const planPath = process.env.KANDELO_CTS_PLAN, outDir = process.env.KANDELO_CTS_OUT;
if (!planPath || !outDir) throw new Error("KANDELO_CTS_PLAN and KANDELO_CTS_OUT are set by scripts/run-graphics-cts.sh");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const maxAttempts = Number(process.env.KANDELO_CTS_MAX_ATTEMPTS ?? 8);
const engineDir = resolve(outDir, "node"), qpaDir = join(engineDir, "qpa");
const deadlines = ctsDeadlineConfig();
let guestPromise: Promise<CtsGuest> | undefined;

const bounded = <T>(promise: Promise<T>, ms: number, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })])
    .finally(() => clearTimeout(timer));
};

for (const chunk of plan.chunks) {
  const ceiling = ctsAttemptCeilingMs(chunk.cases.length, deadlines);
  it(chunk.id, async () => {
    const guest = await (guestPromise ??= buildCtsGuest(plan.suite));
    mkdirSync(qpaDir, { recursive: true });
    const result = await runChunk(chunk, async (cases: string[], attempt: number) => {
      const diagnostics: unknown[] = [];
      let output = "";
      // The deadline follows dEQP's case lines on stdout (cts-progress.mjs).
      const progress = new CaseProgress(deadlines), decoder = new TextDecoder();
      const append = (_pid: number, bytes: Uint8Array) => {
        const text = decoder.decode(bytes, { stream: true });
        progress.feed(text);
        if (output.length < 65536) output += text.slice(0, 65536 - output.length);
      };
      const host = new NodeKernelHost({ maxWorkers: 4, maxPages: 16384, rootfsImage: guest.image,
        onStdout: append, onStderr: append,
        onHostDiagnostic: (diagnostic: unknown) => { if (diagnostics.length < 64) diagnostics.push(diagnostic); } });
      let outcome: Record<string, unknown>, qpa = "";
      try {
        await host.init(guest.kernel.buffer.slice(guest.kernel.byteOffset, guest.kernel.byteOffset + guest.kernel.byteLength) as ArrayBuffer);
        await host.writeFileToVfs(CTS_CASELIST_PATH, ctsCaselist(cases), 0o644);
        const child = await host.spawnFromVfs(guest.guestPath, ctsArguments(plan.suite), { env: [], stdin: new Uint8Array() });
        outcome = await waitForExitOrStall(child.exit, progress);
        if (outcome.kind === "timeout") diagnostics.push({ deadline: progress.snapshot() });
        // The host stays alive across a deadline, so the open case's begin
        // marker is still readable before teardown.
        try {
          const bytes = await bounded(host.readFileFromVfs(CTS_QPA_PATH), 30_000, "QPA read timed out");
          if (bytes && bytes.length > CTS_QPA_MAX_BYTES) throw new Error(`CTS QPA exceeds ${CTS_QPA_MAX_BYTES} bytes`);
          qpa = bytes ? new TextDecoder().decode(bytes) : "";
        } catch (error) { diagnostics.push({ qpaError: String(error) }); }
      } catch (error) {
        outcome = { kind: "error", message: String(error) };
      } finally {
        try { await bounded(host.destroy(), 30_000, "host destroy timed out"); }
        catch (error) { diagnostics.push({ destroyError: String(error) }); }
      }
      writeFileSync(join(qpaDir, `${chunkFileName(chunk.id)}.attempt${attempt}.qpa`), qpa);
      return { qpa, outcome: outcome!, diagnostics, output };
    }, { maxAttempts });
    writeFileSync(join(engineDir, `${chunkFileName(chunk.id)}.json`), JSON.stringify({ ...result, engine: "node",
      version: process.version, suite: plan.suite, args: ctsArguments(plan.suite), artifacts: guest.artifacts }) + "\n");
  }, ceiling * maxAttempts + 120_000);
}
