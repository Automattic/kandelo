import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("function catalogs preserve identities, aliases and failed-registration atomicity", async ({ page, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-browser-function-catalog-"));
  let bytes: number[];
  try {
    writeFileSync(join(dir, "functions.wat"), `(module
      (import "env" "callback" (func $callback (param i32) (result i32)))
      (table (export "functions") 3 3 funcref)
      (func $first (result i32) i32.const 17)
      (func $second (result i32) i32.const 29)
      (elem (i32.const 0) func $first $second $callback))`);
    execFileSync("wat2wasm", [join(dir, "functions.wat"), "-o", join(dir, "functions.wasm")]);
    bytes = [...readFileSync(join(dir, "functions.wasm"))];
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const documentUrl = new URL("/__function_catalog_contract__", baseURL!);
  await page.route(documentUrl.href, route => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Function catalog contract</title>",
  }));
  await page.goto(documentUrl.href);
  const catalogUrl = new URL(`/@fs/${resolve(repoRoot, "host/src/fork-function-catalog.ts")}`, baseURL!).href;
  const result = await page.evaluate(async ({ bytes, catalogUrl }) => {
    const { ForkFunctionCatalog } = await import(catalogUrl);
    const module = new WebAssembly.Module(Uint8Array.from(bytes));
    const source = new WebAssembly.Instance(module, { env: { callback: (value: number) => value + 100 } }).exports.functions as WebAssembly.Table;
    const first = source.get(0), second = source.get(1);
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 3 });
    table.set(0, first); table.set(1, second);
    const parent = new ForkFunctionCatalog();
    parent.register(0, table);
    table.set(0, second); table.set(1, null); table.grow(1, first);
    const recipe = parent.encode(first);
    const decoded = parent.decode({ moduleActivation: 0, ordinal: 0 });
    const fresh = new WebAssembly.Instance(module, { env: { callback: (value: number) => value + 200 } }).exports.functions as WebAssembly.Table;
    const child = new ForkFunctionCatalog();
    child.register(0, fresh);
    const reconstructed = child.decode(recipe);
    const importedParent = new ForkFunctionCatalog();
    const importedChild = new ForkFunctionCatalog();
    importedParent.register(4, source);
    importedChild.register(4, fresh);
    const importedRecipe = importedParent.encode(source.get(2));
    const callbackValues = [importedParent.decode(importedRecipe)(5), importedChild.decode(importedRecipe)(5)];

    const aliases = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    aliases.set(0, first); aliases.set(1, first);
    const alias = new ForkFunctionCatalog();
    alias.register(7, aliases);
    const before = alias.encode(first);
    alias.register(2, aliases);
    const afterRegister = alias.encode(first);
    alias.unregister(2);
    const afterUnload = alias.encode(first);

    const invalid = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    invalid.set(0, first);
    const failed = new ForkFunctionCatalog();
    let registrationError = "", encodeError = "", boundsError = "";
    try { failed.register(9, invalid); } catch (error) { registrationError = String(error); }
    try { failed.encode(first); } catch (error) { encodeError = String(error); }
    try { parent.decode({ moduleActivation: 0, ordinal: 2 }); } catch (error) { boundsError = String(error); }
    return {
      recipe, frozen: decoded === first && decoded() === 17,
      fresh: reconstructed === fresh.get(0) && reconstructed !== first && reconstructed() === 17,
      before, afterRegister, afterUnload, registrationError, encodeError, boundsError, callbackValues,
    };
  }, { bytes, catalogUrl });
  expect(result).toMatchObject({
    recipe: { moduleActivation: 0, ordinal: 0 }, frozen: true, fresh: true, callbackValues: [105, 205],
    before: { moduleActivation: 7, ordinal: 0 },
    afterRegister: { moduleActivation: 2, ordinal: 0 },
    afterUnload: { moduleActivation: 7, ordinal: 0 },
  });
  expect(result.registrationError).toContain("non-function entry 1");
  expect(result.encodeError).toContain("absent from");
  expect(result.boundsError).toContain("out of bounds");
});
