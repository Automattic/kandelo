import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QJS = join(__dirname, "../../examples/libs/quickjs/bin/qjs.wasm");
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");
const HAS_QJS = existsSync(QJS);
const HAS_NODE = existsSync(NODE);

describe.skipIf(!HAS_QJS)("qjs.wasm eval smoke", () => {
  it.each([
    ["print(1+1)", "2"],
    ["print('hello')", "hello"],
    ["print([1,2,3].map(x=>x*2).join(','))", "2,4,6"],
  ])("qjs -e %s prints %s", async (src, expected) => {
    const r = await runCentralizedProgram({
      programPath: QJS,
      argv: ["qjs", "-e", src],
      timeout: 20_000,
    });
    expect(r.stderr).not.toContain("Maximum call stack size");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(expected);
  });
});

describe.skipIf(!HAS_NODE)("node.wasm eval smoke", () => {
  it("node -e console.log(1+1) prints 2", async () => {
    const r = await runCentralizedProgram({
      programPath: NODE,
      argv: ["node", "-e", "console.log(1+1)"],
      timeout: 20_000,
    });
    expect(r.stderr).not.toContain("Maximum call stack size");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("2");
  });
});

/**
 * `\p{...}` Unicode property escapes must work under /v, not just /u.
 * Pre-patch QuickJS-NG misparsed them as literal letters in a character
 * class, corrupting pi-tui's width math (see libregexp patch 0004).
 * Of-strings properties (RGI_Emoji and friends) are stubbed to an empty
 * CharRange so the regex compiles instead of throwing at module init.
 */
describe.skipIf(!HAS_QJS)("qjs.wasm /v + \\p{...} property escapes", () => {
  it.each([
    // Gate fix: \p{Control} actually resolves and matches a real control char.
    [`print(/\\p{Control}/v.test("\\x07"))`, "true"],
    // pi-tui's live class — pre-fix matched ASCII letters from the property
    // names inside "settings"; post-fix the class is empty for ASCII letters.
    [
      `print(/^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+/v.test("settings"))`,
      "false",
    ],
    // Of-strings stub: compiles, never matches a code point.
    [`print(/^\\p{RGI_Emoji}$/v.test("🦊"))`, "false"],
    // \P{stub} inverts the empty range to "matches any code point".
    [`print(/^\\P{RGI_Emoji}$/v.test("a"))`, "true"],
  ])("qjs -e %s prints %s", async (src, expected) => {
    const r = await runCentralizedProgram({
      programPath: QJS,
      argv: ["qjs", "-e", src],
      timeout: 20_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.trim()).toBe("");
    expect(r.stdout.trim()).toBe(expected);
  });

  it("unknown property name under /v still throws SyntaxError", async () => {
    const r = await runCentralizedProgram({
      programPath: QJS,
      argv: [
        "qjs",
        "-e",
        `try { new RegExp("\\\\p{NotAProperty}", "v"); print("ok"); } ` +
          `catch (e) { print("threw:" + e.message); }`,
      ],
      timeout: 20_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("threw:unknown unicode property name");
  });
});
