/**
 * locale-smoke.ts — kd-dvph Perl default/locale startup smoke on Kandelo.
 *
 * Regression guard for the default-locale startup panic: perl 5.40 built for
 * the wasm32 musl target used to abort at interpreter startup when no locale
 * env was set, because perl-cross defaulted the target to glibc's
 * "cat=value;cat=value" LC_ALL notation while Kandelo's libc (musl) returns a
 * POSITIONAL ";"-separated composite ("C.UTF-8;C;C;C;C;C"). perl parsed the
 * first field "C.UTF-8" as name=value, found no '=', and panicked (exit 29).
 *
 * Each case spawns the built perl.wasm under the Node kernel host with a
 * controlled guest environment and asserts a clean run (exit 0 + expected
 * stdout). The empty-env case is the primary regression; the disparate case
 * exercises the exact multi-component positional path that used to panic.
 *
 * If a Perl runtime tree (PERL5LIB with POSIX.pm/XS, e.g. kd-k7zy's
 * perl-runtime) is provided as argv[2], an extra case round-trips
 * POSIX::setlocale(LC_ALL) to verify per-category parsing; otherwise that case
 * is skipped (baseline `make perl` ships no modules).
 *
 * Usage:
 *   bash build.sh && bash packages/registry/perl/build-perl.sh
 *   npx tsx packages/registry/perl/demo/locale-smoke.ts [PERL5LIB_DIR]
 */
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");

interface Case {
  name: string;
  env: string[];
  argv: string[];
  expect: string;
  optional?: boolean;
}

// A trivial arithmetic program that loads no modules, so it works against the
// baseline `make perl` build (no staged runtime). The only thing under test is
// that the interpreter reaches its body instead of panicking during the
// startup locale scan.
const ARITH = 'print "R=", 2 + 3, "\\n"';

function buildCases(perl5lib?: string): Case[] {
  const cases: Case[] = [
    // PRIMARY regression: no locale env at all -> musl returns the disparate
    // positional composite "C.UTF-8;C;C;C;C;C"; used to panic (exit 29).
    { name: "unset-locale (no LC_ALL/LANG)", env: [], argv: ["perl", "-e", ARITH], expect: "R=5" },
    { name: "LC_ALL=C", env: ["LC_ALL=C"], argv: ["perl", "-e", ARITH], expect: "R=5" },
    { name: "LC_ALL=C.UTF-8", env: ["LC_ALL=C.UTF-8"], argv: ["perl", "-e", ARITH], expect: "R=5" },
    { name: "LANG=C.UTF-8", env: ["LANG=C.UTF-8"], argv: ["perl", "-e", ARITH], expect: "R=5" },
    // Browser demos default the guest env to LANG=en_US.UTF-8 (live-setup.ts,
    // browser-kernel-host.ts). musl maps that to a disparate composite too, so
    // this covers the exact env the browser host passes.
    { name: "LANG=en_US.UTF-8 (browser default)", env: ["LANG=en_US.UTF-8"], argv: ["perl", "-e", ARITH], expect: "R=5" },
    // Explicitly disparate categories -> forces musl's multi-field positional
    // composite; this is the exact code path that panicked, now positionally
    // parsed. If the positional category map were wrong the interpreter would
    // mis-route or NULL-deref a category during startup.
    {
      name: "disparate (LC_CTYPE=C.UTF-8, others C)",
      env: ["LC_CTYPE=C.UTF-8", "LC_NUMERIC=C", "LC_TIME=C", "LC_COLLATE=C", "LC_MONETARY=C", "LC_MESSAGES=C"],
      argv: ["perl", "-e", ARITH],
      expect: "R=5",
    },
    // Category-mapping correctness (no modules needed): perl's built-in
    // ${^UTF8LOCALE} is true iff the *LC_CTYPE* startup locale is UTF-8. In a
    // disparate composite it must reflect field 0 (CTYPE) only, so these prove
    // the positional map routes CTYPE to the right slot rather than merely not
    // panicking. If the order were wrong, CTYPE would pick up a different
    // field's value and these would flip.
    {
      name: "category map: CTYPE=C.UTF-8 disparate -> UTF8LOCALE=1",
      env: ["LC_CTYPE=C.UTF-8", "LC_NUMERIC=C", "LC_TIME=C", "LC_COLLATE=C", "LC_MONETARY=C", "LC_MESSAGES=C"],
      argv: ["perl", "-e", 'print "U=", (${^UTF8LOCALE} ? 1 : 0), "\\n"'],
      expect: "U=1",
    },
    {
      name: "category map: LC_ALL=C -> UTF8LOCALE=0",
      env: ["LC_ALL=C"],
      argv: ["perl", "-e", 'print "U=", (${^UTF8LOCALE} ? 1 : 0), "\\n"'],
      expect: "U=0",
    },
  ];

  if (perl5lib) {
    // With a runtime tree, verify per-category parsing by round-tripping the
    // composite through POSIX::setlocale under the disparate env above. This
    // fails loudly if the positional order/count is wrong.
    const PROG = [
      "use POSIX qw(setlocale LC_ALL LC_CTYPE LC_NUMERIC);",
      'my $all = setlocale(LC_ALL);',
      'my $ctype = setlocale(LC_CTYPE);',
      'my $num = setlocale(LC_NUMERIC);',
      'print "LC_ALL=$all\\nLC_CTYPE=$ctype\\nLC_NUMERIC=$num\\n";',
      'print "POSIX_OK\\n" if $ctype =~ /UTF-?8/i && $num eq "C";',
    ].join(" ");
    cases.push({
      name: "POSIX::setlocale round-trip (disparate)",
      env: [
        `PERL5LIB=${perl5lib}`,
        "LC_CTYPE=C.UTF-8",
        "LC_NUMERIC=C",
        "LC_TIME=C",
        "LC_COLLATE=C",
        "LC_MONETARY=C",
        "LC_MESSAGES=C",
      ],
      argv: ["perl", "-e", PROG],
      expect: "POSIX_OK",
      optional: true,
    });
  }
  return cases;
}

