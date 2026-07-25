import {
  readdirSync,
} from "node:fs";
import path from "node:path";
import ts from "typescript";

export type MemoryOwner =
  | "kernel"
  | "process-memory"
  | "framebuffer"
  | "shared-memory"
  | "rust-lent";

export type OwnershipForm =
  | "memory"
  | "buffer"
  | "view";

export interface OwnershipSeed {
  /**
   * Exact `repo/relative/file.ts::Qualified.declaration` key.
   *
   * Wildcards are intentionally unsupported: adding a new owner must produce
   * a visible, narrowly reviewed contract change.
   */
  declaration: string;
  target: "value" | "return";
  owner: MemoryOwner;
  form: OwnershipForm;
  why: string;
}

export interface AuditAllowance {
  /** Exact key returned in {@link AuditFinding.key}. */
  key: string;
  disposition:
    | "scratch-core"
    | "rust-lent"
    | "kernel-read"
    | "kernel-control";
  /** Exact number of structurally identical sites admitted by this entry. */
  count?: number;
  why: string;
}

export interface AuditFinding {
  key: string;
  file: string;
  enclosing: string;
  kind:
    | "kernel-view"
    | "kernel-write"
    | "kernel-view-escape"
    | "kernel-view-return"
    | "kernel-view-store"
    | "kernel-buffer-escape"
    | "kernel-buffer-return"
    | "kernel-buffer-store"
    | "kernel-memory-escape"
    | "kernel-memory-return"
    | "kernel-memory-store"
    | "scratch-allocator-call"
    | "spawn-reservation-call";
  line: number;
  text: string;
}

export interface AuditResult {
  findings: AuditFinding[];
  violations: AuditFinding[];
  unusedAllowances: AuditAllowance[];
  unresolvedSeeds: OwnershipSeed[];
  sourceFiles: string[];
}

export interface AuditOptions {
  rootDir: string;
  sourceFiles: string[];
  ownershipSeeds: readonly OwnershipSeed[];
  allowances?: readonly AuditAllowance[];
  compilerOptions?: ts.CompilerOptions;
  virtualSources?: ReadonlyMap<string, string>;
}

type StateKey = ts.Symbol | ts.FunctionLikeDeclaration;

interface ValueState {
  memory: number;
  buffer: number;
  view: number;
  allocator: boolean;
  reserver: boolean;
  viewConstructors: number;
  properties: Map<string, ValueState>;
  hiddenProperties: Map<string, ValueState>;
  elements: ValueState | null;
}

type StateProjection =
  | { kind: "property"; name: string }
  | { kind: "element" };

interface Constraint {
  target: StateKey;
  expression: ts.Expression;
  projection?: readonly StateProjection[];
}

interface DeclarationTarget {
  value?: ts.Symbol;
  returns?: ts.FunctionLikeDeclaration;
}

const EMPTY_STATE: ValueState = Object.freeze({
  memory: 0,
  buffer: 0,
  view: 0,
  allocator: false,
  reserver: false,
  viewConstructors: 0,
  properties: new Map(),
  hiddenProperties: new Map(),
  elements: null,
});

const OWNER_BITS: Record<MemoryOwner, number> = {
  kernel: 1 << 0,
  "process-memory": 1 << 1,
  framebuffer: 1 << 2,
  "shared-memory": 1 << 3,
  "rust-lent": 1 << 4,
};

const KERNEL_OWNER = OWNER_BITS.kernel;
const TYPED_ARRAY_CONSTRUCTOR = 1 << 0;
const DATA_VIEW_CONSTRUCTOR = 1 << 1;
const TYPE_PROPERTIES = new WeakMap<ts.Type, readonly ts.Symbol[]>();
const INTRINSIC_ARRAY_METHODS = new WeakMap<
  ts.CallExpression,
  string | null
>();
const ARRAY_ELEMENT_RETURNING_METHODS = new Set([
  "at",
  "find",
  "findLast",
  "pop",
  "shift",
]);
const ARRAY_ELEMENT_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findLast",
  "forEach",
  "map",
  "some",
]);

const TYPED_ARRAY_CONSTRUCTORS = new Set([
  "BigInt64Array",
  "BigUint64Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
]);

const TYPED_ARRAY_MUTATORS = new Set([
  "copyWithin",
  "fill",
  "reverse",
  "set",
  "sort",
]);

const ATOMIC_MUTATORS = new Set([
  "add",
  "and",
  "compareExchange",
  "exchange",
  "or",
  "store",
  "sub",
  "xor",
]);

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "test-results",
]);

function emptyState(): ValueState {
  return {
    memory: 0,
    buffer: 0,
    view: 0,
    allocator: false,
    reserver: false,
    viewConstructors: 0,
    properties: new Map(),
    hiddenProperties: new Map(),
    elements: null,
  };
}

function ownerState(owner: MemoryOwner, form: OwnershipForm): ValueState {
  const state = emptyState();
  state[form] = OWNER_BITS[owner];
  return state;
}

function cloneState(state: ValueState): ValueState {
  const result: ValueState = {
    memory: state.memory,
    buffer: state.buffer,
    view: state.view,
    allocator: state.allocator,
    reserver: state.reserver,
    viewConstructors: state.viewConstructors,
    properties: new Map(),
    hiddenProperties: new Map(),
    elements: state.elements ? cloneState(state.elements) : null,
  };
  for (const [name, property] of state.properties) {
    result.properties.set(name, cloneState(property));
  }
  for (const [name, property] of state.hiddenProperties) {
    result.hiddenProperties.set(name, cloneState(property));
  }
  return result;
}

function unionState(into: ValueState, other: ValueState): boolean {
  const beforeMemory = into.memory;
  const beforeBuffer = into.buffer;
  const beforeView = into.view;
  const beforeAllocator = into.allocator;
  const beforeReserver = into.reserver;
  const beforeViewConstructors = into.viewConstructors;
  into.memory |= other.memory;
  into.buffer |= other.buffer;
  into.view |= other.view;
  into.allocator ||= other.allocator;
  into.reserver ||= other.reserver;
  into.viewConstructors |= other.viewConstructors;
  let changed = (
    beforeMemory !== into.memory
    || beforeBuffer !== into.buffer
    || beforeView !== into.view
    || beforeAllocator !== into.allocator
    || beforeReserver !== into.reserver
    || beforeViewConstructors !== into.viewConstructors
  );
  for (const [name, property] of other.properties) {
    const existing = into.properties.get(name);
    if (existing) {
      changed = unionState(existing, property) || changed;
    } else {
      into.properties.set(name, cloneState(property));
      changed = true;
    }
  }
  for (const [name, property] of other.hiddenProperties) {
    const existing = into.hiddenProperties.get(name);
    if (existing) {
      changed = unionState(existing, property) || changed;
    } else {
      into.hiddenProperties.set(name, cloneState(property));
      changed = true;
    }
  }
  if (other.elements) {
    if (into.elements) {
      changed = unionState(into.elements, other.elements) || changed;
    } else {
      into.elements = cloneState(other.elements);
      changed = true;
    }
  }
  return changed;
}

function unionMany(states: Iterable<ValueState>): ValueState {
  const result = emptyState();
  for (const state of states) unionState(result, state);
  return result;
}

