// Exact native link requirements of this build, before fork instrumentation.
// These are real symbols for the executable linker to retain/export, not host
// imports or substitute implementations. Own-library symbols stay local.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const bytes = readFileSync(process.argv[2]);
const module = new WebAssembly.Module(bytes);
const owned = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
const names = [...new Set(WebAssembly.Module.imports(module)
  .filter(entry => !owned.has(entry.name) &&
    ((entry.module === 'env' && entry.kind === 'function') || entry.module === 'GOT.func' || entry.module === 'GOT.mem'))
  .map(entry => entry.name))].sort();
for (const name of names) {
  if (!/^[A-Za-z0-9_.$]+$/.test(name)) throw new Error(`Invalid native dependency: ${name}`);
}
writeFileSync(process.argv[3], JSON.stringify({
  schema: 1, rawLibrarySha256: createHash('sha256').update(bytes).digest('hex'),
  mainExecutableExports: names,
  programExtensionImports: WebAssembly.Module.imports(module).filter(entry =>
    !['env', 'GOT.func', 'GOT.mem'].includes(entry.module)),
}, null, 2) + '\n');
