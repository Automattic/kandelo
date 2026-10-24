// The rootfs package mapping (images/rootfs/PACKAGES.toml): which package
// outputs the base image carries, where, and whether each is lazy.
//
// Two consumers read it and must agree: the rootfs manifest generator
// (scripts/generate-rootfs-package-manifest.mjs), which writes the image's
// lazy entries, and the browser asset generator
// (scripts/generate-browser-lazy-asset-urls.ts), which gives the browser a URL
// for each of those entries. Keep the parsing and the lazy-output rule here so
// they cannot drift apart.

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

export function parsePackagesToml(text) {
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

export function encodeBinaryUrlPath(binaryRel) {
  return binaryRel
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** The install mode one output gets: the output's own, else its package's,
 *  else the override, else the mapping's default. */
export function outputInstallMode(config, pkg, output, defaultInstall) {
  return output.install
    ?? pkg.install
    ?? defaultInstall
    ?? config.default_install
    ?? "lazy";
}

/** The lazy URL the image records for a lazy output. */
export function outputLazyUrl(config, output) {
  return output.lazy_url
    ?? `${config.lazy_url_prefix ?? ""}${encodeBinaryUrlPath(output.binary)}`;
}

/**
 * Every lazy output the default rootfs image records, in mapping order:
 * `{ packageName, binary, lazyUrl }`. `binary` is the package-mirror path
 * (`programs/wasm32/bash.wasm`) and `lazyUrl` the address the image stores.
 */
export function rootfsLazyOutputs(config) {
  const outputs = [];
  for (const pkg of config.packages) {
    for (const output of pkg.outputs ?? []) {
      if (outputInstallMode(config, pkg, output) !== "lazy") continue;
      outputs.push({
        packageName: pkg.name,
        binary: output.binary,
        lazyUrl: outputLazyUrl(config, output),
      });
    }
  }
  return outputs;
}