function hasCapability(
  state: ValueState,
  seen = new Set<ValueState>(),
): boolean {
  if (seen.has(state)) return false;
  seen.add(state);
  if (
    state.memory !== 0
    || state.buffer !== 0
    || state.view !== 0
    || state.allocator
    || state.reserver
    || state.viewConstructors !== 0
  ) {
    return true;
  }
  for (const property of state.properties.values()) {
    if (hasCapability(property, seen)) return true;
  }
  for (const property of state.hiddenProperties.values()) {
    if (hasCapability(property, seen)) return true;
  }
  return state.elements ? hasCapability(state.elements, seen) : false;
}

function propertyState(state: ValueState, name: string): ValueState {
  const result = cloneState(state.properties.get(name) ?? EMPTY_STATE);
  unionState(result, state.hiddenProperties.get(name) ?? EMPTY_STATE);
  if (name === "buffer") {
    result.buffer |= state.memory | state.view;
  }
  return result;
}

function elementState(state: ValueState): ValueState {
  const result = cloneState(state.elements ?? EMPTY_STATE);
  for (const property of state.properties.values()) {
    unionState(result, property);
  }
  for (const property of state.hiddenProperties.values()) {
    unionState(result, property);
  }
  return result;
}

function projectState(
  state: ValueState,
  projections: readonly StateProjection[] | undefined,
): ValueState {
  let result = cloneState(state);
  for (const projection of projections ?? []) {
    result = projection.kind === "property"
      ? propertyState(result, projection.name)
      : elementState(result);
  }
  return result;
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

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function accessedPropertyName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  const argument = expression.argumentExpression;
  return argument
    && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ? argument.text
    : null;
}

function normalizeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").trim();
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function relativeFile(rootDir: string, sourceFile: ts.SourceFile): string {
  return toPosix(path.relative(rootDir, sourceFile.fileName));
}

function namedDeclarationPart(node: ts.Node): string | null {
  if (
    ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)
    || ts.isModuleDeclaration(node)
  ) {
    return node.name?.getText() ?? null;
  }
  if (
    ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
  ) {
    return propertyNameText(node.name) ?? null;
  }
  return null;
}

function enclosingDeclarationParts(node: ts.Node): string[] {
  const parts: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const part = namedDeclarationPart(current);
    if (part) parts.push(part);
  }
  return parts.reverse();
}

function declarationName(node: ts.Declaration): string | null {
  if (
    ts.isVariableDeclaration(node)
    || ts.isPropertyDeclaration(node)
    || ts.isPropertySignature(node)
    || ts.isParameter(node)
    || ts.isBindingElement(node)
  ) {
    return ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (
    ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
  ) {
    return propertyNameText(node.name);
  }
  return null;
}

function declarationKey(
  rootDir: string,
  sourceFile: ts.SourceFile,
  declaration: ts.Declaration,
): string | null {
  const name = declarationName(declaration);
  if (!name) return null;
  const parts = enclosingDeclarationParts(declaration);
  if (ts.isParameter(declaration)) {
    parts.push(`$param:${name}`);
  } else if (parts.at(-1) !== name) {
    parts.push(name);
  }
  return `${relativeFile(rootDir, sourceFile)}::${parts.join(".")}`;
}

function callableName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isConstructorDeclaration(current)) {
      const container = enclosingDeclarationParts(current).join(".");
      return container ? `${container}.constructor` : "constructor";
    }
    if (
      ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
    ) {
      const method = propertyNameText(current.name) ?? "<computed>";
      const container = enclosingDeclarationParts(current).join(".");
      return container ? `${container}.${method}` : method;
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      const container = enclosingDeclarationParts(current).join(".");
      return container
        ? `${container}.${current.name.text}`
        : current.name.text;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)
    ) {
      const container = enclosingDeclarationParts(current.parent).join(".");
      return container
        ? `${container}.${current.parent.name.text}`
        : current.parent.name.text;
    }
  }
  return "<module>";
}

function sourceScriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createProgram(options: AuditOptions): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    ...options.compilerOptions,
  };
  if (!options.virtualSources) {
    return ts.createProgram({
      rootNames: options.sourceFiles,
      options: compilerOptions,
    });
  }

  const normalizedVirtualSources = new Map<string, string>();
  for (const [fileName, source] of options.virtualSources) {
    normalizedVirtualSources.set(path.resolve(fileName), source);
  }
  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    directoryExists(directoryName) {
      const resolved = path.resolve(directoryName);
      for (const fileName of normalizedVirtualSources.keys()) {
        if (fileName.startsWith(`${resolved}${path.sep}`)) return true;
      }
      return baseHost.directoryExists?.(directoryName) ?? false;
    },
    fileExists(fileName) {
      return normalizedVirtualSources.has(path.resolve(fileName))
        || baseHost.fileExists(fileName);
    },
    readFile(fileName) {
      return normalizedVirtualSources.get(path.resolve(fileName))
        ?? baseHost.readFile(fileName);
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const source = normalizedVirtualSources.get(path.resolve(fileName));
      if (source !== undefined) {
        return ts.createSourceFile(
          fileName,
          source,
          languageVersion,
          true,
          sourceScriptKind(fileName),
        );
      }
      return baseHost.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };
  return ts.createProgram({
    rootNames: options.sourceFiles,
    options: compilerOptions,
    host,
  });
}

function isParameterProperty(
  declaration: ts.Declaration,
): declaration is ts.ParameterDeclaration {
  return ts.isParameter(declaration)
    && ts.isIdentifier(declaration.name)
    && ts.isConstructorDeclaration(declaration.parent)
    && Boolean(
      declaration.modifiers?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.PublicKeyword
        || modifier.kind === ts.SyntaxKind.PrivateKeyword
        || modifier.kind === ts.SyntaxKind.ProtectedKeyword
        || modifier.kind === ts.SyntaxKind.ReadonlyKeyword
      ),
    );
}

function canonicalSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }
  const parameterProperty = symbol.declarations?.find(isParameterProperty);
  if (parameterProperty) {
    // TypeScript can materialize distinct symbols for the declaration name,
    // the bare constructor parameter, and `this.property`. They are one
    // runtime slot, so normalize all three to the declaration-name symbol.
    return checker.getSymbolAtLocation(parameterProperty.name) ?? symbol;
  }
  return symbol;
}

function symbolAtExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return canonicalSymbol(checker, checker.getSymbolAtLocation(unwrapped));
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const direct = canonicalSymbol(
      checker,
      checker.getSymbolAtLocation(unwrapped.name),
    );
    if (direct) return direct;
    const receiverType = checker.getTypeAtLocation(
      unwrapExpression(unwrapped.expression),
    );
    return canonicalSymbol(
      checker,
      checker.getPropertyOfType(receiverType, unwrapped.name.text),
    );
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const name = accessedPropertyName(unwrapped);
    if (!name) return undefined;
    const type = checker.getTypeAtLocation(
      unwrapExpression(unwrapped.expression),
    );
    return canonicalSymbol(checker, checker.getPropertyOfType(type, name));
  }
  return undefined;
}

function symbolForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): ts.Symbol | undefined {
  const name = (declaration as ts.NamedDeclaration).name;
  return name
    ? canonicalSymbol(checker, checker.getSymbolAtLocation(name))
    : undefined;
}

function parameterPropertySymbol(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): ts.Symbol | undefined {
  if (!isParameterProperty(parameter)) {
    return undefined;
  }
  const classDeclaration = parameter.parent.parent;
  const classSymbol = classDeclaration.name
    ? canonicalSymbol(
        checker,
        checker.getSymbolAtLocation(classDeclaration.name),
      )
    : undefined;
  if (!classSymbol) return undefined;
  return canonicalSymbol(
    checker,
    checker.getPropertyOfType(
      checker.getDeclaredTypeOfSymbol(classSymbol),
      parameter.name.text,
    ),
  );
}

function hasBody(
  declaration: ts.SignatureDeclaration | undefined,
): declaration is ts.FunctionLikeDeclaration {
  return Boolean(
    declaration
    && "body" in declaration
    && declaration.body,
  );
}

function callbackDeclarations(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration[] {
  const node = unwrapExpression(expression);
  const declarations = new Set<ts.FunctionLikeDeclaration>();
  if (
    ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
  ) {
    declarations.add(node);
  }
  const type = checker.getTypeAtLocation(node);
  for (
    const signature of checker.getSignaturesOfType(
      type,
      ts.SignatureKind.Call,
    )
  ) {
    if (hasBody(signature.declaration)) {
      declarations.add(signature.declaration);
    }
  }
  return [...declarations];
}

function isInProgram(
  programSourceFiles: ReadonlySet<ts.SourceFile>,
  node: ts.Node,
): boolean {
  return programSourceFiles.has(node.getSourceFile());
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

function isSimpleAssignment(node: ts.BinaryExpression): boolean {
  return node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function typedArrayConstructorName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return null;
}

function isIntrinsicLibDeclaration(
  declaration: ts.Declaration,
): boolean {
  const sourceFile = declaration.getSourceFile();
  return sourceFile.isDeclarationFile
    && /^lib\..*\.d\.ts$/.test(path.basename(sourceFile.fileName));
}

function hasIntrinsicLibValueDeclaration(
  symbol: ts.Symbol | undefined,
): boolean {
  return Boolean(
    symbol?.valueDeclaration
    && isIntrinsicLibDeclaration(symbol.valueDeclaration),
  );
}

function intrinsicViewConstructorBits(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): number {
  const name = typedArrayConstructorName(expression);
  if (
    name !== "DataView"
    && (!name || !TYPED_ARRAY_CONSTRUCTORS.has(name))
  ) {
    return 0;
  }
  const symbol = symbolAtExpression(checker, expression);
  if (!hasIntrinsicLibValueDeclaration(symbol)) {
    return 0;
  }
  return name === "DataView"
    ? DATA_VIEW_CONSTRUCTOR
    : TYPED_ARRAY_CONSTRUCTOR;
}

function isIntrinsicBufferFrom(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callee = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee)
    || callee.name.text !== "from"
    || callee.expression.getText(call.getSourceFile()) !== "Buffer"
  ) {
    return false;
  }
  const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
  return Boolean(
    signatureDeclaration?.getSourceFile().isDeclarationFile
    && signatureOwnerName(signatureDeclaration) === "BufferConstructor",
  );
}

function intrinsicArrayMethod(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): string | null {
  const cached = INTRINSIC_ARRAY_METHODS.get(call);
  if (cached !== undefined) return cached;
  const method = callPropertyName(call);
  if (
    !method
    || (
      !ARRAY_ELEMENT_RETURNING_METHODS.has(method)
      && !ARRAY_ELEMENT_CALLBACK_METHODS.has(method)
    )
  ) {
    INTRINSIC_ARRAY_METHODS.set(call, null);
    return null;
  }
  const declaration = checker.getResolvedSignature(call)?.declaration;
  const owner = signatureOwnerName(declaration);
  const result = (
    declaration
    && isIntrinsicLibDeclaration(declaration)
    && (owner === "Array" || owner === "ReadonlyArray")
  )
    ? method
    : null;
  INTRINSIC_ARRAY_METHODS.set(call, result);
  return result;
}

function returnFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function isPersistentStoreTarget(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  assignment: ts.Node,
): boolean {
  const node = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(node)
    || ts.isElementAccessExpression(node)
  ) {
    return true;
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return isPersistentStoreTarget(property.name, checker, assignment);
      }
      if (ts.isPropertyAssignment(property)) {
        return isPersistentStoreTarget(
          property.initializer,
          checker,
          assignment,
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return isPersistentStoreTarget(
          property.expression,
          checker,
          assignment,
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) =>
      !ts.isOmittedExpression(element)
      && isPersistentStoreTarget(
        ts.isSpreadElement(element) ? element.expression : element,
        checker,
        assignment,
      )
    );
  }
  if (!ts.isIdentifier(node)) return false;
  const symbol = symbolAtExpression(checker, node);
  const assignmentFunction = returnFunction(assignment);
  return Boolean(
    symbol?.declarations?.some((declaration) =>
      returnFunction(declaration) !== assignmentFunction
    ),
  );
}

function stateFor(
  states: Map<StateKey, ValueState>,
  key: StateKey | undefined,
): ValueState {
  return key ? states.get(key) ?? EMPTY_STATE : EMPTY_STATE;
}

function mergeIntoKey(
  states: Map<StateKey, ValueState>,
  key: StateKey,
  state: ValueState,
): boolean {
  let target = states.get(key);
  if (!target) {
    target = emptyState();
    states.set(key, target);
  }
  return unionState(target, state);
}

function hydrateTypeProperties(
  state: ValueState,
  expression: ts.Expression,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
): ValueState {
  const result = cloneState(state);
  const type = checker.getTypeAtLocation(expression);
  let properties = TYPE_PROPERTIES.get(type);
  if (!properties) {
    properties = checker.getPropertiesOfType(type);
    TYPE_PROPERTIES.set(type, properties);
  }
  for (const property of properties) {
    const hardPrivate = property.declarations?.some((declaration) => {
      const name = (declaration as ts.NamedDeclaration).name;
      return Boolean(name && ts.isPrivateIdentifier(name));
    });
    if (hardPrivate) continue;
    const hidden = Boolean(
      property.declarations?.some((declaration) =>
        ts.canHaveModifiers(declaration)
        && ts.getModifiers(declaration)?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword
            || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
        )
      ),
    );
    const value = stateFor(states, canonicalSymbol(checker, property));
    if (!hasCapability(value)) continue;
    // WHY: private/protected TypeScript slots must remain selectable through
    // explicit diagnostic casts, but must not make the whole owning wrapper a
    // raw-memory escape. Object spread promotes these ordinary runtime fields.
    const target = hidden ? result.hiddenProperties : result.properties;
    const existing = target.get(property.name);
    if (existing) unionState(existing, value);
    else target.set(property.name, cloneState(value));
  }
  return result;
}

function propertyIs(
  expression: ts.Expression,
  expected: string,
): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    (ts.isPropertyAccessExpression(unwrapped)
      || ts.isElementAccessExpression(unwrapped))
    && accessedPropertyName(unwrapped) === expected
  );
}

