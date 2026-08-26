#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/generate-rootfs-package-manifest.mjs [options]",
    "",
    "Options:",
    "  --packages <path>  package mapping TOML (default: images/rootfs/PACKAGES.toml)",
    "  --binaries-dir <path>",
    "                     resolve outputs only from this artifact tree",
    "  --stage-resolver-binaries <path>",
    "                     copy exact direct-dependency outputs into this new",
    "                     artifact tree, then resolve outputs only from it",
    "  --resolved-output-map <path>",
    "                     consume exact embedded paths or lazy references",
    "                     without consulting an artifact tree",
    "  --default-install <lazy|eager>",
    "                     override the configured default for outputs without",
    "                     an explicit package or output install mode",
    "  --out <path>       generated mkrootfs manifest fragment (required)",
    "  --help             print this message",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  let packages = "images/rootfs/PACKAGES.toml";
  let binariesDir;
  let stageResolverBinaries;
  let resolvedOutputMap;
  let defaultInstall;
  let out;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--packages") {
      packages = argv[++i];
      if (!packages) throw new Error("--packages requires a value");
      continue;
    }
    if (arg === "--out") {
      out = argv[++i];
      if (!out) throw new Error("--out requires a value");
      continue;
    }
    if (arg === "--binaries-dir") {
      binariesDir = argv[++i];
      if (!binariesDir) throw new Error("--binaries-dir requires a value");
      continue;
    }
    if (arg === "--stage-resolver-binaries") {
      stageResolverBinaries = argv[++i];
      if (!stageResolverBinaries) {
        throw new Error("--stage-resolver-binaries requires a value");
      }
      continue;
    }
    if (arg === "--resolved-output-map") {
      resolvedOutputMap = argv[++i];
      if (!resolvedOutputMap) {
        throw new Error("--resolved-output-map requires a value");
      }
      continue;
    }
    if (arg === "--default-install") {
      defaultInstall = argv[++i];
      if (!defaultInstall) {
        throw new Error("--default-install requires a value");
      }
      if (defaultInstall !== "lazy" && defaultInstall !== "eager") {
        throw new Error(
          '--default-install must be either "lazy" or "eager"',
        );
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!out) throw new Error("--out is required");
  if ([binariesDir, stageResolverBinaries, resolvedOutputMap].filter(Boolean).length > 1) {
    throw new Error(
      "--binaries-dir, --stage-resolver-binaries, and --resolved-output-map are mutually exclusive",
    );
  }
  return {
    packages,
    binariesDir,
    stageResolverBinaries,
    resolvedOutputMap,
    defaultInstall,
    out,
  };
}

function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => parseValue(part));
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (/^[0-9]+$/.test(value)) return Number(value);
  throw new Error(`unsupported TOML value: ${raw}`);
}

function parsePackagesToml(text) {
  const root = {
    default_install: "lazy",
    lazy_url_prefix: "",
    packages: [],
  };
  let currentPackage = null;
  let currentOutput = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;

    if (line === "[[packages]]") {
      currentPackage = { outputs: [] };
      root.packages.push(currentPackage);
      currentOutput = null;
      continue;
    }
    if (line === "[[packages.outputs]]") {
      if (!currentPackage) {
        throw new Error(`line ${i + 1}: [[packages.outputs]] before [[packages]]`);
      }
      currentOutput = {};
      currentPackage.outputs.push(currentOutput);
      continue;
    }

    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new Error(`line ${i + 1}: expected key = value`);
    const [, key] = match;
    let raw = match[2];
    if (raw.trim().startsWith("[") && !raw.trim().endsWith("]")) {
      const startLine = i + 1;
      while (++i < lines.length) {
        const next = stripComment(lines[i]).trim();
        raw += ` ${next}`;
        if (next.endsWith("]")) break;
      }
      if (!raw.trim().endsWith("]")) {
        throw new Error(`line ${startLine}: unterminated array`);
      }
    }
    const target = currentOutput ?? currentPackage ?? root;
    target[key] = parseValue(raw);
  }

  return root;
}

function asArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function modeString(mode) {
  if (typeof mode === "string" && /^[0-7]+$/.test(mode)) {
    return mode.padStart(4, "0");
  }
  const numeric = mode ?? 0o755;
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`mode must be a non-negative integer`);
  }
  return numeric.toString(8).padStart(4, "0");
}

