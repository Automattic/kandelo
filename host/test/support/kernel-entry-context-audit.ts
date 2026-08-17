import ts from "typescript";

export type KernelEntryContextViolationKind =
  | "async-detached-effect"
  | "async-export-without-ingress"
  | "bare-entry-selector"
  | "context-alias"
  | "context-async-capture"
  | "context-cross-ingress-capture"
  | "context-detached-capture"
  | "context-return"
  | "context-storage"
  | "dynamic-entry-method-dispatch"
  | "direct-kernel-instance-exports"
  | "direct-eval-in-entry-graph"
  | "export-call-without-entry-channel"
  | "export-from-detached-effect"
  | "host-effect-in-scoped-graph"
  | "implicit-arguments-entry-authority"
  | "indirect-entry-authority"
  | "legacy-detached-operation"
  | "missing-explicit-entry"
  | "mutable-entry-method-dispatch"
  | "nonlexical-detached-effect"
  | "nonlexical-entry-operation"
  | "protocol-effect-from-observer"
  | "scoped-method-async"
  | "transaction-continuation-without-channel-ingress";

export interface KernelEntryContextViolation {
  readonly kind: KernelEntryContextViolationKind;
  readonly owner: string;
  readonly line: number;
  readonly text: string;
}

interface MethodCall {
  readonly callee: string;
  readonly node: ts.CallExpression;
  readonly phase: ExecutionPhase;
}

type ExecutionPhase =
  | "active"
  | "async-fresh"
  | "detached-observer"
  | "detached-protocol"
  | "detached-transaction-start"
  | "serialized-host"
  | "transaction-continuation";

type DetachedEffectKind = "observer" | "protocol" | "transaction-start";

interface HostEffect {
  readonly node: ts.Node;
  readonly description: string;
}

interface IndirectMethodReference {
  readonly method: string;
  readonly node: ts.PropertyAccessExpression | ts.ElementAccessExpression;
}

interface DynamicThisDispatch {
  readonly node: ts.CallExpression;
  readonly phase: ExecutionPhase;
}

interface ScopeScan {
  readonly owner: string;
  readonly contextName: string | null;
  readonly contextSymbol: ts.Symbol | null;
  readonly calls: MethodCall[];
  readonly directEvalCalls: ts.CallExpression[];
  readonly dynamicThisDispatches: DynamicThisDispatch[];
  readonly hostEffects: HostEffect[];
  readonly indirectMethodReferences: IndirectMethodReference[];
}

interface MethodInfo extends ScopeScan {
  readonly node: ts.MethodDeclaration | ts.ConstructorDeclaration;
  readonly contextParameterIndex: number | null;
  readonly directlyExportBearing: boolean;
}

const ROOT_INGRESS_METHODS = new Map([
  ["#runImmediateKernelEntry", 1],
  ["#runOrDeferKernelEntry", 1],
  ["#runOrDeferChannelKernelEntry", 2],
]);
const ENTRY_SELECTORS = new Set([
  "#kernelInstanceForEntry",
  "#kernelInstanceIfAvailableForEntry",
]);
const ASYNC_GLOBAL_CALLBACK_POSITIONS = new Map<string, readonly number[]>([
  ["queueMicrotask", [0]],
  ["setImmediate", [0]],
  ["setInterval", [0]],
  ["setTimeout", [0]],
]);
const ASYNC_METHOD_CALLBACK_POSITIONS = new Map<
  string,
  readonly number[]
>([
  ["#continuePromise", [1, 2]],
  ["#continueWaitAsyncListenerRoot", [2]],
  ["#registerImmediate", [0]],
  ["#registerInterval", [0]],
  ["#registerTimeout", [0]],
  ["#scheduleImmediateListenerRoot", [1]],
  ["#scheduleMicrotaskListenerRoot", [1]],
]);
const ASYNC_MEMBER_CALLBACK_POSITIONS = new Map<
  string,
  readonly number[]
>([
  ["addEventListener", [1]],
  ["catch", [0]],
  ["finally", [0]],
  ["on", [1]],
  ["once", [1]],
  ["then", [0, 1]],
]);
const PROMISE_CONTINUATION_CALLS = new Set(["catch", "finally", "then"]);
const ASYNC_CALLBACK_OBJECT_CALLS = new Map([
  [
    "bindUdp",
    new Map<number, ReadonlySet<string>>([
      [3, new Set(["receive"])],
    ]),
  ],
  [
    "listenTcp",
    new Map<number, ReadonlySet<string>>([
      [3, new Set(["accept"])],
    ]),
  ],
]);
const ASYNC_CONSTRUCTOR_CALLBACK_OBJECTS = new Map([
  [
    "WasmPosixKernel",
    new Map<number, ReadonlySet<string>>([
      [
        2,
        new Set([
          "getKmsCanvas",
          "getProcessMemory",
          "markKmsCanvasGlOwned",
          "onAlarm",
          "onExec",
          "onMapHostAnonymous",
          "onMapHostFile",
          "onMremapHostFile",
          "onNetConnect",
          "onNetListen",
          "onRandom",
          "onSendHttp",
          "onShmAttach",
          "onShmCreate",
          "onShmDetach",
          "onShmRemove",
          "onStderr",
          "onStdin",
          "onStdout",
          "onUdpBind",
          "onUdpUnbind",
          "onUnmapHostFile",
          "onWaitpid",
          "teardown",
        ]),
      ],
    ]),
  ],
]);
const STORED_COLLECTION_METHODS = new Set(["add", "push", "set"]);
const DETACHED_EFFECT_METHODS = new Map<string, DetachedEffectKind>([
  ["deferObserverEffect", "observer"],
  ["deferProtocolEffect", "protocol"],
  ["deferProtocolTransactionStart", "transaction-start"],
]);
const SERIALIZED_HOST_OPERATION_METHOD =
  "#invokeSharedMmapHostOperation";
const PROTOCOL_EFFECT_ROOT_METHODS = new Set([
  ...ROOT_INGRESS_METHODS.keys(),
  "failKernelInstance",
  "publishPreparedChannelCompletion",
  "relistenChannel",
]);
const FOUNDATIONAL_ENTRY_METHODS = new Set([
  ...ROOT_INGRESS_METHODS.keys(),
  ...ENTRY_SELECTORS,
  "#invokeEntryScratchExport",
]);

function detachedEffectKind(
  phase: ExecutionPhase,
): DetachedEffectKind | null {
  if (phase === "detached-observer") return "observer";
  if (phase === "detached-protocol") return "protocol";
  if (phase === "detached-transaction-start") return "transaction-start";
  return null;
}

function propertyNameText(
  name: ts.PropertyName | ts.PrivateIdentifier | undefined,
  source: ts.SourceFile,
): string | null {
  if (name === undefined) return null;
  if (
    ts.isIdentifier(name)
    || ts.isPrivateIdentifier(name)
    || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)
  ) {
    return name.getText(source).replace(/^["']|["']$/g, "");
  }
  return null;
}

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

type MemberAccessExpression =
  | ts.PropertyAccessExpression
  | ts.ElementAccessExpression;

function isMemberAccessExpression(
  node: ts.Node,
): node is MemberAccessExpression {
  return ts.isPropertyAccessExpression(node)
    || ts.isElementAccessExpression(node);
}

function memberAccessName(
  node: MemberAccessExpression,
  source: ts.SourceFile,
): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return propertyNameText(node.name, source);
  }
  const argument = node.argumentExpression
    ? unwrapExpression(node.argumentExpression)
    : undefined;
  return argument && (
    ts.isStringLiteral(argument)
    || ts.isNumericLiteral(argument)
  )
    ? argument.text
    : null;
}

function memberAccessReceiver(
  node: MemberAccessExpression,
): ts.Expression {
  return unwrapExpression(node.expression);
}

function thisMethodName(
  call: ts.CallExpression,
  source: ts.SourceFile,
  resolveElementName?: (expression: ts.Expression) => string | null,
): string | null {
  const callee = unwrapExpression(call.expression);
  if (!isMemberAccessExpression(callee)) return null;
  const receiver = memberAccessReceiver(callee);
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return null;
  const directName = memberAccessName(callee, source);
  if (directName !== null || !ts.isElementAccessExpression(callee)) {
    return directName;
  }
  return callee.argumentExpression === undefined
    ? null
    : resolveElementName?.(callee.argumentExpression) ?? null;
}

function callPropertyName(
  call: ts.CallExpression,
  source: ts.SourceFile,
): string | null {
  const callee = unwrapExpression(call.expression);
  return isMemberAccessExpression(callee)
    ? memberAccessName(callee, source)
    : ts.isIdentifier(callee)
    ? callee.text
    : null;
}

function isFunctionExpressionLike(
  node: ts.Node | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return Boolean(
    node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)),
  );
}

function contextParameterIndex(
  node: ts.SignatureDeclarationBase,
): number | null {
  const isEntryContextType = (
    type: ts.TypeNode | undefined,
  ): boolean => {
    if (type === undefined) return false;
    if (ts.isParenthesizedTypeNode(type)) {
      return isEntryContextType(type.type);
    }
    if (ts.isUnionTypeNode(type)) {
      let includesEntryContext = false;
      for (const member of type.types) {
        if (isEntryContextType(member)) {
          includesEntryContext = true;
          continue;
        }
        if (
          member.kind === ts.SyntaxKind.UndefinedKeyword
          || (
            ts.isLiteralTypeNode(member)
            && member.literal.kind === ts.SyntaxKind.NullKeyword
          )
        ) {
          continue;
        }
        return false;
      }
      return includesEntryContext;
    }
    return ts.isTypeReferenceNode(type)
      && ts.isIdentifier(type.typeName)
      && type.typeName.text === "KernelWorkerEntryContext"
      && type.typeArguments === undefined;
  };

  for (let index = 0; index < node.parameters.length; index++) {
    if (isEntryContextType(node.parameters[index]!.type)) {
      return index;
    }
  }
  return null;
}

