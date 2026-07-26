import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createForkUnwindTag,
  FORK_UNWIND_TAG_IMPORT_MODULE,
  FORK_UNWIND_TAG_IMPORT_NAME,
  isForkUnwindException,
} from "../src/fork-unwind-transport";

function throwingModule(): WebAssembly.Module {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-unwind-tag-"));
  const wat = join(dir, "transport.wat");
  const wasm = join(dir, "transport.wasm");
  writeFileSync(wat, `(module
    (tag $unwind (import "${FORK_UNWIND_TAG_IMPORT_MODULE}" "${FORK_UNWIND_TAG_IMPORT_NAME}"))
    (func (export "throw_unwind") throw $unwind)
  )`);
  execFileSync("wat2wasm", ["--enable-exceptions", wat, "-o", wasm]);
  return new WebAssembly.Module(readFileSync(wasm));
}

describe.skipIf(
  typeof WebAssembly.Tag !== "function"
  || typeof WebAssembly.Exception !== "function",
)("fork unwind transport", () => {
  it("recognizes only the exact process-owned tag identity", () => {
    const tag = createForkUnwindTag();
    const other = createForkUnwindTag();
    const instance = new WebAssembly.Instance(throwingModule(), {
      env: { [FORK_UNWIND_TAG_IMPORT_NAME]: tag },
    });

    let thrown: unknown;
    try {
      (instance.exports.throw_unwind as () => void)();
    } catch (error) {
      thrown = error;
    }
    expect(isForkUnwindException(thrown, tag)).toBe(true);
    expect(isForkUnwindException(thrown, other)).toBe(false);
  });

  it("shares one identity across independently instantiated modules", () => {
    const tag = createForkUnwindTag();
    const module = throwingModule();
    const imports = { env: { [FORK_UNWIND_TAG_IMPORT_NAME]: tag } };
    const first = new WebAssembly.Instance(module, imports);
    const second = new WebAssembly.Instance(module, imports);

    for (const instance of [first, second]) {
      expect(() => (instance.exports.throw_unwind as () => void)()).toThrow();
      try {
        (instance.exports.throw_unwind as () => void)();
      } catch (error) {
        expect(isForkUnwindException(error, tag)).toBe(true);
      }
    }
  });
});
