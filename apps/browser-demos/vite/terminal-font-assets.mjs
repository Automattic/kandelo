import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { openSync } from "fontkit";

const require = createRequire(import.meta.url);
const baseFont = "@fontsource-variable/noto-sans-mono/files/noto-sans-mono-latin-wght-normal.woff2";
const fontPackages = [
  ["@fontsource-variable", [
    "noto-sans-mono", "noto-sans", "noto-sans-symbols",
    "noto-sans-arabic", "noto-sans-armenian", "noto-sans-bengali",
    "noto-sans-canadian-aboriginal", "noto-sans-devanagari", "noto-sans-ethiopic",
    "noto-sans-georgian", "noto-sans-gujarati", "noto-sans-gurmukhi", "noto-sans-hebrew",
    "noto-sans-kannada", "noto-sans-khmer", "noto-sans-lao", "noto-sans-malayalam",
    "noto-sans-myanmar", "noto-sans-oriya", "noto-sans-sinhala", "noto-sans-tamil",
    "noto-sans-telugu", "noto-sans-thai", "noto-serif-tibetan",
  ]],
  ["@fontsource", ["noto-sans-symbols-2", "noto-sans-yi"]],
  // Pick a stable order for shared Han code points and use the other sets
  // for their unique characters. A terminal stream cannot identify a locale.
  ["@fontsource-variable", ["noto-sans-jp", "noto-sans-sc", "noto-sans-tc", "noto-sans-kr", "noto-emoji"]],
];

function fontsourceSubsets() {
  const subsets = [];
  for (const [scope, packages] of fontPackages) {
    const weight = scope === "@fontsource-variable" ? "100 900" : "400";
    const css = scope === "@fontsource-variable" ? "wght.css" : "400.css";
    for (const name of packages) {
      const pkg = `${scope}/${name}`;
      const file = require.resolve(`${pkg}/${css}`);
      const rules = Array.from(readFileSync(file, "utf8").matchAll(/@font-face\s*\{([^}]+)\}/g));
      if (!rules.length) throw new Error(`No font faces in ${pkg}/${css}`);
      // CSS gives later declarations priority when subsets overlap.
      for (const [, rule] of rules.reverse()) {
        const url = rule.match(/url\(\.\/([^)]*\.woff2)\)/)?.[1];
        const unicodeRange = rule.match(/unicode-range:\s*([^;]+);/)?.[1];
        if (!url || !unicodeRange) throw new Error(`Missing Fontsource URL or range in ${pkg}/${css}`);
        const specifier = `${pkg}/${url}`;
        if (specifier === baseFont) continue;
        subsets.push({ specifier, path: resolve(dirname(file), url), weight, unicodeRange });
      }
    }
  }
  return subsets;
}

function ranges(descriptor) {
  return descriptor.split(",").map((range) => {
    const [start, end = start] = range.trim().slice(2).split("-");
    return [Number.parseInt(start.replaceAll("?", "0"), 16), Number.parseInt(end.replaceAll("?", "f"), 16)];
  });
}

export function terminalFontCatalog() {
  const subsets = [
    { specifier: baseFont, path: require.resolve(baseFont), weight: "100 900" },
    ...fontsourceSubsets(),
    ...["marks", "symbols", "hangul-jamo"].map(name => {
      const specifier = `/assets/terminal-fonts/noto-${name}.woff2`;
      return { specifier, path: resolve(dirname(require.resolve("../package.json")), `.${specifier}`), weight: "400", clusterFallback: name === "marks" };
    }),
  ];
  const owners = new Uint16Array(0x110000);
  owners.fill(0xffff);
  for (const [index, subset] of subsets.entries()) {
    // Fontsource's ranges guide browser selection, but some ranges include
    // code points absent from that build. Check the actual WOFF2 cmap.
    const declared = subset.unicodeRange ? ranges(subset.unicodeRange) : null;
    const font = openSync(subset.path);
    for (const cp of font.characterSet) {
      if (owners[cp] !== 0xffff || !font.hasGlyphForCodePoint(cp)) continue;
      if (!declared || declared.some(([start, end]) => cp >= start && cp <= end)) owners[cp] = index;
    }
  }

  const spans = [];
  for (let start = 128; start < owners.length;) {
    const index = owners[start];
    let end = start;
    while (end + 1 < owners.length && owners[end + 1] === index) end++;
    if (index !== 0xffff) spans.push(start, end, index);
    start = end + 1;
  }
  return { subsets, spans };
}

// Consecutive ranges usually have small gaps and lengths. Unsigned varints
// avoid shipping each code point's full decimal spelling to the browser.
function packSpans(spans) {
  const bytes = [];
  const write = (value) => {
    while (value >= 0x80) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value);
  };
  let previousEnd = 127;
  for (let i = 0; i < spans.length; i += 3) {
    const start = spans[i];
    const end = spans[i + 1];
    write(start - previousEnd - 1);
    write(end - start);
    write(spans[i + 2]);
    previousEnd = end;
  }
  return Buffer.from(bytes).toString("base64");
}

export function terminalFontAssets() {
  let catalog;
  let devBase;
  return {
    name: "kandelo-terminal-font-assets",
    configResolved(config) {
      if (config.command === "serve") devBase = config.base;
    },
    resolveId(id) {
      if (id === "virtual:kandelo-terminal-fonts") return "\0" + id;
    },
    load(id) {
      if (id !== "\0virtual:kandelo-terminal-fonts") return;
      catalog ??= terminalFontCatalog();
      const { subsets, spans } = catalog;
      const used = new Set(spans.filter((_, index) => index % 3 === 2));
      const imports = [];
      const assets = subsets.map(({ specifier, path, weight, clusterFallback }, index) => {
        // The base is loaded separately before opening xterm.
        if (index === 0 || !used.has(index)) return "null";
        const url = devBase === undefined
          ? `asset${index}`
          : JSON.stringify(`${devBase}@fs${encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F")}`);
        if (devBase === undefined) {
          imports.push(`import asset${index} from ${JSON.stringify(specifier + "?url&no-inline")};`);
        }
        return `{ url: ${url}, weight: ${JSON.stringify(weight)}${clusterFallback ? ", clusterFallback: true" : ""} }`;
      });
      return `${imports.join("\n")}\nexport const assets = [${assets}];\nexport const packedSpans = ${JSON.stringify(packSpans(spans))};`;
    },
  };
}