function requireString(obj, key, context) {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}: ${key} is required`);
  }
  if (/\s/.test(value)) {
    throw new Error(`${context}: ${key} must not contain whitespace`);
  }
  return value;
}

function requireBinaryPath(obj, context) {
  const value = requireString(obj, "binary", context);
  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /^[A-Za-z]:\//.test(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    value.normalize("NFC") !== value
  ) {
    throw new Error(
      `${context}: binary must be a canonical NFC relative POSIX path without control characters`,
    );
  }
  try {
    for (const segment of segments) encodeURIComponent(segment);
  } catch {
    throw new Error(`${context}: binary contains ill-formed Unicode`);
  }
  return value;
}

function resolveWithin(root, binaryRel) {
  const candidate = resolve(root, binaryRel);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`binary path escapes its artifact tree: ${binaryRel}`);
  }
  return candidate;
}

function portableArtifactPath(value, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    value.normalize("NFC") !== value
  ) {
    throw new Error(
      `${context} must be a canonical NFC relative POSIX path without control characters`,
    );
  }
  return value;
}

function dependencyEnvKey(packageName) {
  return `WASM_POSIX_DEP_${packageName.toUpperCase().replaceAll("-", "_")}_DIR`;
}

function requireFreshDirectory(path, context) {
  try {
    lstatSync(path);
  } catch (e) {
    if (e?.code === "ENOENT") {
      mkdirSync(path, { recursive: true });
      return;
    }
    throw e;
  }
  throw new Error(`${context} already exists; refusing to reuse staged artifacts: ${path}`);
}

function requireResolverDependencyRoot(packageName) {
  const envName = dependencyEnvKey(packageName);
  const configured = process.env[envName];
  if (!configured) {
    throw new Error(
      `package ${packageName}: ${envName} is required when staging resolver binaries`,
    );
  }
  if (!isAbsolute(configured) || resolve(configured) !== configured) {
    throw new Error(`package ${packageName}: ${envName} must be a normalized absolute path`);
  }
  const linkStat = lstatSync(configured);
  if (!linkStat.isDirectory() || linkStat.isSymbolicLink()) {
    throw new Error(
      `package ${packageName}: ${envName} must name a real directory, not a link`,
    );
  }
  return configured;
}

function stageResolverOutputs(config, stageDir) {
  const stageRoot = resolve(repoRoot, stageDir);
  requireFreshDirectory(stageRoot, "resolver binary staging directory");

  const packageNames = new Set();
  const stagedPaths = new Set();
  for (const pkg of config.packages) {
    const packageName = requireString(pkg, "name", "package");
    if (packageNames.has(packageName)) {
      throw new Error(`duplicate rootfs package: ${packageName}`);
    }
    packageNames.add(packageName);
    if (!Array.isArray(pkg.outputs) || pkg.outputs.length === 0) {
      throw new Error(`package ${packageName}: at least one output is required`);
    }

    const dependencyRoot = requireResolverDependencyRoot(packageName);
    const realDependencyRoot = realpathSync(dependencyRoot);
    for (const output of pkg.outputs) {
      const binaryRel = requireBinaryPath(output, `package ${packageName} output`);
      const sourceArtifact = portableArtifactPath(
        output.source_artifact ?? binaryRel.split("/").at(-1),
        `package ${packageName} output ${binaryRel}: source_artifact`,
      );
      const sourcePath = resolveWithin(dependencyRoot, sourceArtifact);
      const sourceStat = lstatSync(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(
          `package ${packageName}: resolver artifact must be a regular file, not a link: ` +
            `${sourceArtifact}`,
        );
      }
      const realSourcePath = realpathSync(sourcePath);
      resolveWithin(realDependencyRoot, relative(realDependencyRoot, realSourcePath));

      if (stagedPaths.has(binaryRel)) {
        throw new Error(`duplicate staged rootfs binary path: ${binaryRel}`);
      }
      stagedPaths.add(binaryRel);
      const destination = resolveWithin(stageRoot, binaryRel);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(sourcePath, destination, constants.COPYFILE_EXCL);
    }
  }
  return stageRoot;
}

function resolveBinary(binaryRel, binariesDir) {
  if (binariesDir) {
    const selectedRoot = resolve(repoRoot, binariesDir);
    const selected = resolveWithin(selectedRoot, binaryRel);
    if (requireRegularFileIfPresent(selected, binaryRel, "selected artifact tree")) return selected;
    throw new Error(
      `binary not found for rootfs package output: ${binaryRel}\n` +
        `  checked selected artifact tree: ${selected}\n` +
        `  Resolve the package into ${selectedRoot} before generating the manifest.`,
    );
  }

  const local = resolveWithin(resolve(repoRoot, "local-binaries"), binaryRel);
  if (requireRegularFileIfPresent(local, binaryRel, "local override tree")) return local;
  const fetched = resolveWithin(resolve(repoRoot, "binaries"), binaryRel);
  if (requireRegularFileIfPresent(fetched, binaryRel, "fetched artifact tree")) return fetched;
  throw new Error(
    `binary not found for rootfs package output: ${binaryRel}\n` +
      `  checked: ${local}\n` +
      `  checked: ${fetched}\n` +
      `  Build the package locally.`,
  );
}

function requireRegularFileIfPresent(path, binaryRel, treeName) {
  let linkStat;
  try {
    linkStat = lstatSync(path);
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }

  let targetStat;
  try {
    targetStat = statSync(path);
  } catch (e) {
    const detail = e?.code ? ` (${e.code})` : "";
    throw new Error(
      `binary in ${treeName} is not a usable regular file${detail}: ${binaryRel}\n  path: ${path}`,
    );
  }
  if (!targetStat.isFile()) {
    const kind = linkStat.isSymbolicLink() ? "symlink target" : "filesystem node";
    throw new Error(
      `binary in ${treeName} is not a regular file (${kind}): ${binaryRel}\n  path: ${path}`,
    );
  }
  return true;
}

function encodeBinaryUrlPath(binaryRel) {
  return binaryRel
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function manifestToken(value, context) {
  if (/\s/.test(value)) throw new Error(`${context} contains whitespace: ${value}`);
  return value;
}

function outputSelector(output, context) {
  const explicit = output.output;
  if (explicit !== undefined) return stableId(explicit, `${context}: output`);
  const binary = requireBinaryPath(output, context);
  const name = binary.split("/").at(-1);
  const dot = name.lastIndexOf(".");
  return stableId(dot > 0 ? name.slice(0, dot) : name, `${context}: derived output`);
}

function resolvedPackageInputId(packageName, selector) {
  const parts = [packageName, "output", selector];
  const stem = ["package", ...parts].join("-");
  if (Buffer.byteLength(stem) <= 128) return stem;
  const identity = canonicalJson({ kind: "package-output", parts });
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const prefix = stem.slice(0, 128 - suffix.length - 1).replace(/[-._]+$/, "");
  return `${prefix}-${suffix}`;
}

function readResolvedOutputMap(path) {
  const absolute = resolve(path);
  if (!isAbsolute(path) || absolute !== path) {
    throw new Error("resolved output map must be a normalized absolute path");
  }
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("resolved output map must be a regular nonsymlink file");
  }
  if (metadata.size > 4 * 1024 * 1024) {
    throw new Error("resolved output map exceeds 4 MiB");
  }
  const text = readFileSync(absolute, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`resolved output map is invalid JSON: ${error.message}`);
  }
  if (canonicalJson(parsed) !== text) {
    throw new Error("resolved output map is not canonical JSON");
  }
  exactKeys(parsed, ["kind", "outputs", "schema"], "resolved output map");
  if (
    parsed.schema !== 1 ||
    parsed.kind !== "kandelo-rootfs-resolved-package-outputs" ||
    !Array.isArray(parsed.outputs) ||
    parsed.outputs.length > 4096
  ) {
    throw new Error("resolved output map protocol is unsupported");
  }
  const result = new Map();
  let previous = "";
  for (const [index, raw] of parsed.outputs.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`resolved package output ${index} must be an object`);
    }
    const materialization = raw.materialization;
    const expectedKeys = materialization === "embedded"
      ? ["bytes", "id", "materialization", "path", "sha256"]
      : materialization === "lazy-reference"
      ? ["bytes", "id", "materialization", "reference", "sha256"]
      : [];
    if (expectedKeys.length === 0) {
      throw new Error(`resolved package output ${index} has unsupported materialization`);
    }
    exactKeys(raw, expectedKeys, `resolved package output ${index}`);
    const id = stableId(raw.id, `resolved package output ${index} id`);
    if (id <= previous || result.has(id)) {
      throw new Error("resolved package outputs must be sorted by unique ID");
    }
    previous = id;
    const sha256 = lowercaseSha256(raw.sha256, `resolved package output ${id}`);
    if (!Number.isSafeInteger(raw.bytes) || raw.bytes <= 0) {
      throw new Error(`resolved package output ${id} bytes must be a positive safe integer`);
    }
    if (materialization === "lazy-reference") {
      if (
        typeof raw.reference !== "string" ||
        !raw.reference.startsWith("https://") ||
        /\s/.test(raw.reference) ||
        (!raw.reference.includes(`sha256:${sha256}`) &&
          !raw.reference.includes(`sha256=${sha256}`))
      ) {
        throw new Error(`resolved package output ${id} lazy reference is not immutable HTTPS`);
      }
    } else {
      if (
        typeof raw.path !== "string" ||
        !isAbsolute(raw.path) ||
        resolve(raw.path) !== raw.path ||
        /\s/.test(raw.path)
      ) {
        throw new Error(`resolved package output ${id} embedded path is not usable`);
      }
      const inputMetadata = lstatSync(raw.path);
      if (!inputMetadata.isFile() || inputMetadata.isSymbolicLink()) {
        throw new Error(`resolved package output ${id} is not a regular nonsymlink file`);
      }
      const contents = readFileSync(raw.path);
      if (
        contents.byteLength !== raw.bytes ||
        createHash("sha256").update(contents).digest("hex") !== sha256
      ) {
        throw new Error(`resolved package output ${id} bytes do not match identity`);
      }
    }
    result.set(id, Object.freeze({ ...raw }));
  }
  return result;
}

function exactKeys(value, expected, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${context} has unknown or missing fields`);
  }
}

