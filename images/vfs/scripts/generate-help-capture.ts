/**
 * Capture --help/--version output from real wasm binaries running inside
 * Kandelo, for host-side help2man to format into man pages. This is the
 * package-agnostic generalization of generate-coreutils-man.ts: it takes an
 * explicit list of (binary, tool) pairs rather than the hard-coded coreutils
 * tool set, so every `-docs` bundle (grep-docs, sed-docs, diffutils-docs, …)
 * shares one capture harness.
 *
 * Faithfulness contract (see CLAUDE.md "Platform Values Contract"): every
 * byte of captured text comes from the wasm binary executing inside a real
 * Kandelo kernel instance (via runCentralizedProgram). This script does not
 * fabricate or edit help text, and it does not run help2man itself — the
 * calling build script formats the capture with host help2man.
 *
 * A tool is invoked as `argv = [<tool>, "--help"|"--version"]`, so single
 * binaries (grep.wasm) and argv[0]-dispatched multi-call binaries alike are
 * handled by naming the intended argv[0]. If a tool prints empty --help
 * inside Kandelo it is logged and skipped — a missing page is an honest gap,
 * never a fabricated one.
 *
 * Usage:
 *   tsx generate-help-capture.ts <capture-dir> <bin> <tool> [<bin> <tool> ...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper";

async function capture(bin: string, tool: string, flag: string): Promise<string> {
  const { stdout } = await runCentralizedProgram({
    programPath: bin,
    argv: [tool, flag],
    env: ["PATH=/usr/bin:/bin", "POSIXLY_CORRECT=1"],
  });
  return stdout;
}

async function main() {
  const [outDir, ...rest] = process.argv.slice(2);
  if (!outDir || rest.length === 0 || rest.length % 2 !== 0) {
    console.error(
      "usage: generate-help-capture.ts <capture-dir> <bin> <tool> [<bin> <tool> ...]",
    );
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  const pairs: Array<{ bin: string; tool: string }> = [];
  for (let i = 0; i < rest.length; i += 2) {
    pairs.push({ bin: rest[i], tool: rest[i + 1] });
  }

  const skipped: string[] = [];
  for (const { bin, tool } of pairs) {
    const help = await capture(bin, tool, "--help");
    const version = await capture(bin, tool, "--version");
    if (!help.trim()) {
      console.error(`skip ${tool}: empty --help from Kandelo`);
      skipped.push(tool);
      continue;
    }
    writeFileSync(join(outDir, `${tool}.help`), help);
    writeFileSync(join(outDir, `${tool}.version`), version);
  }
  console.error(
    `generate-help-capture: captured ${pairs.length - skipped.length}/${pairs.length} tools` +
      (skipped.length ? `; skipped: ${skipped.join(", ")}` : ""),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
