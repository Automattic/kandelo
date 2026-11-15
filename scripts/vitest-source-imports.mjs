import { createRequire } from "node:module";

// TypeScript is a declared host build dependency, installed before this audit.
const ts = createRequire(new URL("../host/package.json", import.meta.url))("typescript");

// Inspect syntax: import-looking text inside a fixture string is data.
export function importSpecifiers(source) {
  const result = new Set();
  const ast = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const add = node => { if (node && ts.isStringLiteralLike(node)) result.add(node.text); };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isExternalModuleReference(node)) add(node.expression);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