function expressionState(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
  programSources: ReadonlySet<ts.SourceFile>,
): ValueState {
  const node = unwrapExpression(expression);
  if (ts.isSpreadElement(node)) {
    // A spread call/new argument passes the elements, not the container.
    // WHY: dropping this projection lets `opaque(...[kernelView])` hide the
    // same live view that `opaque(kernelView)` exposes directly.
    return elementState(
      expressionState(node.expression, checker, states, programSources),
    );
  }
  const direct = ts.isIdentifier(node)
    && ts.isShorthandPropertyAssignment(node.parent)
    && node.parent.name === node
    ? canonicalSymbol(
        checker,
        checker.getShorthandAssignmentValueSymbol(node.parent),
      )
    : symbolAtExpression(checker, node);
  const directState = cloneState(stateFor(states, direct));
  directState.viewConstructors |= intrinsicViewConstructorBits(node, checker);
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
  ) {
    const property = accessedPropertyName(node);
    if (property === "kernel_alloc_scratch") {
      directState.allocator = true;
    } else if (
      property === "kernel_spawn_scratch_begin"
      || property === "kernel_spawn_scratch_pointer"
      || property === "kernel_spawn_scratch_capacity"
      || property === "kernel_spawn_scratch_cancel"
    ) {
      directState.reserver = true;
    }
  }

  if (ts.isConditionalExpression(node)) {
    return unionMany([
      directState,
      expressionState(node.whenTrue, checker, states, programSources),
      expressionState(node.whenFalse, checker, states, programSources),
    ]);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // The comma expression evaluates to its right operand.
      return unionMany([
        directState,
        expressionState(node.right, checker, states, programSources),
      ]);
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      // A logical expression can return either operand without copying it.
      return unionMany([
        directState,
        expressionState(node.left, checker, states, programSources),
        expressionState(node.right, checker, states, programSources),
      ]);
    }
  }
  if (ts.isBinaryExpression(node) && isSimpleAssignment(node)) {
    return unionMany([
      directState,
      expressionState(node.right, checker, states, programSources),
    ]);
  }
  if (ts.isAwaitExpression(node)) {
    return unionMany([
      directState,
      expressionState(node.expression, checker, states, programSources),
    ]);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return unionMany([directState, stateFor(states, node)]);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = cloneState(directState);
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        const value = expressionState(
          property.initializer,
          checker,
          states,
          programSources,
        );
        if (!hasCapability(value)) continue;
        if (!name) {
          if (result.elements) unionState(result.elements, value);
          else result.elements = cloneState(value);
          continue;
        }
        const existing = result.properties.get(name);
        if (existing) unionState(existing, value);
        else result.properties.set(name, value);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        // getSymbolAtLocation(name) denotes the object-literal property. The
        // shorthand value symbol is the outer binding that actually carries
        // ownership into the new container.
        const value = cloneState(
          stateFor(
            states,
            canonicalSymbol(
              checker,
              checker.getShorthandAssignmentValueSymbol(property),
            ),
          ),
        );
        if (!hasCapability(value)) continue;
        const existing = result.properties.get(property.name.text);
        if (existing) unionState(existing, value);
        else result.properties.set(property.name.text, value);
      } else if (ts.isSpreadAssignment(property)) {
        const spread = expressionState(
          property.expression,
          checker,
          states,
          programSources,
        );
        for (const [name, value] of spread.properties) {
          const existing = result.properties.get(name);
          if (existing) unionState(existing, value);
          else result.properties.set(name, cloneState(value));
        }
        for (const [name, value] of spread.hiddenProperties) {
          const existing = result.properties.get(name);
          if (existing) unionState(existing, value);
          else result.properties.set(name, cloneState(value));
        }
        if (spread.elements) {
          if (result.elements) {
            unionState(result.elements, spread.elements);
          } else {
            result.elements = cloneState(spread.elements);
          }
        }
      } else if (
        ts.isMethodDeclaration(property)
        || ts.isGetAccessorDeclaration(property)
      ) {
        const name = propertyNameText(property.name);
        if (!name) continue;
        const value = cloneState(stateFor(states, property));
        if (!hasCapability(value)) continue;
        const existing = result.properties.get(name);
        if (existing) unionState(existing, value);
        else result.properties.set(name, value);
      }
    }
    return result;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const result = cloneState(directState);
    for (const element of node.elements) {
      let value: ValueState;
      if (ts.isSpreadElement(element)) {
        value = elementState(
          expressionState(element.expression, checker, states, programSources),
        );
      } else if (ts.isOmittedExpression(element)) {
        continue;
      } else {
        value = expressionState(element, checker, states, programSources);
      }
      if (!hasCapability(value)) continue;
      if (result.elements) unionState(result.elements, value);
      else result.elements = cloneState(value);
    }
    return result;
  }
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
  ) {
    const receiver = expressionState(
      node.expression,
      checker,
      states,
      programSources,
    );
    const property = accessedPropertyName(node);
    const numericIndex = ts.isElementAccessExpression(node)
      && node.argumentExpression
      && ts.isNumericLiteral(node.argumentExpression);
    const selected = numericIndex
      ? unionMany([
          receiver.elements ?? EMPTY_STATE,
          property === null ? EMPTY_STATE : propertyState(receiver, property),
        ])
      : property === null
        ? elementState(receiver)
        : propertyState(receiver, property);
    const result = cloneState(directState);
    unionState(result, selected);
    return result;
  }
  if (ts.isNewExpression(node)) {
    const constructor = expressionState(
      node.expression,
      checker,
      states,
      programSources,
    );
    if (constructor.viewConstructors !== 0) {
      const source = node.arguments?.[0]
        ? expressionState(node.arguments[0], checker, states, programSources)
        : EMPTY_STATE;
      const result = cloneState(directState);
      // A TypedArray constructed from another TypedArray copies. A DataView
      // or TypedArray constructed from an ArrayBufferLike aliases it.
      result.view |= source.buffer;
      result.memory = 0;
      result.buffer = 0;
      result.properties.clear();
      result.elements = null;
      return result;
    }
    return hydrateTypeProperties(directState, node, checker, states);
  }
  if (ts.isCallExpression(node)) {
    if (propertyIs(node.expression, "subarray")) {
      const receiver = unwrapExpression(node.expression);
      if (
        ts.isPropertyAccessExpression(receiver)
        || ts.isElementAccessExpression(receiver)
      ) {
        const source = expressionState(
          receiver.expression,
          checker,
          states,
          programSources,
        );
        const result = cloneState(directState);
        result.view |= source.view;
        result.memory = 0;
        result.buffer = 0;
        return result;
      }
    }
    if (isIntrinsicBufferFrom(node, checker)) {
      const source = node.arguments[0]
        ? expressionState(node.arguments[0], checker, states, programSources)
        : EMPTY_STATE;
      const result = cloneState(directState);
      result.view |= source.buffer;
      result.memory = 0;
      result.buffer = 0;
      return result;
    }
    const arrayMethod = intrinsicArrayMethod(node, checker);
    if (
      arrayMethod
      && (
        ARRAY_ELEMENT_RETURNING_METHODS.has(arrayMethod)
        || arrayMethod === "filter"
        || arrayMethod === "map"
      )
    ) {
      const receiver = callReceiver(node);
      const result = cloneState(directState);
      if (receiver) {
        const receiverElement = elementState(
          expressionState(receiver, checker, states, programSources),
        );
        if (ARRAY_ELEMENT_RETURNING_METHODS.has(arrayMethod)) {
          unionState(result, receiverElement);
        } else if (arrayMethod === "filter") {
          if (hasCapability(receiverElement)) {
            result.elements = receiverElement;
          }
        } else if (node.arguments[0]) {
          const mappedElement = expressionState(
            node.arguments[0],
            checker,
            states,
            programSources,
          );
          if (hasCapability(mappedElement)) {
            result.elements = mappedElement;
          }
        }
      }
      return result;
    }
    const signature = checker.getResolvedSignature(node);
    const declaration = signature?.declaration;
    const result = cloneState(directState);
    if (propertyIs(node.expression, "slice")) {
      const receiver = callReceiver(node);
      const owner = signatureOwnerName(declaration);
      const provenDetachedTypedArraySlice = Boolean(
        declaration
        && declaration.getSourceFile().isDeclarationFile
        && owner
        && TYPED_ARRAY_CONSTRUCTORS.has(owner),
      );
      if (receiver && !provenDetachedTypedArraySlice) {
        // WHY: Uint8Array#slice copies, but Buffer#slice and arbitrary custom
        // methods may alias. Method spelling alone cannot prove detachment.
        result.view |= expressionState(
          receiver,
          checker,
          states,
          programSources,
        ).view;
      }
    }
    if (declaration && isInProgram(programSources, declaration)) {
      unionState(result, stateFor(states, declaration));
    }
    // Higher-order callbacks retain the return capability in the parameter's
    // state. Calling such a parameter yields that capability.
    unionState(
      result,
      stateFor(states, symbolAtExpression(checker, node.expression)),
    );
    return result;
  }
  return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword
    ? hydrateTypeProperties(directState, node, checker, states)
    : directState;
}

