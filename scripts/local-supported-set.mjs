// Read packages/sets/local-supported.toml for JavaScript consumers: the
// browser binary supply check and the Playwright machine helpers.
//
// The xtask planner (`parse_supported_set` in tools/xtask/src/local_build.rs)
// owns and validates the file's schema; this reader extracts only what those
// consumers need, from the subset of TOML the file uses: `[[table]]` headers,
// `key = value` with strings ("basic" or 'literal'), integers, booleans, and
// arrays of strings (which may span lines). Values it does not need are
// still parsed, so an unrelated key cannot break the reader.

/** `line` without a trailing `#` comment; a `#` inside a string stays. */
function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

const STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

function parseValue(raw, context) {
  const value = raw.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`${context}: unterminated array`);
    return [...value.slice(1, -1).matchAll(STRING)].map((match) => match[1] ?? match[2]);
  }
  const string = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(value);
  if (string) return string[1] ?? string[2];
  if (/^[+-]?[0-9][0-9_]*$/.test(value)) return Number(value.replaceAll("_", ""));
  if (value === "true" || value === "false") return value === "true";
  throw new Error(`${context}: unsupported value ${value}`);
}

function parseTables(text) {
  const root = {};
  const tables = new Map();
  let target = root;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]).trim();
    if (line === "") continue;
    const header = /^\[\[([a-z_]+)\]\]$/.exec(line);
    if (header) {
      target = {};
      const rows = tables.get(header[1]) ?? [];
      rows.push(target);
      tables.set(header[1], rows);
      continue;
    }
    const entry = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!entry) {
      throw new Error(`local-supported.toml line ${index + 1}: unsupported syntax`);
    }
    let raw = entry[2];
    while (raw.trim().startsWith("[") && !raw.trim().endsWith("]") && index + 1 < lines.length) {
      index += 1;
      raw += ` ${stripComment(lines[index]).trim()}`;
    }
    target[entry[1]] = parseValue(raw, `local-supported.toml line ${index + 1}`);
  }
  return { root, tables };
}

/**
 * `{ builtPackages, activeProducts }` for the supported set's text.
 * `builtPackages` is every package the set builds: its `[[packages]]`, its
 * `dependency_only` sources, and the packages its products bind, less its
 * `[[exclusions]]`. `activeProducts` is its `[[products]]` ids.
 */
export function readLocalSupportedSet(text) {
  const { root, tables } = parseTables(text);
  const rows = (name) => tables.get(name) ?? [];
  const excluded = new Set(rows("exclusions").map((row) => row.name));
  const built = new Set([
    ...rows("packages").map((row) => row.name),
    ...(root.dependency_only ?? []),
  ]);
  for (const product of rows("products")) {
    built.add(product.package);
    for (const name of product.package_dependencies ?? []) built.add(name);
    for (const name of product.root_mirror_packages ?? []) built.add(name);
  }
  for (const name of excluded) built.delete(name);
  built.delete(undefined);
  const activeProducts = new Set(rows("products").map((row) => row.id));
  if (built.size === 0 || activeProducts.size === 0) {
    throw new Error("local-supported.toml declares no packages or no products");
  }
  return { builtPackages: built, activeProducts };
}
