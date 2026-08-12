import type { HomebrewVfsPlan } from "./homebrew-vfs-planner";

const FULL_FORMULA_RE =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RUNTIME_ID = "homebrew-runtime-support";
export const HOMEBREW_FLAT_RUNTIME_SUPPORT_POLICY_KIND =
  "kandelo-homebrew-flat-runtime-support-policy" as const;
// WHY: a distinct keg-only Formula identity lets the independent canary live
// beside the core `m4` Formula. The canary payload still installs `bin/m4`.
const LIFECYCLE_CANARY_FORMULA = "m4-canary" as const;

export interface HomebrewRuntimeSupportContract {
  id: typeof RUNTIME_ID;
  catalog: {
    tapRepository: string;
    tapName: string;
    tapCommit: string;
  };
  formulaRoots: string[];
  formulaOrder: string[];
  baseFormulaOrder: string[];
  additionalFormulaOrder: string[];
  activation: {
    capability: "homebrew:runtime";
    root: "/usr/bin/brew";
    atomicGroup: typeof RUNTIME_ID;
  };
  deferredRelocationFormulae: string[];
  lifecycleInstall: {
    tap: "brandonpayton/kandelo-canary";
    repository: "brandonpayton/homebrew-kandelo-canary";
    revision: string;
    formula: typeof LIFECYCLE_CANARY_FORMULA;
  };
}

/**
 * The flat-selection-relative runtime policy deliberately contains only the
 * role roots and activation transaction. Bottle identity is owned solely by
 * the active flat selection, so no campaign, tap, catalog, or lock evidence
 * can enter this policy.
 */
export interface HomebrewFlatRuntimeSupportPolicy {
  readonly schema: 1;
  readonly kind: typeof HOMEBREW_FLAT_RUNTIME_SUPPORT_POLICY_KIND;
  readonly id: typeof RUNTIME_ID;
  readonly bootstrapPackage: string;
  readonly runtimeRoots: readonly string[];
  readonly activation: Readonly<{
    mode: "boot-prefetch";
    capability: "homebrew:runtime";
    root: "/usr/bin/brew";
    atomicGroup: typeof RUNTIME_ID;
  }>;
}

/** Parse the closed, selection-relative policy used for lazy shell roles. */
export function parseHomebrewRuntimeSupportPolicy(
  value: unknown,
): HomebrewFlatRuntimeSupportPolicy {
  const root = exactPolicyRecord(value, [
    "schema",
    "kind",
    "id",
    "bootstrap_package",
    "runtime_roots",
    "activation",
  ], "Homebrew flat runtime-support policy");
  if (
    root.schema !== 1 ||
    root.kind !== HOMEBREW_FLAT_RUNTIME_SUPPORT_POLICY_KIND ||
    root.id !== RUNTIME_ID
  ) {
    throw new Error("Homebrew flat runtime-support policy has an unsupported identity");
  }
  const bootstrapPackage = formula(
    root.bootstrap_package,
    "Homebrew flat runtime-support bootstrap_package",
  );
  const runtimeRoots = formulaArray(
    root.runtime_roots,
    "Homebrew flat runtime-support runtime_roots",
  );
  const activation = exactPolicyRecord(
    root.activation,
    ["mode", "capability", "root", "atomic_group"],
    "Homebrew flat runtime-support activation",
  );
  if (
    activation.mode !== "boot-prefetch" ||
    activation.capability !== "homebrew:runtime" ||
    activation.root !== "/usr/bin/brew" ||
    activation.atomic_group !== RUNTIME_ID
  ) {
    throw new Error("Homebrew flat runtime-support activation is unsupported");
  }
  return deepFreeze({
    schema: 1,
    kind: HOMEBREW_FLAT_RUNTIME_SUPPORT_POLICY_KIND,
    id: RUNTIME_ID,
    bootstrapPackage,
    runtimeRoots: [...runtimeRoots],
    activation: {
      mode: "boot-prefetch",
      capability: "homebrew:runtime",
      root: "/usr/bin/brew",
      atomicGroup: RUNTIME_ID,
    },
  });
}

/**
 * Parse the product contract used by the image builder.
 *
 * The JavaScript audit verifies every explanatory field and catalog bottle
 * identity. This parser independently closes the fields that can change the
 * runtime namespace, activation transaction, or supported relocation surface.
 */
