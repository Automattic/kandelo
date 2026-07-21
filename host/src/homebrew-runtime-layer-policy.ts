import type {
  HomebrewDependency,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "./homebrew-vfs-planner";

export const HOMEBREW_RUNTIME_LAYER_POLICY_KIND =
  "kandelo-homebrew-runtime-layer-policy" as const;

const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const LAYER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const FULL_PACKAGE_RE =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const MAX_RUNTIME_LAYERS = 16;

export interface HomebrewRuntimeLayerPolicyEntry {
  id: string;
  root_package: string;
}

/**
 * Reviewed selection policy for independently composable runtime layers.
 *
 * The policy names package roots, not archive paths. The selected package
 * closure is still resolved from immutable Homebrew sidecars and verified
 * link manifests. `base_package` identifies the package-system artifact whose
 * Homebrew composition owns the lower filesystem.
 */
export interface HomebrewRuntimeLayerPolicy {
  schema: 1;
  kind: typeof HOMEBREW_RUNTIME_LAYER_POLICY_KIND;
  base_package: string;
  layers: HomebrewRuntimeLayerPolicyEntry[];
}

/**
 * Canonical package-output identity projected from the already parsed lower
 * image receipt. The lazy-layer builder remains responsible for verifying the
 * receipt hashes and the exact bottle identities in its composition.
 */
export interface HomebrewRuntimeLayerBasePackageSourceIdentity {
  schema: 1;
  kind: "kandelo-package-output";
  package: { name: string };
  output: { name: string };
}

export interface HomebrewRuntimeLayerBaseClosure {
  source: HomebrewRuntimeLayerBasePackageSourceIdentity;
  packageOrder: readonly string[];
}

export interface HomebrewRuntimeLayerSelection {
  id: string;
  rootPackage: string;
  /** Complete dependency-first closure for this one runtime root. */
  packages: HomebrewVfsPackagePlan[];
  /** Members reused by full package name from the verified lower composition. */
  basePackages: HomebrewVfsPackagePlan[];
  /** Exact members that the runtime layer must pour. */
  layerPackages: HomebrewVfsPackagePlan[];
}

/**
 * Parse the closed, bounded policy schema without evaluating tap code.
 */
export function parseHomebrewRuntimeLayerPolicy(
  value: unknown,
): HomebrewRuntimeLayerPolicy {
  const root = exactRecord(
    value,
    ["schema", "kind", "base_package", "layers"],
    "Homebrew runtime layer policy",
  );
  if (root.schema !== 1 || root.kind !== HOMEBREW_RUNTIME_LAYER_POLICY_KIND) {
    throw new Error("Homebrew runtime layer policy has an unsupported identity");
  }
  const basePackage = packageName(
    root.base_package,
    "Homebrew runtime layer base package",
  );
  if (!Array.isArray(root.layers)) {
    throw new Error("Homebrew runtime layer policy layers must be an array");
  }
  if (root.layers.length === 0 || root.layers.length > MAX_RUNTIME_LAYERS) {
    throw new Error(
      `Homebrew runtime layer policy must contain 1 to ${MAX_RUNTIME_LAYERS} layers`,
    );
  }

  const layers = root.layers.map((value, index) => {
    const entry = exactRecord(
      value,
      ["id", "root_package"],
      `Homebrew runtime layer policy entry ${index}`,
    );
    if (typeof entry.id !== "string" || !LAYER_ID_RE.test(entry.id)) {
      throw new Error(`Homebrew runtime layer policy entry ${index} has an invalid id`);
    }
    if (
      typeof entry.root_package !== "string" ||
      !FULL_PACKAGE_RE.test(entry.root_package)
    ) {
      throw new Error(
        `Homebrew runtime layer policy entry ${index} has an invalid root package`,
      );
    }
    return { id: entry.id, root_package: entry.root_package };
  });

  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const entry of layers) {
    if (ids.has(entry.id)) {
      throw new Error(`Homebrew runtime layer policy duplicates id ${entry.id}`);
    }
    if (roots.has(entry.root_package)) {
      throw new Error(
        `Homebrew runtime layer policy duplicates root ${entry.root_package}`,
      );
    }
    ids.add(entry.id);
    roots.add(entry.root_package);
  }
  const sortedIds = [...ids].sort(compareText);
  if (layers.some((entry, index) => entry.id !== sortedIds[index])) {
    throw new Error("Homebrew runtime layer policy entries are not in canonical id order");
  }

  return {
    schema: 1,
    kind: HOMEBREW_RUNTIME_LAYER_POLICY_KIND,
    base_package: basePackage,
    layers,
  };
}

