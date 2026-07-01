import type { HomebrewBottleArch } from "../host/src/homebrew-vfs-planner";

export const HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
export const HOMEBREW_CELLAR = `${HOMEBREW_PREFIX}/Cellar`;
export const SQLITE_BROWSER_CONSUMER_PATH = "/usr/local/kandelo-smoke/bin/sqlite_basic";
export const ZLIB_BROWSER_CONSUMER_PATH = "/usr/local/kandelo-smoke/bin/zlib_basic";

export type HomebrewSmokeFormula = string;

export interface BrowserSmokeCase {
  name: string;
  formula: HomebrewSmokeFormula;
  required: boolean;
  command: string;
  argv: string[];
  stdin?: string;
  env?: string[];
  skipReason?: string;
  expected: RegExp;
  description: string;
}

export function parseHomebrewSmokeFormula(value: string): HomebrewSmokeFormula {
  if (/^[a-z0-9][a-z0-9._-]*$/.test(value)) return value;
  throw new Error(`formula must be a Homebrew package name, got ${value}`);
}

export function browserUnsupportedReason(arch: HomebrewBottleArch): string | undefined {
  return arch === "wasm64"
    ? "wasm64 browser compatibility is unsupported by the current Homebrew browser sidecar path"
    : undefined;
}

export function browserSmokeCasesForFormula(formula: HomebrewSmokeFormula): BrowserSmokeCase[] {
  switch (formula) {
    case "hello":
      return [programOutputCase({
        formula,
        name: "hello_version",
        argv: [`${HOMEBREW_PREFIX}/bin/hello`, "--version"],
        expected: /hello/i,
        description: "Run hello --version from the poured Homebrew prefix.",
      })];
    case "bc":
      return [programOutputCase({
        formula,
        name: "bc_expression",
        argv: [`${HOMEBREW_PREFIX}/bin/bc`],
        stdin: "2+3\nquit\n",
        expected: /(^|\n)5(\n|$)/,
        description: "Run a simple bc expression from the poured Homebrew prefix.",
      })];
    case "bzip2":
      return [programOutputCase({
        formula,
        name: "bzip2_help",
        argv: [`${HOMEBREW_PREFIX}/bin/bzip2`, "--help"],
        expected: /bzip2/i,
        description: "Run bzip2 --help from the poured Homebrew prefix.",
      })];
    case "coreutils":
      return [programOutputCase({
        formula,
        name: "coreutils_printf",
        argv: [`${HOMEBREW_PREFIX}/bin/coreutils`, "--coreutils-prog=printf", "ok\n"],
        expected: /^ok$/m,
        description: "Run coreutils printf through the multicall binary.",
      })];
    case "cpython":
      return [programOutputCase({
        formula,
        name: "cpython_os_path",
        argv: [`${HOMEBREW_PREFIX}/bin/cpython`, "-S", "-c", "import os; print(os.path.join('a', 'b'))"],
        env: [
          `PYTHONHOME=${HOMEBREW_PREFIX}`,
          "PYTHONDONTWRITEBYTECODE=1",
          "PYTHONNOUSERSITE=1",
        ],
        expected: /^a\/b$/m,
        description: "Run CPython with the poured standard library.",
      })];
    case "diffutils":
      return [programVersionCase(formula, "diff", /diff/i)];
    case "file":
      return [programVersionCase(formula, "file", /file/i)];
    case "findutils":
      return [programVersionCase(formula, "find", /find/i)];
    case "gawk":
      return [programOutputCase({
        formula,
        name: "gawk_begin",
        argv: [`${HOMEBREW_PREFIX}/bin/gawk`, "BEGIN { print 6 * 7 }"],
        expected: /^42$/m,
        description: "Run a BEGIN expression through gawk.",
      })];
    case "grep":
      return [programOutputCase({
        formula,
        name: "grep_stdin",
        argv: [`${HOMEBREW_PREFIX}/bin/grep`, "beta"],
        stdin: "alpha\nbeta\n",
        expected: /^beta$/m,
        description: "Run grep against stdin.",
      })];
    case "gzip":
      return [programVersionCase(formula, "gzip", /gzip/i)];
    case "m4":
      return [programOutputCase({
        formula,
        name: "m4_stdin",
        argv: [`${HOMEBREW_PREFIX}/bin/m4`],
        stdin: "define(`x',`ok')x\n",
        expected: /ok/,
        description: "Run an m4 definition against stdin.",
      })];
    case "make":
      return [programVersionCase(formula, "make", /make/i)];
    case "perl":
      return [programOutputCase({
        formula,
        name: "perl_core_modules",
        argv: [`${HOMEBREW_PREFIX}/bin/perl`, "-e", "use strict; use warnings; print 2 + 3"],
        env: [`PERL5LIB=${HOMEBREW_PREFIX}/lib/perl5/5.40.3`],
        expected: /^5$/m,
        description: "Run Perl with the poured pure core library tree.",
      })];
    case "php":
      return [programOutputCase({
        formula,
        name: "php_expression",
        argv: [`${HOMEBREW_PREFIX}/bin/php`, "-r", "echo 2 + 3;"],
        expected: /^5$/m,
        description: "Run a simple PHP expression through the poured interpreter.",
      })];
    case "posix-utils-lite":
      return [programOutputCase({
        formula,
        name: "patch_scan",
        argv: [`${HOMEBREW_PREFIX}/bin/patch`, "patch"],
        stdin: "--- a/file\n+++ b/file\n",
        expected: /patching file file/,
        description: "Run the posix-utils-lite patch applet against unified patch metadata.",
      })];
    case "sed":
      return [programOutputCase({
        formula,
        name: "sed_substitute",
        argv: [`${HOMEBREW_PREFIX}/bin/sed`, "s/a/b/"],
        stdin: "a\n",
        expected: /^b$/m,
        description: "Run a sed substitution against stdin.",
      })];
    case "tar":
      return [programVersionCase(formula, "tar", /tar/i)];
    case "ruby":
      return [programOutputCase({
        formula,
        name: "ruby_expression",
        argv: [`${HOMEBREW_PREFIX}/bin/ruby`, "-e", "puts 2 + 3"],
        env: [`RUBYLIB=${HOMEBREW_PREFIX}/lib/ruby/4.0.0`],
        expected: /^5$/m,
        description: "Run a simple Ruby expression through the poured interpreter.",
      })];
    case "erlang":
      return [programSkipCase({
        formula,
        name: "erlang_beam_launch",
        reason: "Erlang BEAM Homebrew browser smoke needs specialized -root/-bindir/-boot launch arguments and maxAddr handling; node smoke records the same limitation.",
        description: "Record that the generic browser smoke runner cannot launch BEAM yet.",
      })];
    case "tcl":
      return [programOutputCase({
        formula,
        name: "tcl_expr",
        argv: [`${HOMEBREW_PREFIX}/bin/tcl`],
        stdin: "puts [expr {2 + 5}]\n",
        env: [`TCL_LIBRARY=${HOMEBREW_PREFIX}/lib/tcl8.6`],
        expected: /^7$/m,
        description: "Run a Tcl expression using the poured Tcl runtime library.",
      })];
    case "unzip":
      return [programOutputCase({
        formula,
        name: "unzip_version",
        argv: [`${HOMEBREW_PREFIX}/bin/unzip`, "-v"],
        expected: /unzip/i,
        description: "Run unzip -v from the poured Homebrew prefix.",
      })];
    case "xz":
      return [programOutputCase({
        formula,
        name: "xz_version",
        argv: [`${HOMEBREW_PREFIX}/bin/xz`, "--version"],
        expected: /xz/i,
        description: "Run xz --version from the poured Homebrew prefix.",
      })];
    case "zip":
      return [programOutputCase({
        formula,
        name: "zip_version",
        argv: [`${HOMEBREW_PREFIX}/bin/zip`, "-v"],
        expected: /zip/i,
        description: "Run zip -v from the poured Homebrew prefix.",
      })];
    case "zstd":
      return [programVersionCase(formula, "zstd", /zstandard|zstd/i)];
    case "zlib":
      return [{
        name: "zlib_basic_consumer",
        formula,
        required: true,
        command: ZLIB_BROWSER_CONSUMER_PATH,
        argv: [ZLIB_BROWSER_CONSUMER_PATH],
        expected: /PASS/,
        description: "Run zlib_basic linked against the poured zlib keg.",
      }];
    case "sqlite":
      return [{
        name: "sqlite_basic_consumer",
        formula,
        required: true,
        command: SQLITE_BROWSER_CONSUMER_PATH,
        argv: [SQLITE_BROWSER_CONSUMER_PATH],
        expected: /PASS/,
        description: "Run sqlite_basic linked against the poured sqlite keg.",
      }];
    case "texlive":
      return [programOutputCase({
        formula,
        name: "pdftex_version",
        argv: [`${HOMEBREW_PREFIX}/bin/pdftex`, "--version"],
        env: [`TEXMFCNF=${HOMEBREW_PREFIX}/share/texmf-dist/web2c`],
        expected: /pdfTeX/i,
        description: "Run pdftex --version with the poured texmf config path.",
      })];
    default:
      return [programVersionCase(formula, formula, new RegExp(escapeRegex(formula), "i"))];
  }
}

