// Decode the actual modules structurally. A decoder failure must stop the
// build rather than leave a partial inventory behind a successful text filter.
import { readFileSync } from "node:fs";

const [operation, mainPath, sidePath] = process.argv.slice(2);
const decode = path => new WebAssembly.Module(readFileSync(path));
if (operation === "exports") {
  console.log(WebAssembly.Module.exports(decode(mainPath)).map(e => e.name).sort().join("\n"));
} else if (operation === "missing") {
  const main = decode(mainPath), side = decode(sidePath);
  const exported = new Map(WebAssembly.Module.exports(main).map(e => [e.name, e.kind]));
  const self = new Map(WebAssembly.Module.exports(side).map(e => [e.name, e.kind]));
  // The dynamic linker supplies these exact relocation objects. Fork imports
  // instead come from the process activation owner, never the main exports.
  const relocation = new Map([
    ["memory", "memory"], ["__indirect_function_table", "table"],
    ["__stack_pointer", "global"], ["__memory_base", "global"], ["__table_base", "global"],
  ]);
  const abi = readFileSync(new URL("../../../host/src/generated/abi.ts", import.meta.url), "utf8");
  const forkKinds = new Map([
    ["WPK_FORK_EXCEPTION_IMPORT_ACTIVATION", "global"],
    ["WPK_FORK_RESUME_IMPORT_TABLE", "table"],
    ["WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT", "table"],
    ["WPK_FORK_UNWIND_TAG_IMPORT_NAME", "tag"],
  ]);
  const fork = new Map([...abi.matchAll(/^export const (WPK_FORK_[A-Z0-9_]*IMPORT[A-Z0-9_]*) = "(__wpk_fork_[^"]+)" as const;$/gm)]
    .map(match => [match[2], forkKinds.get(match[1]) ?? "function"]));
  if (!fork.size) throw new Error("Missing generated fork import authority");
  const missing = new Set();
  for (const entry of WebAssembly.Module.imports(side)) {
    const { module, name, kind } = entry;
    if (module === "env") {
      if (name.startsWith("__wpk_fork_")) {
        // Each side module receives its own activation bindings, including
        // capabilities unused by main. Match exact generated names and kinds;
        // a private-name prefix or main export is never an allowance.
        if (fork.get(name) !== kind) missing.add(name);
      } else if (relocation.has(name)) {
        if (relocation.get(name) !== kind) missing.add(name);
      } else if (exported.get(name) !== kind && !(kind === "function" && self.get(name) === "function")) missing.add(name);
    } else if (module === "GOT.func" || module === "GOT.mem") {
      const wanted = module === "GOT.func" ? "function" : "global";
      if (kind !== "global" || (exported.get(name) !== wanted && self.get(name) !== wanted)) missing.add(name);
    } else throw new Error(`Unsupported side-module namespace ${module}`);
  }
  if (missing.size) console.log([...missing].sort().join("\n"));
} else throw new Error("Usage: wasm-symbols.mjs exports MAIN | missing MAIN SIDE");
