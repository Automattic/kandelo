#!/usr/bin/env tsx

const endpoint = process.env.SPIDERMONKEY_NODE_JS_SHELL_URL;
if (!endpoint) {
  console.error("SPIDERMONKEY_NODE_JS_SHELL_URL is not set");
  process.exit(127);
}

const timeoutMs = Number(process.env.SPIDERMONKEY_WRAPPER_TIMEOUT_MS ?? 600_000);
let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`),
      timeoutMs,
    }),
  });
} catch (err: any) {
  console.error(`node js shell bridge request failed: ${err?.message || String(err)}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`node js shell bridge failed: HTTP ${response.status}`);
  console.error(await response.text());
  process.exit(1);
}

const result = await response.json() as {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`${result.error}\n`);

process.exit(typeof result.exitCode === "number" ? result.exitCode : 1);
