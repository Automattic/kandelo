// @ts-check
import { createRequire, builtinModules } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ts = /** @type {typeof import("typescript")} */ (require("typescript"));
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBuiltinNames = new Set(builtinModules.map(name => name.replace(/^node:/u, "")));

/**
 * @typedef {{inventoryRoots: readonly string[], browserRoots: readonly string[],
 * nodeTestRoots: readonly string[], nodeUnitTests: readonly string[]}} TypecheckCoverage
 */
/** Refuse a green check whose context split silently lost a supported root.
 * @param {TypecheckCoverage} coverage
 */
export function auditTypecheckCoverage(coverage) {
  const { inventoryRoots, browserRoots, nodeTestRoots, nodeUnitTests } = coverage;
  const browser = new Set(browserRoots.map(path => resolve(path)));
  const node = new Set(nodeTestRoots.map(path => resolve(path)));
  const expected = new Set([...inventoryRoots, ...nodeUnitTests].map(path => resolve(path)));
  const errors = [];
  for (const path of expected) {
    const isTest = path.endsWith(".test.ts");
    if (!(isTest ? node : browser).has(path)) errors.push(`unchecked ${isTest ? "Node test" : "browser source"}: ${path}`);
  }
  for (const path of browser) {
    if (path.endsWith(".test.ts")) errors.push(`Node test assigned to browser context: ${path}`);
    if (node.has(path)) errors.push(`root assigned to both contexts: ${path}`);
  }
  for (const path of node) if (!path.endsWith(".test.ts")) errors.push(`non-test root assigned to Node test context: ${path}`);
  if (errors.length) throw new Error(errors.join("\n"));
}

/** Include transitive app modules, even when they are outside compiler roots.
 * @param {import("typescript").Program} program
 * @param {string} directory
 */
export function browserAuthoredSourceFiles(program, directory) {
  return program.getSourceFiles().filter(source => {
    const path = relative(directory, source.fileName);
    return !source.isDeclarationFile && path !== ".." && !path.startsWith(`..${sep}`) &&
      !path.split(sep).includes("node_modules");
  }).map(source => source.fileName);
}

/**
 * Real Node declarations are required by imported shared-host branches, but
 * must not grant Node runtime capabilities to browser-authored application code.
 * @param {import("typescript").Program} program
 * @param {readonly string[]} roots
 * @returns {string[]}
 */
export function browserNodeCapabilityFailures(program, roots) {
  const checker = program.getTypeChecker();
  const failures = new Set();
  for (const path of roots) {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`browser capability inventory has no parsed source: ${path}`);
    if (source.isDeclarationFile) continue;
    const syntax = program.getSyntacticDiagnostics(source);
    if (syntax.length) throw new Error(`browser capability parser cannot inspect ${path}: ${ts.flattenDiagnosticMessageText(syntax[0].messageText, "\n")}`);
    /** @param {import("typescript").Node} node @param {string} message */
    const fail = (node, message) => {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.add(`${path}:${position.line + 1}:${position.character + 1}: ${message}`);
    };
    /** @param {import("typescript").Symbol | undefined} symbol */
    const nodeOnly = symbol => {
      if (!symbol) return false;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declarations = symbol.getDeclarations() ?? [];
      return declarations.some(declaration => /[\\/]node_modules[\\/]@types[\\/]node[\\/]/u.test(declaration.getSourceFile().fileName)) &&
        !declarations.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    };
    /** @param {import("typescript").Node} node */
    const visit = node => {
      if (ts.isTypeNode(node)) return;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
        if (!typeOnly && specifier && ts.isStringLiteralLike(specifier) &&
          (specifier.text.startsWith("node:") || nodeBuiltinNames.has(specifier.text)))
          fail(specifier, `browser source cannot import Node runtime module ${specifier.text}`);
        return;
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) &&
        (node.arguments[0].text.startsWith("node:") || nodeBuiltinNames.has(node.arguments[0].text)))
        fail(node, `browser source cannot load Node runtime module ${node.arguments[0].text}`);
      if (ts.isIdentifier(node) && nodeOnly(checker.getSymbolAtLocation(node)))
        fail(node, `browser source cannot use Node-only value ${node.text}`);
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) &&
        nodeOnly(checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), node.argumentExpression.text)))
        fail(node, `browser source cannot use Node-only value ${node.argumentExpression.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...failures];
}

/** @param {string} path */
function readProject(path) {
  const loaded = ts.readConfigFile(path, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(path));
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => appRoot, getNewLine: () => "\n",
  }));
  return { loaded: loaded.config, parsed };
}

/** @param {string | undefined} [reportPath] */
export function typecheckBrowserApp(reportPath) {
  const browserPath = resolve(appRoot, "tsconfig.json");
  const nodePath = resolve(appRoot, "tsconfig.node-tests.json");
  const browser = readProject(browserPath);
  const node = readProject(nodePath);
  // WHY: excludes select the correct compiler context, never remove evidence.
  // Read the authoritative source roots without those context selectors and
  // independently inventory the exact glob used by the declared Node runner.
  // WHY: this inventory is independent of compiler selectors. Reusing include
  // would let a narrowed tsconfig hide the very source we need to protect.
  const inventory = ts.parseJsonConfigFileContent({ ...browser.loaded, include: ["lib", "pages"],
    exclude: ["node_modules"] }, ts.sys, appRoot);
  const nodeUnitTests = ts.sys.readDirectory(appRoot, [".ts"], ["node_modules"], ["**/*.test.ts"]);
  const coverage = { inventoryRoots: inventory.fileNames, browserRoots: browser.parsed.fileNames,
    nodeTestRoots: node.parsed.fileNames, nodeUnitTests };
  auditTypecheckCoverage(coverage);
  const capabilityProgram = ts.createProgram(browser.parsed.fileNames, browser.parsed.options);
  // WHY: an imported app module has browser capabilities even when it is not a
  // configured root. Shared host modules outside this app retain real Node
  // branches and remain checked by the ordinary strict compiler.
  const browserAuthoredFiles = browserAuthoredSourceFiles(capabilityProgram, appRoot);
  const capabilityFailures = browserNodeCapabilityFailures(capabilityProgram, browserAuthoredFiles);
  for (const failure of capabilityFailures) console.error(failure);
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ ...coverage, browserAuthoredFiles, browserCapabilityFailures: capabilityFailures }, null, 2) + "\n");
  console.log(`typecheck inventory: ${coverage.browserRoots.length} browser roots, ${coverage.nodeTestRoots.length} Node unit-test roots; complete`);
  let status = capabilityFailures.length ? 1 : 0;
  for (const [name, path] of [["browser", browserPath], ["node-tests", nodePath]]) {
    console.log(`typecheck ${name}`);
    const result = spawnSync(process.execPath, [resolve(appRoot, "node_modules/.bin/tsc"), "--noEmit", "--pretty", "false", "--project", path],
      { cwd: appRoot, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) status = result.status ?? 1;
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = typecheckBrowserApp(process.argv[2]); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
