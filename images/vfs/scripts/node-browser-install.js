const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const fetch = require("make-fetch-happen");
const semver = require("semver");

function shouldHandle(argv) {
  const cmd = argv[2];
  if (cmd !== "install" && cmd !== "i") return false;
  return parseInstallArgs(argv.slice(3)).packages.length > 0;
}

function parseInstallArgs(args) {
  const out = {
    packages: [],
    prefix: process.cwd(),
    cache: "/tmp/.npm-cache",
    registry: "https://registry.npmjs.org/",
    loglevel: "notice",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prefix") out.prefix = args[++i] || out.prefix;
    else if (arg.startsWith("--prefix=")) out.prefix = arg.slice(9);
    else if (arg === "--cache") out.cache = args[++i] || out.cache;
    else if (arg.startsWith("--cache=")) out.cache = arg.slice(8);
    else if (arg === "--registry") out.registry = args[++i] || out.registry;
    else if (arg.startsWith("--registry=")) out.registry = arg.slice(11);
    else if (arg === "--loglevel") out.loglevel = args[++i] || out.loglevel;
    else if (arg.startsWith("--loglevel=")) out.loglevel = arg.slice(11);
    else if (arg.startsWith("-")) {
      if (arg === "-g" || arg === "--global") {
        throw new Error("browser npm install does not support global installs");
      }
    } else {
      out.packages.push(arg);
    }
  }
  if (!out.registry.endsWith("/")) out.registry += "/";
  return out;
}

function splitSpec(raw) {
  if (raw.startsWith("@")) {
    const slash = raw.indexOf("/");
    const at = raw.indexOf("@", slash + 1);
    return at === -1
      ? { name: raw, range: "latest" }
      : { name: raw.slice(0, at), range: raw.slice(at + 1) || "latest" };
  }
  const at = raw.indexOf("@", 1);
  return at === -1
    ? { name: raw, range: "latest" }
    : { name: raw.slice(0, at), range: raw.slice(at + 1) || "latest" };
}

function packumentUrl(name, registry) {
  const escaped = name.startsWith("@")
    ? "@" + name.slice(1).replace("/", "%2f")
    : encodeURIComponent(name);
  return registry + escaped;
}

function proxyTarballUrl(url, registry) {
  if (registry.startsWith("http://proxy.local/")) {
    return url.replace(/^https:\/\/registry\.npmjs\.org\//, registry);
  }
  return url;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error("registry request failed: " + res.status + " " + url);
  return res.json();
}

async function resolveManifest(name, range, cfg) {
  const packument = await fetchJson(packumentUrl(name, cfg.registry), {
    cache: cfg.cache,
    registry: cfg.registry,
  });
  let version = range === "latest" || !range
    ? packument["dist-tags"] && packument["dist-tags"].latest
    : packument["dist-tags"] && packument["dist-tags"][range];
  if (!version && packument.versions && packument.versions[range]) {
    version = range;
  }
  if (!version) {
    version = semver.maxSatisfying(Object.keys(packument.versions || {}), range);
  }
  if (!version || !packument.versions[version]) {
    throw new Error("No matching version for " + name + "@" + range);
  }
  return packument.versions[version];
}

function packagePath(base, name) {
  return path.join(base, "node_modules", ...name.split("/"));
}

function readString(buf, start, length) {
  let end = start;
  const max = start + length;
  while (end < max && buf[end] !== 0) end++;
  return buf.slice(start, end).toString("utf8");
}

function readOctal(buf, start, length) {
  const raw = readString(buf, start, length).trim();
  return raw ? parseInt(raw, 8) : 0;
}

function safeJoin(root, rel) {
  const normalized = path.normalize(rel).replace(/^\/+/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Unsafe tar entry: " + rel);
  }
  return path.join(root, normalized);
}

function extractTarball(tgz, dest) {
  const tar = zlib.gunzipSync(tgz);
  fs.mkdirSync(dest, { recursive: true });
  for (let off = 0; off + 512 <= tar.length;) {
    const name = readString(tar, off, 100);
    if (!name) break;
    const mode = readOctal(tar, off + 100, 8) || 0o644;
    const size = readOctal(tar, off + 124, 12);
    const type = readString(tar, off + 156, 1) || "0";
    const link = readString(tar, off + 157, 100);
    const prefix = readString(tar, off + 345, 155);
    const fullName = (prefix ? prefix + "/" : "") + name;
    off += 512;

    const rel = fullName.startsWith("package/") ? fullName.slice(8) : fullName;
    if (rel && type !== "x" && type !== "g") {
      const target = safeJoin(dest, rel);
      if (type === "5") {
        fs.mkdirSync(target, { recursive: true });
      } else if (type === "2") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try { fs.symlinkSync(link, target); } catch {}
      } else if (type === "0" || type === "") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, tar.slice(off, off + size));
        try { fs.chmodSync(target, mode & 0o777); } catch {}
      }
    }
    off += Math.ceil(size / 512) * 512;
  }
}