function assignmentWritesKernelView(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
  programSources: ReadonlySet<ts.SourceFile>,
): boolean {
  const node = unwrapExpression(expression);
  if (ts.isElementAccessExpression(node)) {
    return isKernelView(
      expressionState(node.expression, checker, states, programSources),
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) =>
      !ts.isOmittedExpression(element)
      && assignmentWritesKernelView(
        ts.isSpreadElement(element) ? element.expression : element,
        checker,
        states,
        programSources,
      )
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return assignmentWritesKernelView(
          property.initializer,
          checker,
          states,
          programSources,
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentWritesKernelView(
          property.expression,
          checker,
          states,
          programSources,
        );
      }
      return false;
    });
  }
  // A default inside an assignment pattern is itself a nested assignment and
  // is visited independently, avoiding duplicate findings for one write.
  return false;
}

function findingFor(
  rootDir: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  kind: AuditFinding["kind"],
): AuditFinding {
  const file = relativeFile(rootDir, sourceFile);
  const enclosing = callableName(node);
  const text = normalizeText(node, sourceFile);
  const key = `${file}::${enclosing}::${kind}::${text}`;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return { key, file, enclosing, kind, line, text };
}

type KernelOwnershipForm = "memory" | "buffer" | "view";

function hasKernelOwnership(
  state: ValueState,
  form: KernelOwnershipForm,
): boolean {
  if ((state[form] & KERNEL_OWNER) !== 0) return true;
  for (const property of state.properties.values()) {
    if (hasKernelOwnership(property, form)) return true;
  }
  return state.elements
    ? hasKernelOwnership(state.elements, form)
    : false;
}

function isKernelView(state: ValueState): boolean {
  return (state.view & KERNEL_OWNER) !== 0;
}

function isKernelBuffer(state: ValueState): boolean {
  return (state.buffer & KERNEL_OWNER) !== 0;
}

function isKernelMemory(state: ValueState): boolean {
  return (state.memory & KERNEL_OWNER) !== 0;
}

function isViewConstructor(
  node: ts.Node,
  checker: ts.TypeChecker,
  states: Map<StateKey, ValueState>,
  programSources: ReadonlySet<ts.SourceFile>,
): node is ts.NewExpression | ts.CallExpression {
  if (ts.isNewExpression(node)) {
    return expressionState(
      node.expression,
      checker,
      states,
      programSources,
    ).viewConstructors !== 0;
  }
  return (
    ts.isCallExpression(node)
    && isIntrinsicBufferFrom(node, checker)
  );
}

function callPropertyName(call: ts.CallExpression): string | null {
  const callee = unwrapExpression(call.expression);
  return (
    ts.isPropertyAccessExpression(callee)
    || ts.isElementAccessExpression(callee)
  )
    ? accessedPropertyName(callee)
    : null;
}

function callReceiver(call: ts.CallExpression): ts.Expression | null {
  const callee = unwrapExpression(call.expression);
  return (
    ts.isPropertyAccessExpression(callee)
    || ts.isElementAccessExpression(callee)
  )
    ? callee.expression
    : null;
}

function signatureOwnerName(
  declaration: ts.SignatureDeclaration | undefined,
): string | undefined {
  for (let current = declaration?.parent; current; current = current.parent) {
    if (
      (ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current))
      && current.name
    ) {
      return current.name.text;
    }
  }
  return undefined;
}

function isKnownReadOnlyKernelViewArgument(
  call: ts.CallExpression,
  argumentIndex: number,
  checker: ts.TypeChecker,
): boolean {
  const method = callPropertyName(call);
  const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
  const methodOwner = signatureOwnerName(signatureDeclaration);
  // WHY: method spelling alone is not a read-only proof. A Map or custom
  // object's `set(kernelView)` can retain that live view. Admit only the
  // standard typed-array signature whose receiver write consumes arg0
  // synchronously.
  if (
    method === "set"
    && argumentIndex === 0
    && methodOwner !== undefined
    && TYPED_ARRAY_CONSTRUCTORS.has(methodOwner)
    && signatureDeclaration !== undefined
    && isIntrinsicLibDeclaration(signatureDeclaration)
  ) {
    return true;
  }
  // TextDecoder#decode consumes bytes synchronously; a custom `decode`
  // method remains an opaque escape.
  if (
    method === "decode"
    && argumentIndex === 0
    && methodOwner === "TextDecoder"
    && signatureDeclaration !== undefined
    && isIntrinsicLibDeclaration(signatureDeclaration)
  ) {
    return true;
  }
  if (
    argumentIndex === 0
    && ts.isPropertyAccessExpression(call.expression)
    && call.expression.expression.getText(call.getSourceFile()) === "Atomics"
    && signatureDeclaration !== undefined
    && isIntrinsicLibDeclaration(signatureDeclaration)
    && hasIntrinsicLibValueDeclaration(
      symbolAtExpression(checker, call.expression.expression),
    )
    && !ATOMIC_MUTATORS.has(call.expression.name.text)
  ) {
    return true;
  }
  return false;
}

