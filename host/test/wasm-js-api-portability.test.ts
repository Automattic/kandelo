import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { findRepoRoot } from "../src/binary-tiers";

/**
 * Host code mints WebAssembly objects only with types EVERY engine accepts.
 *
 * # Why this exists
 *
 * The JavaScript API is narrower than the Wasm a module may define. Measured
 * in Playwright's WebKit on 2026-09-25: `new WebAssembly.Table` accepts only
 * `"funcref"`/`"anyfunc"`/`"externref"` and `new WebAssembly.Global` only the
 * number types plus those, and both throw a TypeError for `"anyref"` or
 * `"eqref"` -- although the same engine instantiates, exports and grows an
 * `anyref` table a MODULE defines. V8 accepts `"anyref"` as an extension, so a
 * Node run never notices. From 2026-09-12 to 2026-09-25 the host minted the
 * fork-module's static-root catalog as `element: "anyref"`, and no fork could
 * start on WebKit while every Node and Chromium check stayed green. A GC-typed
 * table belongs to a module (the fork-module owns and exports both of its
 * anyref tables); this test keeps the host from minting one again.
 *
 * The same measurement found Playwright's Chromium rejecting the standard
 * spelling `"funcref"` in `new WebAssembly.Table`, so the portable set here is
 * the intersection: `"anyfunc"` and `"externref"`.
 *
 * # What it checks
 *
 * Every `new WebAssembly.Table(...)` and `new WebAssembly.Global(...)` in the
 * runtime sources both hosts load must name its element or value type as a
 * string LITERAL from the portable set. A computed or cast type fails too:
 * this is a static check, and a type it cannot read is a type it cannot vouch
 * for (the original defect hid behind `element as "anyfunc"`) -- unless the
 * expression is listed in `AUDITED_COMPUTED_TYPES` with the reason it can only
 * produce a portable type.
 */

const repoRoot = findRepoRoot();

/** Runtime sources shared by the Node and browser hosts. */
const SCANNED_ROOTS = ["host/src", "web-libs/kandelo-session/src"];

const PORTABLE: Record<string, { property: string; allowed: readonly string[] }> = {
  Table: { property: "element", allowed: ["anyfunc", "externref"] },
  Global: {
    property: "value",
    allowed: ["i32", "i64", "f32", "f64", "anyfunc", "externref"],
  },
};

/**
 * Computed type expressions read by hand, each with why it is portable. Keyed
 * by the exact expression text, so a changed expression is unaudited again.
 */
const AUDITED_COMPUTED_TYPES: Record<string, string> = {
  // host/src/dylink-planner.ts: maps i32/i64/f32/f64 and THROWS on any
  // reference ("opaque") type rather than minting one.
  "valTypeName(act.ty)": "number types only",
  // host/src/pic-side-module.ts: `ptrWidth === 8 ? "i64" : "i32"`.
  pointerType: "i32 or i64",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "generated") out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The text of the parenthesised argument list starting at `open`. */
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")" && --depth === 0) return text.slice(open + 1, at);
  }
  return text.slice(open + 1);
}

interface Construction {
  where: string;
  kind: string;
  argument: string;
}

/** Every `new WebAssembly.{Table,Global}(...)` in `text`. */
function constructionsIn(text: string, file: string): Construction[] {
  const found: Construction[] = [];
  const pattern = /new\s+WebAssembly\s*\.\s*(Table|Global)\s*\(/g;
  for (const match of text.matchAll(pattern)) {
    const open = match.index! + match[0].length - 1;
    const line = text.slice(0, match.index).split("\n").length;
    found.push({ where: `${file}:${line}`, kind: match[1], argument: argumentsAt(text, open) });
  }
  return found;
}

/** The violation for one construction, or null when it is portable. */
function portabilityViolation(c: Construction): string | null {
  const rule = PORTABLE[c.kind];
  const literal = new RegExp(`\\b${rule.property}\\s*:\\s*"([A-Za-z0-9_]+)"\\s*[,}\\n]`).exec(c.argument);
  if (!literal) {
    const computed = new RegExp(`\\b${rule.property}\\s*:\\s*([^,}\\n]+?)\\s*[,}\\n]`).exec(c.argument);
    if (computed && computed[1] in AUDITED_COMPUTED_TYPES) return null;
    return (
      `${c.where}: WebAssembly.${c.kind} ${rule.property} is neither a string literal ` +
      `nor an audited expression (${computed?.[1] ?? "unreadable"})`
    );
  }
  if (!rule.allowed.includes(literal[1])) {
    return (
      `${c.where}: WebAssembly.${c.kind} ${rule.property} "${literal[1]}" is not ` +
      `accepted by every engine's JS API (portable: ${rule.allowed.join(", ")}); ` +
      `a GC-typed table or global must be defined and exported by a module`
    );
  }
  return null;
}

describe("host WebAssembly constructions are engine-portable", () => {
  it("mints no table or global of a type WebKit's JS API rejects", () => {
    const violations: string[] = [];
    let seen = 0;
    for (const root of SCANNED_ROOTS) {
      for (const path of sourceFiles(join(repoRoot, root))) {
        const file = relative(repoRoot, path);
        for (const c of constructionsIn(readFileSync(path, "utf8"), file)) {
          seen += 1;
          const violation = portabilityViolation(c);
          if (violation) violations.push(violation);
        }
      }
    }
    // A scan that finds nothing proves nothing: the host does mint funcref
    // tables and i32 globals, so a zero here means the scan broke.
    expect(seen, "constructions found").toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });

  it("flags exactly the shapes that broke WebKit", () => {
    const check = (source: string) =>
      constructionsIn(source, "x.ts").map((c) => portabilityViolation(c) !== null);
    expect(check(`new WebAssembly.Table({ element: "anyfunc", initial: 0 })`)).toEqual([false]);
    expect(check(`new WebAssembly.Table({ element: "anyref", initial: 0 })`)).toEqual([true]);
    expect(check(`new WebAssembly.Table({ element: element as "anyfunc", initial: 0 })`)).toEqual([true]);
    expect(check(`new WebAssembly.Global({ value: "anyref", mutable: true }, null)`)).toEqual([true]);
    expect(check(`new WebAssembly.Global(\n  { value: "i32", mutable: false },\n  f(1),\n)`)).toEqual([false]);
    expect(check(`new WebAssembly.Global({ value: pointerType, mutable: false }, 0)`)).toEqual([false]);
    expect(check(`new WebAssembly.Global({ value: refType, mutable: false }, 0)`)).toEqual([true]);
  });
});
