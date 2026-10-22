// Runs one registry reproduction against one target and prints a verdict.
//
// This file is the only place that knows how to launch a browser page or a
// script; `xtask runtime-workarounds run` passes the `[repro]` fields as flags
// so no TOML parser is needed here.
//
//   node driver.mjs --dir <repro-dir> --kind browser-page|script --entry <file>
//        --target <t> --attempts N --min-reproduced N --timeout-seconds N
//        --crash-is-reproduced 0|1
//
// The last stdout line is always one JSON object:
//   {"verdict":"reproduced|not-reproduced|inconclusive","version":"...",
//    "os":"macos|linux|windows","details":"..."}
// and the exit status is 0 whenever a verdict was produced.
//
// Repro protocols (the repro itself is Kandelo-free and judges itself):
//   browser-page  the page sets window.__reproVerdict = { verdict, details }
//   script        the script prints a line: REPRO-VERDICT {"verdict":...,"details":...}

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT = join(here, '../../apps/browser-demos/node_modules/@playwright/test/index.mjs');

const ENGINES = ['chromium', 'firefox', 'webkit'];
const VERDICTS = ['reproduced', 'not-reproduced', 'inconclusive'];
const OS_NAMES = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const POLL_MS = 200;
const EVALUATE_TIMEOUT_MS = 1000;
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Combine per-attempt results into one verdict. `reproduced` iff at least
 * `minReproduced` attempts reproduced (a crash counts only when
 * `crashIsReproduced`); else `not-reproduced` iff every attempt reported
 * `not-reproduced`; else `inconclusive`.
 */
export function aggregate(attempts, minReproduced, crashIsReproduced) {
  const reproduced = attempts.filter(
    (a) => a === 'reproduced' || (a === 'crashed' && crashIsReproduced),
  ).length;
  if (reproduced >= minReproduced && reproduced > 0) return 'reproduced';
  if (attempts.length > 0 && attempts.every((a) => a === 'not-reproduced')) return 'not-reproduced';
  return 'inconclusive';
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!name?.startsWith('--') || i + 1 >= argv.length) {
      throw new Error(`bad argument ${JSON.stringify(name)}`);
    }
    flags[name.slice(2)] = argv[i + 1];
  }
  const need = (name) => {
    if (flags[name] === undefined) throw new Error(`missing --${name}`);
    return flags[name];
  };
  const number = (name) => {
    const n = Number(need(name));
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
    return n;
  };
  const kind = need('kind');
  if (kind !== 'browser-page' && kind !== 'script') {
    throw new Error(`--kind must be browser-page or script, got ${JSON.stringify(kind)}`);
  }
  return {
    dir: need('dir'),
    kind,
    entry: need('entry'),
    target: need('target'),
    attempts: number('attempts'),
    minReproduced: number('min-reproduced'),
    timeoutSeconds: number('timeout-seconds'),
    crashIsReproduced: need('crash-is-reproduced') === '1',
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, sleep(ms).then(() => fallback)]);

function normalizeVerdict(raw) {
  if (raw && VERDICTS.includes(raw.verdict)) {
    return { verdict: raw.verdict, details: String(raw.details ?? '') };
  }
  return {
    verdict: 'inconclusive',
    details: `repro reported an unusable verdict: ${JSON.stringify(raw)}`,
  };
}

