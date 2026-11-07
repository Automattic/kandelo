import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// This dispatcher is an internal live ESM binding, not a stable callback API.
// A copied function predates later fatal configuration and misses the sampling
// phase; constrain the real callers rather than claiming snapshots stay live.
function captures(text: string, name = "consumer.ts"): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>(), errors: string[] = [];
  function collect(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "withNativeBatch") imports.add(node.name.text);
    ts.forEachChild(node, collect);
  }
  collect(source);
  function visit(node: ts.Node): void {
    if (ts.isBindingElement(node) && ((node.propertyName && (ts.isIdentifier(node.propertyName) || ts.isStringLiteral(node.propertyName)) && node.propertyName.text === "withNativeBatch") || (ts.isIdentifier(node.name) && node.name.text === "withNativeBatch"))) {
      errors.push("dynamic dispatcher destructuring");
    } else if (ts.isExportSpecifier(node) && (node.propertyName ?? node.name).text === "withNativeBatch") {
      errors.push("internal mutable dispatcher re-export");
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === "withNativeBatch") {
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) errors.push("copied dispatcher property");
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "withNativeBatch") {
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) errors.push("copied literal dispatcher element");
    } else if (ts.isIdentifier(node) && imports.has(node.text)) {
      const parent = node.parent;
      if (!ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent) && !ts.isTypeQueryNode(parent) &&
          !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
          !(ts.isCallExpression(parent) && parent.expression === node)) errors.push("copied ESM dispatcher binding");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

it("accepts ESM live calls and dynamic namespace calls across audit configuration", () => {
  expect(captures('import {withNativeBatch as batch} from "./native-batch"; configure(); batch(owner,"x",work);')).toEqual([]);
  expect(captures('const batch = await import("./native-batch"); configure(); batch.withNativeBatch(owner,"x",work);')).toEqual([]);
});
it.each([
  'const {withNativeBatch} = await import("./native-batch");',
  'const [{withNativeBatch}] = await Promise.all([import("./native-batch")]);',
  'const batch = await import("./native-batch"); const copied = batch.withNativeBatch;',
  'import {withNativeBatch as batch} from "./native-batch"; const copied = batch;',
  'import {withNativeBatch} from "./native-batch"; runLater(withNativeBatch);',
  'export {withNativeBatch} from "./native-batch";',
  `const {'withNativeBatch': batch} = await import("./native-batch");`,
  `const batch=await import("./native-batch"); const copied=batch['withNativeBatch'];`,
  `const batch=await import("./native-batch"); later(batch['withNativeBatch']);`,
])("refuses a stale internal dispatcher capture: %s", text => expect(captures(text)).not.toEqual([]));

it("checks the complete tracked and new supported caller inventory", () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx", "*.mjs"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
  const findings: string[] = []; let callers = 0;
  for (const file of new Set(files)) {
    if (file === "host/src/webgl/native-batch.ts") continue; // Owns the intentional adapter assignments.
    const text = readFileSync(resolve(repo, file), "utf8");
    if (!text.includes("withNativeBatch")) continue;
    callers++;
    for (const finding of captures(text, file)) findings.push(`${file}: ${finding}`);
  }
  expect(callers).toBeGreaterThan(15);
  expect(findings).toEqual([]);
});

it.each(["env", "url"])("configures fatal mode before the batch module initializes via %s", transport => {
  const auditUrl = new URL("../src/webgl/native-audit.ts", import.meta.url).href;
  const batchUrl = new URL("../src/webgl/native-batch.ts", import.meta.url).href;
  const objectsUrl = new URL("../src/webgl/program-objects.ts", import.meta.url).href;
  const script = `
    const a=await import(${JSON.stringify(auditUrl)});
    const requested=${transport === "env" ? 'process.env.KANDELO_GL_AUDIT' : 'new URL("https://control.invalid/?audit=fatal").searchParams.get("audit")'};
    a.configureGlAudit({mode:a.parseGlAuditMode(requested),sink(){},fault(m){throw Error(m)}});
    const b=await import(${JSON.stringify(batchUrl)}),p=await import(${JSON.stringify(objectsUrl)});
    class Renderer { reads=0;getError(){this.reads++;return 0;}isContextLost(){return false;}clear(){} }
    const native=new Renderer(),gl=a.auditGlContext(native),owner={gl,pid:5,sessionId:9,errors:[]};
    b.withNativeBatch(owner,"preconfigured",()=>{for(let i=0;i<8;i++)p.checkedGlCall(owner,()=>gl.clear());});
    if(native.reads!==1)throw Error("native reads="+native.reads);
    console.log("PRECONFIGURED_FATAL_PASS");
  `;
  const stdout = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: repo, encoding: "utf8", timeout: 20_000, env: { ...process.env, KANDELO_GL_AUDIT: "fatal" },
  });
  expect(stdout).toContain("PRECONFIGURED_FATAL_PASS");
});
