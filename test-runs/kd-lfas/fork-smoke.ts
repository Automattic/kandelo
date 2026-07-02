/**
 * fork-smoke.ts — kd-lfas fork/exec safety check for an INSTRUMENTED perl.wasm.
 *
 * The runtime/ext smokes run the raw binary and never fork, so they cannot
 * catch a wasm-opt transform that breaks wasm-fork-instrument's save/restore.
 * Perl imports kernel_fork+kernel_execve and its package.toml fork policy is
 * "auto", so the resolver fork-instruments perl at load. This drives the
 * post-instrument binary through: pure fork()+pipe+waitpid+exit-status,
 * system(LIST) (direct execve), and open('-|',LIST) (fork+exec+pipe capture).
 *
 * Usage: tsx test-runs/kd-lfas/fork-smoke.ts <INSTRUMENTED perl.wasm> [PERL5LIB]
 */
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../host/src/platform/node";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");

const PROG = [
  "use strict; use warnings;",
  "my @res; sub ck { my ($n,$ok)=@_; push @res, $n.'='.($ok?'ok':'FAIL'); }",
  // 1) pure fork(): pipe IPC + waitpid + exit status — exercises the
  //    instrumented call-stack save/restore directly.
  "pipe(my $r, my $w) or die \"pipe: $!\";",
  "my $pid = fork(); die \"fork undef: $!\" unless defined $pid;",
  "if (!$pid) { close $r; syswrite($w,'hello-from-child'); close $w; exit 3; }",
  "close $w; my $msg = do { local $/; <$r> }; close $r; waitpid($pid,0); my $code = $? >> 8;",
  "ck('fork_pid', $pid > 0); ck('fork_pipe', defined $msg && $msg eq 'hello-from-child'); ck('fork_exit', $code == 3);",
  // 2) system(LIST): fork + direct execve of a child perl (no shell).
  "my $rc = system('/bin/perl','-e','exit 5'); ck('system_exit', ($rc >> 8) == 5);",
  // 3) open('-|',LIST): fork + execve + pipe capture (no shell).
  "my $out=''; if (open(my $fh,'-|','/bin/perl','-e',\"print 'PIPE-OK'\")) { local $/; $out=<$fh>; close $fh; } ck('open_pipe', defined $out && $out =~ /PIPE-OK/);",
  "print 'FORKRESULTS=', join(',', @res), \"\\n\";",
  "print((grep { !/=ok$/ } @res) ? \"FORK_SMOKE_FAIL\\n\" : \"FORK_SMOKE_PASS\\n\");",
].join("\n");

async function main() {
  const perlWasm = resolve(process.argv[2] || "");
  const perl5lib = process.argv[3] || resolve(repoRoot, "packages/registry/perl/perl-src/lib");
  const result = await runCentralizedProgram({
    programPath: perlWasm,
    argv: ["perl", "-e", PROG],
    env: [`PERL5LIB=${perl5lib}`, `LC_ALL=C`, `HOME=/tmp`, `TMPDIR=/tmp`, `PATH=/bin`],
    execPrograms: new Map([["/bin/perl", perlWasm]]),
    io: new NodePlatformIO(),
    timeout: 300_000,
  });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const ok = result.exitCode === 0 && result.stdout.includes("FORK_SMOKE_PASS");
  process.exit(ok ? 0 : (result.exitCode || 1));
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
