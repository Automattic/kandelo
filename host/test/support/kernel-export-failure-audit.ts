import ts from "typescript";

export interface KernelExportFailureCatchAllowance {
  /**
   * Exact class method that deliberately settles uncertain Rust ownership in
   * `finally` before throwing a fatal wrapper.
   */
  readonly owner: string;
  readonly why: string;
}

export interface KernelExportFailureViolation {
  readonly owner: string;
  readonly line: number;
  readonly text: string;
}

export interface KernelExportFailureAuditResult {
  readonly violations: readonly KernelExportFailureViolation[];
  readonly unusedAllowances: readonly KernelExportFailureCatchAllowance[];
  readonly contractErrors: readonly string[];
  readonly exportBearingOwners: readonly string[];
}

type WorkerMethod =
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration;

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

function propertyName(
  name: ts.PropertyName | ts.PrivateIdentifier | undefined,
): string | null {
  if (
    name === undefined
    || !(
      ts.isIdentifier(name)
      || ts.isPrivateIdentifier(name)
      || ts.isStringLiteral(name)
      || ts.isNumericLiteral(name)
    )
  ) {
    return null;
  }
  return name.getText().replace(/^["']|["']$/g, "");
}

function ownerName(method: WorkerMethod): string {
  return ts.isConstructorDeclaration(method)
    ? "CentralizedKernelWorker.constructor"
    : `CentralizedKernelWorker.${propertyName(method.name)}`;
}

function directThisMemberName(expression: ts.Expression): string | null {
  const node = unwrapExpression(expression);
  if (
    !ts.isPropertyAccessExpression(node)
    && !ts.isElementAccessExpression(node)
  ) {
    return null;
  }
  const receiver = unwrapExpression(node.expression);
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return null;
  if (ts.isPropertyAccessExpression(node)) return propertyName(node.name);
  const key = node.argumentExpression
    ? unwrapExpression(node.argumentExpression)
    : undefined;
  return key && (ts.isStringLiteral(key) || ts.isNumericLiteral(key))
    ? key.text
    : null;
}

function thisMethodCallName(call: ts.CallExpression): string | null {
  return directThisMemberName(call.expression);
}

function calledMemberName(call: ts.CallExpression): string | null {
  const callee = unwrapExpression(call.expression);
  if (ts.isPropertyAccessExpression(callee)) return propertyName(callee.name);
  if (!ts.isElementAccessExpression(callee)) return null;
  const key = callee.argumentExpression
    ? unwrapExpression(callee.argumentExpression)
    : undefined;
  return key && (ts.isStringLiteral(key) || ts.isNumericLiteral(key))
    ? key.text
    : null;
}

function containsExportsSelection(expression: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (
        ts.isPropertyAccessExpression(node)
        || ts.isElementAccessExpression(node)
      )
      && (
        ts.isPropertyAccessExpression(node)
          ? propertyName(node.name) === "exports"
          : node.argumentExpression !== undefined
            && ts.isStringLiteral(
              unwrapExpression(node.argumentExpression),
            )
            && (
              unwrapExpression(node.argumentExpression) as ts.StringLiteral
            ).text === "exports"
      )
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function hasKernelFacadeReceiver(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current)
    || ts.isElementAccessExpression(current)
  ) {
    const direct = directThisMemberName(current);
    if (direct === "#kernel") return true;
    current = unwrapExpression(current.expression);
  }
  return false;
}

function isDirectKernelExportCall(
  call: ts.CallExpression,
  exportAliases: ReadonlySet<string> = new Set(),
): boolean {
  if (thisMethodCallName(call) === "#invokeEntryScratchExport") return true;
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee) && exportAliases.has(callee.text)) return true;
  return containsExportsSelection(callee)
    || hasKernelFacadeReceiver(callee);
}

function kernelExportCallableAliases(root: ts.Node): Set<string> {
  const aliases = new Set<string>();
  const candidates: Array<{
    readonly name: string;
    readonly initializer: ts.Expression;
  }> = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && node.initializer !== undefined
    ) {
      const names: string[] = [];
      const collectBindingNames = (binding: ts.BindingName): void => {
        if (ts.isIdentifier(binding)) {
          names.push(binding.text);
          return;
        }
        for (const element of binding.elements) {
          if (!ts.isOmittedExpression(element)) {
            collectBindingNames(element.name);
          }
        }
      };
      collectBindingNames(node.name);
      for (const name of names) {
        candidates.push({
          name,
          initializer: unwrapExpression(node.initializer),
        });
      }
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(unwrapExpression(node.left))
    ) {
      candidates.push({
        name: (unwrapExpression(node.left) as ts.Identifier).text,
        initializer: unwrapExpression(node.right),
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(root);

  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, initializer } of candidates) {
      if (aliases.has(name)) continue;
      if (
        containsExportsSelection(initializer)
        || hasKernelFacadeReceiver(initializer)
        || (() => {
          let current = initializer;
          while (
            ts.isPropertyAccessExpression(current)
            || ts.isElementAccessExpression(current)
          ) {
            current = unwrapExpression(current.expression);
          }
          return ts.isIdentifier(current) && aliases.has(current.text);
        })()
      ) {
        aliases.add(name);
        changed = true;
      }
    }
  }
  return aliases;
}

