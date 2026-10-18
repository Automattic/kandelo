import { readFileSync } from "node:fs";

const [modulePath] = process.argv.slice(2);
if (!modulePath || process.argv.length !== 3) {
  throw new Error("usage: node wasm-side-module-c-exports.mjs <side-module.wasm>");
}

const module = new WebAssembly.Module(readFileSync(modulePath));
const required = new Set();
for (const entry of WebAssembly.Module.imports(module)) {
  if (entry.module === "env" && entry.kind === "function" &&
      !entry.name.startsWith("__wpk_fork_")) {
    required.add(entry.name);
  } else if ((entry.module === "GOT.mem" || entry.module === "GOT.func") &&
             entry.kind === "global") {
    required.add(entry.name);
  }
}
for (const name of [...required].sort()) {
  console.log(name);
}