// ---------------------------------------------------------------- browser

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/** Serve `dir` on an ephemeral port, cross-origin isolated. */
async function serve(dir) {
  const root = normalize(dir + sep);
  const server = createServer(async (req, res) => {
    const headers = {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    };
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = normalize(join(dir, pathname));
      if (!file.startsWith(root)) {
        res.writeHead(403, headers).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        ...headers,
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404, headers).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function loadPlaywright() {
  return import(pathToFileURL(PLAYWRIGHT).href);
}

async function browserAttempt(engine, url, timeoutMs) {
  let browser;
  try {
    browser = await engine.launch({ headless: true });
  } catch (error) {
    return { result: 'inconclusive', details: `could not launch ${engine.name()}: ${String(error.message).split('\n')[0]}`, version: null };
  }
  const version = browser.version();
  let crashed = false;
  try {
    const page = await browser.newPage();
    page.on('crash', () => {
      crashed = true;
    });
    browser.on('disconnected', () => {
      crashed = true;
    });
    const deadline = Date.now() + timeoutMs;
    // `commit` returns once the response starts: a page that never finishes
    // loading (or hangs its main thread) must not hang the driver.
    await withTimeout(
      page.goto(url, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => {}),
      timeoutMs,
      undefined,
    );
    while (Date.now() < deadline) {
      if (crashed) return { result: 'crashed', details: 'the page crashed', version };
      // A page stuck in a busy loop never answers; give up on this poll only.
      const raw = await withTimeout(
        page.evaluate(() => window.__reproVerdict ?? null).catch(() => null),
        EVALUATE_TIMEOUT_MS,
        null,
      );
      if (crashed) return { result: 'crashed', details: 'the page crashed', version };
      if (raw) {
        const { verdict, details } = normalizeVerdict(raw);
        return { result: verdict, details, version };
      }
      await sleep(POLL_MS);
    }
    return {
      result: 'inconclusive',
      details: `no verdict within ${timeoutMs / 1000}s`,
      version,
    };
  } finally {
    await withTimeout(browser.close().catch(() => {}), CLOSE_TIMEOUT_MS, undefined);
  }
}

async function runBrowserPage(opts) {
  if (!ENGINES.includes(opts.target)) {
    throw new Error(`browser-page repro cannot run on target ${JSON.stringify(opts.target)}`);
  }
  const playwright = await loadPlaywright();
  const engine = playwright[opts.target];
  const server = await serve(opts.dir);
  const url = `http://127.0.0.1:${server.address().port}/${encodeURI(opts.entry)}`;
  const results = [];
  const details = [];
  let version = null;
  try {
    for (let i = 0; i < opts.attempts; i++) {
      const attempt = await browserAttempt(engine, url, opts.timeoutSeconds * 1000);
      results.push(attempt.result);
      details.push(attempt.details);
      version ??= attempt.version;
    }
  } finally {
    server.close();
  }
  return { results, details, version: version ? `${opts.target} ${version}` : `${opts.target} unknown` };
}

// ----------------------------------------------------------------- script

function commandFor(opts) {
  const entry = join(opts.dir, opts.entry);
  switch (opts.target) {
    case 'node':
      return [process.execPath, [entry]];
    case 'bun':
      return ['bun', [entry]];
    default:
      // Toolchain targets: the script invokes its own tool.
      return ['bash', [entry]];
  }
}

function runToCompletion(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      // Own process group, so the timeout also kills what a script spawned.
      child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error, stdout, stderr });
      return;
    }
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function lastVerdictLine(stdout) {
  const lines = stdout.split('\n').filter((l) => l.startsWith('REPRO-VERDICT '));
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1].slice('REPRO-VERDICT '.length));
  } catch {
    return { verdict: 'unparseable' };
  }
}

async function scriptVersion(opts) {
  if (opts.target === 'node') return process.version;
  const tool = opts.target;
  const out = await runToCompletion(tool, ['--version'], { cwd: opts.dir, timeoutMs: 10_000 });
  const first = (out.stdout || out.stderr).split('\n')[0].trim();
  return out.error || !first ? 'unknown' : first;
}

async function runScript(opts) {
  const [command, args] = commandFor(opts);
  const results = [];
  const details = [];
  for (let i = 0; i < opts.attempts; i++) {
    const out = await runToCompletion(command, args, {
      cwd: opts.dir,
      timeoutMs: opts.timeoutSeconds * 1000,
    });
    if (out.error) {
      results.push('inconclusive');
      details.push(`could not run ${command}: ${out.error.message}`);
      continue;
    }
    const raw = lastVerdictLine(out.stdout);
    if (raw) {
      const { verdict, details: d } = normalizeVerdict(raw);
      results.push(verdict);
      details.push(d);
    } else if (out.timedOut) {
      results.push('inconclusive');
      details.push(`no verdict within ${opts.timeoutSeconds}s; killed`);
    } else if (out.signal) {
      results.push('crashed');
      details.push(`terminated by ${out.signal} without a verdict`);
    } else {
      results.push('inconclusive');
      const tail = out.stderr.trim().split('\n').slice(-1)[0];
      details.push(
        `exited with status ${out.code} without a REPRO-VERDICT line${tail ? `: ${tail}` : ''}`,
      );
    }
  }
  return { results, details, version: await scriptVersion(opts) };
}

// ------------------------------------------------------------------- main

export async function drive(opts) {
  const { results, details, version } =
    opts.kind === 'browser-page' ? await runBrowserPage(opts) : await runScript(opts);
  const verdict = aggregate(results, opts.minReproduced, opts.crashIsReproduced);
  // Show the attempts that decided the verdict; keep the line short.
  const deciding = results
    .map((r, i) => ({ r, d: details[i] }))
    .filter(({ r }) => r === verdict || (verdict === 'reproduced' && r === 'crashed'));
  const summary = `${results.length} attempt(s): ${results.join(', ')}`;
  const why = (deciding.length ? deciding : results.map((r, i) => ({ r, d: details[i] })))
    .map(({ d }) => d)
    .filter(Boolean)
    .slice(0, 1)
    .join('');
  return {
    verdict,
    version,
    os: OS_NAMES[process.platform] ?? process.platform,
    details: why ? `${summary}; ${why}` : summary,
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`driver: ${error.message}`);
    process.exit(2);
  }
  try {
    const line = JSON.stringify(await drive(opts)) + '\n';
    // Browsers and killed children can leave handles behind; exit once the
    // verdict has been flushed.
    process.stdout.write(line, () => process.exit(0));
  } catch (error) {
    console.error(`driver: ${error.stack ?? error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
