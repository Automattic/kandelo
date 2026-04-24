#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "index.ts");
const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
