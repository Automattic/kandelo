// Runs every K10 I0 probe on every engine and writes results.json.
//   node collect.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const run = (f) =>
  JSON.parse(execFileSync(process.execPath, [f], { cwd: here, maxBuffer: 64 << 20 }).toString());

const results = [run("run-node.mjs"), ...run("run-browsers.mjs")];
writeFileSync(new URL("results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
console.log("engines:", results.map((e) => `${e.engine} ${e.version ?? ""}`.trim()).join(" | "));
