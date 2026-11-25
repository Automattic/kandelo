import { execFileSync } from "node:child_process";
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

function boundaryInventory(source: string, abi: KernelAbi): string[] {
  return [
    ...dispatcherSyscalls(source).map((selector) => `Dispatcher syscall: ${selector}`),
    ...abi.kernel_imports.map(({ module, name, kind, signature }) =>
      `Kernel import: ${module}.${name} ${signature ?? kind}`).sort(),
    ...abi.host_intercepted_syscalls.map(({ name, number }) =>
      `Host-intercepted syscall: ${name} ${number}`).sort(),
  ];
}

function addedBoundaryEntries(base: string[], current: string[]): string[] {
  const existing = new Set(base);
  return current.filter((entry) => !existing.has(entry));
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: new URL("../../", import.meta.url),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

describe("Rust-first host boundary", () => {
  it("flags additions to the integration base's dispatcher and host capabilities", () => {
    const base = process.env.SYNTH_BASE_SHA
      ? git("rev-parse", "--verify", "--end-of-options", `${process.env.SYNTH_BASE_SHA}^{commit}`)
      : git("merge-base", "HEAD", "origin/develop");
    const workerPath = "host/src/kernel-worker.ts";
    const abiPath = "abi/snapshot.json";
    const baseline = boundaryInventory(
      git("show", `${base}:${workerPath}`),
      JSON.parse(git("show", `${base}:${abiPath}`)) as KernelAbi,
    );
    const current = boundaryInventory(
      readFileSync(new URL(`../../${workerPath}`, import.meta.url), "utf8"),
      JSON.parse(readFileSync(new URL(`../../${abiPath}`, import.meta.url), "utf8")) as KernelAbi,
    );

    expect(addedBoundaryEntries(baseline, current), `Host boundary grew since ${base}`).toEqual([]);
  });

  it("flags new selectors and changed signatures while allowing removals", () => {
    expect(addedBoundaryEntries(
      ["Dispatcher syscall: SYS_RETIRED", "Kernel import: env.read (i32) -> (i32)"],
      ["Dispatcher syscall: SYS_NEW", "Kernel import: env.read (i64) -> (i32)"],
    )).toEqual(["Dispatcher syscall: SYS_NEW", "Kernel import: env.read (i64) -> (i32)"]);
    expect(addedBoundaryEntries(["Dispatcher syscall: SYS_RETIRED"], [])).toEqual([]);
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