export function browserCaseNamesForFormula(formula: HomebrewSmokeFormula): string[] {
  return browserSmokeCasesForFormula(formula).map((smokeCase) => smokeCase.name);
}

function programSkipCase(options: {
  formula: HomebrewSmokeFormula;
  name: string;
  reason: string;
  description: string;
}): BrowserSmokeCase {
  return {
    name: options.name,
    formula: options.formula,
    required: false,
    command: "skipped",
    argv: [],
    skipReason: options.reason,
    expected: /^$/,
    description: options.description,
  };
}

function programOutputCase(options: {
  formula: HomebrewSmokeFormula;
  name: string;
  argv: string[];
  stdin?: string;
  env?: string[];
  expected: RegExp;
  description: string;
}): BrowserSmokeCase {
  return {
    name: options.name,
    formula: options.formula,
    required: true,
    command: options.argv.join(" "),
    argv: options.argv,
    stdin: options.stdin,
    env: options.env,
    expected: options.expected,
    description: options.description,
  };
}

function programVersionCase(
  formula: HomebrewSmokeFormula,
  binName: string,
  expected: RegExp,
): BrowserSmokeCase {
  return programOutputCase({
    formula,
    name: `${binName}_version`,
    argv: [`${HOMEBREW_PREFIX}/bin/${binName}`, "--version"],
    expected,
    description: `Run ${binName} --version from the poured Homebrew prefix.`,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
