#!/usr/bin/env node

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

function hasExactObjectKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function safeSinglePathComponent(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

function portableArtifactPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every(
      (component) =>
        component.length > 0 && component !== "." && component !== "..",
    );
}

function filePathsConflict(left, right) {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

export function configuredProgramRegistryRoots(
  repoRoot = defaultRepoRoot,
  registryPath = process.env.WASM_POSIX_DEPS_REGISTRY,
) {
  if (registryPath === undefined) {
    return [join(repoRoot, "packages", "registry")];
  }
  return registryPath
    .split(":")
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith("~/") && process.env.HOME !== undefined) {
        return resolve(process.env.HOME, entry.slice(2));
      }
      return isAbsolute(entry) ? resolve(entry) : resolve(repoRoot, entry);
    });
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

function readProgramPackageProjection(registryRoot) {
  const indexPath = join(registryRoot, "program-packages.json");
  const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  if (
    typeof parsed !== "object"
    || parsed === null
    || !hasExactObjectKeys(parsed, ["format", "identities", "packages"])
    || parsed.format !== "kandelo-program-packages-v2"
    || typeof parsed.identities !== "object"
    || parsed.identities === null
    || Array.isArray(parsed.identities)
    || typeof parsed.packages !== "object"
    || parsed.packages === null
    || Array.isArray(parsed.packages)
  ) {
    throw new Error(`invalid generated program package projection: ${indexPath}`);
  }
  for (const [packageName, identity] of Object.entries(parsed.identities)) {
    const cacheKeys = identity?.cacheKeys;
    if (
      !safeSinglePathComponent(packageName)
      || typeof identity !== "object"
      || identity === null
      || !hasExactObjectKeys(identity, ["manifestSha256", "cacheKeys"])
      || typeof identity.manifestSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(identity.manifestSha256)
      || typeof cacheKeys !== "object"
      || cacheKeys === null
      || Array.isArray(cacheKeys)
      || !hasExactObjectKeys(cacheKeys, ["wasm32", "wasm64"])
      || Object.values(cacheKeys).some(
        (cacheKey) =>
          typeof cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(cacheKey),
      )
    ) {
      throw new Error(
        `invalid generated package identity for ${packageName}: ${indexPath}`,
      );
    }
  }
  for (const [packageName, packageProjection] of Object.entries(parsed.packages)) {
    const arches = packageProjection?.arches;
    const cacheKeys = packageProjection?.cacheKeys;
    const dependencyClosures = packageProjection?.dependencyClosures;
    const members = packageProjection?.members;
    if (
      !safeSinglePathComponent(packageName)
      || typeof packageProjection !== "object"
      || packageProjection === null
      || !hasExactObjectKeys(packageProjection, [
        "manifestSha256",
        "arches",
        "cacheKeys",
        "dependencyClosures",
        "members",
      ])
      || typeof packageProjection?.manifestSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(packageProjection.manifestSha256)
      || !Array.isArray(arches)
      || arches.length === 0
      || new Set(arches).size !== arches.length
      || arches.some((arch) => arch !== "wasm32" && arch !== "wasm64")
      || typeof cacheKeys !== "object"
      || cacheKeys === null
      || Array.isArray(cacheKeys)
      || !hasExactObjectKeys(cacheKeys, arches)
      || Object.values(cacheKeys).some(
        (cacheKey) =>
          typeof cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(cacheKey),
      )
      || typeof dependencyClosures !== "object"
      || dependencyClosures === null
      || Array.isArray(dependencyClosures)
      || !hasExactObjectKeys(dependencyClosures, arches)
      || !Array.isArray(members)
      || members.length === 0
    ) {
      throw new Error(
        `invalid generated program package projection for ${packageName}: ${indexPath}`,
      );
    }
    for (const arch of arches) {
      const closure = dependencyClosures[arch];
      // Match the host parser: order is non-semantic and uniqueness is
      // required. Rust still emits one deterministic array so the checked-in
      // projection is reproducible and freshness-checkable.
      const seen = new Set();
      if (
        !Array.isArray(closure)
        || closure.some((dependency) => {
          if (
            typeof dependency !== "object"
            || dependency === null
            || !hasExactObjectKeys(dependency, [
              "packageName",
              "manifestSha256",
              "cacheKey",
            ])
            || !safeSinglePathComponent(dependency.packageName)
            || dependency.packageName === packageName
            || seen.has(dependency.packageName)
            || typeof dependency.manifestSha256 !== "string"
            || !/^[a-f0-9]{64}$/.test(dependency.manifestSha256)
            || typeof dependency.cacheKey !== "string"
            || !/^[a-f0-9]{64}$/.test(dependency.cacheKey)
          ) return true;
          seen.add(dependency.packageName);
          const contextualIdentity = parsed.identities[dependency.packageName];
          if (
            contextualIdentity === undefined
            || contextualIdentity.manifestSha256
              !== dependency.manifestSha256
            || contextualIdentity.cacheKeys[arch] !== dependency.cacheKey
          ) return true;
          return false;
        })
      ) {
        throw new Error(
          `invalid generated dependency closure for ${packageName} (${arch}): ${indexPath}`,
        );
      }
    }
    for (const member of members) {
      const outputKeys = [
        "kind",
        "sourceArtifact",
        "mirrorPath",
        "outputName",
        "forkInstrumentation",
      ];
      const runtimeKeys = [
        "kind",
        "sourceArtifact",
        "mirrorPath",
        "guestPath",
        "mode",
      ];
      if (
        typeof member !== "object"
        || member === null
        || (
          member.kind !== "output"
          && member.kind !== "runtime-file"
        )
        || !hasExactObjectKeys(
          member,
          member.kind === "output" ? outputKeys : runtimeKeys,
        )
        || !portableArtifactPath(member.sourceArtifact)
        || !portableArtifactPath(member.mirrorPath)
        || (
          member.kind === "output"
          && (
            !safeSinglePathComponent(member.outputName)
            || (
              member.forkInstrumentation !== "auto"
              && member.forkInstrumentation !== "disabled"
            )
          )
        )
        || (
          member.kind === "runtime-file"
          && (
            typeof member.guestPath !== "string"
            || !member.guestPath.startsWith("/")
            || !Number.isInteger(member.mode)
            || member.mode < 0
            || member.mode > 0o777
          )
        )
      ) {
        throw new Error(
          `invalid generated program package projection member for ${packageName}: ${indexPath}`,
        );
      }
    }
    if (
      new Set(members.map((member) => member.sourceArtifact)).size
        !== members.length
      || new Set(members.map((member) => member.mirrorPath)).size
        !== members.length
      || (
        members.length === 1
        && members[0].mirrorPath.includes("/")
      )
      || (
        members.length > 1
        && members.some(
          (member) => !member.mirrorPath.startsWith(`${packageName}/`),
        )
      )
    ) {
      throw new Error(
        `invalid generated program package projection layout for ${packageName}: ${indexPath}`,
      );
    }
    const identity = parsed.identities[packageName];
    if (
      identity === undefined
      || identity.manifestSha256 !== packageProjection.manifestSha256
      || arches.some(
        (arch) => identity.cacheKeys[arch] !== packageProjection.cacheKeys[arch],
      )
    ) {
      throw new Error(
        `generated program projection does not match package identity for ${packageName}: ${indexPath}`,
      );
    }
  }
  return {
    indexPath,
    identities: parsed.identities,
    packages: parsed.packages,
  };
}

