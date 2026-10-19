#!/usr/bin/env node
/** Orchestration only: compilation and packaging run in the declared dev shell. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApprovedRefererOrigins } from "../apps/spacefast-cors-proxy/src/request-policy.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `Usage: node scripts/deploy-spacefast.mjs --space ORIGIN [options]

Prepare a combined Kandelo app, CORS proxy and signalling service for an
existing Space. Requires Node 24 and Kandelo's normal build prerequisites.

  --space ORIGIN          Required canonical HTTPS origin of the target Space
  --allow-referer ORIGIN  Also approve this HTTP(S) app origin (repeatable)
  --publish               Build, package and update the selected Space live
  --dry-run               Build, package and inspect the CLI plan; no upload
  --help                  Show this help

Without --publish or --dry-run, only prepare the bundle and print its path
and exact publish command. The Space origin is always approved automatically.
Use origins without paths or trailing slashes. No saved Space selection is
used as a default. This script never installs tools, signs in, creates a
Space, or changes access settings. --publish/--dry-run require the sf CLI.
`;

function origin(value, flag) {
  try {
    const parsed = parseApprovedRefererOrigins(value);
    if (parsed.length === 1 && parsed[0] === value &&
        (flag !== "--space" || value.startsWith("https://"))) return value;
  } catch { /* Keep invalid URLs, including possible callback secrets, out of errors. */ }
  const scheme = flag === "--space" ? "HTTPS" : "HTTP(S)";
  throw new Error(`${flag} requires one exact ${scheme} origin without credentials, path, query, fragment or trailing slash`);
}

function options(args) {
  let space;
  let mode = "prepare";
  const approved = [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    const flag = argument.split("=", 1)[0];
    if (flag === "--space" || flag === "--allow-referer") {
      const value = argument.includes("=") ? argument.slice(flag.length + 1) : args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires an origin`);
      const validated = origin(value, flag);
      if (flag === "--space") {
        if (space) throw new Error("Specify --space exactly once");
        space = validated;
      } else approved.push(validated);
    } else if (argument === "--publish" || argument === "--dry-run") {
      if (mode !== "prepare") throw new Error("Choose only one of --publish and --dry-run");
      mode = argument.slice(2);
    } else throw new Error("Unknown deployment option; use --help");
  }
  if (!space) throw new Error("--space is required; saved Space selections are not used");
  return { space, mode, approved: [...new Set([space, ...approved])] };
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root,
      stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit" });
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk.toString(); process.stdout.write(chunk); });
    child.once("error", error => reject(error.code === "ENOENT"
      ? new Error(`Required command is unavailable: ${command}. Install it separately; no tools were installed.`) : error));
    child.once("close", (code, signal) => code === 0 ? resolve(output)
      : reject(new Error(`${command} failed (${signal ?? code}); deployment stopped`)));
  });
}

function quote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

async function main(args) {
  if (args.includes("--help")) { process.stdout.write(help); return; }
  const { space, mode, approved } = options(args);
  // Check the external publishing tool before an expensive build. Keep it
  // outside the pure build shell so its existing host authentication works.
  if (mode !== "prepare") await run("sf", ["--version"]);
  const context = join(root, ".context");
  await mkdir(context, { recursive: true });
  const work = await mkdtemp(join(context, "spacefast-deploy-"));
  const site = join(work, "static");
  await run("bash", [join(root, "run.sh"), "build-browser", "--base", "/", "--out", site,
    "--cors-proxy", "/cors-proxy?url=", "--signalling-url", "/signalling"]);
  const output = await run("bash", [join(root, "scripts/dev-shell.sh"), "node",
    join(root, "apps/spacefast-cors-proxy/build-site.mjs"), site,
    ...approved.flatMap(value => ["--allow-referer", value])], { capture: true });
  // The shell may print setup notices. The packager's last line is the path;
  // validate that result rather than guessing a glob or evaluating its text.
  const bundle = await realpath(output.trim().split(/\r?\n/).at(-1));
  const local = relative(await realpath(context), bundle);
  if (!local.startsWith("spacefast-kandelo-build-") || local.includes(sep)) {
    throw new Error("Packager returned an unexpected bundle directory; nothing published");
  }
  const config = JSON.parse(await readFile(join(bundle, "sf.jsonc"), "utf8"));
  if (config.runtime?.kind !== "functions") throw new Error("Bundle is missing its Functions configuration");
  console.log(`Prepared bundle: ${bundle}`);
  const publish = ["publish", bundle, "--prebuilt", "--space", space, "--wait"];
  if (mode === "prepare") {
    console.log(`Publish this exact bundle: sf ${publish.map(quote).join(" ")}`);
  } else {
    if (mode === "dry-run") publish.push("--dry-run");
    await run("sf", publish);
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(`Spacefast deployment: ${error.message}`);
  process.exitCode = 1;
});
