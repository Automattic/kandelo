#!/usr/bin/env node

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

export const localOnlyBrowserImports = new Set([
  "programs/wasm32/nginx-vfs.vfs.zst",
  "programs/wasm32/nginx-php-vfs.vfs.zst",
]);

export const registryPackagesWithoutBuildToml = new Set([
  "pcre2-source",
  "sqlite-cli",
]);

function registryPackageDirs(repoRoot) {
  const registryRoot = join(repoRoot, "packages", "registry");
  return readdirSync(registryRoot)
    .map((name) => join(registryRoot, name))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => existsSync(join(path, "package.toml")));
}

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

export function firstTomlString(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1] ?? null;
}

function parseArches(text) {
  const match = text.match(/^\s*arches\s*=\s*\[([\s\S]*?)\]/m);
  if (!match) return ["wasm32"];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((arch) => arch[1]);
}

function parseProgramOutputs(text) {
  return text
    .split(/^\s*\[\[outputs\]\]\s*$/m)
    .slice(1)
    .map((block) => ({
      name: firstTomlString(block, "name"),
      wasm: firstTomlString(block, "wasm"),
    }))
    .filter((output) => output.name && output.wasm);
}

function outputExtension(wasmPath) {
  const basename = wasmPath.split("/").pop() ?? wasmPath;
  const dot = basename.indexOf(".");
  return dot === -1 ? "" : basename.slice(dot);
}

export function packageOutputOwners(repoRoot = defaultRepoRoot) {
  const owners = new Map();

  for (const packageDir of registryPackageDirs(repoRoot)) {
    const manifest = readFileSync(join(packageDir, "package.toml"), "utf8");
    if (firstTomlString(manifest, "kind") !== "program") continue;

    const packageName = firstTomlString(manifest, "name");
    if (!packageName) continue;

    const outputs = parseProgramOutputs(manifest);
    if (outputs.length === 0) continue;

    const hasBuildToml = existsSync(join(packageDir, "build.toml"));
    for (const arch of parseArches(manifest)) {
      for (const output of outputs) {
        const dest = outputs.length > 1
          ? `${packageName}/${output.name}${outputExtension(output.wasm)}`
          : `${output.name}${outputExtension(output.wasm)}`;
        const rel = `programs/${arch}/${dest}`;
        const previous = owners.get(rel);
        if (previous && previous.packageName !== packageName) {
          throw new Error(
            `browser binary output ${rel} is owned by both ` +
              `${previous.packageName} and ${packageName}`,
          );
        }
        owners.set(rel, { packageName, hasBuildToml });
      }
    }
  }

  return owners;
}

function normalizeBinariesRel(rel) {
  if (!rel.startsWith("programs/")) return rel;
  const tail = rel.slice("programs/".length);
  const first = tail.split("/", 1)[0];
  if (first === "wasm32" || first === "wasm64") return rel;
  return `programs/wasm32/${tail}`;
}

export function browserBinariesImports(repoRoot = defaultRepoRoot) {
  const browserRoot = join(repoRoot, "apps", "browser-demos");
  const imports = new Set();
  const patterns = [
    /\bfrom\s+["']@binaries\/([^"'?]+)(?:\?[^"']*)?["']/g,
    /\bimport\(\s*["']@binaries\/([^"'?]+)(?:\?[^"']*)?["']\s*\)/g,
  ];

  for (const file of walkFiles(browserRoot)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        imports.add(normalizeBinariesRel(match[1]));
      }
    }
  }

  return [...imports].sort();
}

export function fetchableRegistryPackageNames(repoRoot = defaultRepoRoot) {
  const names = new Set();
  for (const packageDir of registryPackageDirs(repoRoot)) {
    if (!existsSync(join(packageDir, "build.toml"))) continue;
    const manifest = readFileSync(join(packageDir, "package.toml"), "utf8");
    const packageName = firstTomlString(manifest, "name");
    if (packageName) names.add(packageName);
  }
  return names;
}

export function inspectBrowserBinaryDependencies(repoRoot = defaultRepoRoot) {
  const owners = packageOutputOwners(repoRoot);
  const imports = browserBinariesImports(repoRoot);
  const missingOwners = [];
  const unfetchableOwners = [];
  const packageNames = new Set();

  for (const rel of imports) {
    if (localOnlyBrowserImports.has(rel)) continue;

    const owner = owners.get(rel);
    if (!owner) {
      missingOwners.push(rel);
    } else if (!owner.hasBuildToml) {
      unfetchableOwners.push(`${rel} (${owner.packageName})`);
    } else {
      packageNames.add(owner.packageName);
    }
  }

  return {
    imports,
    missingOwners,
    unfetchableOwners,
    packageNames: [...packageNames].sort(),
  };
}

export function browserBinaryPackageRoots(
  repoRoot = defaultRepoRoot,
  { includePackages = [], excludePackages = [] } = {},
) {
  const audit = inspectBrowserBinaryDependencies(repoRoot);
  if (audit.missingOwners.length > 0) {
    throw new Error(
      `browser @binaries imports without registry owners:\n${audit.missingOwners.join("\n")}`,
    );
  }
  if (audit.unfetchableOwners.length > 0) {
    throw new Error(
      `browser @binaries imports without fetchable packages:\n` +
        audit.unfetchableOwners.join("\n"),
    );
  }

  const fetchable = fetchableRegistryPackageNames(repoRoot);
  const includes = new Set(includePackages);
  const excludes = new Set(excludePackages);
  for (const packageName of [...includes, ...excludes]) {
    if (!/^[a-z0-9][a-z0-9+._-]*$/.test(packageName)) {
      throw new Error(`invalid registry package name: ${packageName}`);
    }
    if (!fetchable.has(packageName)) {
      throw new Error(`browser package selection is not fetchable: ${packageName}`);
    }
  }
  for (const packageName of includes) {
    if (excludes.has(packageName)) {
      throw new Error(`browser package selection both includes and excludes ${packageName}`);
    }
  }

  const roots = new Set([...audit.packageNames, ...includes]);
  for (const packageName of excludes) roots.delete(packageName);
  return [...roots].sort();
}

function parseCliArgs(argv) {
  const options = { includePackages: [], excludePackages: [] };
  let repoRoot = defaultRepoRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag !== "--include-package" &&
      flag !== "--exclude-package" &&
      flag !== "--repo-root"
    ) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--include-package") options.includePackages.push(value);
    if (flag === "--exclude-package") options.excludePackages.push(value);
    if (flag === "--repo-root") repoRoot = resolve(value);
  }
  return { repoRoot, options };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    const { repoRoot, options } = parseCliArgs(process.argv.slice(2));
    const roots = browserBinaryPackageRoots(repoRoot, options);
    process.stdout.write(roots.map((name) => `${name}\n`).join(""));
  } catch (error) {
    console.error(
      `browser-binary-package-roots: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
