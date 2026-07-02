#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.gallery || !args.index) {
  usage(args.help ? 0 : 2);
}

const gallery = JSON.parse(await readText(args.gallery));
const index = parseIndexToml(await readText(args.index));
const errors = [];

if (!gallery || typeof gallery !== "object") {
  errors.push("gallery root must be an object");
} else {
  if (gallery.source_id !== undefined && !validId(gallery.source_id)) {
    errors.push("source_id must match /^[a-z0-9][a-z0-9._-]*$/");
  }
  if (!Array.isArray(gallery.entries)) {
    errors.push("entries must be an array");
  } else {
    const seen = new Set();
    for (const [i, entry] of gallery.entries.entries()) {
      const prefix = `entries[${i}]`;
      if (!entry || typeof entry !== "object") {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (!validId(entry.id)) errors.push(`${prefix}.id must match /^[a-z0-9][a-z0-9._-]*$/`);
      if (seen.has(entry.id)) errors.push(`${prefix}.id duplicates ${entry.id}`);
      seen.add(entry.id);
      for (const field of ["title", "description"]) {
        if (typeof entry[field] !== "string" || entry[field].trim() === "") {
          errors.push(`${prefix}.${field} must be a non-empty string`);
        }
      }
      if (!Array.isArray(entry.packages) || entry.packages.length === 0) {
        errors.push(`${prefix}.packages must be a non-empty array`);
        continue;
      }
      for (const [j, pkg] of entry.packages.entries()) {
        const pkgPrefix = `${prefix}.packages[${j}]`;
        if (!pkg || typeof pkg !== "object") {
          errors.push(`${pkgPrefix} must be an object`);
          continue;
        }
        if (!validId(pkg.name)) errors.push(`${pkgPrefix}.name must match /^[a-z0-9][a-z0-9._-]*$/`);
        if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
          errors.push(`${pkgPrefix}.version must be a non-empty string`);
        }
        const key = `${pkg.name}@${pkg.version}`;
        const record = index.get(key);
        if (!record) {
          errors.push(`${pkgPrefix} missing from index.toml: ${key}`);
        } else if (record.wasm32?.status !== "success") {
          errors.push(`${pkgPrefix} is not wasm32 success in index.toml: ${key}`);
        } else if (!record.wasm32.archive_url) {
          errors.push(`${pkgPrefix} has no wasm32 archive_url in index.toml: ${key}`);
        } else if (record.wasm32.browser_compatible !== true) {
          errors.push(`${pkgPrefix} is not wasm32 browser-compatible in index.toml: ${key}`);
        }
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`validate-software-gallery: ${error}`);
  process.exit(1);
}

console.log(`validate-software-gallery: ${gallery.entries.length} entries valid`);

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--gallery") out.gallery = argv[++i];
    else if (arg === "--index") out.index = argv[++i];
    else {
      console.error(`validate-software-gallery: unknown argument ${arg}`);
      usage(2);
    }
  }
  return out;
}

function usage(code) {
  console.error("usage: scripts/validate-software-gallery.mjs --gallery <path-or-url> --index <path-or-url>");
  process.exit(code);
}

async function readText(pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) {
    const response = await fetch(pathOrUrl);
    if (!response.ok) throw new Error(`${pathOrUrl}: HTTP ${response.status}`);
    return await response.text();
  }
  return await readFile(pathOrUrl, "utf8");
}

function validId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

function parseIndexToml(text) {
  const packages = new Map();
  let currentPackage = null;
  let currentBinary = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line === "[[packages]]") {
      currentPackage = { binary: {} };
      currentBinary = null;
      continue;
    }
    const binaryMatch = line.match(/^\[packages\.binary\.([A-Za-z0-9_-]+)\]$/);
    if (binaryMatch) {
      if (!currentPackage) throw new Error("index.toml has binary section before [[packages]]");
      currentBinary = binaryMatch[1];
      currentPackage.binary[currentBinary] = currentPackage.binary[currentBinary] ?? {};
      continue;
    }
    if (line.startsWith("[")) {
      currentBinary = null;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = parseTomlValue(line.slice(eq + 1).trim());
    if (!currentPackage) continue;
    if (currentBinary) {
      currentPackage.binary[currentBinary][key] = value;
      continue;
    }
    currentPackage[key] = value;
    if (currentPackage.name && currentPackage.version) {
      packages.set(`${currentPackage.name}@${currentPackage.version}`, currentPackage.binary);
    }
  }
  return new Map([...packages].map(([key, binary]) => [key, binary]));
}

function stripComment(line) {
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "\"") {
      quoted = !quoted;
    } else if (ch === "#" && !quoted) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlValue(raw) {
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    return raw.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  return raw;
}
