import {
  readdirSync,
  readFileSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { parse } from "@babel/parser";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import {
  browserRepositoryAliases,
  browserVirtualModuleCapabilities,
} from "./browser-module-contract.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(modulePath), "../..");

function walkFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isSymbolicLink()) {
      // WHY: the browser-input projection is content-bound to a Git tree.
      // Following a symlink would let untracked ambient bytes change which
      // packages a clean commit appears to import.
      throw new Error(`browser source tree contains a symlink: ${full}`);
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

function staticModuleReferences(text, file) {
  const ast = parse(text, {
    sourceType: "unambiguous",
    sourceFilename: file,
    plugins: ["jsx", "typescript", "importAttributes"],
  });
  const references = [];
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
      references.push({ kind: "module", specifier: node.source.value });
    } else if (
      node.type === "CallExpression"
      && node.callee?.type === "Import"
      && node.arguments?.length === 1
      && node.arguments[0]?.type === "StringLiteral"
    ) {
      references.push({
        kind: "module",
        specifier: node.arguments[0].value,
      });
    } else if (
      node.type === "ImportExpression"
      && node.source?.type === "StringLiteral"
    ) {
      references.push({ kind: "module", specifier: node.source.value });
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
        references.push({ kind: "glob", specifier: patterns.value });
      } else if (patterns?.type === "ArrayExpression") {
        throw new Error(
          `array-valued import.meta.glob is not admitted by the browser binary boundary: ${file}`,
        );
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
  return references;
}

function staticModuleSpecifiers(text, file) {
  return staticModuleReferences(text, file).map(({ specifier }) => specifier);
}

function pathIsWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (
    rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  );
}

const sourceModuleExtensions = [
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".cjs",
  ".cts",
];
const sourceModuleExtensionSet = new Set(sourceModuleExtensions);
const nodeBuiltinPackages = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "").split("/", 1)[0]),
);
const sourceSubstitutions = new Map([
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts", ".ts"]],
  [".cjs", [".cts", ".ts"]],
]);

function requiredSourceCandidates(unresolved) {
  const extension = extname(unresolved);
  const candidates = [unresolved];
  for (const substitute of sourceSubstitutions.get(extension) ?? []) {
    candidates.push(unresolved.slice(0, -extension.length) + substitute);
  }
  if (extension === "") {
    for (const sourceExtension of sourceModuleExtensions) {
      candidates.push(`${unresolved}${sourceExtension}`);
      candidates.push(join(unresolved, `index${sourceExtension}`));
    }
  }
  return candidates;
}

function resolveSourceCandidate(repoRoot, unresolved, description) {
  if (!pathIsWithin(repoRoot, unresolved)) {
    throw new Error(`${description} escapes the repository: ${unresolved}`);
  }

  for (const candidate of requiredSourceCandidates(unresolved)) {
    let metadata;
    try {
      metadata = lstatSync(candidate);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`required browser source module is a symlink: ${candidate}`);
    }
    if (!metadata.isFile()) continue;
    if (!sourceModuleExtensionSet.has(extname(candidate))) return null;
    const real = realpathSync(candidate);
    if (!pathIsWithin(repoRoot, real)) {
      throw new Error(
        `required browser source module escapes the repository: ${candidate}`,
      );
    }
    // WHY: package selection is bound to the checked-out Git tree. Even a
    // symlink that currently resolves back into the repository gives ambient
    // filesystem state authority over which source module owns an import.
    if (real !== resolve(candidate)) {
      throw new Error(
        `required browser source module crosses a symlink: ${candidate}`,
      );
    }
    return real;
  }

  const extension = extname(unresolved);
  if (extension !== "" && !sourceModuleExtensionSet.has(extension)) {
    return null;
  }
  throw new Error(`${description} cannot be resolved: ${unresolved}`);
}

