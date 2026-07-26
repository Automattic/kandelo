import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHomebrewRuntimeSupportPlan,
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
  it("binds one 18-tree atomic delta and keeps file/libmagic outside it", () => {
    const contract = parseHomebrewRuntimeSupportContract(source);
    expect(contract.activation).toEqual({
      capability: "homebrew:runtime",
      root: "/usr/bin/brew",
      atomicGroup: "homebrew-runtime-support",
    });
    expect(contract.additionalFormulaOrder).toHaveLength(18);
    expect(contract.deferredRelocationFormulae).toEqual([
      "kandelo-dev/tap-core/libmagic",
      "kandelo-dev/tap-core/file-formula",
    ]);
    expect(contract.lifecycleInstall).toEqual({
      tap: "brandonpayton/kandelo-canary",
      repository: "brandonpayton/homebrew-kandelo-canary",
      revision: "d8bdda662f6d80cf3dcdbe8451edb12bb33bbafc",
      formula: "m4",
    });
    expect(
      contract.deferredRelocationFormulae.some((name) =>
        contract.formulaOrder.includes(name)
      ),
    ).toBe(false);
  });

  it("rejects widening the fixed-prefix proof to file or libmagic", () => {
    for (const formula of [
      "kandelo-dev/tap-core/libmagic",
      "kandelo-dev/tap-core/file-formula",
    ]) {
      const changed = structuredClone(source);
      changed.formula_order.push(formula);
      changed.additional_formula_order.push(formula);
      expect(() => parseHomebrewRuntimeSupportContract(changed)).toThrow(
        /file\/libmagic relocation boundary/,
      );
    }
  });

  it("requires the exact planner order and projects only the additional trees", () => {
    const contract = parseHomebrewRuntimeSupportContract(source);
    const base = plan(contract.baseFormulaOrder);
    const support = plan(contract.formulaOrder);
    expect(() =>
      assertHomebrewRuntimeSupportPlan(contract, base, support)
    ).not.toThrow();

    const delta = projectHomebrewRuntimeSupportDelta(contract, support);
    expect(delta.packages.map((pkg) => pkg.fullName)).toEqual(
      contract.additionalFormulaOrder,
    );
    expect(delta.packages).toHaveLength(18);

    const reordered = plan([
      contract.formulaOrder[1]!,
      contract.formulaOrder[0]!,
      ...contract.formulaOrder.slice(2),
    ]);
    expect(() =>
      assertHomebrewRuntimeSupportPlan(contract, base, reordered)
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
    kandeloAbi: 42,
    releaseTag: "bottles-abi-v42",
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
    prefix: "/home/linuxbrew/.linuxbrew",
    keg: `/home/linuxbrew/.linuxbrew/Cellar/${name}/1`,
    formulaRevision: 0,
    bottleRebuild: 0,
    dependencies: [],
    linkManifestPath: `Kandelo/link/${name}.json`,
    linkManifest: {
      schema: 1,
      package: name,
      version: "1",
      arch: "wasm32",
      prefix: "/home/linuxbrew/.linuxbrew",
      keg: `/home/linuxbrew/.linuxbrew/Cellar/${name}/1`,
      links: [],
      receipts: [],
      env: {},
    },
  };
}
