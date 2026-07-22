#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    "  --eager-package <name>",
    "                     embed every output of this package (repeatable)",
    "  --eager-output <package>:<guest-path>",
    "                     embed one canonical package output (repeatable)",
    "  --out <path>       generated mkrootfs manifest fragment (required)",
    "  --help             print this message",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  let packages = "images/rootfs/PACKAGES.toml";
  let binariesDir;
  let out;
  const eagerPackages = [];
  const eagerOutputs = [];
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
    if (arg === "--eager-package") {
      const packageName = argv[++i];
      if (!packageName) throw new Error("--eager-package requires a value");
      if (!/^[a-z0-9][a-z0-9+._@-]*$/.test(packageName)) {
        throw new Error(`invalid eager package name: ${packageName}`);
      }
      if (eagerPackages.includes(packageName)) {
        throw new Error(`duplicate --eager-package: ${packageName}`);
      }
      eagerPackages.push(packageName);
      continue;
    }
    if (arg === "--eager-output") {
      const selector = argv[++i];
      if (!selector) throw new Error("--eager-output requires a value");
      const separator = selector.indexOf(":");
      const packageName = separator < 0 ? "" : selector.slice(0, separator);
      const path = separator < 0 ? "" : selector.slice(separator + 1);
      if (!/^[a-z0-9][a-z0-9+._@-]*$/.test(packageName) ||
          !path.startsWith("/") || path.includes("//") ||
          path.split("/").some((segment) => segment === "." || segment === "..") ||
          /[\u0000-\u001f\u007f\s]/.test(path)) {
        throw new Error(`invalid eager output selector: ${selector}`);
      }
      if (eagerOutputs.some((entry) => entry.packageName === packageName && entry.path === path)) {
        throw new Error(`duplicate --eager-output: ${selector}`);
      }
      eagerOutputs.push({ packageName, path });
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!out) throw new Error("--out is required");
  return { packages, binariesDir, eagerPackages, eagerOutputs, out };
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
      `  Run scripts/fetch-binaries.sh or build the package locally.`,
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

function generateManifest(
  config,
  binariesDir,
  requestedEagerPackages = [],
  requestedEagerOutputs = [],
) {
  const lines = [
    "# Generated by scripts/generate-rootfs-package-manifest.mjs; do not edit.",
    "",
  ];
  const installed = [];
  const eagerPackages = new Set(requestedEagerPackages);
  const eagerOutputs = new Map(
    requestedEagerOutputs.map((entry) => [
      `${entry.packageName}\0${entry.path}`,
      entry,
    ]),
  );
  const matchedEagerOutputs = new Set();
  const seenPackages = new Set();

  for (const pkg of config.packages) {
    const packageName = requireString(pkg, "name", "package");
    if (seenPackages.has(packageName)) throw new Error(`duplicate package: ${packageName}`);
    seenPackages.add(packageName);
    const packageInstall = pkg.install ?? config.default_install ?? "lazy";
    if (!Array.isArray(pkg.outputs) || pkg.outputs.length === 0) {
      throw new Error(`package ${packageName}: at least one output is required`);
    }

    lines.push(`# ${packageName}`);
    for (const output of pkg.outputs) {
      const binaryRel = requireBinaryPath(output, `package ${packageName} output`);
      const path = requireString(output, "path", `package ${packageName} output ${binaryRel}`);
      const eagerOutputKey = `${packageName}\0${path}`;
      const selectedEagerOutput = eagerOutputs.has(eagerOutputKey);
      if (selectedEagerOutput) matchedEagerOutputs.add(eagerOutputKey);
      const install = eagerPackages.has(packageName) || selectedEagerOutput
        ? "eager"
        : output.install ?? packageInstall;
      const mode = modeString(output.mode);
      const uid = output.uid ?? 0;
      const gid = output.gid ?? 0;
      const resolvedBinary = resolveBinary(binaryRel, binariesDir);

      if (install === "lazy") {
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

  for (const packageName of eagerPackages) {
    if (!seenPackages.has(packageName)) {
      throw new Error(`--eager-package does not name a configured package: ${packageName}`);
    }
  }
  for (const [key, entry] of eagerOutputs) {
    if (!matchedEagerOutputs.has(key)) {
      throw new Error(
        `--eager-output does not name a configured output: ${entry.packageName}:${entry.path}`,
      );
    }
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
  const { manifest, installed } = generateManifest(
    config,
    args.binariesDir,
    args.eagerPackages,
    args.eagerOutputs,
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