function resolveRequiredSourceModule(
  repoRoot,
  sourceFile,
  specifier,
  repositoryAliases,
) {
  const pathPart = specifier.split(/[?#]/, 1)[0];
  if (isAbsolute(pathPart)) {
    throw new Error(
      `required browser source uses an absolute import from ${sourceFile}: ` +
        specifier,
    );
  }
  if (pathPart.startsWith(".")) {
    return resolveSourceCandidate(
      repoRoot,
      resolve(dirname(sourceFile), pathPart),
      `required browser source import from ${sourceFile}`,
    );
  }

  for (const [alias, aliasRoot] of Object.entries(repositoryAliases)) {
    if (pathPart !== alias && !pathPart.startsWith(`${alias}/`)) continue;
    const suffix = pathPart === alias ? "" : pathPart.slice(alias.length + 1);
    const components = suffix.split("/");
    if (
      suffix.includes("\\")
      || suffix.includes("\0")
      || (
        suffix !== ""
        && components.some(
          (component) =>
            component === "" || component === "." || component === "..",
        )
      )
    ) {
      throw new Error(
        `required browser alias import escapes ${alias}: ${specifier}`,
      );
    }
    const unresolved = resolve(aliasRoot, suffix);
    if (!pathIsWithin(aliasRoot, unresolved)) {
      throw new Error(`required browser alias import escapes ${alias}: ${specifier}`);
    }
    return resolveSourceCandidate(
      repoRoot,
      unresolved,
      `required browser alias import ${specifier} from ${sourceFile}`,
    );
  }
  return null;
}

function packageSpecifierName(specifier) {
  const pathPart = specifier.split(/[?#]/, 1)[0];
  const components = pathPart.split("/");
  if (pathPart.startsWith("@")) {
    return components.length >= 2 ? `${components[0]}/${components[1]}` : pathPart;
  }
  return components[0];
}

function declaredExternalPackages(repoRoot, sourceFile, cache) {
  let directory = dirname(sourceFile);
  while (pathIsWithin(repoRoot, directory)) {
    const manifest = join(directory, "package.json");
    let metadata;
    try {
      metadata = lstatSync(manifest);
    } catch {
      metadata = null;
    }
    if (metadata !== null) {
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`browser package manifest is not a regular file: ${manifest}`);
      }
      if (!cache.has(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        const packages = new Set();
        for (const field of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ]) {
          const dependencies = parsed[field];
          if (dependencies === undefined || dependencies === null) continue;
          if (
            typeof dependencies !== "object"
            || Array.isArray(dependencies)
          ) {
            throw new Error(`invalid ${field} in browser package manifest: ${manifest}`);
          }
          for (const name of Object.keys(dependencies)) packages.add(name);
        }
        cache.set(manifest, packages);
      }
      return cache.get(manifest);
    }
    if (directory === repoRoot) break;
    directory = dirname(directory);
  }
  return new Set();
}

function htmlAttribute(attributes, name) {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`,
    "i",
  );
  return attributes.match(pattern)?.[2] ?? null;
}

function browserHtmlEntryModules(repoRoot, browserRoot, entry) {
  if (typeof entry !== "string" || entry.length === 0 || isAbsolute(entry)) {
    throw new Error(`invalid required browser HTML entry: ${String(entry)}`);
  }
  const candidate = resolve(browserRoot, entry);
  if (!pathIsWithin(browserRoot, candidate)) {
    throw new Error(`required browser HTML entry escapes the app: ${entry}`);
  }
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    throw new Error(`required browser HTML entry does not exist: ${entry}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`required browser HTML entry is not a regular file: ${entry}`);
  }
  const real = realpathSync(candidate);
  if (!pathIsWithin(browserRoot, real) || real !== candidate) {
    throw new Error(`required browser HTML entry crosses a symlink: ${entry}`);
  }

  const modules = [];
  const text = readFileSync(real, "utf8");
  for (const match of text.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (htmlAttribute(attributes, "type")?.toLowerCase() !== "module") continue;
    const source = htmlAttribute(attributes, "src");
    if (source === null) continue;
    const pathPart = source.split(/[?#]/, 1)[0];
    if (
      pathPart.length === 0
      || isAbsolute(pathPart)
      || /^[a-z][a-z0-9+.-]*:/i.test(pathPart)
      || pathPart.startsWith("//")
    ) {
      throw new Error(
        `required browser HTML module source is not app-relative: ${source}`,
      );
    }
    const unresolved = resolve(dirname(real), pathPart);
    if (!pathIsWithin(browserRoot, unresolved)) {
      throw new Error(`required browser HTML module escapes the app: ${source}`);
    }
    const resolved = resolveSourceCandidate(
      repoRoot,
      unresolved,
      `required browser HTML module ${source}`,
    );
    if (resolved === null) {
      throw new Error(`required browser HTML module is not source code: ${source}`);
    }
    modules.push(resolved);
  }
  return modules;
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

/**
 * Return the non-optional package-mirror paths reachable from product entries.
 *
 * The full-tree scanner above remains the ownership audit for every browser
 * source. This graph-scoped projection has a different purpose: an exact
 * product proof must materialize only files that Vite cannot build without.
 * `import.meta.glob()` references are deliberately omitted because those are
 * the app's lazy, optional gallery boundary; Vite itself returns an empty map
 * when such an artifact has not been materialized.
 */
export function browserRequiredInputs(
  repoRoot = defaultRepoRoot,
  { entryFiles = [], htmlEntryFiles = [] } = {},
) {
  if (
    !Array.isArray(entryFiles)
    || !Array.isArray(htmlEntryFiles)
    || entryFiles.length + htmlEntryFiles.length === 0
  ) {
    throw new Error("required browser input scan needs at least one entry");
  }

  // Nix may expose a checkout through a /tmp symlink. Canonicalize once so
  // real source files are compared against the same root identity.
  const canonicalRepoRoot = realpathSync(repoRoot);
  const browserRoot = join(canonicalRepoRoot, "apps", "browser-demos");
  const repositoryAliases = browserRepositoryAliases(canonicalRepoRoot);
  const mirrorRoots = [
    join(canonicalRepoRoot, "local-binaries"),
    join(canonicalRepoRoot, "binaries"),
  ];
  const imports = new Set();
  const capabilities = new Set();
  const packageManifestCache = new Map();
  const pending = entryFiles.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || isAbsolute(entry)) {
      throw new Error(`invalid required browser entry: ${String(entry)}`);
    }
    const candidate = resolve(browserRoot, entry);
    if (!pathIsWithin(browserRoot, candidate)) {
      throw new Error(`required browser entry escapes the app: ${entry}`);
    }
    const resolved = resolveRequiredSourceModule(
      canonicalRepoRoot,
      join(browserRoot, "__entry__.ts"),
      `./${entry}`,
      repositoryAliases,
    );
    if (resolved === null) {
      throw new Error(`required browser entry is not a source module: ${entry}`);
    }
    return resolved;
  });
  for (const entry of htmlEntryFiles) {
    pending.push(
      ...browserHtmlEntryModules(canonicalRepoRoot, browserRoot, entry),
    );
  }
  const visited = new Set();

  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    for (const { kind, specifier } of staticModuleReferences(text, file)) {
      if (specifier.startsWith("@binaries/")) {
        if (kind === "glob") {
          throw new Error(
            `required browser source uses an unsupported aliased glob: ${file}`,
          );
        }
        const rel = specifier.slice("@binaries/".length).split("?", 1)[0];
        imports.add(normalizeBinariesRel(rel));
        continue;
      }

      const pathPart = specifier.split(/[?#]/, 1)[0];
      const capability = browserVirtualModuleCapabilities[pathPart];
      if (capability !== undefined) {
        if (kind === "glob") {
          throw new Error(
            `required browser source uses a virtual-module glob: ${file}`,
          );
        }
        capabilities.add(capability);
        continue;
      }

      const aliased = Object.keys(repositoryAliases).some(
        (alias) => pathPart === alias || pathPart.startsWith(`${alias}/`),
      );
      if (aliased) {
        if (kind === "glob") {
          throw new Error(
            `required browser source uses a repository-alias glob: ${file}`,
          );
        }
        const dependency = resolveRequiredSourceModule(
          canonicalRepoRoot,
          file,
          specifier,
          repositoryAliases,
        );
        if (dependency === null) {
          throw new Error(
            `required browser repository alias is not source code: ${specifier}`,
          );
        }
        pending.push(dependency);
        continue;
      }

      if (!pathPart.startsWith(".") && !isAbsolute(pathPart)) {
        if (kind === "glob") {
          throw new Error(
            `required browser source uses an external-package glob: ${file}`,
          );
        }
        const packageName = packageSpecifierName(pathPart);
        const builtinName = packageName.replace(/^node:/, "");
        if (nodeBuiltinPackages.has(builtinName)) continue;
        const declared = declaredExternalPackages(
          canonicalRepoRoot,
          file,
          packageManifestCache,
        );
        if (!declared.has(packageName)) {
          throw new Error(
            `required browser source uses an unknown package or repository alias ` +
              `${specifier} from ${file}`,
          );
        }
        continue;
      }
      const absolute = resolve(dirname(file), pathPart);
      let binaryRel = null;
      for (const mirrorRoot of mirrorRoots) {
        if (!pathIsWithin(mirrorRoot, absolute)) continue;
        binaryRel = relative(mirrorRoot, absolute).split(sep).join("/");
        break;
      }
      if (binaryRel !== null) {
        // WHY: import.meta.glob() is the product's optional artifact boundary.
        // Counting it here would materialize every gallery image before the
        // shell can be tested, defeating both lazy delivery and this proof.
        if (kind === "module") {
          imports.add(normalizeBinariesRel(binaryRel));
        }
        continue;
      }
      if (kind === "glob") {
        throw new Error(
          `required browser source uses an unsupported source glob: ${file}`,
        );
      }
      const dependency = resolveRequiredSourceModule(
        canonicalRepoRoot,
        file,
        specifier,
        repositoryAliases,
      );
      if (dependency !== null) pending.push(dependency);
    }
  }

  return {
    imports: [...imports].sort(),
    capabilities: [...capabilities].sort(),
  };
}

export function browserRequiredBinariesImports(
  repoRoot = defaultRepoRoot,
  entryFiles = [],
) {
  return browserRequiredInputs(repoRoot, { entryFiles }).imports;
}