function stableId(value, context) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error(`${context} is not a stable identifier`);
  }
  return value;
}

function lowercaseSha256(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${context} SHA-256 is invalid`);
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function generateManifest(config, binariesDir, defaultInstall, resolvedOutputs) {
  const lines = [
    "# Generated by scripts/generate-rootfs-package-manifest.mjs; do not edit.",
    "",
  ];
  const installed = [];

  for (const pkg of config.packages) {
    const packageName = requireString(pkg, "name", "package");
    const packageInstall =
      pkg.install ?? defaultInstall ?? config.default_install ?? "lazy";
    if (!Array.isArray(pkg.outputs) || pkg.outputs.length === 0) {
      throw new Error(`package ${packageName}: at least one output is required`);
    }

    lines.push(`# ${packageName}`);
    for (const output of pkg.outputs) {
      const binaryRel = requireBinaryPath(output, `package ${packageName} output`);
      const path = requireString(output, "path", `package ${packageName} output ${binaryRel}`);
      const install = output.install ?? packageInstall;
      const mode = modeString(output.mode);
      const uid = output.uid ?? 0;
      const gid = output.gid ?? 0;
      const context = `package ${packageName} output ${binaryRel}`;
      const inputId = resolvedOutputs
        ? resolvedPackageInputId(
            stableId(packageName, "package name"),
            outputSelector(output, context),
          )
        : undefined;
      const resolved = inputId === undefined ? undefined : resolvedOutputs.get(inputId);
      if (inputId !== undefined && !resolved) {
        throw new Error(`rootfs package output ${inputId} is not resolved`);
      }
      if (resolved) resolvedOutputs.delete(inputId);
      const resolvedBinary = resolved ? undefined : resolveBinary(binaryRel, binariesDir);

      if (resolved?.materialization === "lazy-reference") {
        if (install !== "lazy") {
          throw new Error(`rootfs package output ${inputId} must be embedded`);
        }
        lines.push(
          `${path} f ${mode} ${uid} ${gid} lazy_url=${manifestToken(resolved.reference, "lazy_url")} lazy_size=${resolved.bytes}`,
        );
      } else if (resolved?.materialization === "embedded") {
        lines.push(
          `${path} f ${mode} ${uid} ${gid} src=${manifestToken(resolved.path, "src")}`,
        );
      } else if (install === "lazy") {
        const lazyUrl =
          output.lazy_url ?? `${config.lazy_url_prefix ?? ""}${encodeBinaryUrlPath(binaryRel)}`;
        const size = statSync(resolvedBinary).size;
        lines.push(
          `${path} f ${mode} ${uid} ${gid} lazy_url=${manifestToken(lazyUrl, "lazy_url")} lazy_size=${size}`,
        );
      } else if (install === "eager") {
        const src = relative(repoRoot, resolvedBinary);
        lines.push(`${path} f ${mode} ${uid} ${gid} src=${manifestToken(src, "src")}`);
      } else {
        throw new Error(`package ${packageName} output ${binaryRel}: unsupported install=${install}`);
      }

      installed.push(path);
      for (const alias of asArray(output.aliases, `package ${packageName} output ${binaryRel} aliases`)) {
        lines.push(`${alias} l 0777 ${uid} ${gid} target=${path}`);
        installed.push(alias);
      }
    }
    lines.push("");
  }

  if (resolvedOutputs?.size) {
    throw new Error(
      `unconsumed resolved package output(s): ${[...resolvedOutputs.keys()].join(", ")}`,
    );
  }

  return { manifest: lines.join("\n"), installed };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args === "help") {
    process.stdout.write(usage());
    process.exit(0);
  }

  const packagesPath = resolve(repoRoot, args.packages);
  const outPath = resolve(repoRoot, args.out);
  const config = parsePackagesToml(readFileSync(packagesPath, "utf8"));
  const binariesDir = args.stageResolverBinaries
    ? stageResolverOutputs(config, args.stageResolverBinaries)
    : args.binariesDir;
  const resolvedOutputs = args.resolvedOutputMap
    ? readResolvedOutputMap(args.resolvedOutputMap)
    : undefined;
  const { manifest, installed } = generateManifest(
    config,
    binariesDir,
    args.defaultInstall,
    resolvedOutputs,
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, manifest);
  process.stdout.write(
    `generated ${relative(repoRoot, outPath)} with ${installed.length} VFS path(s)\n`,
  );
  for (const path of installed) process.stdout.write(`  ${path}\n`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`generate-rootfs-package-manifest: ${msg}\n`);
  process.exit(1);
}
