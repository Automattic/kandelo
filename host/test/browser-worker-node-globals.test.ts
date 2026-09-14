import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The browser kernel worker must not evaluate a Node global at module load.
 *
 * # The failure this guards
 *
 * `platform/native-metadata.ts` computed `process.platform === "win32"` into a
 * module-scope `const`. That module is reachable from the browser worker's
 * value-import graph — `browser-kernel-worker-entry` -> `process-lifecycle` ->
 * `vfs/index` -> `vfs/host-fs` -> here — so importing it in a worker threw
 * `ReferenceError: process is not defined` while the module was still being
 * evaluated. The kernel never finished initialising, and every browser test
 * that boots a machine timed out: 103 of 184 fast Playwright specs failed, 88
 * of them on that one error, with no lane owning the defect.
 *
 * A unit test cannot catch that, because the throw happens in a worker in a
 * browser. A type check cannot either: `process` is genuinely declared, since
 * `@types/node` is in scope for a codebase that also runs on Node. What makes
 * it findable without a browser is that the import graph and the evaluation
 * order are both static.
 *
 * # Why only the worker entry
 *
 * Scoped deliberately to `browser-kernel-worker-entry.ts`, which is where the
 * breakage was proven. A bundler may `define` some of these for main-thread
 * code, so asserting the same of every browser entry would risk failing on
 * code that genuinely works. Widen this only with evidence, not on principle.
 *
 * # What counts as "at module load"
 *
 * Anything evaluated when the module is first imported: top-level statements,
 * initializers of module-scope bindings, and static class members. Function
 * and method bodies are not — they run when called, by which time a host that
 * has `process` may legitimately be the caller. `typeof process` is the
 * guarded form and is always allowed; it is the idiom the codebase already
 * uses in `kernel-worker.ts`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");
const ENTRY = join(SRC, "browser-kernel-worker-entry.ts");

/** Globals a browser worker does not have. */
const NODE_ONLY_GLOBALS = new Set([
  "process",
  "require",
  "__dirname",
  "__filename",
  "Buffer",
  "global",
]);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(fromFile), spec));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every module the entry pulls in for its VALUE. `import type` is erased
 * before the bundle exists, so a type-only edge cannot make anything evaluate.
 */
function valueImportGraph(entry: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    order.push(file);
    const source = parse(file);
    for (const statement of source.statements) {
      let spec: ts.Expression | undefined;
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) continue;
        spec = statement.moduleSpecifier;
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly || statement.moduleSpecifier === undefined) continue;
        spec = statement.moduleSpecifier;
      }
      if (spec === undefined || !ts.isStringLiteral(spec)) continue;
      const resolved = resolveSpecifier(file, spec.text);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return order;
}

interface Offence {
  readonly where: string;
  readonly global: string;
  readonly text: string;
}

/** True for a node whose body runs when CALLED, not when the module loads. */
function isDeferredBody(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    // An instance field initializer runs at construction, not at import.
    (ts.isPropertyDeclaration(node) &&
      !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static))
  );
}

/**
 * Does this subtree contain `typeof <name> <op> "undefined"` with the given
 * polarity? `wantDefined` asks for the `!==` spelling — true means "defined" —
 * and its negation asks for the `===` spelling.
 */
function testsDefinedness(
  node: ts.Node,
  name: string,
  wantDefined: boolean,
): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(n)) {
      const kind = n.operatorToken.kind;
      const isNotEqual =
        kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsToken;
      const isEqual =
        kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        kind === ts.SyntaxKind.EqualsEqualsToken;
      if (isNotEqual === wantDefined && (isNotEqual || isEqual)) {
        const sides = [
          [n.left, n.right],
          [n.right, n.left],
        ] as const;
        for (const [maybeTypeOf, maybeLiteral] of sides) {
          if (
            ts.isTypeOfExpression(maybeTypeOf) &&
            ts.isIdentifier(maybeTypeOf.expression) &&
            maybeTypeOf.expression.text === name &&
            ts.isStringLiteral(maybeLiteral) &&
            maybeLiteral.text === "undefined"
          ) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * True when a use of `name` cannot be reached unless `name` exists.
 *
 * The polarity is the whole point and is easy to get wrong:
 * `typeof p !== "undefined" && p.x` is safe, because the right side runs only
 * when the test passed. `typeof p !== "undefined" || p.x` is NOT — `||`
 * evaluates its right side exactly when the left is false, which here means
 * `p` is undefined. So `&&` wants the "is defined" spelling and `||` wants the
 * "is undefined" spelling, and the same asymmetry decides which branch of a
 * conditional is protected.
 */
function isShortCircuitGuarded(node: ts.Node, name: string): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isBinaryExpression(parent) && parent.right === child) {
      const kind = parent.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        testsDefinedness(parent.left, name, true)
      ) {
        return true;
      }
      if (
        kind === ts.SyntaxKind.BarBarToken &&
        testsDefinedness(parent.left, name, false)
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(parent)) {
      if (
        parent.whenTrue === child &&
        testsDefinedness(parent.condition, name, true)
      ) {
        return true;
      }
      if (
        parent.whenFalse === child &&
        testsDefinedness(parent.condition, name, false)
      ) {
        return true;
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function offencesIn(file: string): Offence[] {
  const source = parse(file);
  const found: Offence[] = [];
  const visit = (node: ts.Node): void => {
    if (isDeferredBody(node)) return;
    if (ts.isIdentifier(node) && NODE_ONLY_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const guarded = parent !== undefined && ts.isTypeOfExpression(parent);
      // A property NAME (`foo.process`) or a declaration of the same spelling
      // is not a reference to the global.
      const isPropertyName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node) ||
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent));
      if (!guarded && !isPropertyName && !isShortCircuitGuarded(node, node.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({
          where: `${relative(SRC, file)}:${line + 1}`,
          global: node.text,
          text: node.parent.getText(source).split("\n")[0].slice(0, 100),
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) visit(statement);
  return found;
}

describe("browser kernel worker import graph", () => {
  it("pulls in a real graph, so a green result means something was checked", () => {
    const graph = valueImportGraph(ENTRY);
    // Guards the guard: a resolver that silently resolved nothing would make
    // every assertion below vacuously true.
    expect(graph.length).toBeGreaterThan(50);
    expect(graph).toContain(join(SRC, "vfs/host-fs.ts"));
  });

  it("evaluates no Node-only global when its modules load", () => {
    const offences = valueImportGraph(ENTRY).flatMap(offencesIn);
    expect(
      offences.map((o) => `${o.where} [${o.global}] ${o.text}`),
    ).toEqual([]);
  });
});