async function installOne(name, range, cfg, state, base) {
  const dest = packagePath(base, name);
  const key = path.relative(cfg.prefix, dest).replace(/\\/g, "/");
  const existing = state.installed.get(key);
  if (existing) {
    if (semver.satisfies(existing.version, range) || existing.version === range || range === "latest") {
      return existing;
    }
    throw new Error("Version conflict for " + key + ": " + existing.version + " does not satisfy " + range);
  }

  const manifest = await resolveManifest(name, range, cfg);
  const resolved = proxyTarballUrl(manifest.dist.tarball, cfg.registry);
  state.installed.set(key, {
    name,
    location: key,
    version: manifest.version,
    manifest,
    resolved,
  });

  const res = await fetch(resolved, {
    cache: cfg.cache,
    registry: cfg.registry,
  });
  if (!res.ok) throw new Error("tarball request failed: " + res.status + " " + resolved);
  const tgz = await res.buffer();
  extractTarball(tgz, dest);

  const deps = manifest.dependencies || {};
  for (const dep of Object.keys(deps)) {
    await installOne(dep, deps[dep], cfg, state, dest);
  }
  return state.installed.get(key);
}

function readRootPackage(prefix) {
  const file = path.join(prefix, "package.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { name: "demo", version: "0.0.1" };
  }
}

function writeRootPackage(prefix, pkg) {
  fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

function writeLockfile(prefix, pkg, installed) {
  const packages = {
    "": {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies || {},
    },
  };
  const dependencies = {};
  for (const entry of installed.values()) {
    const manifest = entry.manifest;
    const meta = {
      version: manifest.version,
      resolved: entry.resolved,
    };
    if (manifest.dist && manifest.dist.integrity) meta.integrity = manifest.dist.integrity;
    if (manifest.dependencies) meta.dependencies = manifest.dependencies;
    packages[entry.location] = meta;
    dependencies[entry.name] = {
      version: manifest.version,
      resolved: entry.resolved,
    };
    if (manifest.dist && manifest.dist.integrity) dependencies[entry.name].integrity = manifest.dist.integrity;
    if (manifest.dependencies) dependencies[entry.name].requires = manifest.dependencies;
  }
  fs.writeFileSync(path.join(prefix, "package-lock.json"), JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages,
    dependencies,
  }, null, 2) + "\n");
}

function linkBins(prefix, installed) {
  const binDir = path.join(prefix, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const entry of installed.values()) {
    const bin = entry.manifest.bin;
    if (!bin) continue;
    const bins = typeof bin === "string" ? { [entry.name.split("/").pop()]: bin } : bin;
    for (const name of Object.keys(bins)) {
      if (entry.location.indexOf("/node_modules/") !== -1) continue;
      const target = path.relative(binDir, path.join(prefix, entry.location, bins[name]));
      const link = path.join(binDir, name);
      try { fs.unlinkSync(link); } catch {}
      try { fs.symlinkSync(target, link); } catch {}
    }
  }
}

async function run(argv) {
  const cfg = parseInstallArgs(argv.slice(3));
  const started = Date.now();
  fs.mkdirSync(path.join(cfg.prefix, "node_modules"), { recursive: true });
  fs.mkdirSync(cfg.cache, { recursive: true });
  const root = readRootPackage(cfg.prefix);
  root.dependencies = root.dependencies || {};
  const state = { installed: new Map() };
  for (const raw of cfg.packages) {
    const spec = splitSpec(raw);
    const installed = await installOne(spec.name, spec.range, cfg, state, cfg.prefix);
    root.dependencies[spec.name] = "^" + installed.version;
  }
  writeRootPackage(cfg.prefix, root);
  writeLockfile(cfg.prefix, root, state.installed);
  linkBins(cfg.prefix, state.installed);
  if (cfg.loglevel !== "silent") {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write("\nadded " + state.installed.size + " packages in " + seconds + "s\n");
  }
}

module.exports = { shouldHandle, run };
