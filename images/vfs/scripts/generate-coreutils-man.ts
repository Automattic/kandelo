/**
 * Capture --help/--version output from the real coreutils.wasm running
 * inside Kandelo, one tool at a time, for host-side help2man to format.
 *
 * Faithfulness contract (see CLAUDE.md "Platform Values Contract"): every
 * byte of captured text comes from the wasm binary executing inside a real
 * Kandelo kernel instance (via runCentralizedProgram). This script does not
 * fabricate or edit help text, and it does not run help2man itself — the
 * calling build script (build-coreutils-docs.sh) formats the capture with
 * host help2man against a per-tool replay wrapper.
 *
 * coreutils ships as a single binary dispatched by argv[0] (GNU
 * --enable-single-binary=symlinks), so capturing `ls --help` means spawning
 * coreutils.wasm with argv = ["ls", "--help"].
 *
 * If a tool prints empty --help inside Kandelo, that tool is logged and
 * skipped — a missing page is an honest gap, never a fabricated one.
 *
 * Usage: tsx generate-coreutils-man.ts <coreutils.wasm> <capture-dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper";

// The GNU coreutils 9.6 tool set, minus the five tools coreutils disables
// by default (arch, hostname, su, uptime, users — kill/vdir stay in since
// they build here). Listed explicitly rather than derived from the binary
// so the recipe stays legible; duplicates below are intentionally present
// in the source list and are collapsed by the `Set` at load time.
const TOOLS = [
  "base32", "base64", "basename", "basenc", "cat", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname", "du",
  "echo", "env", "expand", "expr", "factor", "false", "fmt", "fold",
  "groups", "head", "hostid", "id", "join", "link", "ln", "logname", "ls",
  "md5sum", "mkdir", "mkfifo", "mknod", "mktemp", "mv", "nice", "nl",
  "nohup", "nproc", "numfmt", "od", "paste", "pathchk", "pr", "printenv",
  "printf", "ptx", "pwd", "readlink", "realpath", "rm", "rmdir", "seq",
  "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "shred",
  "shuf", "sleep", "sort", "split", "stat", "stty", "sum", "sync", "tac",
  "tail", "tee", "test", "timeout", "touch", "tr", "true", "truncate",
  "tsort", "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc",
  "whoami", "yes", "b2sum", "basename", "chcon", "chgrp", "chmod", "chown",
  "chroot", "cksum", "install", "kill", "runcon", "tail",
];

async function capture(bin: string, tool: string, flag: string): Promise<string> {
  const { stdout } = await runCentralizedProgram({
    programPath: bin,
    argv: [tool, flag],
    env: ["PATH=/usr/bin:/bin", "POSIXLY_CORRECT=1"],
  });
  return stdout;
}

async function main() {
  const [bin, outDir] = process.argv.slice(2);
  if (!bin || !outDir) {
    console.error("usage: generate-coreutils-man.ts <coreutils.wasm> <capture-dir>");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const uniq = Array.from(new Set(TOOLS)).sort();
  const skipped: string[] = [];
  for (const tool of uniq) {
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
    `generate-coreutils-man: captured ${uniq.length - skipped.length}/${uniq.length} tools` +
      (skipped.length ? `; skipped: ${skipped.join(", ")}` : ""),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
