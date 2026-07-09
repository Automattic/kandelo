import type { HomebrewBottleArch } from "../host/src/homebrew-vfs-planner";

export const HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
export const HOMEBREW_CELLAR = `${HOMEBREW_PREFIX}/Cellar`;
export const SQLITE_BROWSER_CONSUMER_PATH = "/usr/local/kandelo-smoke/bin/sqlite_basic";

export type HomebrewSmokeFormula = "hello" | "sqlite" | "bzip2" | "xz";

export interface BrowserSmokeCase {
  name: string;
  formula: HomebrewSmokeFormula;
  required: boolean;
  command: string;
  argv: string[];
  expected: RegExp;
  description: string;
}

export function parseHomebrewSmokeFormula(value: string): HomebrewSmokeFormula {
  if (value === "hello" || value === "sqlite" || value === "bzip2" || value === "xz") {
    return value;
  }
  throw new Error(`formula must be hello, sqlite, bzip2, or xz, got ${value}`);
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
    case "bzip2":
      return [programOutputCase({
        formula,
        name: "bzip2_help",
        argv: [`${HOMEBREW_PREFIX}/bin/bzip2`, "--help"],
        expected: /bzip2/i,
        description: "Run bzip2 --help from the poured Homebrew prefix.",
      })];
    case "xz":
      return [programOutputCase({
        formula,
        name: "xz_version",
        argv: [`${HOMEBREW_PREFIX}/bin/xz`, "--version"],
        expected: /xz/i,
        description: "Run xz --version from the poured Homebrew prefix.",
      })];
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
  }
}

export function browserCaseNamesForFormula(formula: HomebrewSmokeFormula): string[] {
  return browserSmokeCasesForFormula(formula).map((smokeCase) => smokeCase.name);
}

function programOutputCase(options: {
  formula: HomebrewSmokeFormula;
  name: string;
  argv: string[];
  expected: RegExp;
  description: string;
}): BrowserSmokeCase {
  return {
    name: options.name,
    formula: options.formula,
    required: true,
    command: options.argv.join(" "),
    argv: options.argv,
    expected: options.expected,
    description: options.description,
  };
}
