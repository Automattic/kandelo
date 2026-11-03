/**
 * Upstream dEQP case selection and chunking for the full GLES2/EGL runners.
 *
 * The expected cases come from the recorded executable inventories of the
 * pinned upstream revision (docs/graphics/cts-coverage-v1.md, "Inventory
 * identities"), stored gzipped in cts-inventory/ and verified against those
 * SHA256 values. A case the executable does not run is therefore reported
 * as Missing rather than disappearing from the accounting.
 *
 * Chunks never cross a family boundary and hold at most `chunkSize` cases,
 * so one guest process or browser page never runs unbounded, a crash loses
 * at most its chunk (the runner resumes after an attributed case), and every
 * per-family count is the sum of whole chunks.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const CTS_SUITES = Object.freeze({
  gles2: Object.freeze({
    root: "dEQP-GLES2",
    program: "programs/wasm32/graphics-cts/deqp-gles2.wasm",
    guestPath: "/bin/deqp-gles2",
    inventory: "cts-inventory/gles2-cases.txt.gz",
    cases: 19825,
    sha256: "d39ae3e3c1ab3595f747edc071d227ae2797498d99fbf77a25576314a46f876a",
    defaultChunkSize: 100,
  }),
  egl: Object.freeze({
    root: "dEQP-EGL",
    program: "programs/wasm32/graphics-cts/deqp-egl.wasm",
    guestPath: "/bin/deqp-egl",
    inventory: "cts-inventory/egl-cases.txt.gz",
    cases: 4117,
    sha256: "6cfc775002e37be1670aaa6486434099eaea9ef9b3ea68140e807778f83d8fc8",
    defaultChunkSize: 50,
  }),
});

/** Earlier bounded GLES2 selectors, kept as exact prefix selections. */
export const LEGACY_SELECTORS = Object.freeze({
  "negative-state": "dEQP-GLES2.functional.negative_api.state.",
  "negative-api": "dEQP-GLES2.functional.negative_api.",
  "color-clear": "dEQP-GLES2.functional.color_clear.",
});

const TOP_LEVEL = ["accuracy", "capability", "functional", "info", "performance", "stress"];

export function suiteSpec(suite) {
  const spec = CTS_SUITES[suite];
  if (!spec) throw new Error(`Unknown CTS suite "${suite}" (expected gles2 or egl)`);
  return spec;
}

/** Validate an inventory text (one case per line, final newline) exactly. */
export function parseInventory(suite, text) {
  const spec = suiteSpec(suite);
  const sha = createHash("sha256").update(text).digest("hex");
  if (sha !== spec.sha256) throw new Error(`${suite} inventory SHA256 ${sha} differs from the pinned ${spec.sha256}`);
  const cases = text.split("\n");
  if (cases.pop() !== "") throw new Error(`${suite} inventory lacks a final newline`);
  if (cases.length !== spec.cases || new Set(cases).size !== cases.length) {
    throw new Error(`${suite} inventory must contain ${spec.cases} unique cases`);
  }
  if (!cases.every(path => path.startsWith(`${spec.root}.`))) throw new Error(`${suite} inventory has a foreign case`);
  return cases;
}

export function loadInventory(suite) {
  const spec = suiteSpec(suite);
  const bytes = readFileSync(new URL(spec.inventory, import.meta.url));
  return parseInventory(suite, gunzipSync(bytes).toString("utf8"));
}

/** Coverage-map family: root.top.group for nested cases, else the case
 * itself (dEQP-GLES2.info.vendor is its own family). */
export function familyOf(path) {
  const parts = path.split(".");
  return parts.length >= 4 ? parts.slice(0, 3).join(".") : path;
}

/** Families in inventory order, with their cases in inventory order. */
export function families(cases) {
  const map = new Map();
  for (const path of cases) {
    const family = familyOf(path);
    if (!map.has(family)) map.set(family, []);
    map.get(family).push(path);
  }
  return map;
}

/** Selector forms, comma-separated and unioned in inventory order:
 * `all`; a top-level group (`functional`, `info`...); a family with or
 * without the suite root (`functional.fbo`, `dEQP-GLES2.functional.fbo`);
 * a legacy GLES2 name (`negative-state`, `negative-api`, `color-clear`). */
export function selectCases(suite, cases, selector) {
  const spec = suiteSpec(suite);
  const terms = String(selector ?? "").split(",").map(term => term.trim()).filter(Boolean);
  if (terms.length === 0) throw new Error("CTS selector is empty");
  const byFamily = families(cases);
  const byCase = new Set(cases);
  const chosen = new Set();
  for (const term of terms) {
    let matched;
    if (term === "all") matched = cases;
    else if (Object.hasOwn(LEGACY_SELECTORS, term)) {
      if (suite !== "gles2") throw new Error(`Selector "${term}" is a GLES2 selector`);
      matched = cases.filter(path => path.startsWith(LEGACY_SELECTORS[term]));
    } else if (TOP_LEVEL.includes(term)) {
      matched = cases.filter(path => path.startsWith(`${spec.root}.${term}.`));
    } else {
      const family = term.startsWith(`${spec.root}.`) ? term : `${spec.root}.${term}`;
      matched = byFamily.get(family) ?? (byCase.has(family) ? [family] : undefined);
    }
    if (!matched || matched.length === 0) throw new Error(`CTS selector "${term}" matches no ${suite} case`);
    for (const path of matched) chosen.add(path);
  }
  return cases.filter(path => chosen.has(path));
}

/** Split selected cases into family-pure chunks of at most `chunkSize`. */
export function chunkCases(cases, chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("CTS chunk size must be a positive integer");
  const chunks = [];
  for (const [family, members] of families(cases)) {
    for (let index = 0, start = 0; start < members.length; index++, start += chunkSize) {
      chunks.push({ id: `${family}#${String(index).padStart(3, "0")}`, family, cases: members.slice(start, start + chunkSize) });
    }
  }
  return chunks;
}

export function buildPlan({ suite, selector = "all", chunkSize, cases = loadInventory(suite) }) {
  const spec = suiteSpec(suite);
  const selected = selectCases(suite, cases, selector);
  const size = chunkSize ?? spec.defaultChunkSize;
  return { version: 1, suite, selector, chunkSize: size, inventorySha256: spec.sha256,
    caseCount: selected.length, chunks: chunkCases(selected, size) };
}

/** Optional `KANDELO_CTS_CHUNKS`: rerun only the named chunk IDs. */
export function filterChunks(plan, ids) {
  if (!ids) return plan;
  const wanted = new Set(String(ids).split(",").map(id => id.trim()).filter(Boolean));
  const chunks = plan.chunks.filter(chunk => wanted.has(chunk.id));
  const unknown = [...wanted].filter(id => !chunks.some(chunk => chunk.id === id));
  if (unknown.length) throw new Error(`Unknown CTS chunk IDs: ${unknown.join(", ")}`);
  return { ...plan, chunks, caseCount: chunks.reduce((sum, chunk) => sum + chunk.cases.length, 0) };
}

/** A filesystem-safe chunk result name. */
export function chunkFileName(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
