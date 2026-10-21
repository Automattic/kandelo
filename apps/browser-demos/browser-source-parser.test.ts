import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "@babel/parser";
import { browserSourceParserPlugins } from "./browser-binary-imports.mjs";

test("ordinary TypeScript generic functions remain visible to source audits", () => {
  const code = "const receive = <T>(value: T): T => value; import('./child.ts');";
  const ast = parse(code, {
    sourceType: "module", plugins: browserSourceParserPlugins("worker.ts"),
  });
  assert.equal(ast.program.body.length, 2);
  assert.equal(ast.program.body[0].type, "VariableDeclaration");
});

test("JSX remains enabled for JSX and TSX files, including Vite query suffixes", () => {
  for (const file of ["view.jsx", "view.tsx", "view.tsx?direct"]) {
    const ast = parse("const view = <div />;", {
      sourceType: "module", plugins: browserSourceParserPlugins(file),
    });
    assert.equal(ast.program.body[0].type, "VariableDeclaration");
  }
  assert.throws(() => parse("const view = <div />;", {
    sourceType: "module", plugins: browserSourceParserPlugins("worker.ts"),
  }));
});
