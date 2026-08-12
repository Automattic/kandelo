import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHomebrewRuntimeSupportPlan,
  parseHomebrewRuntimeSupportPolicy,
  parseHomebrewRuntimeSupportContract,
  projectHomebrewRuntimeSupportDelta,
} from "../src/homebrew-runtime-support";
import type {
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "../src/homebrew-vfs-planner";

const source = JSON.parse(
  readFileSync(
    resolve("../homebrew/main-shell-homebrew-runtime-support.json"),
    "utf8",
  ),
);

describe("Homebrew shell runtime-support contract", () => {
  it("binds the complete ABI 43 runtime closure to the base", () => {
    const contract = parseHomebrewRuntimeSupportContract(source);
    expect(contract.activation).toEqual({
      capability: "homebrew:runtime",
      root: "/usr/bin/brew",
      atomicGroup: "homebrew-runtime-support",
      requiredKernelAbi: 43,
    });
    expect(contract.availability).toEqual({
      provenance: {
        schema: 1,
        provenance_kind: "local-test",
        promotable: false,
        published: false,
      },
      auditedCatalog: {
        checkoutCommit: "af70e3ba06367dbafb8a95fabbacc3e1352b58b2",
        kandeloAbi: 43,
        releaseTag: "bottles-abi-v43",
        requiredArch: "wasm32",
      },
    });
    expect(contract.additionalFormulaOrder).toEqual(
      contract.formulaOrder.filter(
        (name) => !contract.baseFormulaOrder.includes(name),
      ),
    );
    expect(contract.additionalFormulaOrder).toEqual([]);
    expect(contract.baseFormulaOrder).toContain(
      "kandelo-dev/tap-core/ruby",
    );
    expect(contract.deferredRelocationFormulae).toEqual([]);
    expect(contract.baseFormulaOrder).toEqual(
      expect.arrayContaining([
        "kandelo-dev/tap-core/libmagic",
        "kandelo-dev/tap-core/file-formula",
      ]),
    );
    expect(contract.lifecycleInstall).toEqual({
      tap: "brandonpayton/kandelo-canary",
      repository: "brandonpayton/homebrew-kandelo-canary",
      revision: "b86d1810c68e3ab17bdab218856da3a7516ec95c",
      formula: "m4-canary",
    });
    expect(
      contract.deferredRelocationFormulae.some((name) =>
        contract.formulaOrder.includes(name),
      ),
    ).toBe(false);
  });

  it("rejects declaring one Formula as both admitted and deferred", () => {
    const changed = structuredClone(source);
    changed.deferred_formulae.push({
      package: "kandelo-dev/tap-core/ruby",
      current_state: "public-abi41-only",
      reason: "fixture",
      reentry_gate: "fixture",
    });
    changed.availability.can_be_deferred.push("kandelo-dev/tap-core/ruby");
    expect(() => parseHomebrewRuntimeSupportContract(changed)).toThrow(
      /cannot both admit and defer/,
    );
  });

  it("requires the exact planner order and projects only the additional trees", () => {
    const contract = parseHomebrewRuntimeSupportContract(source);
    const base = plan(contract.baseFormulaOrder);
    const support = plan(contract.formulaOrder);
    expect(() =>
      assertHomebrewRuntimeSupportPlan(contract, base, support),
    ).not.toThrow();

    const delta = projectHomebrewRuntimeSupportDelta(contract, support);
    expect(delta.packages.map((pkg) => pkg.fullName)).toEqual(
      contract.additionalFormulaOrder,
    );
    expect(delta.packages).toHaveLength(
      contract.additionalFormulaOrder.length,
    );

    const reordered = plan([
      contract.formulaOrder[1]!,
      contract.formulaOrder[0]!,
      ...contract.formulaOrder.slice(2),
    ]);
    expect(() =>
      assertHomebrewRuntimeSupportPlan(contract, base, reordered),
    ).toThrow(/differs from its exact base\/catalog contract/);
  });
});

function plan(packageOrder: readonly string[]): HomebrewVfsPlan {
  return {
    tapRepository: "kandelo-dev/homebrew-tap-core",
    tapName: "kandelo-dev/tap-core",
    tapCommit: "1".repeat(40),
    kandeloRepository: "Automattic/kandelo",
    kandeloCommit: "2".repeat(40),
    kandeloAbi: 43,
    releaseTag: "bottles-abi-v43",
    requestedPackages: ["runtime"],
    packages: packageOrder.map((fullName) => packagePlan(fullName)),
  };
}

function packagePlan(fullName: string): HomebrewVfsPackagePlan {
  const name = fullName.split("/").at(-1)!;
  return {
    name,
    fullName,
    tapRepository: "kandelo-dev/homebrew-tap-core",
    tapName: "kandelo-dev/tap-core",
    tapCommit: "1".repeat(40),
    version: "1",
    arch: "wasm32",
    bottleTag: "wasm32_kandelo",
    sourceStatus: "success",
    metadataStatus: "success",
    url: `https://example.invalid/${name}.tar.gz`,
    sha256: "3".repeat(64),
    bytes: 1,
    cacheKeySha: "3".repeat(64),
    prefix: "/opt/kandelo/homebrew",
    keg: `/opt/kandelo/homebrew/Cellar/${name}/1`,
    formulaRevision: 0,
    bottleRebuild: 0,
    dependencies: [],
    linkManifestPath: `Kandelo/link/${name}.json`,
    linkManifest: {
      schema: 1,
      package: name,
      version: "1",
      arch: "wasm32",
      prefix: "/opt/kandelo/homebrew",
      keg: `/opt/kandelo/homebrew/Cellar/${name}/1`,
      links: [],
      receipts: [],
      env: {},
    },
  };
}
