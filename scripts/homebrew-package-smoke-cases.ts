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

/**
 * Formulae that cannot be certified through the non-interactive terminal
 * Homebrew browser smoke because they require framebuffer/DRI device plumbing
 * and (for fbdoom) game data. These mirror the Node smoke's framebuffer skips
 * (kd-v3fs vim-node-smoke) and should be certified via a dedicated browser
 * framebuffer/device smoke harness, not this one.
 */
export function browserFormulaUnsupportedReason(
  formula: HomebrewSmokeFormula,
): string | undefined {
  switch (formula) {
    case "modeset":
      return "modeset requires a DRI/GLES framebuffer device (/dev/dri) not provided by the non-interactive terminal Homebrew browser smoke; certify via a dedicated browser framebuffer/device smoke";
    case "fbdoom":
      return "fbdoom requires IWAD game data and a framebuffer/audio device (/dev/fb0) not provided by the non-interactive terminal Homebrew browser smoke; certify via a dedicated browser framebuffer smoke";
    default:
      return undefined;
  }
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
    case "dash":
      // dash is a POSIX shell; `--version` is an illegal option. Exercise the
      // shell by running a command instead.
      return [programOutputCase({
        formula,
        name: "dash_command",
        argv: [`${HOMEBREW_PREFIX}/bin/dash`, "-c", "echo dash_browser_smoke_ok"],
        expected: /dash_browser_smoke_ok/,
        description: "Run a command through dash from the poured Homebrew prefix.",
      })];
    case "lsof":
      // Kandelo's lsof (examples/lsof.c) has no version flag; `-h` prints usage and exits 0.
      return [programOutputCase({
        formula,
        name: "lsof_help",
        argv: [`${HOMEBREW_PREFIX}/bin/lsof`, "-h"],
        expected: /usage:\s*lsof|lsof/i,
        description: "Run lsof -h from the poured Homebrew prefix.",
      })];
    case "netcat":
      // The poured prefix links `nc` (not `netcat`); `-h` prints the GNU netcat banner.
      return [programOutputCase({
        formula,
        name: "netcat_help",
        argv: [`${HOMEBREW_PREFIX}/bin/nc`, "-h"],
        expected: /netcat|usage/i,
        description: "Run nc -h from the poured Homebrew prefix.",
      })];
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
