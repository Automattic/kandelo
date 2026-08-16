// Compare two wasm binaries section by section and print one TSV row.
//
// Columns: label, file bytes before and after with the delta and percentage,
// code-section bytes before and after with the delta and percentage, then the
// defined-function count before and after. Every section whose size changed
// follows on its own indented line.
//
// The section framing is parsed here rather than shelled out to wasm-objdump:
// Homebrew wabt cannot parse the ABI 43 reference types and reports errors
// while still printing sizes.
//
// Usage: node scripts/wasm-section-sizes.mjs <label> <before.wasm> <after.wasm>
import { readFileSync } from "node:fs";

const NAMES = [
  "Custom", "Type", "Import", "Function", "Table", "Memory", "Global",
  "Export", "Start", "Elem", "Code", "Data", "DataCount", "Tag",
];

function leb(buf, at) {
  let value = 0, shift = 0, index = at;
  for (;;) {
    const byte = buf[index++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, index];
    shift += 7;
  }
}

function sections(buf) {
  const out = [];
  let at = 8;
  while (at < buf.length) {
    const id = buf[at++];
    const [size, body] = leb(buf, at);
    let name = NAMES[id] ?? `Unknown(${id})`;
    if (id === 0) {
      const [len, start] = leb(buf, body);
      name = `Custom:${buf.toString("utf8", start, start + len)}`;
    }
    out.push([name, size]);
    at = body + size;
  }
  return out;
}

function count(buf, id) {
  for (let at = 8; at < buf.length; ) {
    const kind = buf[at++];
    const [size, body] = leb(buf, at);
    if (kind === id) return leb(buf, body)[0];
    at = body + size;
  }
  return 0;
}

const [label, rawPath, instPath] = process.argv.slice(2);
const raw = readFileSync(rawPath);
const inst = readFileSync(instPath);
const rawSections = new Map(sections(raw));
const instSections = new Map(sections(inst));
const rawCode = rawSections.get("Code") ?? 0;
const instCode = instSections.get("Code") ?? 0;

const pct = (delta, base) => (base === 0 ? "n/a" : ((delta / base) * 100).toFixed(1));

console.log(
  [
    label,
    raw.length, inst.length, inst.length - raw.length, pct(inst.length - raw.length, raw.length),
    rawCode, instCode, instCode - rawCode, pct(instCode - rawCode, rawCode),
    count(raw, 3), count(inst, 3),
  ].join("\t"),
);

for (const name of new Set([...rawSections.keys(), ...instSections.keys()])) {
  const before = rawSections.get(name) ?? 0;
  const after = instSections.get(name) ?? 0;
  if (before !== after) console.log(`  ${name}\t${before}\t${after}\t${after - before}`);
}