export function parseHomebrewRuntimeSupportContract(
  value: unknown,
): HomebrewRuntimeSupportContract {
  const root = record(value, "Homebrew runtime-support contract");
  if (
    root.schema !== 1 ||
    root.kind !== "kandelo-homebrew-runtime-support-layer" ||
    root.id !== RUNTIME_ID
  ) {
    throw new Error(
      "Homebrew runtime-support contract has an unsupported identity",
    );
  }
  const catalog = record(root.catalog, "Homebrew runtime-support catalog");
  const tapRepository = repository(
    catalog.tap_repository,
    "Homebrew runtime-support tap repository",
  );
  const tapName = repository(
    catalog.tap_name,
    "Homebrew runtime-support tap name",
  );
  const tapCommit = gitSha(
    catalog.tap_commit,
    "Homebrew runtime-support tap commit",
  );

  const baseFormulaOrder = formulaArray(
    root.base_formula_order,
    "Homebrew runtime-support base Formula order",
  );
  const formulaOrder = formulaArray(
    root.formula_order,
    "Homebrew runtime-support Formula order",
  );
  const additionalFormulaOrder = formulaArray(
    root.additional_formula_order,
    "Homebrew runtime-support additional Formula order",
  );
  if (
    JSON.stringify(additionalFormulaOrder) !==
    JSON.stringify(
      formulaOrder.filter((name) => !baseFormulaOrder.includes(name)),
    )
  ) {
    throw new Error(
      "Homebrew runtime-support additional Formula order is not the base-relative closure",
    );
  }

  if (!Array.isArray(root.formula_roots) || root.formula_roots.length === 0) {
    throw new Error("Homebrew runtime-support roots are missing");
  }
  const formulaRoots = root.formula_roots.map((entry, index) => {
    const item = record(entry, `Homebrew runtime-support root ${index}`);
    return formula(
      item.package,
      `Homebrew runtime-support root ${index} package`,
    );
  });
  unique(formulaRoots, "Homebrew runtime-support roots");
  if (formulaRoots.some((name) => !formulaOrder.includes(name))) {
    throw new Error("Homebrew runtime-support closure omits a root");
  }

  const activation = record(
    root.activation,
    "Homebrew runtime-support activation",
  );
  if (
    activation.mode !== "first-use-atomic" ||
    JSON.stringify(activation.roots) !== JSON.stringify(["/usr/bin/brew"]) ||
    activation.capability !== "homebrew:runtime" ||
    activation.base_image_default !== "deferred"
  ) {
    throw new Error(
      "Homebrew runtime support must be one deferred atomic /usr/bin/brew activation",
    );
  }

  if (!Array.isArray(root.deferred_formulae)) {
    throw new Error("Homebrew runtime-support deferred Formulae are missing");
  }
  const deferredRelocationFormulae = root.deferred_formulae.map(
    (entry, index) => {
      const item = record(
        entry,
        `Homebrew runtime-support deferred Formula ${index}`,
      );
      if (
        item.current_state !== "public-abi41-only" ||
        typeof item.reason !== "string" ||
        item.reason.length === 0 ||
        typeof item.reentry_gate !== "string" ||
        item.reentry_gate.length === 0
      ) {
        throw new Error(
          `Homebrew runtime-support deferred Formula ${index} is invalid`,
        );
      }
      return formula(
        item.package,
        `Homebrew runtime-support deferred Formula ${index} package`,
      );
    },
  );
  unique(
    deferredRelocationFormulae,
    "Homebrew runtime-support deferred Formulae",
  );
  if (deferredRelocationFormulae.some((name) => formulaOrder.includes(name))) {
    throw new Error(
      "Homebrew runtime support cannot both admit and defer one Formula",
    );
  }

  const availability = record(
    root.availability,
    "Homebrew runtime-support availability",
  );
  const audited = record(
    availability.audited_catalog,
    "Homebrew runtime-support audited catalog",
  );
  if (
    audited.checkout_commit !== tapCommit ||
    audited.kandelo_abi !== 42 ||
    audited.required_arch !== "wasm32" ||
    audited.release_tag !== "bottles-abi-v42" ||
    !GIT_SHA_RE.test(String(audited.kandelo_commit)) ||
    !GIT_SHA_RE.test(String(audited.metadata_tap_commit)) ||
    !SHA256_RE.test(String(audited.metadata_sha256)) ||
    JSON.stringify(availability.requires_rebuild) !== "[]" ||
    JSON.stringify(availability.missing_metadata) !== "[]" ||
    JSON.stringify(availability.can_be_deferred) !==
      JSON.stringify(deferredRelocationFormulae)
  ) {
    throw new Error(
      "Homebrew runtime-support availability is not a complete admitted ABI-42 closure",
    );
  }

  if (
    !Array.isArray(root.lifecycle_installs) ||
    root.lifecycle_installs.length !== 1
  ) {
    throw new Error(
      "Homebrew runtime support must declare one third-party lifecycle install",
    );
  }
  const lifecycleInstall = record(
    root.lifecycle_installs[0],
    "Homebrew runtime-support lifecycle install",
  );
  if (
    lifecycleInstall.tap !== "brandonpayton/kandelo-canary" ||
    lifecycleInstall.repository !== "brandonpayton/homebrew-kandelo-canary" ||
    lifecycleInstall.formula !== LIFECYCLE_CANARY_FORMULA ||
    lifecycleInstall.phase !== "guest-lifecycle" ||
    lifecycleInstall.image_closure !== false ||
    typeof lifecycleInstall.reason !== "string" ||
    lifecycleInstall.reason.length === 0
  ) {
    throw new Error(
      "Homebrew runtime support has an invalid third-party lifecycle install",
    );
  }
  const lifecycleRevision = gitSha(
    lifecycleInstall.revision,
    "Homebrew runtime-support lifecycle revision",
  );

  return {
    id: RUNTIME_ID,
    catalog: { tapRepository, tapName, tapCommit },
    formulaRoots,
    formulaOrder,
    baseFormulaOrder,
    additionalFormulaOrder,
    activation: {
      capability: "homebrew:runtime",
      root: "/usr/bin/brew",
      atomicGroup: RUNTIME_ID,
    },
    deferredRelocationFormulae,
    lifecycleInstall: {
      tap: "brandonpayton/kandelo-canary",
      repository: "brandonpayton/homebrew-kandelo-canary",
      revision: lifecycleRevision,
      formula: LIFECYCLE_CANARY_FORMULA,
    },
  };
}