/**
 * Select all independently composable runtime closures from one verified plan.
 *
 * Each runtime root must be an explicit plan root. Packages already owned by
 * the lower shell composition are removed from that runtime's delta. The root
 * itself must remain in the delta, which also makes an empty layer impossible.
 * Non-base packages may belong to only one runtime layer; otherwise applying
 * those layers in arbitrary combinations could double-own the same keg.
 */
export function selectHomebrewRuntimeLayers(
  plan: HomebrewVfsPlan,
  base: HomebrewRuntimeLayerBaseClosure,
  policyValue: unknown,
): HomebrewRuntimeLayerSelection[] {
  const policy = parseHomebrewRuntimeLayerPolicy(policyValue);
  const context = selectionContext(plan, base, policy);
  return selectPolicyEntries(policy.layers, context);
}

function selectPolicyEntries(
  entries: HomebrewRuntimeLayerPolicyEntry[],
  context: SelectionContext,
): HomebrewRuntimeLayerSelection[] {
  const selections = entries.map((entry) =>
    selectPolicyEntry(entry, context)
  );
  const ownerByLayerPackage = new Map<string, string>();
  for (const selection of selections) {
    for (const pkg of selection.layerPackages) {
      const previous = ownerByLayerPackage.get(pkg.fullName);
      if (previous !== undefined) {
        throw new Error(
          `Homebrew runtime layers ${previous} and ${selection.id} share ` +
            `non-base package ${pkg.fullName}`,
        );
      }
      ownerByLayerPackage.set(pkg.fullName, selection.id);
    }
  }
  return selections;
}

/** Select and validate one named entry from the same policy contract. */
export function selectHomebrewRuntimeLayer(
  plan: HomebrewVfsPlan,
  base: HomebrewRuntimeLayerBaseClosure,
  policyValue: unknown,
  id: string,
): HomebrewRuntimeLayerSelection {
  const policy = parseHomebrewRuntimeLayerPolicy(policyValue);
  const entry = policy.layers.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`Homebrew runtime layer policy does not define ${id}`);
  }
  const selections = selectPolicyEntries(
    policy.layers,
    selectionContext(plan, base, policy),
  );
  return selections.find((selection) => selection.id === entry.id)!;
}

interface SelectionContext {
  plan: HomebrewVfsPlan;
  packages: Map<string, HomebrewVfsPackagePlan>;
  dependencies: Map<string, string[]>;
  requestedPackages: Set<string>;
  basePackages: Set<string>;
}

function selectionContext(
  plan: HomebrewVfsPlan,
  base: HomebrewRuntimeLayerBaseClosure,
  policy: HomebrewRuntimeLayerPolicy,
): SelectionContext {
  const source = base.source as unknown;
  if (
    typeof source !== "object" ||
    source === null ||
    Array.isArray(source) ||
    (source as Record<string, unknown>).schema !== 1 ||
    (source as Record<string, unknown>).kind !== "kandelo-package-output"
  ) {
    throw new Error(
      "Homebrew runtime layer base package source has an unsupported identity",
    );
  }
  const sourceRecord = source as Record<string, unknown>;
  const sourcePackage = sourceRecord.package as Record<string, unknown> | undefined;
  const sourceOutput = sourceRecord.output as Record<string, unknown> | undefined;
  const sourcePackageName = sourcePackage?.name;
  const sourceOutputName = sourceOutput?.name;
  if (
    sourcePackageName !== policy.base_package ||
    sourceOutputName !== policy.base_package
  ) {
    throw new Error(
      `Homebrew runtime layer policy requires base package ` +
        `${policy.base_package}, got package ${String(sourcePackageName)} ` +
        `and output ${String(sourceOutputName)}`,
    );
  }
  const basePackages = uniqueFullPackageSet(
    base.packageOrder,
    "Homebrew runtime layer base closure",
  );
  const packages = new Map<string, HomebrewVfsPackagePlan>();
  const packageIndex = new Map<string, number>();
  for (const [index, pkg] of plan.packages.entries()) {
    if (!FULL_PACKAGE_RE.test(pkg.fullName)) {
      throw new Error(`Homebrew runtime layer plan has invalid package ${pkg.fullName}`);
    }
    if (packages.has(pkg.fullName)) {
      throw new Error(`Homebrew runtime layer plan duplicates package ${pkg.fullName}`);
    }
    packages.set(pkg.fullName, pkg);
    packageIndex.set(pkg.fullName, index);
  }
  if (packages.size === 0) {
    throw new Error("Homebrew runtime layer plan has no packages");
  }

  const dependencies = new Map<string, string[]>();
  for (const [index, pkg] of plan.packages.entries()) {
    const fullNames = pkg.dependencies.map((dependency) =>
      dependencyFullName(pkg, dependency)
    );
    if (new Set(fullNames).size !== fullNames.length) {
      throw new Error(
        `Homebrew runtime layer package ${pkg.fullName} has duplicate dependencies`,
      );
    }
    for (const dependency of fullNames) {
      const dependencyIndex = packageIndex.get(dependency);
      if (dependencyIndex === undefined) {
        throw new Error(
          `Homebrew runtime layer package ${pkg.fullName} depends on missing ${dependency}`,
        );
      }
      if (dependencyIndex >= index) {
        throw new Error(
          `Homebrew runtime layer plan is not dependency-first at ${pkg.fullName}`,
        );
      }
    }
    dependencies.set(pkg.fullName, fullNames);
  }

  const requestedPackages = new Set(requestedFullNames(plan));
  if (requestedPackages.size !== plan.requestedPackages.length) {
    throw new Error("Homebrew runtime layer plan duplicates requested packages");
  }
  return { plan, packages, dependencies, requestedPackages, basePackages };
}