function selectedRegistryPackages(repoRoot, registryPath) {
  const selected = new Map();
  let authoritativeIdentities = null;
  let authoritativeProjections = null;
  let authoritativeProjectionPath = null;
  for (
    const registryRoot of configuredProgramRegistryRoots(repoRoot, registryPath)
  ) {
    if (!existsSync(registryRoot)) continue;
    if (!statSync(registryRoot).isDirectory()) {
      throw new Error(`program registry root is not a directory: ${registryRoot}`);
    }
    const indexPath = join(registryRoot, "program-packages.json");
    if (!existsSync(indexPath)) {
      throw new Error(
        `program registry ${registryRoot} is missing program-packages.json`,
      );
    }
    const projection = readProgramPackageProjection(registryRoot);
    authoritativeIdentities ??= projection.identities;
    authoritativeProjections ??= projection.packages;
    authoritativeProjectionPath ??= projection.indexPath;
    const entries = readdirSync(registryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const packageName = entry.name;
      if (selected.has(packageName)) continue;
      const packageDir = join(registryRoot, packageName);
      const manifestPath = join(packageDir, "package.toml");
      if (!existsSync(manifestPath)) continue;
      let manifestIsFile = false;
      try {
        manifestIsFile = statSync(manifestPath).isFile();
      } catch {
        manifestIsFile = false;
      }
      if (!manifestIsFile) continue;
      const packageProjection =
        authoritativeProjections[packageName] ?? null;
      const packageIdentity =
        authoritativeIdentities[packageName] ?? null;
      if (packageIdentity !== null) {
        const manifestDigest = createHash("sha256")
          .update(readFileSync(manifestPath))
          .digest("hex");
        if (manifestDigest !== packageIdentity.manifestSha256) {
          throw new Error(
            `stale generated package identity for ${packageName}: ${projection.indexPath}`,
          );
        }
      }
      selected.set(packageName, {
        packageDir,
        manifestPath,
        identity: packageIdentity,
        projection: packageProjection,
        projectionPath: authoritativeProjectionPath,
      });
    }
  }
  return selected;
}