const SYNCHRONOUS_CALLBACK_CALLS = new Set([
  "#invokeSharedMmapHostOperation",
  "#runOrDeferChannelKernelEntry",
  "#runOrDeferKernelEntry",
  "#runOrDeferPendingSpawnCompletionKernelEntry",
  "withLease",
]);

/**
 * Visit only code that can run before the containing call returns.
 *
 * Timer, Promise, network, and event callbacks are stored host work: a catch
 * around their registration cannot receive a later export unwind. Inline
 * scratch leases and entry ingresses are synchronous when admitted, so their
 * callbacks remain part of the catchable call graph.
 */
function visitSynchronousCalls(
  root: ts.Node,
  visitor: (call: ts.CallExpression) => void,
): void {
  const visit = (node: ts.Node, insideSynchronousClosure: boolean): void => {
    if (
      ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
      || ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
    ) {
      if (insideSynchronousClosure && node.body) {
        visit(node.body, true);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      visitor(node);
      visit(node.expression, insideSynchronousClosure);
      const callbackIsSynchronous = SYNCHRONOUS_CALLBACK_CALLS.has(
        thisMethodCallName(node) ?? calledMemberName(node) ?? "",
      );
      for (const argument of node.arguments) {
        if (
          ts.isArrowFunction(argument)
          || ts.isFunctionExpression(argument)
        ) {
          if (callbackIsSynchronous || insideSynchronousClosure) {
            visit(argument.body, true);
          }
        } else {
          visit(argument, insideSynchronousClosure);
        }
      }
      return;
    }
    ts.forEachChild(node, (child) =>
      visit(child, insideSynchronousClosure)
    );
  };
  visit(root, false);
}

function firstStatementRethrowsBrand(
  clause: ts.CatchClause,
): boolean {
  const binding = clause.variableDeclaration?.name;
  if (!binding || !ts.isIdentifier(binding)) return false;
  const statement = clause.block.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return false;
  const expression = unwrapExpression(statement.expression);
  if (!ts.isCallExpression(expression)) return false;
  if (thisMethodCallName(expression) !== "#rethrowKernelEntryFatal") {
    return false;
  }
  const argument = expression.arguments[0];
  return Boolean(
    argument
    && ts.isIdentifier(unwrapExpression(argument))
    && (unwrapExpression(argument) as ts.Identifier).text === binding.text,
  );
}

function firstStatementDefersBrandedFailure(
  clause: ts.CatchClause,
): boolean {
  const binding = clause.variableDeclaration?.name;
  if (!binding || !ts.isIdentifier(binding)) return false;
  const statement = clause.block.statements[0];
  if (!statement || !ts.isIfStatement(statement)) return false;
  const condition = unwrapExpression(statement.expression);
  if (!ts.isCallExpression(condition)) return false;
  const callee = unwrapExpression(condition.expression);
  const argument = condition.arguments[0];
  return ts.isIdentifier(callee)
    && callee.text === "isKernelExportFailure"
    && Boolean(
      argument
      && ts.isIdentifier(unwrapExpression(argument))
      && (unwrapExpression(argument) as ts.Identifier).text === binding.text,
    );
}

/**
 * Find synchronous catches that can receive a gate-branded Wasm export unwind.
 *
 * WHY: the gate's fatal observer runs only after its lexical entry is revoked.
 * Checking a worker-wide fatal field inside that same scope can therefore turn
 * a real Wasm trap into EIO, a fallback value, or a retry. This audit follows
 * the worker's private call graph, so a newly introduced wrapper inherits the
 * same fail-stop contract without a syscall-name allowlist.
 */
export function auditKernelExportFailureCatches(
  sourceText: string,
  allowances: readonly KernelExportFailureCatchAllowance[] = [],
): KernelExportFailureAuditResult {
  const source = ts.createSourceFile(
    "/kernel-worker.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const worker = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement)
      && statement.name?.text === "CentralizedKernelWorker",
  );
  if (!worker) {
    throw new Error("CentralizedKernelWorker declaration was not found");
  }

  const methods = new Map<string, WorkerMethod>();
  for (const member of worker.members) {
    if (
      !ts.isMethodDeclaration(member)
      && !ts.isConstructorDeclaration(member)
    ) {
      continue;
    }
    const name = ts.isConstructorDeclaration(member)
      ? "constructor"
      : propertyName(member.name);
    if (name !== null) methods.set(name, member);
  }

  const directExportMethods = new Set<string>();
  const callsByMethod = new Map<string, Set<string>>();
  const aliasesByMethod = new Map<string, ReadonlySet<string>>();
  for (const [name, method] of methods) {
    const calls = new Set<string>();
    const exportAliases = method.body
      ? kernelExportCallableAliases(method.body)
      : new Set<string>();
    aliasesByMethod.set(name, exportAliases);
    if (method.body) {
      visitSynchronousCalls(method.body, (call) => {
        if (isDirectKernelExportCall(call, exportAliases)) {
          directExportMethods.add(name);
        }
        const target = thisMethodCallName(call);
        if (target !== null) calls.add(target);
      });
    }
    callsByMethod.set(name, calls);
  }

  const exportBearingMethods = new Set(directExportMethods);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, calls] of callsByMethod) {
      if (exportBearingMethods.has(name)) continue;
      if ([...calls].some((call) => exportBearingMethods.has(call))) {
        exportBearingMethods.add(name);
        changed = true;
      }
    }
  }

  const allowanceByOwner = new Map<
    string,
    KernelExportFailureCatchAllowance
  >();
  const contractErrors: string[] = [];
  for (const allowance of allowances) {
    if (allowance.owner.trim() === "") {
      contractErrors.push("kernel-export catch allowance owner is empty");
      continue;
    }
    if (allowance.why.trim() === "") {
      contractErrors.push(
        `kernel-export catch allowance ${allowance.owner} has an empty WHY`,
      );
    }
    if (allowanceByOwner.has(allowance.owner)) {
      contractErrors.push(
        `duplicate kernel-export catch allowance: ${allowance.owner}`,
      );
      continue;
    }
    allowanceByOwner.set(allowance.owner, allowance);
  }
  const allowanceUseCounts = new Map<string, number>();
  const violations: KernelExportFailureViolation[] = [];

  const tryCanReceiveExportFailure = (
    block: ts.Block,
    exportAliases: ReadonlySet<string>,
  ): boolean => {
    let found = false;
    visitSynchronousCalls(block, (node) => {
      if (found) return;
      if (isDirectKernelExportCall(node, exportAliases)) {
        found = true;
        return;
      }
      const target = thisMethodCallName(node);
      if (target !== null && exportBearingMethods.has(target)) {
        found = true;
      }
    });
    return found;
  };

  for (const method of methods.values()) {
    const owner = ownerName(method);
    const methodName = ts.isConstructorDeclaration(method)
      ? "constructor"
      : propertyName(method.name)!;
    const exportAliases = aliasesByMethod.get(methodName) ?? new Set();
    const inspect = (node: ts.Node): void => {
      if (
        ts.isCatchClause(node)
        && tryCanReceiveExportFailure(
          node.parent.tryBlock,
          exportAliases,
        )
      ) {
        if (firstStatementRethrowsBrand(node)) {
          ts.forEachChild(node, inspect);
          return;
        }
        if (
          firstStatementDefersBrandedFailure(node)
          && allowanceByOwner.has(owner)
        ) {
          allowanceUseCounts.set(
            owner,
            (allowanceUseCounts.get(owner) ?? 0) + 1,
          );
          ts.forEachChild(node, inspect);
          return;
        }
        violations.push({
          owner,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line
            + 1,
          text: node.getText(source).replace(/\s+/g, " ").slice(0, 240),
        });
      }
      ts.forEachChild(node, inspect);
    };
    if (method.body) inspect(method.body);
  }

  for (const owner of allowanceByOwner.keys()) {
    const uses = allowanceUseCounts.get(owner) ?? 0;
    if (uses > 1) {
      contractErrors.push(
        `kernel-export catch allowance ${owner} matched ${uses} catches; `
        + "each allowance must identify exactly one settlement catch",
      );
    }
  }

  return {
    violations,
    unusedAllowances: allowances.filter(
      ({ owner }) => (allowanceUseCounts.get(owner) ?? 0) === 0,
    ),
    contractErrors,
    exportBearingOwners: [...exportBearingMethods]
      .map((name) => `CentralizedKernelWorker.${name}`)
      .sort(),
  };
}

export function formatKernelExportFailureAudit(
  result: KernelExportFailureAuditResult,
): string[] {
  return [
    ...result.violations.map(
      ({ owner, line, text }) =>
        `unguarded kernel-export catch ${owner}:${line}: ${text}`,
    ),
    ...result.unusedAllowances.map(
      ({ owner }) => `unused kernel-export catch allowance: ${owner}`,
    ),
    ...result.contractErrors,
  ];
}