function selectPolicyEntry(
  entry: HomebrewRuntimeLayerPolicyEntry,
  context: SelectionContext,
): HomebrewRuntimeLayerSelection {
  const root = context.packages.get(entry.root_package);
  if (root === undefined) {
    throw new Error(
      `Homebrew runtime layer ${entry.id} root ${entry.root_package} is absent from the plan`,
    );
  }
  if (!context.requestedPackages.has(entry.root_package)) {
    throw new Error(
      `Homebrew runtime layer ${entry.id} root ${entry.root_package} was not explicitly requested`,
    );
  }

  const closure = new Set<string>();
  const visit = (fullName: string): void => {
    if (closure.has(fullName)) return;
    closure.add(fullName);
    for (const dependency of context.dependencies.get(fullName) ?? []) visit(dependency);
  };
  visit(root.fullName);

  const packages = context.plan.packages.filter((pkg) => closure.has(pkg.fullName));
  const basePackages = packages.filter((pkg) =>
    context.basePackages.has(pkg.fullName)
  );
  const layerPackages = packages.filter((pkg) =>
    !context.basePackages.has(pkg.fullName)
  );
  if (context.basePackages.has(root.fullName)) {
    throw new Error(
      `Homebrew runtime layer ${entry.id} root ${root.fullName} is already owned by the base`,
    );
  }
  if (layerPackages.length === 0) {
    throw new Error(`Homebrew runtime layer ${entry.id} has an empty package delta`);
  }

  return {
    id: entry.id,
    rootPackage: entry.root_package,
    packages,
    basePackages,
    layerPackages,
  };
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
      throw new Error("Homebrew runtime layer plan has invalid federated roots");
    }
    return [...federated.requestedFullNames] as string[];
  }
  return plan.requestedPackages.map((name) => {
    packageName(name, "Homebrew runtime layer requested package");
    return `${plan.tapName}/${name}`;
  });
}

function dependencyFullName(
  pkg: HomebrewVfsPackagePlan,
  dependency: HomebrewDependency,
): string {
  const fullName = dependency.full_name ?? `${pkg.tapName}/${dependency.name}`;
  if (!FULL_PACKAGE_RE.test(fullName)) {
    throw new Error(
      `Homebrew runtime layer package ${pkg.fullName} has invalid dependency ${fullName}`,
    );
  }
  return fullName;
}

function uniqueFullPackageSet(values: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (!FULL_PACKAGE_RE.test(value)) {
      throw new Error(`${label} has invalid package ${value}`);
    }
    if (result.has(value)) {
      throw new Error(`${label} duplicates package ${value}`);
    }
    result.add(value);
  }
  if (result.size === 0) throw new Error(`${label} is empty`);
  return result;
}

function packageName(value: unknown, label: string): string {
  if (typeof value !== "string" || !PACKAGE_NAME_RE.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareText);
  const expected = [...fields].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