function parameterIdentifier(
  node: ts.SignatureDeclarationBase,
  index: number | null,
): string | null {
  if (index === null) return null;
  const name = node.parameters[index]?.name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const result: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    result.push(...bindingIdentifiers(element.name));
  }
  return result;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

function isIdentifierValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (
    (
      ts.isPropertyAssignment(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent)
      || ts.isMethodSignature(parent)
      || ts.isPropertySignature(parent)
    )
    && parent.name === node
  ) {
    return false;
  }
  if (
    (
      ts.isVariableDeclaration(parent)
      || ts.isParameter(parent)
      || ts.isBindingElement(parent)
      || ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent)
    )
    && parent.name === node
  ) {
    return false;
  }
  if (
    ts.isLabeledStatement(parent)
    || ts.isBreakStatement(parent)
    || ts.isContinueStatement(parent)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)
    || ts.isTypeNode(parent)
  ) {
    return false;
  }
  return true;
}

function directThisProperty(
  node: MemberAccessExpression,
  source: ts.SourceFile,
): string | null {
  return memberAccessReceiver(node).kind === ts.SyntaxKind.ThisKeyword
    ? memberAccessName(node, source)
    : null;
}

function isDirectKernelInstanceExports(
  node: MemberAccessExpression,
  source: ts.SourceFile,
): boolean {
  if (memberAccessName(node, source) !== "exports") return false;
  const receiver = memberAccessReceiver(node);
  return isMemberAccessExpression(receiver)
    && memberAccessReceiver(receiver).kind === ts.SyntaxKind.ThisKeyword
    && memberAccessName(receiver, source) === "#kernelInstance";
}

function isDirectCallTarget(node: MemberAccessExpression): boolean {
  let candidate: ts.Node = node;
  let parent = candidate.parent;
  while (
    parent
    && (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    )
  ) {
    candidate = parent;
    parent = parent.parent;
  }
  return Boolean(
    parent
    && ts.isCallExpression(parent)
    && parent.expression === candidate,
  );
}

function sourceLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function compactText(source: ts.SourceFile, node: ts.Node): string {
  return node.getText(source).replace(/\s+/g, " ").slice(0, 240);
}

function formatOwner(
  member: ts.MethodDeclaration | ts.ConstructorDeclaration,
  source: ts.SourceFile,
): string {
  return ts.isConstructorDeclaration(member)
    ? "CentralizedKernelWorker.constructor"
    : `CentralizedKernelWorker.${propertyNameText(member.name, source)}`;
}

/**
 * Audit the lexical capability used while a void ingress owns the kernel gate.
 *
 * The check intentionally follows private method calls instead of maintaining
 * a hand-written syscall allowlist. Adding a new helper therefore inherits the
 * same explicit-context and detached-effect requirements automatically.
 */
