#!/usr/bin/env node
/**
 * Plan and summarize chunked upstream dEQP runs (no guest execution here).
 *
 *   node tests/graphics/cts-run.mjs plan --suite gles2 --selector all [--chunk-size N] [--chunks ID,ID] --out DIR
 *   node tests/graphics/cts-run.mjs summarize --out DIR [--strict]
 *
 * `plan` writes DIR/plan.json. Runners write DIR/<engine>/<chunk>.json.
 * `summarize` writes DIR/summary.json and DIR/cases.tsv and, with --strict,
 * exits 1 on any Fail/Crash/Timeout/Missing or other non-passing status.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPlan, filterChunks } from "./cts-plan.mjs";
import { strictVerdict, summarize } from "./cts-accounting.mjs";

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (key === "strict") { result.strict = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
    result[key] = argv[++i];
  }
  return result;
}

export function planCommand(opts) {
  if (!opts.out) throw new Error("--out is required");
  const chunkSize = opts["chunk-size"] === undefined ? undefined : Number(opts["chunk-size"]);
  const plan = filterChunks(buildPlan({ suite: opts.suite, selector: opts.selector ?? "all", chunkSize }), opts.chunks);
  mkdirSync(resolve(opts.out), { recursive: true });
  writeFileSync(join(resolve(opts.out), "plan.json"), JSON.stringify(plan) + "\n");
  return plan;
}

export function readResults(out) {
  const results = {};
  for (const entry of readdirSync(out, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(out, entry.name);
    results[entry.name] = readdirSync(dir).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(dir, name), "utf8")));
  }
  return results;
}

export function summarizeCommand(opts) {
  if (!opts.out) throw new Error("--out is required");
  const out = resolve(opts.out), planPath = join(out, "plan.json");
  if (!existsSync(planPath)) throw new Error(`${planPath} is missing; run the plan step first`);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const engines = opts.engines ? opts.engines.split(",") : null;
  const results = readResults(out);
  for (const engine of engines ?? []) results[engine] ??= [];
  const { summary, tsv } = summarize(plan, results);
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(out, "cases.tsv"), tsv);
  return { summary, verdict: strictVerdict(summary) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const opts = options(rest);
    if (command === "plan") {
      const plan = planCommand(opts);
      console.log(`planned ${plan.caseCount} ${plan.suite} cases in ${plan.chunks.length} chunks`);
    } else if (command === "summarize") {
      const { summary, verdict } = summarizeCommand(opts);
      for (const [engine, data] of Object.entries(summary.engines)) {
        console.log(`${engine}: ${Object.entries(data.totals).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(", ")}`
          + (data.crashedChunks.length ? `; ${data.crashedChunks.length} chunk(s) with a guest crash, deadline or absent result (see summary.json crashedChunks)` : ""));
      }
      for (const error of summary.accountingErrors) console.log(`accounting error: ${error}`);
      if (opts.strict && !verdict.ok) {
        for (const reason of verdict.reasons) console.error(`strict: ${reason}`);
        process.exit(1);
      }
    } else throw new Error("usage: cts-run.mjs plan|summarize [options]");
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
}
