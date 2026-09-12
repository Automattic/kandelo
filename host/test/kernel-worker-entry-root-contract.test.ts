import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENTRY_SOURCES = [
  "../src/browser-kernel-worker-entry.ts",
  "../src/node-kernel-worker-entry.ts",
] as const;

const REQUIRED_KERNEL_CALLBACKS = [
  "onClone",
  "onExec",
  "onExit",
  "onFork",
  "onKernelFatal",
  "onProcessMemoryTarget",
  "onResolveSpawn",
  "onSpawn",
  "onThreadExit",
] as const;

// These names denote raw Wasm authority or mutable queues whose invariants
// belong to CentralizedKernelWorker. An entry adapter may invoke the reviewed
// public API, but must not recover these members through a structural cast.
const FORBIDDEN_WORKER_MEMBERS = new Set([
  "kernel",
  "kernelEntryGate",
  "kernelInstance",
  "kernelMemory",
  "largeSpawnScratchInUse",
  "largeTransferScratchInUse",
  "pendingPipeReaders",
  "pendingPipeWriters",
  "processes",
  "retrySyscall",
  "scheduleWakeBlockedRetries",
  "scratchOffset",
  "scratchRegion",
  "stdinBuffers",
  "stdinFinite",
  "tcpScratchRegion",
]);

type Finding = {
  readonly line: number;
  readonly message: string;
};

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isKernelWorker(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) && unwrapped.text === "kernelWorker";
}

function memberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  const argument = expression.argumentExpression === undefined
    ? undefined
    : unwrapExpression(expression.argumentExpression);
  return argument !== undefined && (
    ts.isStringLiteral(argument)
    || ts.isNumericLiteral(argument)
  )
    ? argument.text
    : null;
}

function auditEntrySource(sourceText: string, fileName: string): Finding[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const report = (node: ts.Node, message: string): void => {
    findings.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      message,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      && isKernelWorker(node.expression)
    ) {
      report(
        node,
        "kernelWorker must not be structurally cast to recover hidden authority",
      );
    }

    if (
      ts.isVariableDeclaration(node)
      && node.initializer !== undefined
      && isKernelWorker(node.initializer)
      && (!ts.isIdentifier(node.name) || node.name.text !== "kernelWorker")
    ) {
      report(
        node,
        "kernelWorker must not be aliased outside its reviewed public surface",
      );
    }

    if (
      (ts.isPropertyAccessExpression(node)
        || ts.isElementAccessExpression(node))
    ) {
      const name = memberName(node);
      if (name === "exports") {
        report(
          node,
          "worker entry roots must not invoke WebAssembly exports directly",
        );
      }
      if (isKernelWorker(node.expression)) {
        if (name === null) {
          report(
            node,
            "kernelWorker members must not use computed dynamic access",
          );
        } else if (FORBIDDEN_WORKER_MEMBERS.has(name)) {
          report(
            node,
            `kernelWorker.${name} bypasses its reviewed public ingress`,
          );
        }
      }
    }

    if (
      ts.isCallExpression(node)
      && node.arguments.some((argument) => isKernelWorker(argument))
    ) {
      report(
        node,
        "kernelWorker must not escape as an argument to an unreviewed helper",
      );
    }

    if (
      ts.isReturnStatement(node)
      && node.expression !== undefined
      && isKernelWorker(node.expression)
    ) {
      report(node, "kernelWorker must not escape from a worker entry root");
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/**
 * The callback names `processLifecycleKernelCallbacks()` returns.
 *
 * Both entries spread that one record, so the parity this file asserts is
 * now structurally guaranteed for the shared half — which is stronger than
 * comparing two hand-written copies. What is still worth asserting is that
 * the record reaching the kernel is complete, and that each entry actually
 * takes it.
 */
function sharedLifecycleCallbackNames(): string[] {
  const url = new URL("../src/process-lifecycle.ts", import.meta.url);
  const source = ts.createSourceFile(
    url.pathname,
    readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === "processLifecycleKernelCallbacks"
    ) {
      const ret = node.body?.statements.find(ts.isReturnStatement);
      const literal = ret?.expression;
      if (literal !== undefined && ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          const name = property.name;
          if (name !== undefined && ts.isIdentifier(name)) names.push(name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(
    names,
    "process-lifecycle.ts must declare processLifecycleKernelCallbacks",
  ).not.toHaveLength(0);
  return names;
}

function kernelCallbackNames(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const callbackSets: string[][] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(unwrapExpression(node.expression))
      && unwrapExpression(node.expression).text === "CentralizedKernelWorker"
    ) {
      const callbacks = node.arguments?.[2];
      if (callbacks !== undefined && ts.isObjectLiteralExpression(callbacks)) {
        callbackSets.push(callbacks.properties.flatMap((property) => {
          // The process-lifecycle callbacks are one record now, spread in by
          // both entries. Resolve the spread to the names that record
          // actually declares, so this stays a check on which callbacks reach
          // the kernel rather than on where they are typed.
          if (
            ts.isSpreadAssignment(property)
            && ts.isCallExpression(property.expression)
            && ts.isIdentifier(property.expression.expression)
            && property.expression.expression.text
              === "processLifecycleKernelCallbacks"
          ) {
            return sharedLifecycleCallbackNames();
          }
          if (
            !ts.isPropertyAssignment(property)
            && !ts.isShorthandPropertyAssignment(property)
            && !ts.isMethodDeclaration(property)
          ) {
            return [];
          }
          const name = property.name;
          if (
            ts.isIdentifier(name)
            || ts.isStringLiteral(name)
            || ts.isNumericLiteral(name)
          ) {
            return [name.text];
          }
          return [];
        }).sort());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  expect(
    callbackSets,
    `${fileName} must construct exactly one CentralizedKernelWorker`,
  ).toHaveLength(1);
  return callbackSets[0]!;
}

describe("kernel worker entry-root authority contract", () => {
  it.each(ENTRY_SOURCES)(
    "%s uses only the reviewed worker surface",
    (relativePath) => {
      const url = new URL(relativePath, import.meta.url);
      const sourceText = readFileSync(url, "utf8");
      const findings = auditEntrySource(sourceText, url.pathname);

      expect(findings).toEqual([]);
    },
  );

  it("keeps the Node and browser kernel callback roots in parity", () => {
    const callbackSets = ENTRY_SOURCES.map((relativePath) => {
      const url = new URL(relativePath, import.meta.url);
      const sourceText = readFileSync(url, "utf8");
      return kernelCallbackNames(sourceText, url.pathname);
    });

    expect(callbackSets[0]).toEqual([...REQUIRED_KERNEL_CALLBACKS]);
    expect(callbackSets[1]).toEqual(callbackSets[0]);

    // Sharing the record must not read as an entry losing its wiring.
    for (const relativePath of ENTRY_SOURCES) {
      const url = new URL(relativePath, import.meta.url);
      expect(
        readFileSync(url, "utf8"),
        `${relativePath} must spread the shared callback record`,
      ).toContain("...processLifecycleKernelCallbacks(),");
    }
  });
});