export function auditKernelEntryContext(
  sourceText: string,
): KernelEntryContextViolation[] {
  const virtualFileName = "/kernel-worker.ts";
  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const parsedSource = ts.createSourceFile(
    virtualFileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  compilerHost.fileExists = (fileName) => fileName === virtualFileName;
  compilerHost.readFile = (fileName) =>
    fileName === virtualFileName ? sourceText : undefined;
  compilerHost.getSourceFile = (fileName) =>
    fileName === virtualFileName ? parsedSource : undefined;
  const program = ts.createProgram(
    [virtualFileName],
    compilerOptions,
    compilerHost,
  );
  const source = program.getSourceFile(virtualFileName);
  if (!source) throw new Error("kernel-worker.ts could not be parsed");
  const checker = program.getTypeChecker();
  const identifierSymbol = (
    node: ts.Node | undefined,
  ): ts.Symbol | null => {
    if (!node || !ts.isIdentifier(node)) return null;
    // resolveName performs lexical binding lookup only. getSymbolAtLocation
    // can ask the checker for a flow-narrowed type and recurse through the
    // entire 20k-line syscall dispatch graph until the TypeScript checker
    // exhausts its own stack.
    return checker.resolveName(
      node.text,
      node,
      ts.SymbolFlags.Value,
      false,
    ) ?? null;
  };
  const exactImmutableLiteralName = (
    expression: ts.Expression,
    visiting = new Set<ts.Symbol>(),
  ): string | null => {
    const node = unwrapExpression(expression);
    if (
      ts.isStringLiteral(node)
      || ts.isNumericLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      return node.text;
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = identifierSymbol(node);
    if (symbol === null || visiting.has(symbol)) return null;
    const declarations = symbol.declarations?.filter(
      ts.isVariableDeclaration,
    ) ?? [];
    if (declarations.length !== 1) return null;
    const declaration = declarations[0]!;
    if (
      declaration.initializer === undefined
      || !ts.isVariableDeclarationList(declaration.parent)
      || (
        declaration.parent.flags & ts.NodeFlags.Const
      ) === 0
    ) {
      return null;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(symbol);
    return exactImmutableLiteralName(
      declaration.initializer,
      nextVisiting,
    );
  };
  const resolvedThisMethodName = (
    call: ts.CallExpression,
  ): string | null =>
    thisMethodName(call, source, exactImmutableLiteralName);
  const isUnresolvedComputedThisDispatch = (
    call: ts.CallExpression,
  ): boolean => {
    const callee = unwrapExpression(call.expression);
    return ts.isElementAccessExpression(callee)
      && memberAccessReceiver(callee).kind === ts.SyntaxKind.ThisKeyword
      && resolvedThisMethodName(call) === null;
  };
  const isGenuineDirectEval = (
    call: ts.CallExpression,
  ): boolean => {
    if (call.questionDotToken !== undefined) return false;
    const callee = unwrapExpression(call.expression);
    return ts.isIdentifier(callee)
      && callee.text === "eval"
      && identifierSymbol(callee) === null;
  };
  const exactSymbolIdentifier = (
    expression: ts.Expression | undefined,
    expected: ts.Symbol | null,
  ): boolean => {
    if (expression === undefined || expected === null) return false;
    return identifierSymbol(unwrapExpression(expression)) === expected;
  };
  const containsAuthoritySymbol = (
    node: ts.Node,
    authorities: ReadonlySet<ts.Symbol>,
  ): boolean => {
    let found = false;
    const visit = (candidate: ts.Node): void => {
      if (found) return;
      const symbol = identifierSymbol(candidate);
      if (symbol !== null && authorities.has(symbol)) {
        found = true;
        return;
      }
      ts.forEachChild(candidate, visit);
    };
    visit(node);
    return found;
  };
  const violations: KernelEntryContextViolation[] = [];
  const seenViolations = new Set<string>();
  const report = (
    kind: KernelEntryContextViolationKind,
    owner: string,
    node: ts.Node,
    text: string,
  ): void => {
    const line = sourceLine(source, node);
    const key = `${kind}:${owner}:${line}:${text}`;
    if (seenViolations.has(key)) return;
    seenViolations.add(key);
    violations.push({ kind, owner, line, text });
  };

  let workerClass: ts.ClassDeclaration | undefined;
  for (const statement of source.statements) {
    if (
      ts.isClassDeclaration(statement)
      && statement.name?.text === "CentralizedKernelWorker"
    ) {
      workerClass = statement;
      break;
    }
  }
  if (!workerClass) {
    throw new Error("CentralizedKernelWorker declaration was not found");
  }

  const capturedObjectIntrinsics = new Map<
    "freeze" | "seal",
    Set<ts.Symbol>
  >([
    ["freeze", new Set()],
    ["seal", new Set()],
  ]);
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement)
      || (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name)
        || declaration.initializer === undefined
      ) {
        continue;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isPropertyAccessExpression(initializer)) continue;
      const receiver = unwrapExpression(initializer.expression);
      if (
        !ts.isIdentifier(receiver)
        || receiver.text !== "Object"
        || identifierSymbol(receiver) !== null
      ) {
        continue;
      }
      const operation = propertyNameText(initializer.name, source);
      if (operation !== "freeze" && operation !== "seal") continue;
      const symbol = identifierSymbol(declaration.name);
      if (symbol !== null) capturedObjectIntrinsics.get(operation)!.add(symbol);
    }
  }
  const isCapturedObjectIntrinsicCall = (
    expression: ts.Expression,
    operation: "freeze" | "seal",
  ): expression is ts.CallExpression => {
    const node = unwrapExpression(expression);
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrapExpression(node.expression);
    return ts.isIdentifier(callee)
      && (
        (identifierSymbol(callee) !== null
          && capturedObjectIntrinsics
            .get(operation)!
            .has(identifierSymbol(callee)!))
      );
  };
  const workerClassSymbol =
    workerClass.name === undefined
      ? null
      : identifierSymbol(workerClass.name);
  const isWorkerPrototype = (
    expression: ts.Expression | undefined,
  ): boolean => {
    if (expression === undefined || workerClassSymbol === null) return false;
    const node = unwrapExpression(expression);
    return ts.isPropertyAccessExpression(node)
      && propertyNameText(node.name, source) === "prototype"
      && exactSymbolIdentifier(node.expression, workerClassSymbol);
  };
  const prototypeIsFrozen = source.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const expression = unwrapExpression(statement.expression);
    return isCapturedObjectIntrinsicCall(expression, "freeze")
      && isWorkerPrototype(expression.arguments[0]);
  });
  const constructor = workerClass.members.find(ts.isConstructorDeclaration);
  const isThisSealStatement = (statement: ts.Statement): boolean => {
    if (!ts.isExpressionStatement(statement)) return false;
    const expression = unwrapExpression(statement.expression);
    return isCapturedObjectIntrinsicCall(expression, "seal")
      && expression.arguments.length === 1
      && unwrapExpression(expression.arguments[0]!).kind
        === ts.SyntaxKind.ThisKeyword;
  };
  const testCapabilitySymbol = (() => {
    for (const statement of source.statements) {
      if (
        !ts.isVariableStatement(statement)
        || (statement.declarationList.flags & ts.NodeFlags.Const) === 0
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name)
          && declaration.name.text
            === "centralizedKernelWorkerTestCapability"
        ) {
          return identifierSymbol(declaration.name);
        }
      }
    }
    return null;
  })();
  const isArgumentsTestCapability = (
    expression: ts.Expression,
  ): boolean => {
    const node = unwrapExpression(expression);
    if (!ts.isBinaryExpression(node)) return false;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
      return false;
    }
    const isArgumentsIndexThree = (candidate: ts.Expression): boolean => {
      const exact = unwrapExpression(candidate);
      if (!ts.isElementAccessExpression(exact)) return false;
      const receiver = unwrapExpression(exact.expression);
      const index = exact.argumentExpression
        ? unwrapExpression(exact.argumentExpression)
        : undefined;
      return ts.isIdentifier(receiver)
        && receiver.text === "arguments"
        && index !== undefined
        && ts.isNumericLiteral(index)
        && index.text === "3";
    };
    const isCapability = (candidate: ts.Expression): boolean =>
      testCapabilitySymbol !== null
      && exactSymbolIdentifier(candidate, testCapabilitySymbol);
    return (
      isArgumentsIndexThree(node.left) && isCapability(node.right)
    ) || (
      isCapability(node.left) && isArgumentsIndexThree(node.right)
    );
  };
  const productionInstancesAreSealed = Boolean(
    constructor?.body?.statements.some((statement) => {
      if (isThisSealStatement(statement)) return true;
      if (
        !ts.isIfStatement(statement)
        || !isArgumentsTestCapability(statement.expression)
        || statement.elseStatement === undefined
      ) {
        return false;
      }
      const alternate = statement.elseStatement;
      return ts.isBlock(alternate)
        ? alternate.statements.some(isThisSealStatement)
        : isThisSealStatement(alternate);
    }),
  );
  const isNewTarget = (expression: ts.Expression): boolean => {
    const node = unwrapExpression(expression);
    return ts.isMetaProperty(node)
      && node.keywordToken === ts.SyntaxKind.NewKeyword
      && node.name.text === "target";
  };
  const alwaysThrows = (statement: ts.Statement): boolean =>
    ts.isThrowStatement(statement)
    || (
      ts.isBlock(statement)
      && statement.statements.length > 0
      && ts.isThrowStatement(statement.statements[0]!)
    );
  const subclassesAreRejected = Boolean(
    constructor?.body?.statements.some((statement) => {
      if (
        !ts.isIfStatement(statement)
        || statement.elseStatement !== undefined
        || !alwaysThrows(statement.thenStatement)
      ) {
        return false;
      }
      const condition = unwrapExpression(statement.expression);
      if (
        !ts.isBinaryExpression(condition)
        || condition.operatorToken.kind
          !== ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        return false;
      }
      return (
        isNewTarget(condition.left)
        && exactSymbolIdentifier(condition.right, workerClassSymbol)
      ) || (
        exactSymbolIdentifier(condition.left, workerClassSymbol)
        && isNewTarget(condition.right)
      );
    }),
  );
  const prototypeDispatchIsStable =
    prototypeIsFrozen
    && productionInstancesAreSealed
    && subclassesAreRejected;

  /*
   * These summaries are deliberately keyed by the exact class method and
   * callback parameter position. A wrapper only inherits asynchronous
   * behavior when it forwards one of its own parameters to a reviewed
   * scheduler/listener position. This closes the "rename setTimeout behind a
   * helper" hole without guessing from method spelling or treating ordinary
   * synchronous higher-order functions as schedulers.
   */
  const asyncMethodCallbackPositions = new Map<string, Set<number>>();
  for (const [name, positions] of ASYNC_METHOD_CALLBACK_POSITIONS) {
    asyncMethodCallbackPositions.set(name, new Set(positions));
  }
  const declaredMethods = new Map<
    string,
    ts.MethodDeclaration | ts.ConstructorDeclaration
  >();
  for (const member of workerClass.members) {
    if (
      !ts.isMethodDeclaration(member)
      && !ts.isConstructorDeclaration(member)
    ) {
      continue;
    }
    const name = ts.isConstructorDeclaration(member)
      ? "constructor"
      : propertyNameText(member.name, source);
    if (name !== null) declaredMethods.set(name, member);
  }
  const exactParameterIndex = (
    expression: ts.Expression | undefined,
    declaration: ts.SignatureDeclarationBase,
  ): number | null => {
    if (expression === undefined) return null;
    const node = unwrapExpression(expression);
    if (!ts.isIdentifier(node)) return null;
    const symbol = identifierSymbol(node);
    if (symbol === null) return null;
    for (let index = 0; index < declaration.parameters.length; index++) {
      const parameter = declaration.parameters[index]!;
      if (
        ts.isIdentifier(parameter.name)
        && identifierSymbol(parameter.name) === symbol
      ) {
        return index;
      }
    }
    return null;
  };
  let asyncSummaryChanged = true;
  while (asyncSummaryChanged) {
    asyncSummaryChanged = false;
    for (const [name, declaration] of declaredMethods) {
      if (!declaration.body) continue;
      let positions = asyncMethodCallbackPositions.get(name);
      if (positions === undefined) {
        positions = new Set();
        asyncMethodCallbackPositions.set(name, positions);
      }
      const inspect = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = unwrapExpression(node.expression);
          let callbackPositions: readonly number[] | undefined;
          if (
            ts.isIdentifier(callee)
            && identifierSymbol(callee) === null
          ) {
            callbackPositions =
              ASYNC_GLOBAL_CALLBACK_POSITIONS.get(callee.text);
          }
          const methodName = resolvedThisMethodName(node);
          if (methodName !== null) {
            callbackPositions =
              asyncMethodCallbackPositions.get(methodName)
              ?? callbackPositions;
          }
          if (callbackPositions === undefined && isMemberAccessExpression(callee)) {
            const member = memberAccessName(callee, source);
            if (
              member !== null
              && ASYNC_MEMBER_CALLBACK_POSITIONS.has(member)
            ) {
              callbackPositions =
                ASYNC_MEMBER_CALLBACK_POSITIONS.get(member);
            }
          }
          for (const callbackPosition of callbackPositions ?? []) {
            const parameterIndex = exactParameterIndex(
              node.arguments[callbackPosition],
              declaration,
            );
            if (
              parameterIndex !== null
              && !positions!.has(parameterIndex)
            ) {
              positions!.add(parameterIndex);
              asyncSummaryChanged = true;
            }
          }
        }
        if (
          ts.isBinaryExpression(node)
          && isAssignmentOperator(node.operatorToken.kind)
          && isMemberAccessExpression(unwrapExpression(node.left))
          && memberAccessName(
            unwrapExpression(node.left) as MemberAccessExpression,
            source,
          ) === "onmessage"
        ) {
          const parameterIndex = exactParameterIndex(
            node.right,
            declaration,
          );
          if (
            parameterIndex !== null
            && !positions!.has(parameterIndex)
          ) {
            positions!.add(parameterIndex);
            asyncSummaryChanged = true;
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(declaration.body);
    }
  }

  const methods = new Map<string, MethodInfo>();
  const rootScopes: ScopeScan[] = [];

  const scanScope = (
    body: ts.Node,
    owner: string,
    contextName: string | null,
    contextSymbol: ts.Symbol | null,
    localCallables: ReadonlyMap<
      ts.Symbol,
      ts.ArrowFunction | ts.FunctionExpression
    >,
  ): Omit<ScopeScan, "owner" | "contextName" | "contextSymbol"> & {
    directlyExportBearing: boolean;
  } => {
    const calls: MethodCall[] = [];
    const directEvalCalls: ts.CallExpression[] = [];
    const dynamicThisDispatches: DynamicThisDispatch[] = [];
    const hostEffects: HostEffect[] = [];
    const indirectMethodReferences: IndirectMethodReference[] = [];
    let directlyExportBearing = false;
    const ownsEntryContext =
      contextName !== null && contextSymbol !== null;
    const trustedSelector =
      ENTRY_SELECTORS.has(owner.split(".").at(-1) ?? "");
    const scopedAuthoritySymbols = new Set<ts.Symbol>(
      contextSymbol === null ? [] : [contextSymbol],
    );

    const expressionReturnsAuthority = (
      expression: ts.Expression,
      authorities: ReadonlySet<ts.Symbol>,
      selectorsReturnAuthority: boolean,
    ): boolean => {
      const node = unwrapExpression(expression);
      if (ts.isIdentifier(node)) {
        const symbol = identifierSymbol(node);
        return symbol !== null && authorities.has(symbol);
      }
      if (ts.isPropertyAccessExpression(node)) {
        return expressionReturnsAuthority(
          node.expression,
          authorities,
          selectorsReturnAuthority,
        );
      }
      if (ts.isElementAccessExpression(node)) {
        return expressionReturnsAuthority(
          node.expression,
          authorities,
          selectorsReturnAuthority,
        );
      }
      if (ts.isCallExpression(node)) {
        const methodName = resolvedThisMethodName(node);
        if (
          selectorsReturnAuthority
          && methodName !== null
          && ENTRY_SELECTORS.has(methodName)
        ) {
          return true;
        }
        const callee = unwrapExpression(node.expression);
        if (
          isMemberAccessExpression(callee)
          && memberAccessName(callee, source) === "bind"
        ) {
          return expressionReturnsAuthority(
            memberAccessReceiver(callee),
            authorities,
            selectorsReturnAuthority,
          )
            || node.arguments.some((argument) =>
              expressionReturnsAuthority(
                argument,
                authorities,
                selectorsReturnAuthority,
              )
            );
        }
        // Ordinary calls consume their receiver and arguments. Their return
        // value is not authority unless the reviewed selector above says so.
        return false;
      }
      if (isFunctionExpressionLike(node)) {
        return containsAuthoritySymbol(node.body, authorities);
      }
      if (ts.isConditionalExpression(node)) {
        return expressionReturnsAuthority(
          node.whenTrue,
          authorities,
          selectorsReturnAuthority,
        )
          || expressionReturnsAuthority(
            node.whenFalse,
            authorities,
            selectorsReturnAuthority,
          );
      }
      if (ts.isBinaryExpression(node)) {
        return expressionReturnsAuthority(
          node.left,
          authorities,
          selectorsReturnAuthority,
        )
          || expressionReturnsAuthority(
            node.right,
            authorities,
            selectorsReturnAuthority,
          );
      }
      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.some(
          (element) =>
            ts.isExpression(element)
            && expressionReturnsAuthority(
              element,
              authorities,
              selectorsReturnAuthority,
            ),
        );
      }
      if (ts.isObjectLiteralExpression(node)) {
        return node.properties.some((property) => {
          if (ts.isShorthandPropertyAssignment(property)) {
            const symbol = identifierSymbol(property.name);
            return symbol !== null && authorities.has(symbol);
          }
          if (ts.isPropertyAssignment(property)) {
            return expressionReturnsAuthority(
              property.initializer,
              authorities,
              selectorsReturnAuthority,
            );
          }
          if (ts.isSpreadAssignment(property)) {
            return expressionReturnsAuthority(
              property.expression,
              authorities,
              selectorsReturnAuthority,
            );
          }
          if (
            ts.isMethodDeclaration(property)
            || ts.isGetAccessorDeclaration(property)
            || ts.isSetAccessorDeclaration(property)
          ) {
            return Boolean(
              property.body
              && containsAuthoritySymbol(
                property.body,
                authorities,
              ),
            );
          }
          return false;
        });
      }
      return false;
    };
    const expressionReturnsScopedAuthority = (
      expression: ts.Expression,
    ): boolean =>
      expressionReturnsAuthority(
        expression,
        scopedAuthoritySymbols,
        true,
      );
    const expressionReturnsDirectContext = (
      expression: ts.Expression,
    ): boolean => {
      if (contextSymbol === null) return false;
      const node = unwrapExpression(expression);
      if (ts.isIdentifier(node)) {
        return identifierSymbol(node) === contextSymbol;
      }
      if (isFunctionExpressionLike(node)) {
        return containsAuthoritySymbol(
          node.body,
          new Set([contextSymbol]),
        );
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        return isMemberAccessExpression(callee)
          && memberAccessName(callee, source) === "bind"
          && (
            expressionReturnsDirectContext(memberAccessReceiver(callee))
            || node.arguments.some(expressionReturnsDirectContext)
          );
      }
      if (ts.isConditionalExpression(node)) {
        return expressionReturnsDirectContext(node.whenTrue)
          || expressionReturnsDirectContext(node.whenFalse);
      }
      if (ts.isBinaryExpression(node)) {
        return expressionReturnsDirectContext(node.left)
          || expressionReturnsDirectContext(node.right);
      }
      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.some(
          (element) =>
            ts.isExpression(element)
            && expressionReturnsDirectContext(element),
        );
      }
      if (ts.isObjectLiteralExpression(node)) {
        return node.properties.some((property) => {
          if (ts.isShorthandPropertyAssignment(property)) {
            return identifierSymbol(property.name) === contextSymbol;
          }
          if (ts.isPropertyAssignment(property)) {
            return expressionReturnsDirectContext(property.initializer);
          }
          if (ts.isSpreadAssignment(property)) {
            return expressionReturnsDirectContext(property.expression);
          }
          return false;
        });
      }
      // A property or element selected from the context is a derived scoped
      // capability. It may be used synchronously, but the general authority
      // tracker above still rejects returning, storing, or capturing it.
      return false;
    };
    const isScopedEntryInstanceExports = (
      node: MemberAccessExpression,
    ): boolean => {
      if (memberAccessName(node, source) !== "exports") return false;
      const receiver = memberAccessReceiver(node);
      return isMemberAccessExpression(receiver)
        && memberAccessName(receiver, source) === "instance"
        && exactSymbolIdentifier(
          memberAccessReceiver(receiver),
          contextSymbol,
        );
    };
    const resolveLocalCallable = (
      expression: ts.Expression | undefined,
    ): ts.ArrowFunction | ts.FunctionExpression | undefined => {
      if (isFunctionExpressionLike(expression)) return expression;
      if (!expression || !ts.isIdentifier(expression)) return undefined;
      const symbol = identifierSymbol(expression);
      return symbol === null ? undefined : localCallables.get(symbol);
    };
    const visitedCallablePhases = new Map<
      ts.ArrowFunction | ts.FunctionExpression,
      Set<ExecutionPhase>
    >();
    const visitCallable = (
      callback: ts.ArrowFunction | ts.FunctionExpression,
      phase: ExecutionPhase,
    ): void => {
      let phases = visitedCallablePhases.get(callback);
      if (phases === undefined) {
        phases = new Set();
        visitedCallablePhases.set(callback, phases);
      }
      if (phases.has(phase)) return;
      phases.add(phase);
      visit(callback.body, phase);
    };
    const hostOwnedRoot = (
      expression: ts.Expression,
    ): string | null => {
      let current = unwrapExpression(expression);
      while (
        isMemberAccessExpression(current)
      ) {
        const direct = directThisProperty(current, source);
        if (
          direct === "callbacks"
          || direct === "io"
          || direct?.endsWith("Observer")
        ) {
          return direct;
        }
        current = memberAccessReceiver(current);
      }
      return null;
    };
    const hostEffectAliases = new Set<ts.Symbol>();
    const knownPromiseSymbols = new Set<ts.Symbol>();
    const collectKnownPromiseBindings = (node: ts.Node): void => {
      if (
        (
          ts.isVariableDeclaration(node)
          || ts.isParameter(node)
        )
        && ts.isIdentifier(node.name)
        && /\bPromise\s*</.test(node.type?.getText(source) ?? "")
      ) {
        const symbol = identifierSymbol(node.name);
        if (symbol !== null) knownPromiseSymbols.add(symbol);
      }
      ts.forEachChild(node, collectKnownPromiseBindings);
    };
    collectKnownPromiseBindings(body);
    const isUnshadowedGlobal = (
      expression: ts.Expression,
      expected: string,
    ): boolean => {
      const node = unwrapExpression(expression);
      return ts.isIdentifier(node)
        && node.text === expected
        && identifierSymbol(node) === null;
    };
    const isKnownPromiseExpression = (
      expression: ts.Expression,
    ): boolean => {
      const node = unwrapExpression(expression);
      if (ts.isIdentifier(node)) {
        const symbol = identifierSymbol(node);
        return symbol !== null && knownPromiseSymbols.has(symbol);
      }
      if (ts.isNewExpression(node)) {
        return isUnshadowedGlobal(node.expression, "Promise");
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isIdentifier(callee)) {
          const symbol = identifierSymbol(callee);
          const local = symbol === null
            ? undefined
            : localCallables.get(symbol);
          return Boolean(
            local?.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            )
            || /\bPromise(?:Like)?\s*</.test(
              local?.type?.getText(source) ?? "",
            ),
          );
        }
        if (!ts.isPropertyAccessExpression(callee)) return false;
        const method = propertyNameText(callee.name, source);
        if (
          method !== null
          && PROMISE_CONTINUATION_CALLS.has(method)
          && isKnownPromiseExpression(callee.expression)
        ) {
          return true;
        }
        return isUnshadowedGlobal(callee.expression, "Promise");
      }
      if (
        ts.isPropertyAccessExpression(node)
        && propertyNameText(node.name, source) === "value"
      ) {
        const receiver = unwrapExpression(node.expression);
        if (!ts.isCallExpression(receiver)) return false;
        const callee = unwrapExpression(receiver.expression);
        return ts.isPropertyAccessExpression(callee)
          && propertyNameText(callee.name, source) === "waitAsync"
          && isUnshadowedGlobal(callee.expression, "Atomics");
      }
      return false;
    };
    const callableLaunchesPromise = (
      callback: ts.ArrowFunction | ts.FunctionExpression,
      visiting = new Set<ts.Node>(),
    ): boolean => {
      if (visiting.has(callback)) return false;
      visiting.add(callback);
      if (
        callback.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        )
        || /\bPromise(?:Like)?\s*</.test(
          callback.type?.getText(source) ?? "",
        )
      ) {
        return true;
      }

      let launches = false;
      const inspect = (node: ts.Node): void => {
        if (launches) return;
        if (node !== callback && isFunctionExpressionLike(node)) return;
        if (ts.isAwaitExpression(node)) {
          launches = true;
          return;
        }
        if (
          ts.isNewExpression(node)
          && isUnshadowedGlobal(node.expression, "Promise")
        ) {
          launches = true;
          return;
        }
        if (ts.isCallExpression(node)) {
          if (isKnownPromiseExpression(node)) {
            launches = true;
            return;
          }
          const callee = unwrapExpression(node.expression);
          if (ts.isIdentifier(callee)) {
            const symbol = identifierSymbol(callee);
            const local = symbol === null
              ? undefined
              : localCallables.get(symbol);
            if (local && callableLaunchesPromise(local, visiting)) {
              launches = true;
              return;
            }
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(callback.body);
      return launches;
    };
    const callableExplicitlyReturnsValue = (
      callback: ts.ArrowFunction | ts.FunctionExpression,
    ): boolean => {
      if (
        callback.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        )
      ) {
        return true;
      }
      if (!ts.isBlock(callback.body)) {
        const expression = unwrapExpression(callback.body);
        return !(
          ts.isVoidExpression(expression)
          || (
            ts.isIdentifier(expression)
            && expression.text === "undefined"
          )
        );
      }
      let returnsValue = false;
      const inspect = (node: ts.Node): void => {
        if (returnsValue) return;
        if (node !== callback && isFunctionExpressionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression !== undefined) {
          const expression = unwrapExpression(node.expression);
          if (
            !ts.isVoidExpression(expression)
            && !(
              ts.isIdentifier(expression)
              && expression.text === "undefined"
            )
          ) {
            returnsValue = true;
            return;
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(callback.body);
      return returnsValue;
    };
    const reviewedAsyncCallbackPositions = (
      call: ts.CallExpression,
    ): ReadonlySet<number> => {
      const callee = unwrapExpression(call.expression);
      if (
        ts.isIdentifier(callee)
        && identifierSymbol(callee) === null
      ) {
        return new Set(
          ASYNC_GLOBAL_CALLBACK_POSITIONS.get(callee.text) ?? [],
        );
      }
      const methodName = resolvedThisMethodName(call);
      if (methodName !== null) {
        return asyncMethodCallbackPositions.get(methodName) ?? new Set();
      }
      if (!isMemberAccessExpression(callee)) return new Set();
      const method = memberAccessName(callee, source);
      if (method === null) return new Set();
      if (
        PROMISE_CONTINUATION_CALLS.has(method)
        && !isKnownPromiseExpression(memberAccessReceiver(callee))
      ) {
        return new Set();
      }
      return new Set(
        ASYNC_MEMBER_CALLBACK_POSITIONS.get(method) ?? [],
      );
    };
    const reviewedObjectCallbacks = (
      call: ts.CallExpression,
    ): Array<ts.ArrowFunction | ts.FunctionExpression> => {
      const property = callPropertyName(call, source);
      if (property === null) return [];
      const argumentsByProperty = ASYNC_CALLBACK_OBJECT_CALLS.get(property);
      if (argumentsByProperty === undefined) return [];
      const callbacks: Array<ts.ArrowFunction | ts.FunctionExpression> = [];
      for (const [argumentIndex, allowedProperties] of argumentsByProperty) {
        const argument = call.arguments[argumentIndex];
        if (argument === undefined) continue;
        const object = unwrapExpression(argument);
        if (!ts.isObjectLiteralExpression(object)) {
          report(
            "nonlexical-entry-operation",
            owner,
            argument,
            `${property} callback object must be an inline reviewed object literal`,
          );
          continue;
        }
        for (const member of object.properties) {
          const memberName = propertyNameText(member.name, source);
          if (memberName === null || !allowedProperties.has(memberName)) {
            continue;
          }
          if (ts.isPropertyAssignment(member)) {
            const callback = resolveLocalCallable(member.initializer);
            if (callback !== undefined) {
              callbacks.push(callback);
            } else {
              report(
                "nonlexical-entry-operation",
                owner,
                member,
                `${property}.${memberName} must be an inline or directly declared callback`,
              );
            }
          } else if (ts.isShorthandPropertyAssignment(member)) {
            const callback = resolveLocalCallable(member.name);
            if (callback !== undefined) {
              callbacks.push(callback);
            } else {
              report(
                "nonlexical-entry-operation",
                owner,
                member,
                `${property}.${memberName} must resolve to a directly declared callback`,
              );
            }
          } else {
            report(
              "nonlexical-entry-operation",
              owner,
              member,
              `${property}.${memberName} must use a lexical function value`,
            );
          }
        }
      }
      return callbacks;
    };
    const reviewedConstructorObjectCallbacks = (
      node: ts.NewExpression,
    ): Array<ts.ArrowFunction | ts.FunctionExpression> => {
      const constructor = unwrapExpression(node.expression);
      if (!ts.isIdentifier(constructor)) return [];
      const argumentsByProperty =
        ASYNC_CONSTRUCTOR_CALLBACK_OBJECTS.get(constructor.text);
      if (argumentsByProperty === undefined) return [];
      const callbacks: Array<ts.ArrowFunction | ts.FunctionExpression> = [];
      for (const [argumentIndex, allowedProperties] of argumentsByProperty) {
        const argument = node.arguments?.[argumentIndex];
        if (argument === undefined) continue;
        const object = unwrapExpression(argument);
        if (!ts.isObjectLiteralExpression(object)) {
          report(
            "nonlexical-entry-operation",
            owner,
            argument,
            `${constructor.text} callback contract must be an inline reviewed object literal`,
          );
          continue;
        }
        for (const member of object.properties) {
          const memberName = propertyNameText(member.name, source);
          if (memberName === null || !allowedProperties.has(memberName)) {
            continue;
          }
          if (ts.isPropertyAssignment(member)) {
            const callback = resolveLocalCallable(member.initializer);
            if (callback !== undefined) {
              callbacks.push(callback);
            } else {
              report(
                "nonlexical-entry-operation",
                owner,
                member,
                `${constructor.text}.${memberName} must be an inline or directly declared callback`,
              );
            }
          } else if (ts.isShorthandPropertyAssignment(member)) {
            const callback = resolveLocalCallable(member.name);
            if (callback !== undefined) {
              callbacks.push(callback);
            } else {
              report(
                "nonlexical-entry-operation",
                owner,
                member,
                `${constructor.text}.${memberName} must resolve to a directly declared callback`,
              );
            }
          } else {
            report(
              "nonlexical-entry-operation",
              owner,
              member,
              `${constructor.text}.${memberName} must use a lexical function value`,
            );
          }
        }
      }
      return callbacks;
    };
    const directlyOpensChannelIngress = (
      callback: ts.ArrowFunction | ts.FunctionExpression,
    ): boolean => {
      let found = false;
      const inspect = (node: ts.Node): void => {
        if (found) return;
        if (node !== callback.body && isFunctionExpressionLike(node)) return;
        if (
          ts.isCallExpression(node)
          && resolvedThisMethodName(node) === "#runOrDeferChannelKernelEntry"
        ) {
          found = true;
          return;
        }
        ts.forEachChild(node, inspect);
      };
      inspect(callback.body);
      return found;
    };
    const visitAsyncCallback = (
      callback: ts.ArrowFunction | ts.FunctionExpression,
      callbackPhase: "async-fresh" | "transaction-continuation",
    ): void => {
      if (
        containsAuthoritySymbol(
          callback.body,
          scopedAuthoritySymbols,
        )
      ) {
        report(
          "context-async-capture",
          owner,
          callback,
          "entry context is captured by an asynchronous callback",
        );
      }
      if (
        callbackPhase === "transaction-continuation"
        && !directlyOpensChannelIngress(callback)
      ) {
        report(
          "transaction-continuation-without-channel-ingress",
          owner,
          callback,
          "a protocol transaction continuation must directly re-enter through "
            + "#runOrDeferChannelKernelEntry before completion or rollback",
        );
      }
      visitCallable(callback, callbackPhase);
    };

    const visit = (node: ts.Node, phase: ExecutionPhase): void => {
      if (
        ownsEntryContext
        && ts.isIdentifier(node)
        && node.text === "arguments"
        && isIdentifierValueReference(node)
      ) {
        report(
          "implicit-arguments-entry-authority",
          owner,
          node,
          "a scope owning KernelWorkerEntryContext may not recover "
            + "authority through the implicit arguments object",
        );
      }
      let rootOperationIndex: number | null = null;
      let asyncCallbacks:
        | Array<ts.ArrowFunction | ts.FunctionExpression>
        | null = null;
      let directLocalInvocation:
        | ts.ArrowFunction
        | ts.FunctionExpression
        | undefined;
      let directLocalInvocationSymbol: ts.Symbol | null = null;
      if (ts.isCallExpression(node)) {
        if (isGenuineDirectEval(node)) {
          directEvalCalls.push(node);
        }
        if (isUnresolvedComputedThisDispatch(node)) {
          dynamicThisDispatches.push({ node, phase });
        }
        const methodName = resolvedThisMethodName(node);
        const property = callPropertyName(node, source);
        const callee = unwrapExpression(node.expression);
        const receiver = isMemberAccessExpression(callee)
          ? memberAccessReceiver(callee)
          : undefined;
        const effectKind =
          property === null
            ? undefined
            : DETACHED_EFFECT_METHODS.get(property);
        const isContextDefer =
          ownsEntryContext
          && effectKind !== undefined
          && receiver !== undefined
          && expressionReturnsScopedAuthority(receiver);

        if (isContextDefer) {
          const callbackExpression = node.arguments[0];
          const callback = resolveLocalCallable(callbackExpression);
          if (!callback) {
            report(
              "nonlexical-detached-effect",
              owner,
              callbackExpression ?? node,
              "detached effects must be inline or a directly declared local closure",
            );
          }
          if (
            callback
            && containsAuthoritySymbol(
              callback.body,
              scopedAuthoritySymbols,
            )
          ) {
            report(
              "context-detached-capture",
              owner,
              callback,
              "detached host effect captures its revoked entry context",
            );
          }
          if (
            callback
            && effectKind !== "transaction-start"
            && callableLaunchesPromise(callback)
          ) {
            report(
              "async-detached-effect",
              owner,
              callback,
              `${effectKind} effect must finish synchronously and may not `
                + "return, launch, or await a Promise",
            );
          }
          if (
            callback
            && effectKind === "transaction-start"
            && callableExplicitlyReturnsValue(callback)
          ) {
            report(
              "async-detached-effect",
              owner,
              callback,
              "protocol transaction start must return undefined after "
                + "synchronously registering captured-Promise continuations",
            );
          }
          if (callback) {
            visitCallable(
              callback,
              effectKind === "observer"
                ? "detached-observer"
                : effectKind === "protocol"
                ? "detached-protocol"
                : "detached-transaction-start",
            );
          }
          for (let index = 1; index < node.arguments.length; index++) {
            visit(node.arguments[index]!, phase);
          }
          return;
        }

        if (methodName === SERIALIZED_HOST_OPERATION_METHOD) {
          const callbackExpression = node.arguments[1];
          const callback = resolveLocalCallable(callbackExpression);
          if (!callback) {
            report(
              "nonlexical-entry-operation",
              owner,
              callbackExpression ?? node,
              `${SERIALIZED_HOST_OPERATION_METHOD} requires an inline or `
                + "directly declared synchronous callback",
            );
          } else {
            if (
              containsAuthoritySymbol(
                callback.body,
                scopedAuthoritySymbols,
              )
            ) {
              report(
                "context-detached-capture",
                owner,
                callback,
                "serialized host operation captures kernel entry authority",
              );
            }
            if (callableLaunchesPromise(callback)) {
              report(
                "scoped-method-async",
                owner,
                callback,
                "serialized host operation must finish synchronously",
              );
            }
            visitCallable(callback, "serialized-host");
          }
          if (
            ownsEntryContext
            && !exactSymbolIdentifier(node.arguments[0], contextSymbol)
          ) {
            report(
              "missing-explicit-entry",
              owner,
              node,
              `${SERIALIZED_HOST_OPERATION_METHOD} must receive the exact `
                + "lexical entry argument",
            );
          }
          visit(node.expression, phase);
          for (let index = 0; index < node.arguments.length; index++) {
            if (index !== 1) visit(node.arguments[index]!, phase);
          }
          return;
        }

        if (
          methodName !== null
          && ROOT_INGRESS_METHODS.has(methodName)
        ) {
          const operationIndex = ROOT_INGRESS_METHODS.get(methodName)!;
          rootOperationIndex = operationIndex;
          const operation = node.arguments[operationIndex];
          if (!isFunctionExpressionLike(operation)) {
            report(
              "nonlexical-entry-operation",
              owner,
              operation ?? node,
              `${methodName} requires an inline lexical operation closure`,
            );
          } else if (
            containsAuthoritySymbol(
              operation.body,
              scopedAuthoritySymbols,
            )
          ) {
            report(
              "context-cross-ingress-capture",
              owner,
              operation,
              "a fresh ingress operation captures authority from its outer entry",
            );
          }
          if (
            methodName === "#runOrDeferKernelEntry"
            && node.arguments.length >= 4
            && node.arguments[3]!.kind !== ts.SyntaxKind.UndefinedKeyword
          ) {
            report(
              "legacy-detached-operation",
              owner,
              node.arguments[3]!,
              "detached effects must be registered through "
                + "entry.deferProtocolEffect or entry.deferObserverEffect",
            );
          }
        }

        if (methodName !== null) {
          if (phase === "serialized-host") {
            report(
              "nonlexical-entry-operation",
              owner,
              node,
              "serialized host operation may invoke only staged host "
                + "capabilities, not worker methods",
            );
          }
          calls.push({ callee: methodName, node, phase });
          if (
            ENTRY_SELECTORS.has(methodName)
            || methodName === "#invokeEntryScratchExport"
          ) {
            directlyExportBearing = true;
            if (detachedEffectKind(phase) !== null) {
              report(
                "export-from-detached-effect",
                owner,
                node,
                `${methodName} is called after the entry scope is revoked`,
              );
            } else if (phase === "async-fresh") {
              report(
                "async-export-without-ingress",
                owner,
                node,
                `${methodName} is called from an async callback without a fresh ingress`,
              );
            } else if (
              ownsEntryContext
              && !exactSymbolIdentifier(
                node.arguments[0],
                contextSymbol,
              )
            ) {
              report(
                "bare-entry-selector",
                owner,
                node,
                `${methodName} must receive the exact lexical entry context`,
              );
            }
          }
        }

        const callbackPositions = reviewedAsyncCallbackPositions(node);
        const callbacks = reviewedObjectCallbacks(node);
        for (const index of callbackPositions) {
          const argument = node.arguments[index];
          if (argument === undefined) continue;
          const callback = resolveLocalCallable(argument);
          if (callback !== undefined) {
            callbacks.push(callback);
            continue;
          }
          const exactArgument = unwrapExpression(argument);
          if (
            exactArgument.kind !== ts.SyntaxKind.UndefinedKeyword
            && !ts.isIdentifier(exactArgument)
          ) {
            report(
              "nonlexical-entry-operation",
              owner,
              argument,
              "reviewed asynchronous callback positions require an inline "
                + "or directly declared lexical callback",
            );
          }
        }
        if (callbacks.length > 0) asyncCallbacks = callbacks;

        const directCallee = unwrapExpression(node.expression);
        if (ts.isIdentifier(directCallee)) {
          directLocalInvocationSymbol = identifierSymbol(directCallee);
          directLocalInvocation =
            directLocalInvocationSymbol === null
              ? undefined
              : localCallables.get(directLocalInvocationSymbol);
        } else if (isFunctionExpressionLike(directCallee)) {
          directLocalInvocation = directCallee;
        }

        if (phase === "active") {
          const hostRoot = hostOwnedRoot(node.expression);
          const calleeIdentifier = unwrapExpression(node.expression);
          const aliasedHostEffect =
            ts.isIdentifier(calleeIdentifier)
            && identifierSymbol(calleeIdentifier) !== null
            && hostEffectAliases.has(identifierSymbol(calleeIdentifier)!);
          if (hostRoot !== null || aliasedHostEffect) {
            hostEffects.push({
              node,
              description: hostRoot === null
                ? "aliased host-owned callback invocation"
                : `host-owned ${hostRoot} invocation`,
            });
          }
        }
      }

      if (ts.isCallExpression(node) && rootOperationIndex !== null) {
        // The operation receives a fresh lexical context and is audited as a
        // root below. Treating its body as part of the enclosing method would
        // falsely make a context-free caller responsible for calls made by
        // that new scope.
        for (let index = 0; index < node.arguments.length; index++) {
          if (
            index === rootOperationIndex
            || (
              resolvedThisMethodName(node) === "#runOrDeferKernelEntry"
              && index === 3
            )
          ) {
            continue;
          }
          visit(node.arguments[index]!, phase);
        }
        const detachedPost = node.arguments[3];
        if (
          resolvedThisMethodName(node) === "#runOrDeferKernelEntry"
          && isFunctionExpressionLike(detachedPost)
        ) {
          visit(detachedPost.body, "detached-protocol");
        }
        return;
      }

      if (ts.isCallExpression(node) && asyncCallbacks !== null) {
        // Evaluate the scheduler receiver and ordinary arguments now, but the
        // callback body starts later with no authority from this entry.
        visit(node.expression, phase);
        for (const argument of node.arguments) visit(argument, phase);
        const callbackPhase =
          phase === "detached-transaction-start"
            || phase === "transaction-continuation"
            ? "transaction-continuation"
            : "async-fresh";
        for (const callback of asyncCallbacks) {
          visitAsyncCallback(callback, callbackPhase);
        }
        return;
      }

      if (ts.isCallExpression(node) && directLocalInvocation) {
        for (const argument of node.arguments) visit(argument, phase);
        visitCallable(directLocalInvocation, phase);
        return;
      }

      if (ts.isCallExpression(node)) {
        // Unknown higher-order functions are conservatively synchronous.
        // Only the reviewed ingress, detached-effect, and async scheduler
        // branches above are allowed to change the callback's phase.
        for (const argument of node.arguments) {
          const callback = resolveLocalCallable(argument);
          if (callback) visitCallable(callback, phase);
        }
      }

      if (ts.isNewExpression(node)) {
        const constructor = unwrapExpression(node.expression);
        if (
          phase === "active"
          && ts.isIdentifier(constructor)
          && constructor.text === "Promise"
        ) {
          hostEffects.push({
            node,
            description: "async scheduling through Promise",
          });
        }
        if (
          ts.isIdentifier(constructor)
          && constructor.text === "Promise"
        ) {
          const executor = resolveLocalCallable(node.arguments?.[0]);
          if (executor) visitCallable(executor, phase);
        }
        for (const callback of reviewedConstructorObjectCallbacks(node)) {
          visitAsyncCallback(callback, "async-fresh");
        }
      }

      if (ts.isAwaitExpression(node) && phase === "active") {
        hostEffects.push({
          node,
          description: "await in the active scoped graph",
        });
      }

      if (isMemberAccessExpression(node)) {
        if (isDirectKernelInstanceExports(node, source)) {
          report(
            "direct-kernel-instance-exports",
            owner,
            node,
            "raw #kernelInstance.exports bypasses the entry selector",
          );
          directlyExportBearing = true;
        }
        if (isScopedEntryInstanceExports(node)) {
          directlyExportBearing = true;
        }
        const receiver = memberAccessReceiver(node);
        if (
          receiver.kind === ts.SyntaxKind.ThisKeyword
          && !isDirectCallTarget(node)
        ) {
          const method = memberAccessName(node, source);
          if (method !== null) {
            indirectMethodReferences.push({ method, node });
          }
        }
        if (
          ownsEntryContext
          && exactSymbolIdentifier(
            memberAccessReceiver(node),
            contextSymbol,
          )
          && DETACHED_EFFECT_METHODS.has(
            memberAccessName(node, source) ?? "",
          )
          && !isDirectCallTarget(node)
        ) {
          report(
            "indirect-entry-authority",
            owner,
            node,
            "entry detached-effect registration may not be aliased or "
              + "invoked through call/apply/bind",
          );
        }
      }

      if (
        ts.isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
        && isMemberAccessExpression(unwrapExpression(node.left))
        && memberAccessName(
          unwrapExpression(node.left) as MemberAccessExpression,
          source,
        ) === "onmessage"
      ) {
        const callback = resolveLocalCallable(node.right);
        visit(node.left, phase);
        if (callback === undefined) {
          report(
            "nonlexical-entry-operation",
            owner,
            node.right,
            "MessagePort.onmessage requires an inline or directly declared "
              + "lexical listener",
          );
        } else {
          visitAsyncCallback(
            callback,
            phase === "detached-transaction-start"
                || phase === "transaction-continuation"
              ? "transaction-continuation"
              : "async-fresh",
          );
        }
        return;
      }

      if (
        phase === "active"
        && ts.isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
        && hostOwnedRoot(node.left) !== null
      ) {
        hostEffects.push({
          node,
          description: `host-owned ${hostOwnedRoot(node.left)} mutation`,
        });
      }

      if (
        ownsEntryContext
        && ts.isVariableDeclaration(node)
        && !ts.isIdentifier(node.name)
        && node.initializer
        && expressionReturnsScopedAuthority(node.initializer)
      ) {
        for (const identifier of bindingIdentifiers(node.name)) {
          const symbol = identifierSymbol(identifier);
          if (symbol !== null) scopedAuthoritySymbols.add(symbol);
        }
        report(
          "context-alias",
          owner,
          node,
          "entry authority is destructured instead of threaded explicitly",
        );
      }

      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && hostOwnedRoot(node.initializer) !== null
      ) {
        const symbol = identifierSymbol(node.name);
        if (symbol !== null) hostEffectAliases.add(symbol);
      }

      if (
        ownsEntryContext
        &&
        ts.isReturnStatement(node)
        && node.expression
        && expressionReturnsScopedAuthority(node.expression)
        && !trustedSelector
      ) {
        report(
          "context-return",
          owner,
          node,
          "entry context escapes through a return value",
        );
      }

      if (
        ownsEntryContext
        && ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && identifierSymbol(node.name) !== contextSymbol
        && node.initializer
      ) {
        const declarationSymbol = identifierSymbol(node.name);
        const returnsScopedAuthority =
          expressionReturnsScopedAuthority(node.initializer);
        if (
          returnsScopedAuthority
          && declarationSymbol !== null
        ) {
          scopedAuthoritySymbols.add(declarationSymbol);
        }
        if (
          expressionReturnsDirectContext(node.initializer)
          && !trustedSelector
        ) {
          report(
            "context-alias",
            owner,
            node,
            "entry context is aliased instead of threaded explicitly",
          );
        } else if (
          returnsScopedAuthority
          && isFunctionExpressionLike(unwrapExpression(node.initializer))
        ) {
          report(
            "context-alias",
            owner,
            node,
            "a local closure aliases entry-scoped authority",
          );
        }
      }

      if (
        ownsEntryContext
        &&
        ts.isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
        && (
          expressionReturnsScopedAuthority(node.right)
          || exactSymbolIdentifier(node.left, contextSymbol)
        )
      ) {
        report(
          "context-storage",
          owner,
          node,
          "entry context is assigned into longer-lived state",
        );
      }

      if (ts.isCallExpression(node)) {
        const property = callPropertyName(node, source);
        if (
          ownsEntryContext
          &&
          property
          && STORED_COLLECTION_METHODS.has(property)
          && node.arguments.some((argument) =>
            expressionReturnsScopedAuthority(argument)
          )
        ) {
          report(
            "context-storage",
            owner,
            node,
            "entry context is stored in a collection",
          );
        }
      }

      // Function expressions are declarations, not execution. Their bodies
      // are visited only by the direct-call, detached, async, or ingress
      // branches above, each with the correct phase.
      if (isFunctionExpressionLike(node)) return;
      ts.forEachChild(node, (child) => visit(child, phase));
    };

    try {
      visit(body, "active");
    } catch (cause) {
      if (cause instanceof RangeError) {
        throw new Error(
          `kernel entry-context audit recursion overflow in ${owner}`,
          { cause },
        );
      }
      throw cause;
    }
    return {
      calls,
      directEvalCalls,
      dynamicThisDispatches,
      hostEffects,
      indirectMethodReferences,
      directlyExportBearing,
    };
  };

  const collectLocalCallables = (
    body: ts.Node,
  ): Map<ts.Symbol, ts.ArrowFunction | ts.FunctionExpression> => {
    const callables =
      new Map<ts.Symbol, ts.ArrowFunction | ts.FunctionExpression>();
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && isFunctionExpressionLike(node.initializer)
      ) {
        const symbol = identifierSymbol(node.name);
        if (symbol !== null) callables.set(symbol, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(body);
    return callables;
  };

  for (const member of workerClass.members) {
    if (
      !ts.isMethodDeclaration(member)
      && !ts.isConstructorDeclaration(member)
    ) {
      if (
        ts.isPropertyDeclaration(member)
        && member.type?.getText(source).replace(/\s+/g, "")
          .match(
            /^(?:KernelWorkerEntryContext|null|undefined|\(|\)|\|)+$/,
          )
      ) {
        report(
          "context-storage",
          "CentralizedKernelWorker",
          member,
          "entry context may not be stored in an instance field",
        );
      }
      continue;
    }
    if (!member.body) continue;
    const name = ts.isConstructorDeclaration(member)
      ? "constructor"
      : propertyNameText(member.name, source);
    if (name === null) continue;
    const owner = formatOwner(member, source);
    const parameterIndex = contextParameterIndex(member);
    const contextName =
      parameterIdentifier(member, parameterIndex);
    const contextSymbol =
      parameterIndex === null
        ? null
        : identifierSymbol(member.parameters[parameterIndex]!.name);
    if (parameterIndex !== null && contextName === null) {
      report(
        "context-alias",
        owner,
        member.parameters[parameterIndex]!,
        "KernelWorkerEntryContext must use one explicit identifier parameter",
      );
    }
    if (
      parameterIndex !== null
      && member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      )
    ) {
      report(
        "scoped-method-async",
        owner,
        member,
        "a method receiving KernelWorkerEntryContext must be synchronous",
      );
    }
    if (
      name !== "#kernelEntryContext"
      && member.type?.getText(source).includes("KernelWorkerEntryContext")
    ) {
      report(
        "context-return",
        owner,
        member.type,
        "only #kernelEntryContext may construct and return an entry context",
      );
    }

    const scan = scanScope(
      member.body,
      owner,
      contextName,
      contextSymbol,
      collectLocalCallables(member.body),
    );
    methods.set(name, {
      ...scan,
      owner,
      contextName,
      contextSymbol,
      node: member,
      contextParameterIndex: parameterIndex,
    });
  }

  const collectRootScopes = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const methodName = resolvedThisMethodName(node);
      const operationIndex =
        methodName === null ? undefined : ROOT_INGRESS_METHODS.get(methodName);
      if (operationIndex !== undefined) {
        const operation = node.arguments[operationIndex];
        if (isFunctionExpressionLike(operation)) {
          const parameter = operation.parameters[0]?.name;
          if (parameter && ts.isIdentifier(parameter)) {
            const owner =
              `CentralizedKernelWorker.<scoped-root@${sourceLine(source, operation)}>`;
            const contextSymbol = identifierSymbol(parameter);
            const scan = scanScope(
              operation.body,
              owner,
              parameter.text,
              contextSymbol,
              collectLocalCallables(operation.body),
            );
            rootScopes.push({
              owner,
              contextName: parameter.text,
              contextSymbol,
              calls: scan.calls,
              directEvalCalls: scan.directEvalCalls,
              dynamicThisDispatches: scan.dynamicThisDispatches,
              hostEffects: scan.hostEffects,
              indirectMethodReferences: scan.indirectMethodReferences,
            });
          }
        }
      }
    }
    ts.forEachChild(node, collectRootScopes);
  };
  collectRootScopes(workerClass);

  const exportBearing = new Set<string>();
  for (const [name, method] of methods) {
    if (method.directlyExportBearing) exportBearing.add(name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, method] of methods) {
      if (
        !exportBearing.has(name)
        && method.calls.some(
          (call) =>
            call.phase === "active"
            && !ROOT_INGRESS_METHODS.has(call.callee)
            && exportBearing.has(call.callee),
        )
      ) {
        exportBearing.add(name);
        changed = true;
      }
    }
  }

  // Observer effects may notify materialized host observers, but they must not
  // publish a channel, relisten, open another kernel ingress, or fatalize the
  // generation. Follow ordinary private-method calls from those protocol roots
  // so moving the operation behind a helper cannot evade the contract.
  const protocolBearing = new Set<string>();
  for (const name of PROTOCOL_EFFECT_ROOT_METHODS) {
    if (methods.has(name)) protocolBearing.add(name);
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const [name, method] of methods) {
      if (
        !protocolBearing.has(name)
        && method.calls.some(
          (call) =>
            call.phase === "active" && protocolBearing.has(call.callee),
        )
      ) {
        protocolBearing.add(name);
        changed = true;
      }
    }
  }

  const inspectExplicitEdges = (scope: ScopeScan): void => {
    for (const call of scope.calls) {
      const target = methods.get(call.callee);
      if (
        call.phase === "detached-observer"
        && protocolBearing.has(call.callee)
      ) {
        report(
          "protocol-effect-from-observer",
          scope.owner,
          call.node,
          `${call.callee} reaches protocol publication, relisten, `
            + "kernel ingress, or fatalization from an observer effect",
        );
      }
      if (detachedEffectKind(call.phase) !== null) {
        if (
          exportBearing.has(call.callee)
          && !ENTRY_SELECTORS.has(call.callee)
          && call.callee !== "#invokeEntryScratchExport"
        ) {
          report(
            "export-from-detached-effect",
            scope.owner,
            call.node,
            `${call.callee} reaches a kernel export after scope revocation`,
          );
        }
        continue;
      }
      if (
        call.phase === "async-fresh"
        || call.phase === "transaction-continuation"
      ) {
        // An asynchronous listener owns no prior entry context. Opening one of
        // the two reviewed lexical ingress methods is exactly how it may
        // regain export authority.
        if (ROOT_INGRESS_METHODS.has(call.callee)) {
          if (
            call.phase === "transaction-continuation"
            && call.callee !== "#runOrDeferChannelKernelEntry"
          ) {
            report(
              "transaction-continuation-without-channel-ingress",
              scope.owner,
              call.node,
              "protocol transaction completion must use the channel ingress "
                + "that validates exact registration and CH_PENDING",
            );
          }
          continue;
        }
        if (
          exportBearing.has(call.callee)
          && !ENTRY_SELECTORS.has(call.callee)
          && call.callee !== "#invokeEntryScratchExport"
        ) {
          report(
            "async-export-without-ingress",
            scope.owner,
            call.node,
            `${call.callee} reaches a kernel export from an async callback without a fresh ingress`,
          );
        }
        continue;
      }
      if (!target) continue;
      const requiresExplicitEntry =
        target.contextParameterIndex !== null
        || exportBearing.has(call.callee);
      if (!requiresExplicitEntry) continue;
      if (target.contextParameterIndex === null) {
        report(
          "export-call-without-entry-channel",
          scope.owner,
          call.node,
          `${call.callee} reaches a kernel export but declares no entry parameter`,
        );
        continue;
      }
      if (
        scope.contextSymbol === null
        || !exactSymbolIdentifier(
          call.node.arguments[target.contextParameterIndex],
          scope.contextSymbol,
        )
      ) {
        report(
          "missing-explicit-entry",
          scope.owner,
          call.node,
          `${call.callee} must receive the exact lexical entry argument`,
        );
      }
    }
  };
  const inspectIndirectReferences = (
    scope: ScopeScan,
    foundationalOnly: boolean,
  ): void => {
    for (const reference of scope.indirectMethodReferences) {
      if (
        !methods.has(reference.method)
        || (
          foundationalOnly
          && !FOUNDATIONAL_ENTRY_METHODS.has(reference.method)
        )
      ) {
        continue;
      }
      report(
        "indirect-entry-authority",
        scope.owner,
        reference.node,
        `${reference.method} may only be invoked as a direct method call`,
      );
    }
  };
  const inspectOpaqueEntryOperations = (scope: ScopeScan): void => {
    for (const call of scope.dynamicThisDispatches) {
      report(
        "dynamic-entry-method-dispatch",
        scope.owner,
        call.node,
        "computed this[...] dispatch in the entry graph must resolve from "
          + "an exact immutable literal or use a direct reviewed method call",
      );
    }
    for (const call of scope.directEvalCalls) {
      report(
        "direct-eval-in-entry-graph",
        scope.owner,
        call,
        "direct eval may capture lexical entry authority while hiding export "
          + "selection from the static entry graph",
      );
    }
  };
  const opaqueOperationReachable = new Set<string>();
  const opaqueOperationQueue: string[] = [];
  const enqueueOpaqueOperationCalls = (scope: ScopeScan): void => {
    for (const call of scope.calls) {
      if (
        methods.has(call.callee)
        && !opaqueOperationReachable.has(call.callee)
      ) {
        opaqueOperationReachable.add(call.callee);
        opaqueOperationQueue.push(call.callee);
      }
    }
  };
  for (const root of rootScopes) {
    inspectOpaqueEntryOperations(root);
    enqueueOpaqueOperationCalls(root);
  }
  while (opaqueOperationQueue.length > 0) {
    const method = methods.get(opaqueOperationQueue.shift()!);
    if (!method) continue;
    inspectOpaqueEntryOperations(method);
    enqueueOpaqueOperationCalls(method);
  }
  // A context-bearing method is itself an authority boundary even before a
  // current root reaches it. This prevents a later direct call from activating
  // opaque dispatch or eval that was already present but outside today's graph.
  for (const method of methods.values()) {
    if (method.contextParameterIndex !== null) {
      inspectOpaqueEntryOperations(method);
    }
  }
  const reachable = new Set<string>();
  const queue: string[] = [];
  const enqueueCalls = (scope: ScopeScan): void => {
    for (const call of scope.calls) {
      if (
        call.phase === "active"
        && methods.has(call.callee)
        && !reachable.has(call.callee)
      ) {
        reachable.add(call.callee);
        queue.push(call.callee);
      }
    }
  };
  for (const root of rootScopes) {
    for (const effect of root.hostEffects) {
      report(
        "host-effect-in-scoped-graph",
        root.owner,
        effect.node,
        effect.description,
      );
    }
    inspectIndirectReferences(root, false);
    enqueueCalls(root);
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    const method = methods.get(name);
    if (!method) continue;
    enqueueCalls(method);
  }
  for (const name of reachable) {
    const method = methods.get(name);
    if (!method) continue;
    for (const effect of method.hostEffects) {
      report(
        "host-effect-in-scoped-graph",
        method.owner,
        effect.node,
        effect.description,
      );
    }
    inspectIndirectReferences(method, false);
  }
  for (const method of methods.values()) {
    inspectIndirectReferences(method, true);
  }
  for (const root of rootScopes) inspectExplicitEdges(root);
  // Export authority is a local contract, not merely a property of methods
  // currently reachable from the known ingress roots. A newly registered
  // timer, MessagePort listener, EventEmitter callback, or host callback
  // object can enter any method later, so every selector/caller method must
  // independently prove its exact lexical entry edge.
  for (const method of methods.values()) inspectExplicitEdges(method);

  if (!prototypeDispatchIsStable) {
    const entryGraphReachable = new Set<string>();
    const entryGraphQueue: string[] = [];
    const enqueueEntryGraphCalls = (scope: ScopeScan): void => {
      for (const call of scope.calls) {
        if (
          methods.has(call.callee)
          && !entryGraphReachable.has(call.callee)
        ) {
          entryGraphReachable.add(call.callee);
          entryGraphQueue.push(call.callee);
        }
      }
    };
    for (const root of rootScopes) enqueueEntryGraphCalls(root);
    while (entryGraphQueue.length > 0) {
      const method = methods.get(entryGraphQueue.shift()!);
      if (method) enqueueEntryGraphCalls(method);
    }
    const inspectPrototypeDispatch = (scope: ScopeScan): void => {
      for (const call of scope.calls) {
        if (
          call.callee.startsWith("#")
          || !methods.has(call.callee)
        ) {
          continue;
        }
        report(
          "mutable-entry-method-dispatch",
          scope.owner,
          call.node,
          `${call.callee} uses mutable prototype dispatch in the entry graph; `
            + "seal each worker instance and freeze "
            + "CentralizedKernelWorker.prototype through captured intrinsics, "
            + "and reject subclass construction",
        );
      }
    };
    for (const root of rootScopes) inspectPrototypeDispatch(root);
    for (const name of entryGraphReachable) {
      const method = methods.get(name);
      if (method) inspectPrototypeDispatch(method);
    }
  }

  return violations.sort(
    (left, right) =>
      left.line - right.line
      || left.kind.localeCompare(right.kind)
      || left.text.localeCompare(right.text),
  );
}

export function formatKernelEntryContextViolations(
  violations: readonly KernelEntryContextViolation[],
): string[] {
  return violations.map(
    ({ kind, owner, line, text }) =>
      `${kind} at ${owner}:${line}: ${text}`,
  );
}