async function main() {
  const perlWasm = resolve(repoRoot, "packages/registry/perl/bin/perl.wasm");
  const perl5lib = process.argv[2];
  if (!existsSync(perlWasm)) {
    console.error("perl.wasm not found. Run: bash packages/registry/perl/build-perl.sh");
    process.exit(1);
  }

  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const c of buildCases(perl5lib)) {
    let result;
    try {
      result = await runCentralizedProgram({
        programPath: perlWasm,
        argv: c.argv,
        env: c.env,
        io: new NodePlatformIO(),
        timeout: 60_000,
      });
    } catch (err) {
      failed.push(`${c.name}: threw ${String(err)}`);
      continue;
    }
    const ok = result.exitCode === 0 && result.stdout.includes(c.expect);
    const detail = `exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.trim())}`;
    if (ok) {
      passed.push(`${c.name}: ${detail}`);
    } else if (c.optional && result.exitCode !== 0) {
      // Optional cases (need runtime modules) are skipped, not failed, when the
      // interpreter can't load the module — the required cases still gate.
      skipped.push(`${c.name}: ${detail} stderr=${JSON.stringify(result.stderr.trim())} (runtime module unavailable)`);
    } else {
      failed.push(`${c.name}: ${detail} stderr=${JSON.stringify(result.stderr.trim())}`);
    }
  }

  console.log("=== PASSED ===");
  for (const p of passed) console.log("  " + p);
  if (skipped.length) {
    console.log("=== SKIPPED ===");
    for (const s of skipped) console.log("  " + s);
  }
  if (failed.length) {
    console.log("=== FAILED ===");
    for (const f of failed) console.log("  " + f);
  }

  const allRequiredPass = failed.length === 0;
  console.log(allRequiredPass ? "PERL_LOCALE_SMOKE_PASS" : "PERL_LOCALE_SMOKE_FAIL");
  process.exit(allRequiredPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
