import type { HomebrewBottleArch } from "../host/src/homebrew-vfs-planner";

export const HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
export const HOMEBREW_CELLAR = `${HOMEBREW_PREFIX}/Cellar`;
export const SQLITE_BROWSER_CONSUMER_PATH = "/usr/local/kandelo-smoke/bin/sqlite_basic";

export type HomebrewSmokeFormula = string;

export interface BrowserSmokeCase {
  name: string;
  formula: HomebrewSmokeFormula;
  required: boolean;
  command: string;
  argv: string[];
  stdin?: string;
  env?: string[];
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
    case "bash":
      return [programOutputCase({
        formula,
        name: "bash_echo",
        argv: [`${HOMEBREW_PREFIX}/bin/bash`, "-c", "echo bash-ok"],
        env: ["TERM=dumb"],
        expected: /^bash-ok$/m,
        description: "Run a non-interactive Bash command from the poured Homebrew prefix.",
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
        name: "cpython_print",
        argv: [`${HOMEBREW_PREFIX}/bin/python3`, "-S", "-c", "print('python-ok')"],
        env: [
          `PYTHONHOME=${HOMEBREW_PREFIX}`,
          "PYTHONDONTWRITEBYTECODE=1",
          "PYTHONNOUSERSITE=1",
        ],
        expected: /^python-ok$/m,
        description: "Run a CPython one-liner using the poured stdlib.",
      })];
    case "curl":
      return [programVersionCase(formula, "curl", /curl/i)];
    case "dinit":
      return [programVersionCase(formula, "dinit", /dinit/i)];
    case "diffutils":
      return [programVersionCase(formula, "diff", /diff/i)];
    case "erlang":
      return [programOutputCase({
        formula,
        name: "erlang_eval",
        argv: [
          `${HOMEBREW_PREFIX}/bin/erlang`,
          "-S", "1:1",
          "-A", "0",
          "-SDio", "1",
          "-SDcpu", "1:1",
          "-P", "262144",
          "--",
          "-root", `${HOMEBREW_PREFIX}/lib/erlang`,
          "-bindir", `${HOMEBREW_PREFIX}/lib/erlang/erts-16.1.2/bin`,
          "-progname", "erl",
          "-home", "/tmp",
          "-start_epmd", "false",
          "-boot", `${HOMEBREW_PREFIX}/lib/erlang/releases/28/start_clean`,
          "-noshell",
          "-eval", "io:format(\"erlang-ok~n\"), halt().",
        ],
        env: [
          `ROOTDIR=${HOMEBREW_PREFIX}/lib/erlang`,
          `BINDIR=${HOMEBREW_PREFIX}/lib/erlang/erts-16.1.2/bin`,
          "EMU=beam",
          "PROGNAME=erl",
        ],
        expected: /erlang-ok/,
        description: "Attempt to boot BEAM with the poured OTP runtime.",
      })];
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
    case "nethack":
      return [programOutputCase({
        formula,
        name: "nethack_scores",
        argv: [`${HOMEBREW_PREFIX}/bin/nethack`, "-s"],
        env: [`NETHACKDIR=${HOMEBREW_PREFIX}/share/nethack`, "TERM=xterm"],
        expected: /nethack|points|score/i,
        description: "Run NetHack score listing against the poured runtime data.",
      })];
    case "perl":
      return [programOutputCase({
        formula,
        name: "perl_print",
        argv: [`${HOMEBREW_PREFIX}/bin/perl`, "-e", "print qq(perl-ok\\n)"],
        env: [`PERL5LIB=${HOMEBREW_PREFIX}/lib/perl5/5.40.3`],
        expected: /^perl-ok$/m,
        description: "Run a Perl one-liner using the poured core library.",
      })];
    case "php":
      return [programOutputCase({
        formula,
        name: "php_print",
        argv: [`${HOMEBREW_PREFIX}/bin/php`, "-r", "echo 'php-ok\n';"],
        expected: /^php-ok$/m,
        description: "Run a PHP CLI one-liner from the poured Homebrew prefix.",
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
    case "ruby":
      return [programOutputCase({
        formula,
        name: "ruby_print",
        argv: [`${HOMEBREW_PREFIX}/bin/ruby`, "-e", "puts 'ruby-ok'"],
        env: [`RUBYLIB=${HOMEBREW_PREFIX}/lib/ruby/4.0.0`, "GEM_HOME=/tmp/gems"],
        expected: /^ruby-ok$/m,
        description: "Run a Ruby one-liner using the poured runtime library.",
      })];
    case "tar":
      return [programVersionCase(formula, "tar", /tar/i)];
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
    case "texlive":
      return [programOutputCase({
        formula,
        name: "pdftex_version",
        argv: [`${HOMEBREW_PREFIX}/bin/pdftex`, "--version"],
        env: [
          `TEXMFDIST=${HOMEBREW_PREFIX}/share/texmf-dist`,
          `TEXMFCNF=${HOMEBREW_PREFIX}/share/texmf-dist/web2c`,
        ],
        expected: /pdfTeX/i,
        description: "Run pdftex --version from the poured TeX Live keg.",
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
    default:
      return [programVersionCase(formula, formula, new RegExp(escapeRegex(formula), "i"))];
  }
}

export function browserCaseNamesForFormula(formula: HomebrewSmokeFormula): string[] {
  return browserSmokeCasesForFormula(formula).map((smokeCase) => smokeCase.name);
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
