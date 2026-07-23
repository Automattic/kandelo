import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatReport,
  validateLedger,
} from "../../scripts/check-homebrew-registry-ownership.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ledgerPath = join(repoRoot, "docs", "homebrew-registry-ownership.json");
const scratchRoots: string[] = [];

type Ledger = {
  sources: {
    tap: {
      commit: string;
      formula_directory: string;
      sidecar_directory: string;
    };
  };
  registry_entries: Record<string, Record<string, unknown>>;
  tap_formulae: Record<
    string,
    {
      recipe_state: string;
      declared_architectures: string[];
      architecture_evidence: Record<
        string,
        | string
        | {
            status: string;
            [key: string]: unknown;
          }
      >;
      registry_entries: string[];
      [key: string]: unknown;
    }
  >;
  [key: string]: unknown;
};

function loadLedger(): Ledger {
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
}

function cloneLedger(): Ledger {
  return structuredClone(loadLedger());
}

function makeScratch(): string {
  const target = join(repoRoot, "target");
  mkdirSync(target, { recursive: true });
  const scratch = mkdtempSync(join(target, "homebrew-ownership-"));
  scratchRoots.push(scratch);
  return scratch;
}

function makeTapFixture(ledger: Ledger): string {
  const tapRoot = makeScratch();
  const formulaRoot = join(tapRoot, ledger.sources.tap.formula_directory);
  const sidecarRoot = join(tapRoot, ledger.sources.tap.sidecar_directory);
  mkdirSync(formulaRoot, { recursive: true });
  mkdirSync(sidecarRoot, { recursive: true });

  for (const [name, formula] of Object.entries(ledger.tap_formulae)) {
    const bridge =
      formula.recipe_state === "registry_bridge"
        ? "  KANDELO_REGISTRY_BRIDGE = true\n"
        : "";
    const bottleLines = formula.declared_architectures
      .map(
        (arch) =>
          `    sha256 cellar: :any_skip_relocation, ${arch}_kandelo: "${"0".repeat(64)}"`,
      )
      .join("\n");
    writeFileSync(
      join(formulaRoot, `${name}.rb`),
      `class Fixture\n${bridge}  bottle do\n${bottleLines}\n  end\nend\n`,
    );

    const bottles = Object.entries(formula.architecture_evidence)
      .filter(([, value]) => value === "success")
      .map(([arch]) => ({ arch, status: "success" }));
    if (bottles.length > 0) {
      writeFileSync(
        join(sidecarRoot, `${name}.json`),
        `${JSON.stringify({ name, bottles }, null, 2)}\n`,
      );
    }
  }

  execFileSync("git", ["init", "-q"], { cwd: tapRoot });
  execFileSync("git", ["add", "."], { cwd: tapRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Kandelo Test",
      "-c",
      "user.email=kandelo-test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: tapRoot },
  );
  ledger.sources.tap.commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: tapRoot,
    encoding: "utf8",
  }).trim();
  return tapRoot;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Homebrew registry ownership ledger", () => {
  it("classifies the exact current and historical inventories", () => {
    const ledger = loadLedger();

    expect(validateLedger(ledger, { repoRoot })).toEqual([]);
    expect(Object.keys(ledger.registry_entries)).toHaveLength(76);
    expect(ledger.registry_entries["node-compat"].role).toBe("still_unowned");
    expect(ledger.registry_entries.npm.role).toBe("still_unowned");
  });

  it("rejects an unclassified registry directory", () => {
    const ledger = cloneLedger();
    delete ledger.registry_entries.bash;

    expect(validateLedger(ledger, { repoRoot })).toContain(
      "packages/registry inventory differs (extra: bash)",
    );
  });

  it("requires Formula and registry ownership to map in both directions", () => {
    const ledger = cloneLedger();
    ledger.tap_formulae.python.registry_entries = [];

    const errors = validateLedger(ledger, { repoRoot });
    expect(errors).toContain(
      "registry entry cpython maps to python, but its tap record does not map back",
    );
    expect(errors).toContain(
      "tap Formula python.tap_native_role must be a non-empty string",
    );
  });

  it("keeps candidate coverage non-authoritative until its gap is closed", () => {
    const ledger = cloneLedger();
    ledger.registry_entries["sqlite-cli"].role = "formula_recipe";

    const errors = validateLedger(ledger, { repoRoot });
    expect(errors).toContain(
      "registry entry sqlite-cli.formulae must be a non-empty array of non-empty strings",
    );
    expect(errors).toContain(
      "tap Formula sqlite candidate sqlite-cli must remain still_unowned until accepted",
    );
  });

  it("requires every declared architecture and non-success disposition", () => {
    const ledger = cloneLedger();
    ledger.tap_formulae.icu.declared_architectures.push("wasm64");
    const pending = ledger.tap_formulae.icu.architecture_evidence.wasm32;
    if (typeof pending !== "string") delete pending.first_error_or_artifact;

    const errors = validateLedger(ledger, { repoRoot });
    expect(errors).toContain(
      "tap Formula icu architecture evidence differs (missing: wasm64)",
    );
    expect(errors).toContain(
      "tap Formula icu.wasm32 fields differs (missing: first_error_or_artifact)",
    );
  });

  it("validates Formula files, bridge markers, sidecars, and bottle evidence", () => {
    const ledger = cloneLedger();
    const tapRoot = makeTapFixture(ledger);

    expect(validateLedger(ledger, { repoRoot, tapRoot })).toEqual([]);

    rmSync(join(tapRoot, "Kandelo", "formula", "bash.json"));
    const errors = validateLedger(ledger, { repoRoot, tapRoot });
    expect(errors).toContain("tap sidecar inventory differs (missing: bash)");
  });

  it("generates an operator report from the checked ledger", () => {
    const report = formatReport(loadLedger());

    expect(report).toContain("Current registry entries: 76.");
    expect(report).toContain("Tap Formulae: 61.");
    expect(report).toContain("Still unowned (14):");
    expect(report).toContain("Registry-bridge Formulae (10):");
    expect(report).toContain("Formula architecture success (67):");
    expect(report).toContain("Formula architecture pending (1): icu:wasm32");
  });
});
