import {
  readdirSync,
  readFileSync,
} from "node:fs";
import { parse } from "@babel/parser";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(modulePath), "../..");

function walkFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function normalizeBinariesRel(rel) {
  if (!rel.startsWith("programs/")) return rel;
  const tail = rel.slice("programs/".length);
  const first = tail.split("/", 1)[0];
  if (first === "wasm32" || first === "wasm64") return rel;
  return `programs/wasm32/${tail}`;
}

function staticModuleSpecifiers(text, file) {
  const ast = parse(text, {
    sourceType: "unambiguous",
    sourceFilename: file,
    plugins: ["jsx", "typescript", "importAttributes"],
  });
  const specifiers = [];
  const pending = [ast.program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    if (
      (
        node.type === "ImportDeclaration"
        || node.type === "ExportNamedDeclaration"
        || node.type === "ExportAllDeclaration"
      )
      && node.source?.type === "StringLiteral"
    ) {
      specifiers.push(node.source.value);
    } else if (
      node.type === "CallExpression"
      && node.callee?.type === "Import"
      && node.arguments?.length === 1
      && node.arguments[0]?.type === "StringLiteral"
    ) {
      specifiers.push(node.arguments[0].value);
    } else if (
      node.type === "ImportExpression"
      && node.source?.type === "StringLiteral"
    ) {
      specifiers.push(node.source.value);
    } else if (
      node.type === "CallExpression"
      && node.callee?.type === "MemberExpression"
      && node.callee.computed === false
      && node.callee.object?.type === "MetaProperty"
      && node.callee.object.meta?.name === "import"
      && node.callee.object.property?.name === "meta"
      && node.callee.property?.type === "Identifier"
      && node.callee.property.name === "glob"
    ) {
      const patterns = node.arguments?.[0];
      if (patterns?.type === "StringLiteral") {
        specifiers.push(patterns.value);
      } else if (patterns?.type === "ArrayExpression") {
        for (const element of patterns.elements) {
          if (element?.type === "StringLiteral") {
            specifiers.push(element.value);
          }
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) pending.push(child);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  return specifiers;
}

/**
 * Return every concrete package-mirror path authored into the browser graph.
 *
 * Keep this scanner app-local: Vite must be able to load it after the
 * documented app-only dependency install, while root package audits re-export
 * the same implementation instead of maintaining a second parser.
 */
export function browserBinariesImports(repoRoot = defaultRepoRoot) {
  const browserRoot = join(repoRoot, "apps", "browser-demos");
  const imports = new Set();
  const mirrorRoots = [
    join(repoRoot, "local-binaries"),
    join(repoRoot, "binaries"),
  ];

  for (const file of walkFiles(browserRoot)) {
    const text = readFileSync(file, "utf8");
    for (const specifier of staticModuleSpecifiers(text, file)) {
      if (specifier.startsWith("@binaries/")) {
        const rel = specifier.slice("@binaries/".length).split("?", 1)[0];
        imports.add(normalizeBinariesRel(rel));
        continue;
      }

      const pathPart = specifier.split("?", 1)[0];
      if (!pathPart.startsWith(".")) continue;
      const absolute = resolve(dirname(file), pathPart);
      for (const mirrorRoot of mirrorRoots) {
        const rel = relative(mirrorRoot, absolute);
        if (
          rel === ""
          || rel === ".."
          || rel.startsWith(`..${sep}`)
          || isAbsolute(rel)
        ) {
          continue;
        }
        // Relative imports and import.meta.glob() must cross the same package
        // resolver boundary as @binaries. This is especially important for
        // optional globs: Vite follows their mirror symlink directly and would
        // otherwise lose the package identity before its resolve hook runs.
        imports.add(normalizeBinariesRel(rel.split(sep).join("/")));
      }
    }
  }

  return [...imports].sort();
}
