import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseHomebrewRuntimeLayerPolicy,
  projectHomebrewRuntimeLayerPlan,
  selectHomebrewRuntimeLayer,
  selectHomebrewRuntimeLayers,
  type HomebrewRuntimeLayerPolicy,
} from "../src/homebrew-runtime-layer-policy";
import type {
  HomebrewDependency,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "../src/homebrew-vfs-planner";

const TAP_NAME = "kandelo-dev/tap-core";
const POLICY_PATH = resolve(import.meta.dirname, "../../homebrew/runtime-layer-policy.json");

function checkedInPolicy(): HomebrewRuntimeLayerPolicy {
  return parseHomebrewRuntimeLayerPolicy(
    JSON.parse(readFileSync(POLICY_PATH, "utf8")),
  );
}

function dependency(name: string): HomebrewDependency {
  return { name, full_name: `${TAP_NAME}/${name}` };
}

function pkg(
  name: string,
  dependencies: HomebrewDependency[] = [],
): HomebrewVfsPackagePlan {
  return {
    name,
    fullName: `${TAP_NAME}/${name}`,
    tapName: TAP_NAME,
    dependencies,
  } as HomebrewVfsPackagePlan;
}

function languagePlan(): HomebrewVfsPlan {
  return {
    schema: 1,
    tapRepository: "kandelo-dev/homebrew-tap-core",
    tapName: TAP_NAME,
    tapCommit: "1".repeat(40),
    kandeloRepository: "Automattic/kandelo",
    kandeloCommit: "2".repeat(40),
    kandeloAbi: 41,
    releaseTag: "bottles-abi-v41",
    requestedPackages: ["dash", "python", "perl", "erlang"],
    packages: [
      pkg("dash"),
      pkg("zlib"),
      pkg("python", [dependency("zlib")]),
      pkg("perl", [dependency("zlib")]),
      pkg("erlang"),
    ],
  };
}

const SHELL_BASE = {
  source: {
    schema: 1 as const,
    kind: "kandelo-package-output" as const,
    package: { name: "shell" },
    output: { name: "shell" },
  },
  packageOrder: [
    `${TAP_NAME}/dash`,
    `${TAP_NAME}/zlib`,
    `${TAP_NAME}/coreutils`,
  ],
};

describe("Homebrew runtime layer policy", () => {
  it("pins the three language roots above the canonical shell package", () => {
    expect(checkedInPolicy()).toEqual({
      schema: 1,
      kind: "kandelo-homebrew-runtime-layer-policy",
      base_package: "shell",
      layers: [
        { id: "erlang", root_package: `${TAP_NAME}/erlang` },
        { id: "perl", root_package: `${TAP_NAME}/perl` },
        { id: "python", root_package: `${TAP_NAME}/python` },
      ],
    });
  });

  it("selects independent runtime deltas and excludes shell-owned closure", () => {
    const selections = selectHomebrewRuntimeLayers(
      languagePlan(),
      SHELL_BASE,
      checkedInPolicy(),
    );
    const summary = Object.fromEntries(selections.map((selection) => [
      selection.id,
      {
        closure: selection.packages.map((pkg) => pkg.name),
        base: selection.basePackages.map((pkg) => pkg.name),
        layer: selection.layerPackages.map((pkg) => pkg.name),
      },
    ]));
    expect(summary).toEqual({
      erlang: { closure: ["erlang"], base: [], layer: ["erlang"] },
      python: {
        closure: ["zlib", "python"],
        base: ["zlib"],
        layer: ["python"],
      },
      perl: {
        closure: ["zlib", "perl"],
        base: ["zlib"],
        layer: ["perl"],
      },
    });
  });

  it("selects one named runtime without admitting unrelated plan roots", () => {
    const selection = selectHomebrewRuntimeLayer(
      languagePlan(),
      SHELL_BASE,
      checkedInPolicy(),
      "python",
    );
    expect(selection.rootPackage).toBe(`${TAP_NAME}/python`);
    expect(selection.packages.map((pkg) => pkg.name)).toEqual(["zlib", "python"]);
    expect(selection.layerPackages.map((pkg) => pkg.name)).toEqual(["python"]);
    expect(projectHomebrewRuntimeLayerPlan(languagePlan(), selection)).toMatchObject({
      requestedPackages: ["python"],
      packages: [
        { name: "zlib" },
        { name: "python" },
      ],
    });
  });

  it("rejects a root already owned by the base instead of emitting an empty delta", () => {
    expect(() => selectHomebrewRuntimeLayer(
      languagePlan(),
      {
        ...SHELL_BASE,
        packageOrder: [...SHELL_BASE.packageOrder, `${TAP_NAME}/python`],
      },
      checkedInPolicy(),
      "python",
    )).toThrow("root kandelo-dev/tap-core/python is already owned by the base");
  });

  it("rejects a non-base dependency shared by otherwise independent layers", () => {
    expect(() => selectHomebrewRuntimeLayers(
      languagePlan(),
      {
        source: SHELL_BASE.source,
        packageOrder: [`${TAP_NAME}/dash`, `${TAP_NAME}/coreutils`],
      },
      checkedInPolicy(),
    )).toThrow(
      "runtime layers perl and python share non-base package kandelo-dev/tap-core/zlib",
    );
  });

  it("selects one reviewed runtime from a one-root producer plan", () => {
    const plan = languagePlan();
    plan.requestedPackages = ["python"];
    plan.packages = plan.packages.filter((candidate) =>
      candidate.name === "zlib" || candidate.name === "python"
    );
    const selection = selectHomebrewRuntimeLayer(
      plan,
      SHELL_BASE,
      checkedInPolicy(),
      "python",
    );
    expect(selection.packages.map((pkg) => pkg.name)).toEqual(["zlib", "python"]);
    expect(selection.layerPackages.map((pkg) => pkg.name)).toEqual(["python"]);
  });

  it("requires every policy root to be both present and explicitly requested", () => {
    const absent = languagePlan();
    absent.packages = absent.packages.filter((candidate) => candidate.name !== "erlang");
    expect(() => selectHomebrewRuntimeLayers(
      absent,
      SHELL_BASE,
      checkedInPolicy(),
    )).toThrow("erlang root kandelo-dev/tap-core/erlang is absent from the plan");

    const transitiveOnly = languagePlan();
    transitiveOnly.requestedPackages = transitiveOnly.requestedPackages.filter(
      (name) => name !== "perl",
    );
    expect(() => selectHomebrewRuntimeLayers(
      transitiveOnly,
      SHELL_BASE,
      checkedInPolicy(),
    )).toThrow("perl root kandelo-dev/tap-core/perl was not explicitly requested");
  });

  it("requires dependency-first, complete package plans", () => {
    const missing = languagePlan();
    missing.packages = missing.packages.filter((candidate) => candidate.name !== "zlib");
    expect(() => selectHomebrewRuntimeLayers(
      missing,
      SHELL_BASE,
      checkedInPolicy(),
    )).toThrow("python depends on missing kandelo-dev/tap-core/zlib");

    const reversed = languagePlan();
    const zlib = reversed.packages.splice(1, 1)[0];
    reversed.packages.push(zlib);
    expect(() => selectHomebrewRuntimeLayers(
      reversed,
      SHELL_BASE,
      checkedInPolicy(),
    )).toThrow("plan is not dependency-first at kandelo-dev/tap-core/python");
  });

  it("binds selection to the declared lower package and a nonempty unique base closure", () => {
    expect(() => selectHomebrewRuntimeLayers(
      languagePlan(),
      {
        ...SHELL_BASE,
        source: {
          ...SHELL_BASE.source,
          package: { name: "rootfs" },
        },
      },
      checkedInPolicy(),
    )).toThrow("requires base package shell, got package rootfs and output shell");
    expect(() => selectHomebrewRuntimeLayers(
      languagePlan(),
      {
        ...SHELL_BASE,
        source: {
          ...SHELL_BASE.source,
          output: { name: "rootfs" },
        },
      },
      checkedInPolicy(),
    )).toThrow("requires base package shell, got package shell and output rootfs");
    expect(() => selectHomebrewRuntimeLayers(
      languagePlan(),
      { source: SHELL_BASE.source, packageOrder: [] },
      checkedInPolicy(),
    )).toThrow("base closure is empty");
    expect(() => selectHomebrewRuntimeLayers(
      languagePlan(),
      {
        source: SHELL_BASE.source,
        packageOrder: [`${TAP_NAME}/dash`, `${TAP_NAME}/dash`],
      },
      checkedInPolicy(),
    )).toThrow("base closure duplicates package kandelo-dev/tap-core/dash");
  });

  it("rejects ambiguous, reordered, and open-ended policy documents", () => {
    const policy = checkedInPolicy();
    expect(() => parseHomebrewRuntimeLayerPolicy({
      ...policy,
      layers: [policy.layers[1], policy.layers[0], policy.layers[2]],
    })).toThrow("entries are not in canonical id order");
    expect(() => parseHomebrewRuntimeLayerPolicy({
      ...policy,
      layers: [policy.layers[0], { ...policy.layers[0] }],
    })).toThrow("duplicates id erlang");
    expect(() => parseHomebrewRuntimeLayerPolicy({
      ...policy,
      layers: [policy.layers[0], {
        ...policy.layers[1],
        root_package: policy.layers[0].root_package,
      }],
    })).toThrow("id must match its root package name");
    expect(() => parseHomebrewRuntimeLayerPolicy({
      ...policy,
      comment: "not part of the signed policy shape",
    })).toThrow("policy has unexpected fields");
    expect(() => parseHomebrewRuntimeLayerPolicy({
      ...policy,
      layers: [
        policy.layers[0],
        policy.layers[1],
        { id: "python3", root_package: `${TAP_NAME}/python` },
      ],
    })).toThrow("id must match its root package name");
  });

  it("rejects unknown layer ids at selection time", () => {
    expect(() => selectHomebrewRuntimeLayer(
      languagePlan(),
      SHELL_BASE,
      checkedInPolicy(),
      "ruby",
    )).toThrow("policy does not define ruby");
  });
});
