#!/usr/bin/env node
/**
 * Run a package build command inside a Kandelo machine.
 *
 *   guest-build.ts --kernel <kernel.wasm> --image <build.vfs.zst>
 *     --workspace <dir> [--input <guest>=<host>]... [--env K=V]...
 *     --timeout-ms <n> --source-date-epoch <n> [--log <file>]
 *     -- <argv...>
 *
 * Recipes reach this through scripts/guest-build.sh rather than directly.
 * The process exits with the guest command's status (124 on timeout).
 * See docs/package-management.md, "Building inside Kandelo".
 */
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type GuestBuildInput,
  type GuestBuildRequest,
  runGuestBuild,
} from "../host/src/node-guest-build";

export interface GuestBuildCli {
  kernel: string;
  image: string;
  log?: string;
  request: GuestBuildRequest;
}

function integerFlag(flag: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flag} expects a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/** Parse the command line; throws with the offending flag named. */
export function parseGuestBuildArgs(args: readonly string[]): GuestBuildCli {
  const single = new Map<string, string>();
  const inputs: GuestBuildInput[] = [];
  const env: Record<string, string> = {};
  let argv: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") {
      argv = args.slice(i + 1);
      break;
    }
    if (!flag.startsWith("--")) {
      throw new Error(`expected a flag or -- before the command, got ${JSON.stringify(flag)}`);
    }
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    switch (flag) {
      case "--kernel":
      case "--image":
      case "--workspace":
      case "--timeout-ms":
      case "--source-date-epoch":
      case "--log":
        if (single.has(flag)) throw new Error(`${flag} given twice`);
        single.set(flag, value);
        break;
      case "--input": {
        const eq = value.indexOf("=");
        if (eq <= 0 || eq === value.length - 1) {
          throw new Error(`--input expects <guest>=<host>, got ${JSON.stringify(value)}`);
        }
        inputs.push({ guestPath: value.slice(0, eq), hostPath: value.slice(eq + 1) });
        break;
      }
      case "--env": {
        const eq = value.indexOf("=");
        if (eq <= 0) throw new Error(`--env expects K=V, got ${JSON.stringify(value)}`);
        const key = value.slice(0, eq);
        if (key in env) throw new Error(`--env ${key} given twice`);
        env[key] = value.slice(eq + 1);
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }

  const required = (flag: string): string => {
    const value = single.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  const kernel = required("--kernel");
  const image = required("--image");
  const workspace = required("--workspace");
  const timeoutMs = integerFlag("--timeout-ms", required("--timeout-ms"));
  const sourceDateEpoch = integerFlag("--source-date-epoch", required("--source-date-epoch"));
  if (argv === undefined || argv.length === 0) {
    throw new Error("the guest command must follow --");
  }

  const cli: GuestBuildCli = {
    kernel,
    image,
    request: { workspace, inputs, env, timeoutMs, sourceDateEpoch, argv },
  };
  const log = single.get("--log");
  if (log !== undefined) cli.log = log;
  return cli;
}

async function main(): Promise<number> {
  let cli: GuestBuildCli;
  try {
    cli = parseGuestBuildArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`guest-build: ${(error as Error).message}\n`);
    return 2;
  }
  const logFd = cli.log === undefined ? undefined : openSync(cli.log, "w");
  try {
    const result = await runGuestBuild({
      kernelWasm: new Uint8Array(readFileSync(cli.kernel)),
      image: new Uint8Array(readFileSync(cli.image)),
      request: cli.request,
      log: (chunk) => {
        process.stderr.write(chunk);
        if (logFd !== undefined) writeSync(logFd, chunk);
      },
    });
    if (result.timedOut) {
      process.stderr.write(
        `guest-build: command exceeded ${cli.request.timeoutMs} ms and was stopped\n`,
      );
    }
    return result.exitCode;
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`guest-build: ${(error as Error).stack ?? error}\n`);
      process.exit(1);
    },
  );
}
