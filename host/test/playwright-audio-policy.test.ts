import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

it("browser specs and support fixtures cannot bypass the saved silent-audio policy", () => {
  const bypasses: string[] = [];
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".context", "target", "test-results"].includes(entry.name)) scan(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const ast = parse(readFileSync(path, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] });
      for (const node of ast.program.body) {
        if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
        if (!/^(?:@playwright\/test|playwright\/test)(?:\/|$)/.test(node.source.value)) continue;
        const importsTest = node.specifiers.some(specifier =>
          specifier.type !== "ImportSpecifier" ||
          (specifier.importKind !== "type" &&
            (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value) === "test"));
        if (importsTest) bypasses.push(`${relative(root, path)}:${node.loc?.start.line}`);
      }
    }
  };
  scan(join(root, "apps/browser-demos/test"));
  scan(join(root, "packages/registry"));
  expect(bypasses, "Import test from the shared playwright-test fixture so speaker output stays silent").toEqual([]);
});
