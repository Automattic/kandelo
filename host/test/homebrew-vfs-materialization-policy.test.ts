import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHomebrewVfsDeferredPackageCollection,
  deriveFlatLazyCompositionPartition,
  parseHomebrewVfsMaterializationPolicy,
  projectEmbeddedHomebrewVfsPlan,
  selectHomebrewVfsMaterialization,
  type HomebrewVfsMaterializationPolicy,
} from "../src/homebrew-vfs-materialization-policy";
import { projectHomebrewBottleSelection } from "../src/homebrew-bottle-selection";
import { parseHomebrewRuntimeSupportPolicy } from "../src/homebrew-runtime-support";
import type {
  HomebrewDependency,
  HomebrewFederatedVfsPlan,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "../src/homebrew-vfs-planner";

const TAP_NAME = "kandelo-dev/tap-core";
const POLICY_PATH = resolve(
  import.meta.dirname,
  "../../homebrew/main-shell-materialization-policy.json",
);
const MIGRATION_LOCK_PATH = resolve(
  import.meta.dirname,
  "../../homebrew/main-shell-migration-lock.json",
);
const FLAT_SELECTION_PATH = resolve(
  import.meta.dirname,
  "../../homebrew/main-shell-flat-selection.json",
);
const RUNTIME_SUPPORT_POLICY_PATH = resolve(
  import.meta.dirname,
  "../../homebrew/main-shell-runtime-support-policy.json",
);

function checkedInPolicy(): HomebrewVfsMaterializationPolicy {
  return parseHomebrewVfsMaterializationPolicy(
    JSON.parse(readFileSync(POLICY_PATH, "utf8")),
  );
}

function checkedInFlatSelection() {
  return projectHomebrewBottleSelection(
    JSON.parse(readFileSync(FLAT_SELECTION_PATH, "utf8")),
    { expectedAbi: 42 },
  );
}

function checkedInRuntimeSupportPolicy() {
  return parseHomebrewRuntimeSupportPolicy(
    JSON.parse(readFileSync(RUNTIME_SUPPORT_POLICY_PATH, "utf8")),
  );
}

function dependency(name: string, fullName = `${TAP_NAME}/${name}`): HomebrewDependency {
  return { name, full_name: fullName };
}

function pkg(
  name: string,
  dependencies: HomebrewDependency[] = [],
  tapName = TAP_NAME,
): HomebrewVfsPackagePlan {
  return {
    name,
    fullName: `${tapName}/${name}`,
    tapName,
    dependencies,
  } as HomebrewVfsPackagePlan;
}

function shellPlan(): HomebrewVfsPlan {
  return {
    schema: 1,
    tapRepository: "Kandelo-dev/homebrew-tap-core",
    tapName: TAP_NAME,
    tapCommit: "1".repeat(40),
    kandeloRepository: "Automattic/kandelo",
    kandeloCommit: "2".repeat(40),
    kandeloAbi: 41,
    releaseTag: "bottles-abi-v41",
    requestedPackages: [
      "dash",
      "bash",
      "coreutils",
      "login",
      "sudo-lite",
      "sudo",
      "ruby",
    ],
    packages: [
      pkg("dash"),
      pkg("libcxx"),
      pkg("ncurses", [dependency("libcxx")]),
      pkg("bash", [dependency("ncurses")]),
      pkg("coreutils"),
      pkg("zlib"),
      pkg("login"),
      pkg("sudo-lite"),
      pkg("sudo"),
      pkg("libyaml"),
      pkg("ruby", [dependency("libyaml"), dependency("zlib")]),
    ],
  };
}

describe("Homebrew VFS materialization policy", () => {
  it("pins the login product and its exact dependency-first closure", () => {
    expect(checkedInPolicy()).toEqual({
      schema: 1,
      kind: "kandelo-homebrew-vfs-materialization-policy",
      embedded_roots: [
        `${TAP_NAME}/bash`,
        `${TAP_NAME}/login`,
        `${TAP_NAME}/sudo-lite`,
        `${TAP_NAME}/sudo`,
        `${TAP_NAME}/ruby`,
      ],
      embedded_package_order: [
        `${TAP_NAME}/libcxx`,
        `${TAP_NAME}/ncurses`,
        `${TAP_NAME}/bash`,
        `${TAP_NAME}/zlib`,
        `${TAP_NAME}/login`,
        `${TAP_NAME}/sudo-lite`,
        `${TAP_NAME}/sudo`,
        `${TAP_NAME}/libyaml`,
        `${TAP_NAME}/ruby`,
      ],
    });
  });

  it("leaves every non-embedded Formula in the migration lock deferred", () => {
    const lock = JSON.parse(readFileSync(MIGRATION_LOCK_PATH, "utf8")) as {
      formula_closure: string[];
    };
    const embedded = new Set(checkedInPolicy().embedded_package_order);
    const deferred = lock.formula_closure.filter((name) => !embedded.has(name));
    expect(deferred).toHaveLength(
      lock.formula_closure.length - embedded.size,
    );
    expect(deferred).toContain(`${TAP_NAME}/dash`);
    expect(new Set([...embedded, ...deferred])).toEqual(new Set(lock.formula_closure));
  });

  it("partitions every planned package without overlap or loss", () => {
    const selection = selectHomebrewVfsMaterialization(shellPlan(), checkedInPolicy());
    expect(selection.embeddedRoots).toEqual([
      `${TAP_NAME}/bash`,
      `${TAP_NAME}/login`,
      `${TAP_NAME}/sudo-lite`,
      `${TAP_NAME}/sudo`,
      `${TAP_NAME}/ruby`,
    ]);
    expect(selection.embeddedPackages.map((entry) => entry.name)).toEqual([
      "libcxx",
      "ncurses",
      "bash",
      "zlib",
      "login",
      "sudo-lite",
      "sudo",
      "libyaml",
      "ruby",
    ]);
    expect(selection.deferredPackages.map((entry) => entry.name)).toEqual([
      "dash",
      "coreutils",
    ]);
    expect(new Set([
      ...selection.embeddedPackages,
      ...selection.deferredPackages,
    ].map((entry) => entry.fullName))).toEqual(
      new Set(shellPlan().packages.map((entry) => entry.fullName)),
    );
  });

  it("projects the embedded roots and closure without retaining deferred roots", () => {
    const plan = shellPlan();
    const selection = selectHomebrewVfsMaterialization(plan, checkedInPolicy());
    expect(projectEmbeddedHomebrewVfsPlan(plan, selection)).toMatchObject({
      requestedPackages: ["bash", "login", "sudo-lite", "sudo", "ruby"],
      packages: [
        { name: "libcxx" },
        { name: "ncurses" },
        { name: "bash" },
        { name: "zlib" },
        { name: "login" },
        { name: "sudo-lite" },
        { name: "sudo" },
        { name: "libyaml" },
        { name: "ruby" },
      ],
    });
  });

  it("preserves exact cross-tap root identities in a federated projection", () => {
    const plan = shellPlan() as HomebrewFederatedVfsPlan;
    plan.requestedFullNames = [
      `${TAP_NAME}/dash`,
      `${TAP_NAME}/bash`,
      `${TAP_NAME}/coreutils`,
      `${TAP_NAME}/login`,
      `${TAP_NAME}/sudo-lite`,
      `${TAP_NAME}/sudo`,
      `${TAP_NAME}/ruby`,
    ];
    plan.taps = [];
    const selection = selectHomebrewVfsMaterialization(plan, checkedInPolicy());
    const projected = projectEmbeddedHomebrewVfsPlan(plan, selection) as HomebrewFederatedVfsPlan;
    expect(projected.requestedFullNames).toEqual([
      `${TAP_NAME}/bash`,
      `${TAP_NAME}/login`,
      `${TAP_NAME}/sudo-lite`,
      `${TAP_NAME}/sudo`,
      `${TAP_NAME}/ruby`,
    ]);
    expect(projected.requestedPackages).toEqual([
      "bash",
      "login",
      "sudo-lite",
      "sudo",
      "ruby",
    ]);
  });

  it("requires the embedded root to be an explicit reviewed plan root", () => {
    const plan = shellPlan();
    plan.requestedPackages = ["dash", "coreutils"];
    expect(() =>
      selectHomebrewVfsMaterialization(plan, checkedInPolicy())
    ).toThrow("root kandelo-dev/tap-core/bash was not explicitly requested");
  });

  it("fails closed when the actual Bash dependency closure changes", () => {
    const plan = shellPlan();
    plan.packages.splice(1, 0, pkg("openssl"));
    plan.packages.find((entry) => entry.name === "bash")!.dependencies.push(
      dependency("openssl"),
    );
    expect(() =>
      selectHomebrewVfsMaterialization(plan, checkedInPolicy())
    ).toThrow("embedded closure differs from the reviewed policy");
  });

  it("requires a complete dependency-first plan", () => {
    const missing = shellPlan();
    missing.packages = missing.packages.filter((entry) => entry.name !== "libcxx");
    expect(() =>
      selectHomebrewVfsMaterialization(missing, checkedInPolicy())
    ).toThrow("ncurses depends on missing kandelo-dev/tap-core/libcxx");

    const reversed = shellPlan();
    const libcxx = reversed.packages.splice(1, 1)[0];
    reversed.packages.splice(3, 0, libcxx);
    expect(() =>
      selectHomebrewVfsMaterialization(reversed, checkedInPolicy())
    ).toThrow("plan is not dependency-first at kandelo-dev/tap-core/ncurses");
  });

  it("rejects duplicate packages, dependencies, and requested roots", () => {
    const duplicatePackage = shellPlan();
    duplicatePackage.packages.push(pkg("bash"));
    expect(() =>
      selectHomebrewVfsMaterialization(duplicatePackage, checkedInPolicy())
    ).toThrow("plan duplicates kandelo-dev/tap-core/bash");

    const duplicateDependency = shellPlan();
    duplicateDependency.packages.find((entry) => entry.name === "bash")!.dependencies.push(
      dependency("ncurses"),
    );
    expect(() =>
      selectHomebrewVfsMaterialization(duplicateDependency, checkedInPolicy())
    ).toThrow("bash duplicates a dependency");

    const duplicateRoot = shellPlan();
    duplicateRoot.requestedPackages.push("bash");
    expect(() =>
      selectHomebrewVfsMaterialization(duplicateRoot, checkedInPolicy())
    ).toThrow("plan duplicates a requested package");
  });

  it("rejects an all-embedded plan because the cutover requires a deferred partition", () => {
    const plan = shellPlan();
    const embedded = new Set(checkedInPolicy().embedded_package_order);
    plan.requestedPackages = ["bash", "login", "sudo-lite", "sudo", "ruby"];
    plan.packages = plan.packages.filter((entry) => embedded.has(entry.fullName));
    expect(() =>
      selectHomebrewVfsMaterialization(plan, checkedInPolicy())
    ).toThrow("policy leaves no deferred packages");
  });

  it("binds direct trees one-to-one by full package name, independent of tree order", () => {
    const selection = selectHomebrewVfsMaterialization(shellPlan(), checkedInPolicy());
    expect(() => assertHomebrewVfsDeferredPackageCollection(
      selection,
      [`${TAP_NAME}/dash`, `${TAP_NAME}/coreutils`],
      // Descriptor trees have their own canonical id order. Explicit package
      // bindings, not array position, own the relation to the package plan.
      [`${TAP_NAME}/coreutils`, `${TAP_NAME}/dash`],
    )).not.toThrow();
  });

  it("rejects reordered package plans and incomplete or foreign direct-tree bindings", () => {
    const selection = selectHomebrewVfsMaterialization(shellPlan(), checkedInPolicy());
    expect(() => assertHomebrewVfsDeferredPackageCollection(
      selection,
      [`${TAP_NAME}/coreutils`, `${TAP_NAME}/dash`],
      [`${TAP_NAME}/dash`, `${TAP_NAME}/coreutils`],
    )).toThrow("layer package order differs from the selected partition");
    expect(() => assertHomebrewVfsDeferredPackageCollection(
      selection,
      [`${TAP_NAME}/dash`, `${TAP_NAME}/coreutils`],
      [`${TAP_NAME}/dash`],
    )).toThrow("tree count 1 differs from the deferred package count 2");
    expect(() => assertHomebrewVfsDeferredPackageCollection(
      selection,
      [`${TAP_NAME}/dash`, `${TAP_NAME}/coreutils`],
      [`${TAP_NAME}/dash`, `${TAP_NAME}/bash`],
    )).toThrow(
      'missing=["kandelo-dev/tap-core/coreutils"] ' +
        'unexpected=["kandelo-dev/tap-core/bash"]',
    );
    expect(() => assertHomebrewVfsDeferredPackageCollection(
      selection,
      [`${TAP_NAME}/dash`, `${TAP_NAME}/coreutils`],
      [`${TAP_NAME}/dash`, `${TAP_NAME}/dash`],
    )).toThrow("deferred tree package bindings contains a duplicate package");
  });

  it("rejects open-ended, duplicate, and internally inconsistent policies", () => {
    const policy = checkedInPolicy();
    expect(() => parseHomebrewVfsMaterializationPolicy({
      ...policy,
      note: "not part of the signed policy shape",
    })).toThrow("policy has unexpected or missing fields");
    expect(() => parseHomebrewVfsMaterializationPolicy({
      ...policy,
      embedded_roots: [policy.embedded_roots[0], policy.embedded_roots[0]],
    })).toThrow("embedded_roots contains a duplicate package");
    expect(() => parseHomebrewVfsMaterializationPolicy({
      ...policy,
      embedded_package_order: [
        policy.embedded_package_order[0],
        policy.embedded_package_order[0],
      ],
    })).toThrow("embedded_package_order contains a duplicate package");
    expect(() => parseHomebrewVfsMaterializationPolicy({
      ...policy,
      embedded_roots: [`${TAP_NAME}/dash`],
    })).toThrow("root kandelo-dev/tap-core/dash is absent from embedded_package_order");
  });

  it("uses full names for cross-tap dependencies instead of guessing the root tap", () => {
    const plan = shellPlan();
    const thirdPartyName = "third-party/tools/libcxx";
    plan.packages[1] = pkg("libcxx", [], "third-party/tools");
    plan.packages.find((entry) => entry.name === "ncurses")!.dependencies = [
      dependency("libcxx", thirdPartyName),
    ];
    expect(() =>
      selectHomebrewVfsMaterialization(plan, checkedInPolicy())
    ).toThrow("embedded closure differs from the reviewed policy");
  });
});
