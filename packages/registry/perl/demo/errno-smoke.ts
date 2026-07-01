/**
 * errno-smoke.ts — kd-gtxa Perl Errno.pm runtime smoke on Kandelo.
 *
 * Runs the built perl.wasm under the Node kernel host (host-fs passthrough so
 * PERL5LIB resolves) and checks that `use Errno` loads and exposes the wasm
 * target's errno constants with musl's numeric values.
 *
 * Guards the reported gap (kd-gtxa): ext/Errno's Errno_pm.PL discovers which
 * headers hold the E* #defines by preprocessing `#include <errno.h>` and
 * scanning the output for `# <line> "file"` linemarkers. The wasm target's
 * cpp config runs the preprocessor with -P, which inhibits linemarkers, so the
 * scan found no headers, collected no constants, and Errno_pm.PL died
 * "No error definitions found" -> Errno.pm was never generated/staged and
 * `use Errno` failed "Can't locate Errno.pm". The constants themselves are
 * plain `#define EPERM 1` in the sysroot (musl arch/generic bits/errno.h);
 * they were simply never discovered. build-perl.sh now points the scan at the
 * sysroot errno headers directly so Errno.pm generates and ships.
 *
 * Usage:
 *   bash build.sh && bash packages/registry/perl/build-perl.sh
 *   npx tsx packages/registry/perl/demo/errno-smoke.ts [PERL5LIB_DIR]
 *
 * PERL5LIB_DIR defaults to the built privlib staged by build-perl.sh; pass an
 * arg (e.g. an unzipped perl-runtime.zip) to smoke the shippable layout.
 */
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");

// Known musl (arch/generic bits/errno.h) values. Asserting exact numbers proves
// Errno.pm carries the *wasm target's* constants, not the build host's.
const EXPECT: Array<[string, number]> = [
  ["EPERM", 1],
  ["ENOENT", 2],
  ["ESRCH", 3],
  ["EINTR", 4],
  ["EIO", 5],
  ["EBADF", 9],
  ["EAGAIN", 11],
  ["ENOMEM", 12],
  ["EACCES", 13],
  ["EEXIST", 17],
  ["ENOTDIR", 20],
  ["EISDIR", 21],
  ["EINVAL", 22],
];

const checks = EXPECT.map(
  ([n, v]) =>
    `ck('${n}', sub { Errno::${n}() == ${v} or die 'got '.Errno::${n}() });`,
).join("\n");

const PROG = [
  "use strict; use warnings;",
  // Errno's constant subs are require'd at runtime, so calling them in this
  // same -e is 'too early to check prototype' -- a benign parse-time warning.
  "no warnings 'prototype';",
  "my @res;",
  "sub ck { my ($n,$c)=@_; my $r=eval { $c->() }; push @res, $n.'='.((defined $r && !$@)?'ok':'FAIL('.(($@=~/^(.*?)(?: at |\\n)/)?$1:'err').')'); }",
  // The reported gap: Errno.pm must exist and load at all.
  "ck('use_Errno', sub { require Errno; $INC{'Errno.pm'} or die 'not loaded'; 1 });",
  // Exact musl values for a spread of constants.
  checks,
  // Enough constants present (musl generic ships 134 E*); a truncated scan
  // would collect far fewer, so require a healthy count.
  "ck('count>=100', sub { my $n=grep { Errno->can($_) } @Errno::EXPORT_OK; $n>=100 or die \"only $n\" });",
  // The tied %! interface (Errno's headline feature) must reflect $!.
  "ck('errno_tie', sub { local $! = Errno::ENOENT(); $!{ENOENT} or die; !$!{EACCES} or die 'EACCES leaked'; 1 });",
  "print 'PERLVER=',$],\"\\n\";",
  "print 'ERRNO_COUNT=',scalar(grep { Errno->can($_) } @Errno::EXPORT_OK),\"\\n\";",
  "print 'RESULTS=',join(',',@res),\"\\n\";",
  "print((grep { !/=ok$/ } @res) ? \"PERL_ERRNO_SMOKE_FAIL\\n\" : \"PERL_ERRNO_SMOKE_PASS\\n\");",
].join("\n");

async function main() {
  const perlWasm = resolve(repoRoot, "packages/registry/perl/bin/perl.wasm");
  const perl5lib = process.argv[2] ||
    resolve(repoRoot, "packages/registry/perl/perl-src/lib");
  if (!existsSync(perlWasm)) {
    console.error("perl.wasm not found. Run: bash packages/registry/perl/build-perl.sh");
    process.exit(1);
  }

  const result = await runCentralizedProgram({
    programPath: perlWasm,
    argv: ["perl", "-e", PROG],
    // LC_ALL=C: perl 5.40 panics at startup parsing the composite default
    // locale Kandelo's musl setlocale returns ('C.UTF-8;C;C;C;C;C') -- a
    // separate platform boundary (kd-dvph), not this package's gap.
    env: [`PERL5LIB=${perl5lib}`, `LC_ALL=C`, `HOME=/tmp`, `TMPDIR=/tmp`],
    io: new NodePlatformIO(),
    timeout: 300_000,
  });

  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const ok = result.exitCode === 0 && result.stdout.includes("PERL_ERRNO_SMOKE_PASS");
  process.exit(ok ? 0 : (result.exitCode || 1));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
