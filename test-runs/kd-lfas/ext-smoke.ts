/**
 * ext-smoke.ts — kd-lfas extended functional battery for perl.wasm.
 *
 * Broader than demo/runtime-smoke.ts (which checks module load / XS bootstrap):
 * this exercises arithmetic, floats, string ops, regex+unicode, sort, hashes,
 * pack/unpack (bit-level, codegen-sensitive), sprintf formats, math funcs, and
 * refs/closures — to rule out subtle wasm-opt miscompilation of the optimized
 * binary, not just "does it still boot".
 *
 * Usage: tsx test-runs/kd-lfas/ext-smoke.ts <perl.wasm> [PERL5LIB_DIR]
 */
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../host/src/platform/node";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");

const PROG = [
  "use strict; use warnings;",
  "use List::Util qw(sum max min reduce first);",
  "use POSIX qw(floor ceil pow);",
  "my @res;",
  "sub ck { my ($n,$c)=@_; my $r=eval { $c->() }; push @res, $n.'='.((defined $r && $r && !$@)?'ok':'FAIL('.(($@=~/^(.*?)(?: at |\\n)/)?$1:('got='.(defined $r?$r:'undef'))).')'); }",
  // integer + float arithmetic
  "ck('int_arith', sub { (7*6==42) && (2**10==1024) && (17%5==2) && (int(-7/2)==-3) });",
  "ck('float_pi', sub { sprintf('%.5f', atan2(1,1)*4) eq '3.14159' });",
  "ck('float_sqrt', sub { abs(sqrt(2)-1.4142135623731) < 1e-9 });",
  "ck('bigmul', sub { (1_000_000 * 1_000_000) == 1e12 });",
  // string ops
  "ck('str_basic', sub { my $s='Kandelo'; (uc($s) eq 'KANDELO') && (reverse('abc') eq 'cba') && (substr($s,0,3) eq 'Kan') && (index($s,'del')==3) });",
  "ck('str_join_split', sub { join('-',split(/,/, 'a,b,c')) eq 'a-b-c' });",
  "ck('str_repeat', sub { ('ab' x 3) eq 'ababab' && length('x' x 1000)==1000 });",
  // sprintf format battery (codegen + libc)
  "ck('sprintf_fmt', sub { sprintf('%05d|%x|%o|%.3e|%+d', 42, 255, 8, 12345.678, 7) eq '00042|ff|10|1.235e+04|+7' });",
  // regex incl. named captures, substitution, tr, unicode word char
  "ck('re_named', sub { 'ver=5.40' =~ /ver=(?<maj>\\d+)\\.(?<min>\\d+)/; ($+{maj}==5 && $+{min}==40) });",
  "ck('re_subst', sub { (my $t='aaa') =~ s/a/b/g; $t eq 'bbb' });",
  "ck('re_tr', sub { (my $t='hello') =~ tr/a-z/A-Z/; $t eq 'HELLO' });",
  // /u forces Unicode \\w semantics regardless of the string's utf8 flag, so\n  // the letter U+00E9 (e-acute) matches; without /u a Latin-1 (non-utf8) string\n  // uses ASCII \\w rules -- correct Perl semantics, not a codegen issue.\n  "ck('re_unicode', sub { my $c=\"caf\\x{e9}\"; ($c =~ /^\\w+$/u) ? 1 : 0 });",
  // sort: numeric + Schwartzian transform
  "ck('sort_num', sub { join(',', sort { $a <=> $b } (10,2,33,4)) eq '2,4,10,33' });",
  "ck('sort_schwartz', sub { my @w=qw(ccc a bb); join(',', map {$_->[1]} sort {$a->[0]<=>$b->[0]} map {[length($_),$_]} @w) eq 'a,bb,ccc' });",
  // hashes
  "ck('hash_ops', sub { my %h=(a=>1,b=>2,c=>3); (exists $h{b}) && (join(',',sort keys %h) eq 'a,b,c') && (sum(values %h)==6) && (delete $h{a}==1) && (!exists $h{a}) });",
  // pack/unpack — bit/byte level, sensitive to codegen
  "ck('pack_N', sub { unpack('N', pack('N', 0xDEADBEEF)) == 0xDEADBEEF });",
  "ck('pack_mixed', sub { my $p=pack('A3 n C', 'abc', 513, 7); join(',', unpack('A3 n C', $p)) eq 'abc,513,7' });",
  // POSIX math
  "ck('posix_math', sub { (floor(3.7)==3) && (ceil(3.2)==4) && (pow(2,8)==256) });",
  // List::Util
  "ck('listutil', sub { (max(3,9,1)==9) && (min(3,9,1)==1) && (reduce {$a*$b} 1..5)==120 && (first {$_>3} 1..10)==4 });",
  // refs / closures / deref
  "ck('refs', sub { my $ar=[1,2,3]; my $hr={x=>10}; my $cr=sub {$_[0]+1}; ($ar->[1]==2) && ($hr->{x}==10) && ($cr->(41)==42) });",
  "ck('closure', sub { my $n=0; my $inc=sub {$n++}; $inc->() for 1..5; $n==5 });",
  "print 'EXTVER=',$],\"\\n\";",
  "print 'EXTRESULTS=',join(',',@res),\"\\n\";",
  "print((grep { !/=ok$/ } @res) ? \"EXT_SMOKE_FAIL\\n\" : \"EXT_SMOKE_PASS\\n\");",
].join("\n");

async function main() {
  const perlWasm = resolve(process.argv[2] || "");
  const perl5lib = process.argv[3] || resolve(repoRoot, "packages/registry/perl/perl-src/lib");
  const result = await runCentralizedProgram({
    programPath: perlWasm,
    argv: ["perl", "-e", PROG],
    env: [`PERL5LIB=${perl5lib}`, `LC_ALL=C`, `HOME=/tmp`, `TMPDIR=/tmp`],
    io: new NodePlatformIO(),
    timeout: 300_000,
  });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const ok = result.exitCode === 0 && result.stdout.includes("EXT_SMOKE_PASS");
  process.exit(ok ? 0 : (result.exitCode || 1));
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
