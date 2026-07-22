import type {
  HomebrewDependency,
  HomebrewFederatedVfsPlan,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "./homebrew-vfs-planner";

export const HOMEBREW_VFS_MATERIALIZATION_POLICY_KIND =
  "kandelo-homebrew-vfs-materialization-policy" as const;

const FULL_PACKAGE_RE =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const MAX_EMBEDDED_ROOTS = 32;
const MAX_PLAN_PACKAGES = 128;

/**
 * Reviewed partition between package bytes required offline and package bytes
 * that may remain deferred. The exact embedded closure is intentional: a new
 * dependency must be reviewed instead of silently increasing the base image or
 * leaving a default-shell dependency unavailable offline.
 */
export interface HomebrewVfsMaterializationPolicy {
  schema: 1;
  kind: typeof HOMEBREW_VFS_MATERIALIZATION_POLICY_KIND;
  embedded_roots: string[];
  /** Dependency-first full package names, exactly as they must occur in the plan. */
  embedded_package_order: string[];
}

export interface HomebrewVfsMaterializationSelection {
  embeddedRoots: string[];
  embeddedPackages: HomebrewVfsPackagePlan[];
  deferredPackages: HomebrewVfsPackagePlan[];
}

export function parseHomebrewVfsMaterializationPolicy(
  value: unknown,
): HomebrewVfsMaterializationPolicy {
  const root = exactRecord(
    value,
    ["schema", "kind", "embedded_roots", "embedded_package_order"],
    "Homebrew VFS materialization policy",
  );
  if (
    root.schema !== 1 ||
    root.kind !== HOMEBREW_VFS_MATERIALIZATION_POLICY_KIND
  ) {
    throw new Error("Homebrew VFS materialization policy has an unsupported identity");
  }
  const embeddedRoots = fullPackageArray(
    root.embedded_roots,
    "Homebrew VFS materialization policy embedded_roots",
    MAX_EMBEDDED_ROOTS,
  );
  const embeddedPackageOrder = fullPackageArray(
    root.embedded_package_order,
    "Homebrew VFS materialization policy embedded_package_order",
    MAX_PLAN_PACKAGES,
  );
  const embeddedSet = new Set(embeddedPackageOrder);
  for (const packageName of embeddedRoots) {
    if (!embeddedSet.has(packageName)) {
      throw new Error(
        `Homebrew VFS materialization root ${packageName} is absent from ` +
          "embedded_package_order",
      );
    }
  }
  return {
    schema: 1,
    kind: HOMEBREW_VFS_MATERIALIZATION_POLICY_KIND,
    embedded_roots: embeddedRoots,
    embedded_package_order: embeddedPackageOrder,
  };
}

/**
 * Resolve the embedded dependency closure from the verified package plan and
 * require it to match the reviewed policy exactly. Everything else in the plan
 * is the deferred partition; no package may disappear or belong to both sides.
 */
export function selectHomebrewVfsMaterialization(
  plan: HomebrewVfsPlan,
  policyValue: unknown,
): HomebrewVfsMaterializationSelection {
  const policy = parseHomebrewVfsMaterializationPolicy(policyValue);
  const packages = validatePlan(plan);
  const requested = new Set(requestedFullNames(plan));
  for (const root of policy.embedded_roots) {
    if (!requested.has(root)) {
      throw new Error(
        `Homebrew VFS materialization root ${root} was not explicitly requested`,
      );
    }
  }

  const closure = new Set<string>();
  const visit = (fullName: string): void => {
    if (closure.has(fullName)) return;
    const pkg = packages.get(fullName);
    if (pkg === undefined) {
      throw new Error(`Homebrew VFS materialization root ${fullName} is absent from the plan`);
    }
    closure.add(fullName);
    for (const dependency of pkg.dependencies) {
      visit(dependencyFullName(pkg, dependency));
    }
  };
  for (const root of policy.embedded_roots) visit(root);

  const embeddedPackages = plan.packages.filter((pkg) => closure.has(pkg.fullName));
  const embeddedOrder = embeddedPackages.map((pkg) => pkg.fullName);
  if (!arraysEqual(embeddedOrder, policy.embedded_package_order)) {
    throw new Error(
      "Homebrew VFS materialization embedded closure differs from the reviewed policy: " +
        `actual=${JSON.stringify(embeddedOrder)} ` +
        `expected=${JSON.stringify(policy.embedded_package_order)}`,
    );
  }
  const deferredPackages = plan.packages.filter((pkg) => !closure.has(pkg.fullName));
  if (deferredPackages.length === 0) {
    throw new Error("Homebrew VFS materialization policy leaves no deferred packages");
  }
  if (
    embeddedPackages.length + deferredPackages.length !== plan.packages.length ||
    new Set([...embeddedPackages, ...deferredPackages].map((pkg) => pkg.fullName)).size !==
      plan.packages.length
  ) {
    throw new Error("Homebrew VFS materialization partition is inconsistent");
  }
  return {
    embeddedRoots: [...policy.embedded_roots],
    embeddedPackages,
    deferredPackages,
  };
}

/** Project the full reviewed plan into the exact eager base-image plan. */
export function projectEmbeddedHomebrewVfsPlan(
  plan: HomebrewVfsPlan,
  selection: HomebrewVfsMaterializationSelection,
): HomebrewVfsPlan {
  const packageByFullName = new Map(plan.packages.map((pkg) => [pkg.fullName, pkg]));
  const roots = selection.embeddedRoots.map((fullName) => {
    const pkg = packageByFullName.get(fullName);
    if (pkg === undefined) {
      throw new Error(`Homebrew VFS embedded root ${fullName} is absent from the plan`);
    }
    return pkg.name;
  });
  const projected: HomebrewVfsPlan = {
    ...plan,
    requestedPackages: roots,
    packages: [...selection.embeddedPackages],
  };
  if ("requestedFullNames" in plan) {
    (projected as HomebrewFederatedVfsPlan).requestedFullNames = [
      ...selection.embeddedRoots,
    ];
  }
  return projected;
}

/**
 * Bind a direct deferred-tree collection to the selected package partition.
 * Package order remains dependency order, while tree order is independently
 * canonical; ownership therefore comes only from each tree's explicit full
 * package name.
 */
export function assertHomebrewVfsDeferredPackageCollection(
  selection: HomebrewVfsMaterializationSelection,
  layerPackageOrderValue: unknown,
  treePackageBindingsValue: unknown,
): void {
  const layerPackageOrder = fullPackageArray(
    layerPackageOrderValue,
    "Homebrew VFS deferred layer package order",
    MAX_PLAN_PACKAGES,
  );
  const expectedOrder = selection.deferredPackages.map((pkg) => pkg.fullName);
  if (!arraysEqual(layerPackageOrder, expectedOrder)) {
    throw new Error(
      "Homebrew VFS deferred layer package order differs from the selected partition: " +
        `actual=${JSON.stringify(layerPackageOrder)} ` +
        `expected=${JSON.stringify(expectedOrder)}`,
    );
  }
  const treePackageBindings = fullPackageArray(
    treePackageBindingsValue,
    "Homebrew VFS deferred tree package bindings",
    MAX_PLAN_PACKAGES,
  );
  if (treePackageBindings.length !== expectedOrder.length) {
    throw new Error(
      `Homebrew VFS deferred tree count ${treePackageBindings.length} differs from ` +
        `the deferred package count ${expectedOrder.length}`,
    );
  }
  const expected = new Set(expectedOrder);
  const actual = new Set(treePackageBindings);
  const missing = expectedOrder.filter((name) => !actual.has(name));
  const unexpected = treePackageBindings.filter((name) => !expected.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      "Homebrew VFS deferred trees do not bind one-to-one to deferred packages: " +
        `missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }
}

function validatePlan(plan: HomebrewVfsPlan): Map<string, HomebrewVfsPackagePlan> {
  if (plan.packages.length === 0) {
    throw new Error("Homebrew VFS materialization plan has no packages");
  }
  const packages = new Map<string, HomebrewVfsPackagePlan>();
  const indexByFullName = new Map<string, number>();
  for (const [index, pkg] of plan.packages.entries()) {
    fullPackageName(pkg.fullName, `Homebrew VFS materialization package ${index}`);
    if (packages.has(pkg.fullName)) {
      throw new Error(`Homebrew VFS materialization plan duplicates ${pkg.fullName}`);
    }
    packages.set(pkg.fullName, pkg);
    indexByFullName.set(pkg.fullName, index);
  }
  for (const [index, pkg] of plan.packages.entries()) {
    const dependencies = pkg.dependencies.map((dependency) =>
      dependencyFullName(pkg, dependency)
    );
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(
        `Homebrew VFS materialization package ${pkg.fullName} duplicates a dependency`,
      );
    }
    for (const dependency of dependencies) {
      const dependencyIndex = indexByFullName.get(dependency);
      if (dependencyIndex === undefined) {
        throw new Error(
          `Homebrew VFS materialization package ${pkg.fullName} depends on missing ` +
            dependency,
        );
      }
      if (dependencyIndex >= index) {
        throw new Error(
          `Homebrew VFS materialization plan is not dependency-first at ${pkg.fullName}`,
        );
      }
    }
  }
  return packages;
}

function requestedFullNames(plan: HomebrewVfsPlan): string[] {
  const federated = plan as HomebrewVfsPlan & { requestedFullNames?: unknown };
  if (federated.requestedFullNames !== undefined) {
    if (
      !Array.isArray(federated.requestedFullNames) ||
      federated.requestedFullNames.length !== plan.requestedPackages.length ||
      federated.requestedFullNames.some((value) =>
        typeof value !== "string" || !FULL_PACKAGE_RE.test(value)
      )
    ) {
      throw new Error("Homebrew VFS materialization plan has invalid federated roots");
    }
    if (new Set(federated.requestedFullNames).size !== federated.requestedFullNames.length) {
      throw new Error("Homebrew VFS materialization plan duplicates a requested package");
    }
    return [...federated.requestedFullNames] as string[];
  }
  const values = plan.requestedPackages.map((name, index) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error(`Homebrew VFS materialization requested package ${index} is invalid`);
    }
    return `${plan.tapName}/${name}`;
  });
  if (new Set(values).size !== values.length) {
    throw new Error("Homebrew VFS materialization plan duplicates a requested package");
  }
  return values;
}

function dependencyFullName(
  pkg: HomebrewVfsPackagePlan,
  dependency: HomebrewDependency,
): string {
  const fullName = dependency.full_name ?? `${pkg.tapName}/${dependency.name}`;
  return fullPackageName(
    fullName,
    `Homebrew VFS materialization dependency of ${pkg.fullName}`,
  );
}

function fullPackageArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new Error(`${label} must contain 1 to ${max} package names`);
  }
  const packages = value.map((item, index) =>
    fullPackageName(item, `${label}[${index}]`)
  );
  if (new Set(packages).size !== packages.length) {
    throw new Error(`${label} contains a duplicate package`);
  }
  return packages;
}

function fullPackageName(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_PACKAGE_RE.test(value)) {
    throw new Error(`${label} is not a canonical full package name`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!arraysEqual(actual, expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