function validateSelectedProgramDependencyContext(
  packageName,
  selected,
  selectedPackages,
) {
  const packageProjection = selected.projection;
  for (const arch of packageProjection.arches) {
    if (!selected.identity) {
      throw new Error(
        `program package ${packageName} at ${selected.manifestPath} has no ` +
          `authoritative contextual identity for ${arch}; regenerate ` +
          "program-packages.json with the exact ordered registry roots",
      );
    }
    const selectedProgramCacheKey = selected.identity.cacheKeys[arch];
    if (
      selected.identity.manifestSha256
        !== packageProjection.manifestSha256
      || selectedProgramCacheKey !== packageProjection.cacheKeys[arch]
    ) {
      throw new Error(
        `program package ${packageName} was projected with manifest ` +
          `${packageProjection.manifestSha256} and cache key ` +
          `${packageProjection.cacheKeys[arch]} for ${arch}, but the ` +
          `authoritative first-hit registry context requires manifest ` +
          `${selected.identity.manifestSha256} and cache key ` +
          `${selectedProgramCacheKey ?? "<missing>"}. Regenerate this program ` +
          "projection with the exact ordered registry roots; the highest-priority " +
          "index must carry the complete combined-context projection rather than " +
          "relying on a lower suffix-context build identity.",
      );
    }
    for (const expected of packageProjection.dependencyClosures[arch]) {
      const dependency = selectedPackages.get(expected.packageName);
      if (!dependency) {
        throw new Error(
          `program package ${packageName} was generated against dependency ` +
            `${expected.packageName}, but that dependency is absent from the ` +
            "configured first-hit registry roots",
        );
      }
      if (!dependency.identity) {
        throw new Error(
          `program package ${packageName} was generated against dependency ` +
            `${expected.packageName}, but the first-hit package at ` +
            `${dependency.manifestPath} has no contextual identity`,
        );
      }
      const selectedCacheKey = dependency.identity.cacheKeys[arch];
      if (
        dependency.identity.manifestSha256 !== expected.manifestSha256
        || selectedCacheKey !== expected.cacheKey
      ) {
        throw new Error(
          `program package ${packageName} has a contextual cache identity ` +
            `mismatch for ${arch}: its projection expects dependency ` +
            `${expected.packageName} manifest ${expected.manifestSha256} and ` +
            `cache key ${expected.cacheKey}, but first-hit selection at ` +
            `${dependency.manifestPath} provides manifest ` +
            `${dependency.identity.manifestSha256} and cache key ` +
            `${selectedCacheKey ?? "<missing>"}. Regenerate the program ` +
            "projection with the exact ordered registry roots; the complete " +
            "highest-priority projection must bind every selected program to " +
            "the same combined dependency context.",
        );
      }
    }
  }
}

export function packageOutputOwners(
  repoRoot = defaultRepoRoot,
  { registryPath } = {},
) {
  const owners = new Map();
  const selectedPackages = selectedRegistryPackages(repoRoot, registryPath);
  for (
    const [packageName, selected] of selectedPackages
  ) {
    const { packageDir, projection: packageProjection } = selected;
    if (packageProjection === null) continue;
    validateSelectedProgramDependencyContext(
      packageName,
      selected,
      selectedPackages,
    );
    const hasBuildToml = existsSync(join(packageDir, "build.toml"));
    for (const arch of packageProjection.arches) {
      for (const member of packageProjection.members) {
        const rel = `programs/${arch}/${member.mirrorPath}`;
        for (const [previousRel, previous] of owners) {
          if (
            previous.packageName !== packageName
            && filePathsConflict(previousRel, rel)
          ) {
            throw new Error(
              `browser binary outputs ${previousRel} and ${rel} conflict ` +
                `between ${previous.packageName} and ${packageName}`,
            );
          }
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

export function browserBinariesImports(repoRoot = defaultRepoRoot) {
  const browserRoot = join(repoRoot, "apps", "browser-demos");
  const imports = new Set();

  for (const file of walkFiles(browserRoot)) {
    const text = readFileSync(file, "utf8");
    for (const specifier of staticModuleSpecifiers(text, file)) {
      if (!specifier.startsWith("@binaries/")) continue;
      const rel = specifier.slice("@binaries/".length).split("?", 1)[0];
      imports.add(normalizeBinariesRel(rel));
    }
  }

  return [...imports].sort();
}

export function fetchableRegistryPackageNames(
  repoRoot = defaultRepoRoot,
  { registryPath } = {},
) {
  const names = new Set();
  const selectedPackages = selectedRegistryPackages(repoRoot, registryPath);
  for (const [packageName, selected] of selectedPackages) {
    if (
      selected.projection !== null
      && existsSync(join(selected.packageDir, "build.toml"))
    ) {
      validateSelectedProgramDependencyContext(
        packageName,
        selected,
        selectedPackages,
      );
      names.add(packageName);
    }
  }
  return names;
}

export function inspectBrowserBinaryDependencies(
  repoRoot = defaultRepoRoot,
  { registryPath } = {},
) {
  const owners = packageOutputOwners(repoRoot, { registryPath });
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
  {
    includePackages = [],
    excludePackages = [],
    registryPath,
  } = {},
) {
  const audit = inspectBrowserBinaryDependencies(repoRoot, { registryPath });
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

  const fetchable = fetchableRegistryPackageNames(repoRoot, { registryPath });
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
