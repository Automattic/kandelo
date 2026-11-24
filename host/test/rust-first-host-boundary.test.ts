import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function dispatcherSyscalls(source: string): string[] {
  const file = ts.createSourceFile("kernel-worker.ts", source, ts.ScriptTarget.Latest, true);
  const worker = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === "CentralizedKernelWorker",
  );
  const dispatcher = worker?.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && ts.isPrivateIdentifier(member.name)
      && member.name.text === "#handleSyscallInner",
  );
  if (!dispatcher?.body) throw new Error("Find the production syscall dispatcher before updating this check");

  const selectors = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && /^SYS_[A-Z0-9_]+$/.test(node.text)) {
      selectors.add(node.text);
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "ABI_SYSCALLS") {
      selectors.add(`ABI_SYSCALLS.${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node) && node.expression.getText(file) === "ABI_SYSCALLS") {
      const argument = node.argumentExpression;
      selectors.add(ts.isStringLiteral(argument) ? `ABI_SYSCALLS.${argument.text}` : "ABI_SYSCALLS[computed]");
    }
    if (ts.isBinaryExpression(node)) {
      const operands = [node.left, node.right];
      if (operands.some((operand) => ts.isIdentifier(operand) && operand.text === "syscallNr")) {
        for (const operand of operands) {
          if (ts.isNumericLiteral(operand)) selectors.add(`number ${Number(operand.text)}`);
        }
      }
    }
    if (ts.isCaseClause(node) && ts.isNumericLiteral(node.expression)) {
      const parent = node.parent.parent;
      if (ts.isSwitchStatement(parent) && parent.expression.getText(file) === "syscallNr") {
        selectors.add(`number ${Number(node.expression.text)}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(dispatcher.body);
  return [...selectors].sort();
}

type KernelAbi = {
  kernel_imports: { module: string; name: string; kind: string; signature?: string }[];
  host_intercepted_syscalls: { name: string; number: number }[];
};

function boundaryInventory(source: string, abi: KernelAbi): string {
  const sections = [
    ["TypeScript dispatcher syscall references", ...dispatcherSyscalls(source)],
    ["Kernel imports", ...abi.kernel_imports.map(({ module, name, kind, signature }) =>
      `${module}.${name} ${signature ?? kind}`).sort()],
    ["Host-intercepted syscalls in the ABI", ...abi.host_intercepted_syscalls.map(({ name, number }) =>
      `${name} ${number}`).sort()],
  ];
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

describe("Rust-first host boundary", () => {
  it("records the existing dispatcher references and kernel host capabilities", () => {
    const source = readFileSync(new URL("../src/kernel-worker.ts", import.meta.url), "utf8");
    const abi = JSON.parse(readFileSync(new URL("../../abi/snapshot.json", import.meta.url), "utf8")) as KernelAbi;

    // A new reference or import needs an ownership review. Remove retired
    // entries with the code so a later change cannot silently restore them.
    const recorded = readFileSync(new URL("./rust-first-host-boundary.txt", import.meta.url), "utf8");
    expect(boundaryInventory(source, abi)).toBe(recorded);
  });

  it("finds syscall selectors without counting comments or other methods", () => {
    const source = `class CentralizedKernelWorker {
      #handleSyscallInner(syscallNr: number) {
        // if (syscallNr === SYS_OLD) return;
        if (syscallNr === SYS_NEW || ABI_SYSCALLS.Later === syscallNr) return;
        if (ABI_SYSCALLS["Property"] === syscallNr || 92 === syscallNr) return;
        switch (syscallNr) { case 93: return; }
      }
      trace() { return SYS_UNRELATED; }
    }`;
    expect(dispatcherSyscalls(source)).toEqual([
      "ABI_SYSCALLS.Later", "ABI_SYSCALLS.Property", "SYS_NEW", "number 92", "number 93",
    ]);
    expect(() => dispatcherSyscalls("class CentralizedKernelWorker {}")).toThrow("production syscall dispatcher");
  });
});
