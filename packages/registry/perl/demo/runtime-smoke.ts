/**
 * runtime-smoke.ts — kd-k7zy Perl core-module runtime smoke on Kandelo.
 *
 * Runs the built perl.wasm under the Node kernel host (host-fs passthrough so
 * PERL5LIB resolves) and checks that the generated core-module runtime library
 * loads and that XS core modules bootstrap through XSLoader::load.
 *
 * Guards the reported gap (kd-k7zy): main's build-perl.sh ran `make perl`,
 * which stops before perl-cross's `nonxs_ext extensions` targets that generate
 * XSLoader.pm and stage the core-module tree, so File::Spec (-> Cwd -> XSLoader)
 * failed. build-perl.sh now runs `make -k` and ships that tree as
 * perl-runtime.zip, and builds extensions statically (-Uusedl) so their XS
 * loads without dlopen (Kandelo wasm has none).
 *
 * Usage:
 *   bash build.sh && bash packages/registry/perl/build-perl.sh
 *   npx tsx packages/registry/perl/demo/runtime-smoke.ts [PERL5LIB_DIR]
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

// Each check prints "<name>=ok" on success. The XS modules (POSIX/Cwd/...) each
// require XSLoader to bootstrap their statically-linked half, so their success
// also proves XSLoader::load works without dlopen.
const PROG = [
  "use strict; use warnings;",
  "my @res;",
  "sub ck { my ($n,$c)=@_; my $r=eval { $c->() }; push @res, $n.'='.((defined $r && !$@)?'ok':'FAIL('.(($@=~/^(.*?)(?: at |\\n)/)?$1:'err').')'); }",
  // Generated files: Config.pm + XSLoader.pm (the reported missing file).
  "ck('Config', sub { require Config; $Config::Config{version} eq '5.40.3' or die 'ver'; 1 });",
  "ck('XSLoader', sub { require XSLoader; $XSLoader::VERSION or die; 1 });",
  // File::Spec: the reported failing module. catfile is path logic; rel2abs
  // pulls in Cwd (an XS module) so it also exercises the XS boot path.
  "ck('FileSpec_catfile', sub { require File::Spec; File::Spec->catfile('a','b','c.txt') eq 'a/b/c.txt' or die });",
  "ck('FileSpec_rel2abs', sub { File::Spec->rel2abs('x','/root') eq '/root/x' or die });",
  // XS core modules that bootstrap through XSLoader::load.
  "ck('Cwd_xs',     sub { require Cwd; Cwd::getcwd(); 1 });",
  "ck('POSIX_xs',   sub { require POSIX; POSIX::floor(3.7)==3 or die });",
  "ck('Fcntl_xs',   sub { require Fcntl; defined Fcntl::O_RDONLY() or die });",
  "ck('ListUtil_xs',sub { require List::Util; List::Util::sum(1,2,3,4)==10 or die });",
  "ck('DataDumper_xs',sub { require Data::Dumper; Data::Dumper::Dumper([1])=~/1/ or die });",
  "print 'PERLVER=',$],\"\\n\";",
  "print 'RESULTS=',join(',',@res),\"\\n\";",
  "print((grep { !/=ok$/ } @res) ? \"PERL_RUNTIME_SMOKE_FAIL\\n\" : \"PERL_RUNTIME_SMOKE_PASS\\n\");",
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
  const ok = result.exitCode === 0 && result.stdout.includes("PERL_RUNTIME_SMOKE_PASS");
  process.exit(ok ? 0 : (result.exitCode || 1));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