function validateContractEntries(
  ownershipSeeds: readonly OwnershipSeed[],
  allowances: readonly AuditAllowance[],
): void {
  const seedKeys = new Set<string>();
  for (const seed of ownershipSeeds) {
    if (
      seed.declaration.includes("*")
      || seed.declaration.includes("?")
      || seed.declaration.endsWith("::")
    ) {
      throw new Error(`ownership seed must be exact: ${seed.declaration}`);
    }
    if (seed.why.trim().length < 12) {
      throw new Error(`ownership seed requires a WHY: ${seed.declaration}`);
    }
    const key = `${seed.declaration}::${seed.target}::${seed.owner}::${seed.form}`;
    if (seedKeys.has(key)) throw new Error(`duplicate ownership seed: ${key}`);
    seedKeys.add(key);
  }
  const allowanceKeys = new Set<string>();
  for (const allowance of allowances) {
    if (allowance.key.includes("*") || allowance.key.includes("?")) {
      throw new Error(`audit allowance must be exact: ${allowance.key}`);
    }
    if (allowance.why.trim().length < 12) {
      throw new Error(`audit allowance requires a WHY: ${allowance.key}`);
    }
    if (
      allowance.count !== undefined
      && (!Number.isSafeInteger(allowance.count) || allowance.count <= 0)
    ) {
      throw new Error(`audit allowance count must be positive: ${allowance.key}`);
    }
    if (allowanceKeys.has(allowance.key)) {
      throw new Error(`duplicate audit allowance: ${allowance.key}`);
    }
    allowanceKeys.add(allowance.key);
  }
}