/** Bind the parsed contract to both immutable planner outputs. */
export function assertHomebrewRuntimeSupportPlan(
  contract: HomebrewRuntimeSupportContract,
  basePlan: HomebrewVfsPlan,
  supportPlan: HomebrewVfsPlan,
): void {
  const baseOrder = basePlan.packages.map((pkg) => pkg.fullName);
  const supportOrder = supportPlan.packages.map((pkg) => pkg.fullName);
  if (
    contract.catalog.tapRepository !== supportPlan.tapRepository ||
    contract.catalog.tapName !== supportPlan.tapName ||
    basePlan.tapRepository !== supportPlan.tapRepository ||
    basePlan.tapName !== supportPlan.tapName ||
    basePlan.tapCommit !== supportPlan.tapCommit ||
    basePlan.kandeloCommit !== supportPlan.kandeloCommit ||
    JSON.stringify(baseOrder) !== JSON.stringify(contract.baseFormulaOrder) ||
    JSON.stringify(supportOrder) !== JSON.stringify(contract.formulaOrder) ||
    supportPlan.kandeloAbi !== 42 ||
    supportPlan.packages.some(
      (pkg) =>
        pkg.arch !== "wasm32" ||
        pkg.sourceStatus !== "success" ||
        pkg.metadataStatus !== "success",
    )
  ) {
    throw new Error(
      "Homebrew runtime-support plan differs from its exact base/catalog contract",
    );
  }
}

/**
 * Produce only the support trees absent from the base shell contract.
 *
 * The current reviewed contract adds 18 trees, but deriving the boundary from
 * the contract keeps a future catalog update from silently disagreeing with
 * the runtime implementation.
 */
export function projectHomebrewRuntimeSupportDelta(
  contract: HomebrewRuntimeSupportContract,
  plan: HomebrewVfsPlan,
): HomebrewVfsPlan {
  const additional = new Set(contract.additionalFormulaOrder);
  const packages = plan.packages.filter((pkg) => additional.has(pkg.fullName));
  if (
    packages.length !== contract.additionalFormulaOrder.length ||
    JSON.stringify(packages.map((pkg) => pkg.fullName)) !==
      JSON.stringify(contract.additionalFormulaOrder)
  ) {
    throw new Error(
      "Homebrew runtime-support plan cannot produce its exact contract delta",
    );
  }
  return { ...plan, packages };
}

function record(value: unknown, label: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

function exactPolicyRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return value as Record<string, unknown>;
}

function formulaArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  const result = value.map((entry, index) =>
    formula(entry, `${label} ${index}`),
  );
  unique(result, label);
  return result;
}

function formula(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_FORMULA_RE.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function repository(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA_RE.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
