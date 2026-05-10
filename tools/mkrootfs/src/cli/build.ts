// `mkrootfs build` — wires the buildImage() library function into the CLI.
//
// Arg-parsing supports `--key value` and `--key=value` for long flags and
// `-o <path>`. Unknown flags abort with exit 2. Builder errors (manifest
// problems, missing source files, archive collisions) surface as a single
// `mkrootfs build: <message>\n` line on stderr with no stack trace; truly
// unexpected exceptions are re-thrown so Node prints a real backtrace.

import { writeFileSync } from "node:fs";
import { buildImage } from "../builder.ts";

const SUBCOMMAND_USAGE = `Usage: mkrootfs build <MANIFEST> <sourceTree> -o <output.vfs> [options]

Required:
  <MANIFEST>             path to the manifest file
  <sourceTree>           on-disk rootfs source directory (implicit src=)
  -o, --output <path>    write the VFS image to this path

Options:
  --repo-root <path>     root for resolving relative src= and url= paths (default: cwd)
  --quiet                suppress non-fatal override warnings
  --help                 print this message
`;

interface ParsedArgs {
  manifest: string;
  sourceTree: string;
  output: string;
  repoRoot?: string;
  quiet: boolean;
}

class UsageError extends Error {}

function parseArgs(args: string[]): ParsedArgs | "help" {
  const positional: string[] = [];
  let output: string | undefined;
  let repoRoot: string | undefined;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return "help";
    if (a === "--quiet") {
      quiet = true;
      continue;
    }
    if (a === "-o" || a === "--output") {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`flag "${a}" requires a value`);
      output = v;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      const key = a.slice(0, eq);
      const value = a.slice(eq + 1);
      if (key === "--output" || key === "-o") {
        output = value;
        continue;
      }
      if (key === "--repo-root") {
        repoRoot = value;
        continue;
      }
      throw new UsageError(`unknown flag "${key}"`);
    }
    if (a === "--repo-root") {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`flag "${a}" requires a value`);
      repoRoot = v;
      continue;
    }
    if (a.startsWith("-")) {
      throw new UsageError(`unknown flag "${a}"`);
    }
    positional.push(a);
  }

  if (positional.length !== 2) {
    throw new UsageError(
      `expected 2 positional args (MANIFEST, sourceTree), got ${positional.length}`,
    );
  }
  if (!output) {
    throw new UsageError(`missing required -o/--output <path>`);
  }
  return {
    manifest: positional[0],
    sourceTree: positional[1],
    output,
    repoRoot,
    quiet,
  };
}

export async function runBuild(args: string[]): Promise<number> {
  let parsed: ParsedArgs | "help";
  try {
    parsed = parseArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`mkrootfs build: ${e.message}\n`);
      process.stderr.write(SUBCOMMAND_USAGE);
      return 2;
    }
    throw e;
  }
  if (parsed === "help") {
    process.stdout.write(SUBCOMMAND_USAGE);
    return 0;
  }

  const onWarn = parsed.quiet
    ? () => {}
    : (msg: string) => process.stderr.write(`mkrootfs: warning: ${msg}\n`);

  let image: Uint8Array;
  try {
    image = await buildImage({
      manifest: parsed.manifest,
      sourceTree: parsed.sourceTree,
      repoRoot: parsed.repoRoot ?? process.cwd(),
      onWarn,
    });
  } catch (e) {
    // Node fs / parser / validator errors carry useful messages but the stack
    // trace is noise for end users — print message-only.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mkrootfs build: ${msg}\n`);
    return 1;
  }

  try {
    writeFileSync(parsed.output, image);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mkrootfs build: failed to write ${parsed.output}: ${msg}\n`);
    return 1;
  }

  return 0;
}