export function auditWasmMemoryWrites(options: AuditOptions): AuditResult {
  const allowances = options.allowances ?? [];
  validateContractEntries(options.ownershipSeeds, allowances);
  const program = createProgram(options);
  const checker = program.getTypeChecker();
  const requestedFiles = new Set(
    options.sourceFiles.map((fileName) => path.resolve(fileName)),
  );
  const sourceFiles = program.getSourceFiles().filter(
    (sourceFile) =>
      requestedFiles.has(path.resolve(sourceFile.fileName))
      && !sourceFile.isDeclarationFile,
  );
  const programSources = new Set(sourceFiles);
  const states = new Map<StateKey, ValueState>();
  const constraints: Constraint[] = [];
  const declarationTargets = new Map<string, DeclarationTarget>();
  const seededReturnStates = new Map<StateKey, ValueState>();
  const seededValueStates = new Map<StateKey, ValueState>();

  const addDeclarationTarget = (
    sourceFile: ts.SourceFile,
    declaration: ts.Declaration,
    target: DeclarationTarget,
  ): void => {
    const key = declarationKey(options.rootDir, sourceFile, declaration);
    if (!key) return;
    const existing = declarationTargets.get(key) ?? {};
    if (target.value) existing.value = target.value;
    if (target.returns) existing.returns = target.returns;
    declarationTargets.set(key, existing);
  };

  const addBindingConstraints = (
    name: ts.BindingName,
    expression: ts.Expression,
    projection: readonly StateProjection[] = [],
  ): void => {
    if (ts.isIdentifier(name)) {
      const target = canonicalSymbol(
        checker,
        checker.getSymbolAtLocation(name),
      );
      if (target) constraints.push({ target, expression, projection });
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        const property = propertyNameText(element.propertyName)
          ?? (ts.isIdentifier(element.name) ? element.name.text : null);
        const nextProjection: StateProjection = element.dotDotDotToken
          || property === null
          ? { kind: "element" }
          : { kind: "property", name: property };
        addBindingConstraints(
          element.name,
          expression,
          [...projection, nextProjection],
        );
        if (element.initializer) {
          addBindingConstraints(element.name, element.initializer);
        }
      }
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      addBindingConstraints(
        element.name,
        expression,
        [...projection, { kind: "element" }],
      );
      if (element.initializer) {
        addBindingConstraints(element.name, element.initializer);
      }
    }
  };
  const addAssignmentConstraints = (
    targetExpression: ts.Expression,
    sourceExpression: ts.Expression,
    projection: readonly StateProjection[] = [],
  ): void => {
    const targetNode = unwrapExpression(targetExpression);
    if (
      ts.isIdentifier(targetNode)
      || ts.isPropertyAccessExpression(targetNode)
      || ts.isElementAccessExpression(targetNode)
    ) {
      const target = symbolAtExpression(checker, targetNode);
      if (target) {
        constraints.push({
          target,
          expression: sourceExpression,
          projection,
        });
      }
      return;
    }
    if (ts.isObjectLiteralExpression(targetNode)) {
      for (const property of targetNode.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          addAssignmentConstraints(
            property.name,
            sourceExpression,
            [
              ...projection,
              { kind: "property", name: property.name.text },
            ],
          );
          if (property.objectAssignmentInitializer) {
            addAssignmentConstraints(
              property.name,
              property.objectAssignmentInitializer,
            );
          }
        } else if (ts.isPropertyAssignment(property)) {
          const name = propertyNameText(property.name);
          addAssignmentConstraints(
            property.initializer,
            sourceExpression,
            [
              ...projection,
              name === null
                ? { kind: "element" }
                : { kind: "property", name },
            ],
          );
        } else if (ts.isSpreadAssignment(property)) {
          addAssignmentConstraints(
            property.expression,
            sourceExpression,
            [...projection, { kind: "element" }],
          );
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(targetNode)) {
      for (const element of targetNode.elements) {
        if (ts.isOmittedExpression(element)) continue;
        addAssignmentConstraints(
          ts.isSpreadElement(element) ? element.expression : element,
          sourceExpression,
          [...projection, { kind: "element" }],
        );
      }
    }
  };

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        || ts.isPropertyDeclaration(node)
        || ts.isPropertySignature(node)
        || ts.isParameter(node)
      ) {
        const symbol = symbolForDeclaration(checker, node);
        if (symbol) addDeclarationTarget(sourceFile, node, { value: symbol });
      }
      if (
        ts.isFunctionDeclaration(node)
        || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)
      ) {
        const symbol = symbolForDeclaration(checker, node);
        addDeclarationTarget(sourceFile, node, {
          value: symbol,
          returns: node,
        });
      }

      if (
        (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))
        && node.initializer
      ) {
        if (ts.isVariableDeclaration(node)) {
          addBindingConstraints(node.name, node.initializer);
        } else {
          const target = symbolForDeclaration(checker, node);
          if (target) {
            constraints.push({ target, expression: node.initializer });
          }
        }
      } else if (ts.isBinaryExpression(node) && isSimpleAssignment(node)) {
        addAssignmentConstraints(node.left, node.right);
      } else if (ts.isReturnStatement(node) && node.expression) {
        const fn = returnFunction(node);
        if (fn) {
          constraints.push({ target: fn, expression: node.expression });
          if (ts.isGetAccessorDeclaration(fn)) {
            const target = symbolForDeclaration(checker, fn);
            if (target) {
              constraints.push({ target, expression: node.expression });
            }
          }
        }
      } else if (
        ts.isArrowFunction(node)
        && !ts.isBlock(node.body)
      ) {
        constraints.push({ target: node, expression: node.body });
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        if (declaration && isInProgram(programSources, declaration)) {
          const parameters = declaration.parameters;
          const args = node.arguments ?? [];
          for (let index = 0; index < args.length; index++) {
            const parameter = parameters[Math.min(index, parameters.length - 1)];
            if (!parameter) continue;
            addBindingConstraints(parameter.name, args[index]);
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const method = intrinsicArrayMethod(node, checker);
        const receiver = method ? callReceiver(node) : null;
        const callback = node.arguments[0];
        if (
          method
          && receiver
          && callback
          && ARRAY_ELEMENT_CALLBACK_METHODS.has(method)
        ) {
          for (const declaration of callbackDeclarations(callback, checker)) {
            if (!isInProgram(programSources, declaration)) continue;
            const elementParameter = declaration.parameters[0];
            if (elementParameter) {
              addBindingConstraints(
                elementParameter.name,
                receiver,
                [{ kind: "element" }],
              );
            }
            const containerParameter = declaration.parameters[2];
            if (containerParameter) {
              addBindingConstraints(containerParameter.name, receiver);
            }
          }
        }
      }
      if (ts.isForOfStatement(node)) {
        const projection: readonly StateProjection[] = [{ kind: "element" }];
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const declaration of node.initializer.declarations) {
            addBindingConstraints(
              declaration.name,
              node.expression,
              projection,
            );
          }
        } else {
          addAssignmentConstraints(
            node.initializer,
            node.expression,
            projection,
          );
        }
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const property = parameterPropertySymbol(checker, node);
        if (property) {
          constraints.push({ target: property, expression: node.name });
        }
      }
      if (ts.isParameter(node) && node.initializer) {
        addBindingConstraints(node.name, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const unresolvedSeeds: OwnershipSeed[] = [];
  for (const seed of options.ownershipSeeds) {
    const target = declarationTargets.get(seed.declaration);
    const key = seed.target === "return" ? target?.returns : target?.value;
    if (!key) {
      unresolvedSeeds.push(seed);
      continue;
    }
    mergeIntoKey(states, key, ownerState(seed.owner, seed.form));
    if (seed.target === "return" && target?.returns) {
      mergeIntoKey(
        seededReturnStates,
        target.returns,
        ownerState(seed.owner, seed.form),
      );
    } else if (seed.target === "value" && target?.value) {
      mergeIntoKey(
        seededValueStates,
        target.value,
        ownerState(seed.owner, seed.form),
      );
    }
  }

  // Alias/argument/return propagation reaches a fixed point over the complete
  // source set. This is what makes a new helper file or a renamed local alias
  // visible to the contract.
  let changed = true;
  for (let pass = 0; changed && pass < constraints.length + 32; pass++) {
    changed = false;
    for (const constraint of constraints) {
      const state = expressionState(
        constraint.expression,
        checker,
        states,
        programSources,
      );
      const projected = projectState(state, constraint.projection);
      changed = mergeIntoKey(states, constraint.target, projected) || changed;
    }
  }

  const findings: AuditFinding[] = [];
  const addFinding = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    kind: AuditFinding["kind"],
  ): void => {
    findings.push(findingFor(options.rootDir, sourceFile, node, kind));
  };
  const ownershipWitness = (
    expression: ts.Expression,
    form: KernelOwnershipForm,
  ): ts.Expression => {
    const node = unwrapExpression(expression);
    const state = expressionState(node, checker, states, programSources);
    if ((state[form] & KERNEL_OWNER) !== 0) return node;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        let value: ts.Expression | undefined;
        if (ts.isPropertyAssignment(property)) {
          value = property.initializer;
        } else if (ts.isShorthandPropertyAssignment(property)) {
          value = property.name;
        } else if (ts.isSpreadAssignment(property)) {
          value = property.expression;
        }
        if (
          value
          && hasKernelOwnership(
            expressionState(value, checker, states, programSources),
            form,
          )
        ) {
          return ownershipWitness(value, form);
        }
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const value = ts.isSpreadElement(element)
          ? element.expression
          : element;
        if (
          hasKernelOwnership(
            expressionState(value, checker, states, programSources),
            form,
          )
        ) {
          return ownershipWitness(value, form);
        }
      }
    } else if (ts.isConditionalExpression(node)) {
      for (const value of [node.whenTrue, node.whenFalse]) {
        if (
          hasKernelOwnership(
            expressionState(value, checker, states, programSources),
            form,
          )
        ) {
          return ownershipWitness(value, form);
        }
      }
    }
    return node;
  };
  const addOwnershipFindings = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    state: ValueState,
    site: "escape" | "return" | "store",
    admitReadOnlyView = false,
    seededTarget?: ts.Symbol,
    witnessExpression?: ts.Expression,
  ): void => {
    if (
      !admitReadOnlyView
      && hasKernelOwnership(state, "view")
      && !(
        seededTarget
        && hasKernelOwnership(
          stateFor(seededValueStates, seededTarget),
          "view",
        )
      )
    ) {
      addFinding(
        sourceFile,
        witnessExpression && (state.view & KERNEL_OWNER) === 0
          ? ownershipWitness(witnessExpression, "view")
          : node,
        `kernel-view-${site}`,
      );
    }
    if (
      hasKernelOwnership(state, "buffer")
      && !(
        seededTarget
        && hasKernelOwnership(
          stateFor(seededValueStates, seededTarget),
          "buffer",
        )
      )
    ) {
      addFinding(
        sourceFile,
        witnessExpression && (state.buffer & KERNEL_OWNER) === 0
          ? ownershipWitness(witnessExpression, "buffer")
          : node,
        `kernel-buffer-${site}`,
      );
    }
    if (
      hasKernelOwnership(state, "memory")
      && !(
        seededTarget
        && hasKernelOwnership(
          stateFor(seededValueStates, seededTarget),
          "memory",
        )
      )
    ) {
      addFinding(
        sourceFile,
        witnessExpression && (state.memory & KERNEL_OWNER) === 0
          ? ownershipWitness(witnessExpression, "memory")
          : node,
        `kernel-memory-${site}`,
      );
    }
  };

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (isViewConstructor(
        node,
        checker,
        states,
        programSources,
      )) {
        const state = expressionState(node, checker, states, programSources);
        if (isKernelView(state)) {
          addFinding(sourceFile, node, "kernel-view");
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeState = expressionState(
          node.expression,
          checker,
          states,
          programSources,
        );
        if (calleeState.allocator) {
          addFinding(sourceFile, node, "scratch-allocator-call");
        }
        if (calleeState.reserver) {
          addFinding(sourceFile, node, "spawn-reservation-call");
        }

        const receiver = callReceiver(node);
        const method = callPropertyName(node);
        if (receiver && method) {
          const receiverState = expressionState(
            receiver,
            checker,
            states,
            programSources,
          );
          if (
            isKernelView(receiverState)
            && (
              TYPED_ARRAY_MUTATORS.has(method)
              || method.startsWith("set")
              || method.startsWith("write")
            )
          ) {
            addFinding(sourceFile, node, "kernel-write");
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(sourceFile) === "Atomics"
          && ATOMIC_MUTATORS.has(node.expression.name.text)
          && node.arguments[0]
          && isKernelView(
            expressionState(
              node.arguments[0],
              checker,
              states,
              programSources,
            ),
          )
        ) {
          addFinding(sourceFile, node, "kernel-write");
        }

        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        const analyzedBody = declaration
          && isInProgram(programSources, declaration)
          && hasBody(declaration);
        if (
          !analyzedBody
          && !isViewConstructor(node, checker, states, programSources)
        ) {
          node.arguments.forEach((argument, index) => {
            addOwnershipFindings(
              sourceFile,
              node,
              expressionState(argument, checker, states, programSources),
              "escape",
              isKnownReadOnlyKernelViewArgument(node, index, checker),
            );
          });
        }
      }
      if (
        ts.isNewExpression(node)
        && !isViewConstructor(node, checker, states, programSources)
      ) {
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        const analyzedBody = declaration
          && isInProgram(programSources, declaration)
          && hasBody(declaration);
        if (!analyzedBody) {
          for (const argument of node.arguments ?? []) {
            addOwnershipFindings(
              sourceFile,
              node,
              expressionState(argument, checker, states, programSources),
              "escape",
            );
          }
        }
      }

      if (
        ts.isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
      ) {
        if (
          assignmentWritesKernelView(
            node.left,
            checker,
            states,
            programSources,
          )
        ) {
          addFinding(sourceFile, node, "kernel-write");
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && ts.isElementAccessExpression(unwrapExpression(node.operand))
      ) {
        const operand = unwrapExpression(node.operand) as ts.ElementAccessExpression;
        if (
          isKernelView(
            expressionState(operand.expression, checker, states, programSources),
          )
        ) {
          addFinding(sourceFile, node, "kernel-write");
        }
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const state = expressionState(
          node.expression,
          checker,
          states,
          programSources,
        );
        const fn = returnFunction(node);
        if (fn) {
          unionState(
            state,
            stateFor(seededReturnStates, fn),
          );
        }
        addOwnershipFindings(
          sourceFile,
          node,
          state,
          "return",
          false,
          undefined,
          node.expression,
        );
      }
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        addOwnershipFindings(
          sourceFile,
          node,
          expressionState(node.body, checker, states, programSources),
          "return",
          false,
          undefined,
          node.body,
        );
      }
      if (
        ts.isBinaryExpression(node)
        && isSimpleAssignment(node)
        && isPersistentStoreTarget(node.left, checker, node)
      ) {
        addOwnershipFindings(
          sourceFile,
          node,
          expressionState(node.right, checker, states, programSources),
          "store",
          false,
          symbolAtExpression(checker, node.left),
        );
      }
      if (
        ts.isPropertyDeclaration(node)
        && node.initializer
      ) {
        addOwnershipFindings(
          sourceFile,
          node,
          expressionState(node.initializer, checker, states, programSources),
          "store",
          false,
          symbolForDeclaration(checker, node),
        );
      }
      if (
        ts.isVariableDeclaration(node)
        && node.initializer
        && returnFunction(node) === null
      ) {
        addOwnershipFindings(
          sourceFile,
          node,
          expressionState(node.initializer, checker, states, programSources),
          "store",
          false,
          symbolForDeclaration(checker, node),
        );
      }
      if (ts.isParameter(node)) {
        const property = parameterPropertySymbol(checker, node);
        if (property && ts.isIdentifier(node.name)) {
          addOwnershipFindings(
            sourceFile,
            node,
            expressionState(node.name, checker, states, programSources),
            "store",
            false,
            property,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  findings.sort((a, b) => a.key.localeCompare(b.key));
  const allowanceByKey = new Map(allowances.map((entry) => [entry.key, entry]));
  const consumedAllowanceCounts = new Map<string, number>();
  const violations: AuditFinding[] = [];
  for (const finding of findings) {
    const allowance = allowanceByKey.get(finding.key);
    const consumed = consumedAllowanceCounts.get(finding.key) ?? 0;
    if (allowance && consumed < (allowance.count ?? 1)) {
      consumedAllowanceCounts.set(finding.key, consumed + 1);
    } else {
      violations.push(finding);
    }
  }
  const unusedAllowances = allowances.filter(
    (entry) =>
      (consumedAllowanceCounts.get(entry.key) ?? 0) !== (entry.count ?? 1),
  );

  return {
    findings,
    violations,
    unusedAllowances,
    unresolvedSeeds,
    sourceFiles: sourceFiles
      .map((sourceFile) => relativeFile(options.rootDir, sourceFile))
      .sort(),
  };
}

function isTypeScriptFile(fileName: string): boolean {
  return (
    fileName.endsWith(".ts")
    || fileName.endsWith(".tsx")
    || fileName.endsWith(".mts")
    || fileName.endsWith(".cts")
  ) && !fileName.endsWith(".d.ts");
}

function isOrdinaryTestHarness(relativePath: string): boolean {
  if (
    relativePath === "apps/browser-demos/test/epoll-repro.ts"
    || relativePath.startsWith("apps/browser-demos/test/fixtures/")
  ) {
    return false;
  }
  return (
    relativePath.startsWith("host/test/")
    || relativePath.includes("/test/")
    || relativePath.endsWith(".test.ts")
    || relativePath.endsWith(".test.tsx")
    || relativePath.endsWith(".spec.ts")
    || relativePath.endsWith(".spec.tsx")
  );
}

/**
 * Discover TypeScript runtime sources from the repository instead of naming a
 * handful of current files. New production/diagnostic files are therefore in
 * scope automatically.
 */
export function repositoryTypeScriptSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // These checked-out upstream trees are not Kandelo TypeScript runtime
        // sources and can contain their own nested build products.
        const relative = toPosix(path.relative(rootDir, absolute));
        if (
          relative === "libc/musl"
          || relative === "tests/libc/libc-test"
          || relative === "tests/sortix/os-test"
        ) {
          continue;
        }
        visitDirectory(absolute);
        continue;
      }
      if (!entry.isFile() || !isTypeScriptFile(entry.name)) continue;
      const relative = toPosix(path.relative(rootDir, absolute));
      if (!isOrdinaryTestHarness(relative)) files.push(absolute);
    }
  };
  visitDirectory(rootDir);
  return files.sort();
}

export function virtualAuditOptions(
  sources: Readonly<Record<string, string>>,
  ownershipSeeds: readonly OwnershipSeed[],
  allowances: readonly AuditAllowance[] = [],
): AuditOptions {
  const rootDir = path.resolve("/virtual");
  const virtualSources = new Map<string, string>();
  for (const [fileName, source] of Object.entries(sources)) {
    virtualSources.set(path.join(rootDir, fileName), source);
  }
  return {
    rootDir,
    sourceFiles: [...virtualSources.keys()],
    ownershipSeeds,
    allowances,
    virtualSources,
  };
}

/** Format failures for one compact Vitest assertion. */
export function formatAuditFailures(result: AuditResult): string[] {
  const failures: string[] = [];
  for (const seed of result.unresolvedSeeds) {
    failures.push(`unresolved ownership seed: ${seed.declaration}`);
  }
  for (const finding of result.violations) {
    failures.push(
      `${finding.file}:${finding.line} ${finding.kind} in ${finding.enclosing}: ${finding.text}`,
    );
  }
  for (const allowance of result.unusedAllowances) {
    failures.push(`stale audit allowance: ${allowance.key}`);
  }
  return failures;
}
