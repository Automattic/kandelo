#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkMainShellProjection } from "./vfs-product-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tapRepository = "kandelo-dev/homebrew-tap-core";
const tapName = "kandelo-dev/tap-core";
const gitShaPattern = /^[0-9a-f]{40}$/;
const formulaIdentityPattern = /^kandelo-dev\/tap-core\/[a-z0-9][a-z0-9._-]*$/;
const provenanceDigestFlag = "--print-runtime-bottle-provenance-sha256";
const provenanceDigestDomain =
  "kandelo-homebrew-runtime-bottle-provenance-v1\u0000";

if (process.argv[2] === provenanceDigestFlag) {
  if (process.argv.length !== 5) {
    throw new Error(
      `usage: check-homebrew-main-shell-brewfile.mjs ${provenanceDigestFlag} ` +
        "<metadata.json> <runtime-support.json>",
    );
  }
  console.log(
    computeRuntimeBottleProvenanceFromFiles(
      resolve(process.argv[3]),
      resolve(process.argv[4]),
    ),
  );
  process.exit(0);
}

const brewfile = resolve(
  process.argv[2] ?? `${repoRoot}/homebrew/main-shell.Brewfile`,
);
const lockPath = resolve(
  process.argv[3] ?? `${repoRoot}/homebrew/main-shell-migration-lock.json`,
);
const metadataPath = process.argv[4] ? resolve(process.argv[4]) : undefined;
const runtimeSupportPath = resolve(
  process.argv[5] ??
    `${repoRoot}/homebrew/main-shell-homebrew-runtime-support.json`,
);
const productCatalogPath = resolve(
  process.argv[6] ?? `${repoRoot}/images/vfs/products/generated/catalog.json`,
);
const materializationPath = resolve(
  process.argv[7] ??
    `${repoRoot}/homebrew/main-shell-materialization-policy.json`,
);
const lock = readMigrationLock(lockPath);
const runtimeSupport = readRuntimeSupport(runtimeSupportPath, lock);
const shellDependencies = readDependencies(
  `${repoRoot}/packages/registry/shell/package.toml`,
);
// Formulae and Homebrew's source tree come from the same immutable closed
// selection. A registry dependency here would let the canonical package use
// different bytes than the direct product proof.
assertExactSequence(
  shellDependencies,
  [],
  "the canonical shell package must not depend on transitional registry packages",
  ({ name, version }) => `${name}@${version}`,
);
const lockedRegistryPackages = lock.packages.map(({ registry }) => registry);
const expectedFormulae = lock.packages.map(({ formula }) => formula.name);
const actualFormulae = readBrewfilePackages(brewfile);

assertUnique(
  lockedRegistryPackages.map(({ name }) => name),
  "migration lock registry roots",
);
assertUnique(expectedFormulae, "migration lock Formulae");
assertUnique(actualFormulae, "main-shell Brewfile");
assertExactSequence(
  actualFormulae,
  expectedFormulae,
  "main-shell Brewfile does not match the migration lock",
  (value) => value,
);
checkMainShellProjection({
  catalogPath: productCatalogPath,
  brewfilePath: brewfile,
  runtimeSupportPath,
  materializationPath,
});
validateReviewedSubstitutions(lock);
validateCompatibilityPolicy(lock, runtimeSupport);
if (metadataPath !== undefined) {
  validateTapMetadata(lock, runtimeSupport, metadataPath);
}

console.log(
  `Homebrew main-shell contract: ${actualFormulae.length} reviewed migration roots, ` +
    `${lock.formula_closure.length} base Formulae, ` +
    `${runtimeSupport.formulaOrder.length} runtime Formulae, and ` +
    `${runtimeSupport.availability.auditedFormulae.length} audited Formulae; ` +
    `the runtime adds ${runtimeSupport.additionalFormulaOrder.length} beyond the base, ` +
    `yielding ${runtimeSupport.compositionFormulaOrder.length} total Formulae, with ` +
    `${runtimeSupport.deferredFormulae.length} optional Formulae deferred at catalog ` +
    `${lock.catalog.tap_commit}.`,
);

function readMigrationLock(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    value.tap_repository !== tapRepository ||
    value.tap_name !== tapName
  ) {
    throw new Error(
      `invalid main-shell migration lock schema or tap identity: ${path}`,
    );
  }
  if (
    !isRecord(value.catalog) ||
    JSON.stringify(Object.keys(value.catalog).sort()) !==
      JSON.stringify(["tap_commit"]) ||
    typeof value.catalog.tap_commit !== "string" ||
    !gitShaPattern.test(value.catalog.tap_commit)
  ) {
    throw new Error(
      `main-shell migration lock must pin one exact catalog commit: ${path}`,
    );
  }
  if (
    !Array.isArray(value.packages) ||
    !Array.isArray(value.formula_closure) ||
    !Array.isArray(value.reviewed_substitutions)
  ) {
    throw new Error(
      `main-shell migration lock packages/formula_closure/substitutions must be arrays: ${path}`,
    );
  }
  if (
    !isRecord(value.consumer) ||
    value.consumer.profile !== "main-shell" ||
    value.consumer.max_vfs_byte_length !== 512 * 1024 * 1024
  ) {
    throw new Error(
      `main-shell migration lock must declare the 512 MiB consumer profile: ${path}`,
    );
  }
  const packages = value.packages.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !isRecord(entry.registry) ||
      !isRecord(entry.formula)
    ) {
      throw new Error(`invalid migration lock package ${index}`);
    }
    const registry = readIdentity(
      entry.registry,
      `packages[${index}].registry`,
    );
    const formula = readIdentity(entry.formula, `packages[${index}].formula`);
    for (const field of ["revision", "bottle_rebuild"]) {
      if (!Number.isInteger(entry.formula[field]) || entry.formula[field] < 0) {
        throw new Error(
          `packages[${index}].formula.${field} must be a non-negative integer`,
        );
      }
    }
    return {
      registry,
      formula: {
        ...formula,
        revision: entry.formula.revision,
        bottle_rebuild: entry.formula.bottle_rebuild,
      },
    };
  });
  const formulaClosure = value.formula_closure.map((entry, index) =>
    readFormulaIdentity(entry, `formula_closure[${index}]`),
  );
  if (packages.length === 0 || formulaClosure.length === 0) {
    throw new Error(
      `main-shell migration lock must contain roots and a closure: ${path}`,
    );
  }
  assertUnique(formulaClosure, "migration lock formula_closure");
  const missingRoots = packages
    .map(({ formula }) => `${tapName}/${formula.name}`)
    .filter((identity) => !formulaClosure.includes(identity));
  if (missingRoots.length > 0) {
    throw new Error(
      `main-shell migration lock formula_closure omits registry-root Formulae: ` +
        missingRoots.join(", "),
    );
  }
  return { ...value, packages, formula_closure: formulaClosure };
}

function readIdentity(value, label) {
  if (
    typeof value.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.name) ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error(`${label} must contain a valid name and non-empty version`);
  }
  return { name: value.name, version: value.version };
}

function readFormulaIdentity(value, label) {
  if (typeof value !== "string" || !formulaIdentityPattern.test(value)) {
    throw new Error(
      `${label} must be a canonical ${tapName}/<formula> identity`,
    );
  }
  return value;
}

function validateReviewedSubstitutions(lock) {
  const expected = [];
  for (const { registry, formula } of lock.packages) {
    if (registry.name !== formula.name) {
      expected.push({
        kind: "formula_identity",
        registry: `${registry.name}@${registry.version}`,
        formula: `${tapName}/${formula.name}@${formula.version}`,
      });
    }
    if (registry.version !== formula.version) {
      expected.push({
        kind: "version",
        registry: `${registry.name}@${registry.version}`,
        formula: `${tapName}/${formula.name}@${formula.version}`,
      });
    }
  }
  const actual = lock.reviewed_substitutions.map((entry, index) => {
    const label = `reviewed_substitutions[${index}]`;
    if (
      !isRecord(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(["formula", "kind", "reason", "registry"]) ||
      (entry.kind !== "formula_identity" && entry.kind !== "version") ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new Error(`${label} is invalid`);
    }
    return {
      kind: entry.kind,
      registry: readReviewedRegistryIdentity(
        entry.registry,
        `${label}.registry`,
      ),
      formula: readReviewedFormulaIdentity(entry.formula, `${label}.formula`),
    };
  });
  assertUnique(
    actual.map(
      ({ kind, registry, formula }) => `${kind}:${registry}->${formula}`,
    ),
    "reviewed migration substitutions",
  );
  assertExactSequence(
    actual,
    expected,
    "reviewed migration substitutions are incomplete or stale",
    ({ kind, registry, formula }) => `${kind}:${registry}->${formula}`,
  );
}

function readReviewedRegistryIdentity(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a registry name@version identity`);
  }
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${label} must be a registry name@version identity`);
  }
  readIdentity(
    { name: value.slice(0, separator), version: value.slice(separator + 1) },
    label,
  );
  return value;
}

function readReviewedFormulaIdentity(value, label) {
  const prefix = `${tapName}/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(
      `${label} must be a ${tapName}/<formula>@<version> identity`,
    );
  }
  const unqualified = value.slice(prefix.length);
  const separator = unqualified.lastIndexOf("@");
  if (separator <= 0 || separator === unqualified.length - 1) {
    throw new Error(
      `${label} must be a ${tapName}/<formula>@<version> identity`,
    );
  }
  readIdentity(
    {
      name: unqualified.slice(0, separator),
      version: unqualified.slice(separator + 1),
    },
    label,
  );
  return value;
}

function validateCompatibilityPolicy(lock, runtimeSupport) {
  const compatibility = lock.compatibility;
  if (
    !isRecord(compatibility) ||
    Object.keys(compatibility).sort().join("\0") !==
      "aliases\0link_conflict_owners\0mirror_link_manifest_bin\0public_commands\0runtime_state" ||
    !isRecord(compatibility.mirror_link_manifest_bin) ||
    JSON.stringify(compatibility.mirror_link_manifest_bin.targets) !==
      JSON.stringify(["/usr/bin", "/bin"]) ||
    !Array.isArray(compatibility.link_conflict_owners) ||
    !Array.isArray(compatibility.aliases) ||
    !isRecord(compatibility.public_commands) ||
    !Array.isArray(compatibility.runtime_state)
  ) {
    throw new Error("main-shell migration compatibility policy is invalid");
  }

  const lockedPackages = new Set(lock.formula_closure);
  // WHY: the deferred support trees and the embedded base eventually share
  // one Homebrew prefix, so their link collisions and public command aliases
  // need one policy even though support Formulae are absent from the base.
  const consumerNamespacePackages = new Set([
    ...lockedPackages,
    ...runtimeSupport.additionalFormulaOrder,
  ]);
  const conflictTargets = new Set();
  for (const [index, entry] of compatibility.link_conflict_owners.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.target !== "string" ||
      !/^bin\/[a-z0-9][a-z0-9._+-]*$/.test(entry.target) ||
      typeof entry.package !== "string" ||
      !consumerNamespacePackages.has(entry.package) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new Error(
        `compatibility.link_conflict_owners[${index}] is invalid`,
      );
    }
    if (conflictTargets.has(entry.target)) {
      throw new Error(
        `compatibility link conflict target is duplicated: ${entry.target}`,
      );
    }
    conflictTargets.add(entry.target);
  }

  const aliasTargets = new Set();
  for (const [index, entry] of compatibility.aliases.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.package !== "string" ||
      !consumerNamespacePackages.has(entry.package) ||
      (entry.source_kind !== "link" && entry.source_kind !== "keg") ||
      typeof entry.source !== "string" ||
      !/^[a-z0-9][a-z0-9._+-]*(?:\/[a-z0-9][a-z0-9._+-]*)*$/.test(
        entry.source,
      ) ||
      (entry.source_kind === "link" &&
        !/^bin\/[a-z0-9][a-z0-9._+-]*$/.test(entry.source)) ||
      !Array.isArray(entry.targets) ||
      entry.targets.length === 0 ||
      entry.targets.some(
        (target) =>
          typeof target !== "string" ||
          !/^\/(?:[a-z0-9._+-]+\/)*[a-z0-9._+-]+$/.test(target),
      ) ||
      new Set(entry.targets).size !== entry.targets.length
    ) {
      throw new Error(`compatibility.aliases[${index}] is invalid`);
    }
    for (const target of entry.targets) {
      if (aliasTargets.has(target)) {
        throw new Error(`compatibility alias target is duplicated: ${target}`);
      }
      aliasTargets.add(target);
    }
  }

  validatePublicCommands(compatibility.public_commands, lockedPackages);

  const runtimePaths = new Map();
  for (const [index, entry] of compatibility.runtime_state.entries()) {
    const expectedKeys = [
      "gid",
      "kind",
      "mode",
      "path",
      "reason",
      "requires_package",
      "uid",
    ];
    if (entry?.kind === "text_file") expectedKeys.push("contents");
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      typeof entry.requires_package !== "string" ||
      !lockedPackages.has(entry.requires_package) ||
      typeof entry.path !== "string" ||
      !/^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/.test(entry.path) ||
      entry.path === "/etc/kandelo" ||
      entry.path.startsWith("/etc/kandelo/") ||
      entry.path === "/opt/kandelo/homebrew" ||
      entry.path.startsWith("/opt/kandelo/homebrew/") ||
      !["directory", "empty_file", "text_file"].includes(entry.kind) ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o7777 ||
      !Number.isSafeInteger(entry.uid) ||
      entry.uid < 0 ||
      entry.uid > 0x7fff_ffff ||
      !Number.isSafeInteger(entry.gid) ||
      entry.gid < 0 ||
      entry.gid > 0x7fff_ffff ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0 ||
      entry.reason.length > 1024 ||
      (entry.kind === "text_file" &&
        (typeof entry.contents !== "string" ||
          Buffer.byteLength(entry.contents, "utf8") > 65_536))
    ) {
      throw new Error(`compatibility.runtime_state[${index}] is invalid`);
    }
    if (runtimePaths.has(entry.path)) {
      throw new Error(
        `compatibility runtime state path is duplicated: ${entry.path}`,
      );
    }
    runtimePaths.set(entry.path, entry);
  }
  for (const entry of runtimePaths.values()) {
    let ancestor = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    while (ancestor !== "/") {
      const parent = runtimePaths.get(ancestor);
      if (parent !== undefined && parent.kind !== "directory") {
        throw new Error(
          `compatibility runtime state ${parent.path} cannot contain ${entry.path}`,
        );
      }
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/")) || "/";
    }
  }
}

function validatePublicCommands(value, lockedPackages) {
  if (
    Object.keys(value).sort().join("\0") !==
      "mirrored_names\0supporting_paths\0usr_bin_only\0usr_local_bin_only" ||
    !Array.isArray(value.mirrored_names) ||
    !Array.isArray(value.usr_bin_only) ||
    !Array.isArray(value.usr_local_bin_only) ||
    !Array.isArray(value.supporting_paths)
  ) {
    throw new Error("main-shell public command contract is invalid");
  }
  const readNames = (entries, label) => {
    const names = entries.map((entry, index) => {
      if (
        typeof entry !== "string" ||
        (entry !== "[" && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(entry))
      ) {
        throw new Error(`${label}[${index}] is not a command name`);
      }
      return entry;
    });
    assertUnique(names, label);
    assertExactSequence(
      names,
      [...names].sort(),
      `${label} must be sorted`,
      (entry) => entry,
    );
    return names;
  };
  const mirroredNames = readNames(
    value.mirrored_names,
    "public_commands.mirrored_names",
  );
  const usrBinOnly = readNames(
    value.usr_bin_only,
    "public_commands.usr_bin_only",
  );
  const usrLocalBinOnly = readNames(
    value.usr_local_bin_only,
    "public_commands.usr_local_bin_only",
  );
  if (mirroredNames.length === 0) {
    throw new Error("main-shell public command contract cannot be empty");
  }
  assertUnique(
    [...mirroredNames, ...usrBinOnly, ...usrLocalBinOnly],
    "public command names across path cohorts",
  );

  const supportingPaths = new Set();
  for (const [index, entry] of value.supporting_paths.entries()) {
    const label = `public_commands.supporting_paths[${index}]`;
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !== "kind\0package\0path\0reason" ||
      typeof entry.package !== "string" ||
      !lockedPackages.has(entry.package) ||
      typeof entry.path !== "string" ||
      !/^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/.test(entry.path) ||
      (entry.kind !== "file" && entry.kind !== "directory") ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new Error(`${label} is invalid`);
    }
    if (supportingPaths.has(entry.path)) {
      throw new Error(`supporting path is duplicated: ${entry.path}`);
    }
    supportingPaths.add(entry.path);
  }
}

function validateTapMetadata(lock, runtimeSupport, path) {
  const metadataBytes = readFileSync(path);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const auditedCatalog = runtimeSupport.availability.auditedCatalog;
  if (
    !isRecord(metadata) ||
    metadata.schema !== 1 ||
    metadata.tap_repository !== tapRepository ||
    metadata.tap_name !== tapName ||
    metadata.tap_commit !== auditedCatalog.metadata_tap_commit ||
    metadata.kandelo_commit !== auditedCatalog.kandelo_commit ||
    metadata.kandelo_abi !== auditedCatalog.kandelo_abi ||
    metadata.release_tag !== auditedCatalog.release_tag ||
    createHash("sha256").update(metadataBytes).digest("hex") !==
      auditedCatalog.metadata_sha256 ||
    !Array.isArray(metadata.packages)
  ) {
    throw new Error(
      `tap metadata differs from the exact audited ABI-42 catalog: ${path}`,
    );
  }
  const byName = new Map();
  for (const [index, value] of metadata.packages.entries()) {
    const pkg = readTapMetadataPackage(value, `metadata.packages[${index}]`);
    if (byName.has(pkg.name)) {
      throw new Error(`tap metadata contains duplicate Formula ${pkg.name}`);
    }
    byName.set(pkg.name, pkg);
  }
  for (const { formula } of lock.packages) {
    const pkg = byName.get(formula.name);
    if (!isRecord(pkg)) {
      throw new Error(`tap metadata is missing locked Formula ${formula.name}`);
    }
    const expectedVersion =
      formula.revision === 0
        ? formula.version
        : `${formula.version}_${formula.revision}`;
    if (
      pkg.full_name !== `${tapName}/${formula.name}` ||
      pkg.version !== expectedVersion ||
      pkg.formula_revision !== formula.revision ||
      pkg.bottle_rebuild !== formula.bottle_rebuild
    ) {
      throw new Error(
        `tap metadata Formula drift for ${formula.name}: expected ` +
          `${expectedVersion} revision ${formula.revision} rebuild ${formula.bottle_rebuild}`,
      );
    }
  }
  const actualClosure = resolveTapFormulaClosure(
    lock.packages.map(({ formula }) => formula.name),
    byName,
  );
  if (actualClosure.length !== lock.formula_closure.length) {
    throw new Error(
      `tap metadata resolves ${actualClosure.length} main-shell Formulae; ` +
        `the reviewed closure requires ${lock.formula_closure.length}`,
    );
  }
  if (lock.product === undefined) {
    // Published ABI-42 locks historically reviewed the closure as a set. Keep
    // that supported release contract while the local ABI-43 product requires
    // its costly build sequence to be exact and dependency-first.
    assertExactSet(
      actualClosure,
      lock.formula_closure,
      "tap metadata dependency closure does not match reviewed formula_closure",
      (value) => value,
    );
  } else {
    assertExactSequence(
      actualClosure,
      lock.formula_closure,
      "tap metadata dependency-first order does not match reviewed formula_closure",
      (value) => value,
    );
  }
  const actualRuntimeSupportClosure = resolveTapFormulaClosure(
    runtimeSupport.formulaRoots.map((entry) =>
      entry.package.slice(`${tapName}/`.length),
    ),
    byName,
  );
  assertExactSequence(
    actualRuntimeSupportClosure,
    runtimeSupport.formulaOrder,
    "tap metadata dependency closure does not match the Homebrew runtime-support layer",
    (value) => value,
  );
  if (runtimeSupport.availability.reusablePublicAbi42 !== undefined) {
    const actualRuntimeBottleProvenanceSha256 =
      computeRuntimeBottleProvenanceSha256(
        byName,
        runtimeSupport.availability.reusablePublicAbi42,
        auditedCatalog,
      );
    if (
      actualRuntimeBottleProvenanceSha256 !==
      auditedCatalog.runtime_bottle_provenance_sha256
    ) {
      throw new Error(
        "Homebrew runtime-support bottle provenance digest differs from the " +
          `reviewed cohort: expected ${auditedCatalog.runtime_bottle_provenance_sha256}, ` +
          `actual ${actualRuntimeBottleProvenanceSha256}`,
      );
    }
  }
}

function readRuntimeSupport(path, lock) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const expectedKeys = [
    "activation",
    "additional_formula_order",
    "availability",
    "base_formula_order",
    "catalog",
    "deferred_formulae",
    "formula_order",
    "formula_roots",
    "id",
    "kind",
    "lifecycle_installs",
    "required_commands",
    "schema",
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0") ||
    value.schema !== 1 ||
    value.kind !== "kandelo-homebrew-runtime-support-layer" ||
    value.id !== "homebrew-runtime-support"
  ) {
    throw new Error(`invalid Homebrew runtime-support layer schema: ${path}`);
  }
  if (
    !isRecord(value.catalog) ||
    value.catalog.tap_repository !== tapRepository ||
    value.catalog.tap_name !== tapName ||
    value.catalog.tap_commit !== lock.catalog.tap_commit
  ) {
    throw new Error(
      "Homebrew runtime-support catalog must equal the base migration lock",
    );
  }
  assertExactSequence(
    value.base_formula_order,
    lock.formula_closure,
    "Homebrew runtime-support layer has a different base closure",
    (entry) => readFormulaIdentity(entry, "base_formula_order"),
  );

  if (
    !Array.isArray(value.formula_roots) ||
    !Array.isArray(value.formula_order) ||
    !Array.isArray(value.additional_formula_order)
  ) {
    throw new Error(
      "Homebrew runtime-support Formula contracts must be arrays",
    );
  }
  const formulaRoots = value.formula_roots.map((entry, index) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !== "package\0reason" ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new Error(`formula_roots[${index}] is invalid`);
    }
    return {
      package: readFormulaIdentity(
        entry.package,
        `formula_roots[${index}].package`,
      ),
      reason: entry.reason,
    };
  });
  assertUnique(
    formulaRoots.map(({ package: packageName }) => packageName),
    "Homebrew runtime-support roots",
  );
  const formulaOrder = value.formula_order.map((entry, index) =>
    readFormulaIdentity(entry, `formula_order[${index}]`),
  );
  const additionalFormulaOrder = value.additional_formula_order.map(
    (entry, index) =>
      readFormulaIdentity(entry, `additional_formula_order[${index}]`),
  );
  assertUnique(formulaOrder, "Homebrew runtime-support formula_order");
  if (formulaOrder.length === 0) {
    throw new Error("Homebrew runtime-support formula_order cannot be empty");
  }
  assertUnique(
    additionalFormulaOrder,
    "Homebrew runtime-support additional_formula_order",
  );
  for (const { package: packageName } of formulaRoots) {
    if (!formulaOrder.includes(packageName)) {
      throw new Error(
        `Homebrew runtime-support closure omits root ${packageName}`,
      );
    }
  }
  assertExactSequence(
    additionalFormulaOrder,
    formulaOrder.filter(
      (packageName) => !lock.formula_closure.includes(packageName),
    ),
    "Homebrew runtime-support additional closure is not its exact base-relative difference",
    (entry) => entry,
  );
  // WHY: the reviewed descriptors own the changing Formula inventory. Keep
  // the invariant here relational so admitting one dependency does not also
  // require changing a second, hard-coded cardinality in executable code.
  const compositionFormulaOrder = [
    ...lock.formula_closure,
    ...additionalFormulaOrder,
  ];
  assertUnique(
    compositionFormulaOrder,
    "Homebrew shell/runtime Formula union",
  );

  if (!Array.isArray(value.deferred_formulae)) {
    throw new Error(
      "Homebrew runtime-support deferred_formulae must be an array",
    );
  }
  const deferredFormulae = value.deferred_formulae.map((entry, index) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !==
        "current_state\0package\0reason\0reentry_gate" ||
      entry.current_state !== "public-abi41-only" ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0 ||
      typeof entry.reentry_gate !== "string" ||
      entry.reentry_gate.trim().length === 0
    ) {
      throw new Error(`deferred_formulae[${index}] is invalid`);
    }
    return readFormulaIdentity(
      entry.package,
      `deferred_formulae[${index}].package`,
    );
  });
  const availability = readRuntimeSupportAvailability(
    value.availability,
    lock,
    formulaOrder,
    deferredFormulae,
    compositionFormulaOrder,
  );

  const activation = value.activation;
  if (
    !isRecord(activation) ||
    activation.mode !== "first-use-atomic" ||
    JSON.stringify(activation.roots) !== JSON.stringify(["/usr/bin/brew"]) ||
    activation.capability !== "homebrew:runtime" ||
    activation.base_image_default !== "deferred" ||
    activation.demo_variant !== "may-materialize" ||
    !isRecord(activation.bootstrap_package) ||
    activation.bootstrap_package.name !== "homebrew-bootstrap" ||
    JSON.stringify(activation.bootstrap_package.outputs) !==
      JSON.stringify(["homebrew-bootstrap.zip", "homebrew-brew.env"]) ||
    activation.bootstrap_package.required_kernel_abi !==
      availability.auditedCatalog.kandelo_abi
  ) {
    throw new Error(
      "Homebrew runtime support must be one atomic, deferred /usr/bin/brew activation",
    );
  }

  if (!Array.isArray(value.required_commands)) {
    throw new Error(
      "Homebrew runtime-support required_commands must be an array",
    );
  }
  const requiredCommands = value.required_commands.map((entry, index) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !== "package\0path\0reason" ||
      typeof entry.path !== "string" ||
      !/^\/usr\/bin\/[a-z0-9][a-z0-9._+-]*$/.test(entry.path) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      throw new Error(`required_commands[${index}] is invalid`);
    }
    const packageName = readFormulaIdentity(
      entry.package,
      `required_commands[${index}].package`,
    );
    if (!formulaOrder.includes(packageName)) {
      throw new Error(
        `required command ${entry.path} belongs to undeclared ${packageName}`,
      );
    }
    return { path: entry.path, package: packageName };
  });
  assertUnique(
    requiredCommands.map(({ path: commandPath }) => commandPath),
    "Homebrew runtime-support command paths",
  );
  assertExactSet(
    requiredCommands.map(({ package: packageName }) => packageName),
    formulaRoots.map(({ package: packageName }) => packageName),
    "each Homebrew runtime root must own a reviewed required command",
    (entry) => entry,
  );

  if (
    !Array.isArray(value.lifecycle_installs) ||
    value.lifecycle_installs.length !== 1
  ) {
    throw new Error(
      "Homebrew runtime-support lifecycle must declare one independent-tap install",
    );
  }
  const lifecycleInstall = value.lifecycle_installs[0];
  // WHY: the canary's keg-only Formula identity must not collide with the
  // core `m4` keg, even though both payloads intentionally provide `bin/m4`.
  if (
    !isRecord(lifecycleInstall) ||
    lifecycleInstall.tap !== "brandonpayton/kandelo-canary" ||
    lifecycleInstall.repository !== "brandonpayton/homebrew-kandelo-canary" ||
    typeof lifecycleInstall.revision !== "string" ||
    !/^[0-9a-f]{40}$/.test(lifecycleInstall.revision) ||
    lifecycleInstall.formula !== "m4-canary" ||
    lifecycleInstall.phase !== "guest-lifecycle" ||
    lifecycleInstall.image_closure !== false ||
    typeof lifecycleInstall.reason !== "string" ||
    lifecycleInstall.reason.trim().length === 0
  ) {
    throw new Error(
      "the third-party m4-canary must remain a live lifecycle install outside the image",
    );
  }
  const canaryIdentity = `${lifecycleInstall.tap}/${lifecycleInstall.formula}`;
  if (
    lock.formula_closure.includes(canaryIdentity) ||
    formulaOrder.includes(canaryIdentity)
  ) {
    throw new Error(
      "third-party m4-canary leaked into a trusted image closure",
    );
  }

  return {
    formulaRoots,
    formulaOrder,
    additionalFormulaOrder,
    compositionFormulaOrder,
    deferredFormulae,
    availability,
  };
}

function readRuntimeSupportAvailability(
  value,
  lock,
  formulaOrder,
  deferredFormulae,
  compositionFormulaOrder,
) {
  if (!isRecord(value) || !isRecord(value.audited_catalog)) {
    throw new Error(
      "Homebrew runtime-support availability partition is invalid",
    );
  }
  const keys = Object.keys(value).sort().join("\0");
  const local =
    keys ===
    "audited_catalog\0can_be_deferred\0local_test_formulae\0missing_metadata\0provenance\0requires_rebuild";
  const publishedAbi42 =
    keys ===
    "audited_catalog\0can_be_deferred\0missing_metadata\0requires_rebuild\0reusable_public_abi42";
  if (
    (!local && !publishedAbi42) ||
    (local &&
      (!isRecord(value.provenance) ||
        Object.keys(value.provenance).sort().join("\0") !==
          "promotable\0provenance_kind\0published\0schema" ||
        value.provenance.schema !== 1 ||
        value.provenance.provenance_kind !== "local-test" ||
        value.provenance.promotable !== false ||
        value.provenance.published !== false))
  ) {
    throw new Error(
      "Homebrew runtime-support availability partition is invalid",
    );
  }
  const auditedCatalog = value.audited_catalog;
  const localCatalogValid =
    Object.keys(auditedCatalog).sort().join("\0") ===
      "checkout_commit\0kandelo_abi\0release_tag\0required_arch" &&
    auditedCatalog.kandelo_abi === 43 &&
    auditedCatalog.release_tag === "bottles-abi-v43";
  const publishedCatalogValid =
    Object.keys(auditedCatalog).sort().join("\0") ===
      "checkout_commit\0kandelo_abi\0kandelo_commit\0metadata_sha256\0metadata_tap_commit\0release_tag\0required_arch\0runtime_bottle_provenance_sha256" &&
    gitShaPattern.test(auditedCatalog.metadata_tap_commit) &&
    gitShaPattern.test(auditedCatalog.kandelo_commit) &&
    /^[0-9a-f]{64}$/.test(auditedCatalog.metadata_sha256 ?? "") &&
    /^[0-9a-f]{64}$/.test(
      auditedCatalog.runtime_bottle_provenance_sha256 ?? "",
    ) &&
    auditedCatalog.kandelo_abi === 42 &&
    auditedCatalog.release_tag === "bottles-abi-v42";
  if (
    auditedCatalog.checkout_commit !== lock.catalog.tap_commit ||
    auditedCatalog.required_arch !== "wasm32" ||
    (local ? !localCatalogValid : !publishedCatalogValid)
  ) {
    throw new Error(
      local
        ? "Homebrew runtime-support availability must bind the local ABI-43 wasm32 catalog"
        : "Homebrew runtime-support availability must bind the exact ABI-42 wasm32 catalog",
    );
  }

  const readPartition = (key) => {
    if (!Array.isArray(value[key])) {
      throw new Error(
        `Homebrew runtime-support availability.${key} must be an array`,
      );
    }
    const entries = value[key].map((entry, index) =>
      readFormulaIdentity(entry, `availability.${key}[${index}]`),
    );
    assertUnique(entries, `Homebrew runtime-support availability.${key}`);
    return entries;
  };
  const admittedFormulae = readPartition(
    local ? "local_test_formulae" : "reusable_public_abi42",
  );
  const requiresRebuild = readPartition("requires_rebuild");
  const missingMetadata = readPartition("missing_metadata");
  const canBeDeferred = readPartition("can_be_deferred");
  const partition = [
    ...admittedFormulae,
    ...requiresRebuild,
    ...missingMetadata,
    ...canBeDeferred,
  ];
  assertUnique(
    partition,
    "Homebrew runtime-support availability partition",
  );
  const outsideComposition = partition.filter(
    (identity) => !compositionFormulaOrder.includes(identity),
  );
  if (outsideComposition.length !== 0) {
    throw new Error(
      "Homebrew runtime-support availability includes Formulae outside the " +
        `declared shell/runtime union: ${outsideComposition.join(", ")}`,
    );
  }
  const unavailableActivation = formulaOrder.filter(
    (identity) => !admittedFormulae.includes(identity),
  );
  if (unavailableActivation.length !== 0) {
    throw new Error(
      "Homebrew runtime-support activation includes Formulae without " +
        (local ? "local-test bottles: " : "admitted public ABI-42 bottles: ") +
        unavailableActivation.join(", "),
    );
  }
  assertExactSequence(
    requiresRebuild,
    [],
    "a Formula requiring rebuild cannot enter the current atomic activation",
    (entry) => entry,
  );
  assertExactSequence(
    missingMetadata,
    [],
    "a Formula missing metadata cannot enter the current atomic activation",
    (entry) => entry,
  );
  assertExactSequence(
    canBeDeferred,
    deferredFormulae,
    "Homebrew runtime-support availability and deferred contracts disagree",
    (entry) => entry,
  );
  return {
    auditedCatalog,
    ...(local
      ? { localTestFormulae: admittedFormulae }
      : { reusablePublicAbi42: admittedFormulae }),
    auditedFormulae: partition,
  };
}

function readAdmittedRuntimeSupportBottle(pkg, name, catalog) {
  if (!isRecord(pkg) || !Array.isArray(pkg.bottles)) {
    throw new Error(
      `Homebrew runtime-support Formula ${name} has no admitted package metadata`,
    );
  }
  const candidates = pkg.bottles.filter(
    (bottle) => isRecord(bottle) && bottle.arch === catalog.required_arch,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Homebrew runtime-support Formula ${name} has ${candidates.length} ` +
        `${catalog.required_arch} bottle identities, expected one`,
    );
  }
  const bottle = candidates[0];
  const builtFrom = isRecord(bottle.built_from) ? bottle.built_from : undefined;
  const expectedUrl = `https://ghcr.io/v2/${tapRepository}/${name}/blobs/sha256:${bottle.sha256}`;
  if (
    bottle.status !== "success" ||
    bottle.kandelo_abi !== catalog.kandelo_abi ||
    bottle.bottle_tag !== `${catalog.required_arch}_kandelo` ||
    !Number.isSafeInteger(bottle.bytes) ||
    bottle.bytes <= 0 ||
    typeof bottle.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(bottle.sha256) ||
    bottle.cache_key_sha !== bottle.sha256 ||
    bottle.url !== expectedUrl ||
    !Array.isArray(bottle.runtime_support) ||
    !bottle.runtime_support.includes("node") ||
    builtFrom === undefined ||
    Object.keys(builtFrom).sort().join("\0") !==
      "formula_sha256\0kandelo_commit\0kandelo_repository\0tap_commit\0tap_repository" ||
    builtFrom.tap_repository !== tapRepository ||
    builtFrom.kandelo_repository !== "Automattic/kandelo" ||
    typeof builtFrom.kandelo_commit !== "string" ||
    !gitShaPattern.test(builtFrom.kandelo_commit) ||
    typeof builtFrom.tap_commit !== "string" ||
    !gitShaPattern.test(builtFrom.tap_commit) ||
    typeof builtFrom.formula_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(builtFrom.formula_sha256)
  ) {
    throw new Error(
      `Homebrew runtime-support Formula ${name} lacks an admitted public ` +
        `${catalog.required_arch} ABI-${catalog.kandelo_abi} bottle identity`,
    );
  }
  return bottle;
}

function computeRuntimeBottleProvenanceSha256(
  byName,
  formulaIdentities,
  catalog,
) {
  if (!Array.isArray(formulaIdentities)) {
    throw new Error(
      "Homebrew runtime-support provenance cohort must be an array",
    );
  }
  const identities = formulaIdentities.map((identity, index) =>
    readFormulaIdentity(identity, `runtime provenance cohort[${index}]`),
  );
  assertUnique(identities, "Homebrew runtime-support provenance cohort");

  const projection = identities.map((identity) => {
    const name = identity.slice(`${tapName}/`.length);
    const pkg = byName.get(name);
    // WHY: aggregate metadata describes the latest catalog publication, while
    // an unchanged immutable bottle truthfully retains the commit that built
    // it. Hash the exact ordered bottle/provenance projection so reviewers can
    // admit a mixed-producer catalog without rewriting historical provenance.
    const bottle = readAdmittedRuntimeSupportBottle(pkg, name, catalog);
    return {
      full_name: pkg.full_name,
      version: pkg.version,
      formula_revision: pkg.formula_revision,
      bottle_rebuild: pkg.bottle_rebuild,
      bottle: {
        arch: bottle.arch,
        bottle_tag: bottle.bottle_tag,
        kandelo_abi: bottle.kandelo_abi,
        url: bottle.url,
        sha256: bottle.sha256,
        bytes: bottle.bytes,
        cache_key_sha: bottle.cache_key_sha,
        built_from: {
          tap_repository: bottle.built_from.tap_repository,
          tap_commit: bottle.built_from.tap_commit,
          kandelo_repository: bottle.built_from.kandelo_repository,
          kandelo_commit: bottle.built_from.kandelo_commit,
          formula_sha256: bottle.built_from.formula_sha256,
        },
      },
    };
  });
  return createHash("sha256")
    .update(provenanceDigestDomain)
    .update(JSON.stringify(projection))
    .digest("hex");
}

function computeRuntimeBottleProvenanceFromFiles(metadataPath, supportPath) {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const support = JSON.parse(readFileSync(supportPath, "utf8"));
  const catalog = support?.availability?.audited_catalog;
  const formulaIdentities = support?.availability?.reusable_public_abi42;
  if (
    !isRecord(metadata) ||
    metadata.schema !== 1 ||
    metadata.tap_repository !== tapRepository ||
    metadata.tap_name !== tapName ||
    !Array.isArray(metadata.packages) ||
    !isRecord(catalog) ||
    catalog.kandelo_abi !== 42 ||
    catalog.required_arch !== "wasm32" ||
    metadata.kandelo_abi !== catalog.kandelo_abi ||
    metadata.release_tag !== catalog.release_tag
  ) {
    throw new Error(
      "runtime bottle provenance inputs lack canonical metadata, cohort, ABI, or architecture",
    );
  }
  const byName = new Map();
  for (const [index, value] of metadata.packages.entries()) {
    const pkg = readTapMetadataPackage(value, `metadata.packages[${index}]`);
    if (byName.has(pkg.name)) {
      throw new Error(`tap metadata contains duplicate Formula ${pkg.name}`);
    }
    byName.set(pkg.name, pkg);
  }
  return computeRuntimeBottleProvenanceSha256(
    byName,
    formulaIdentities,
    catalog,
  );
}

function readTapMetadataPackage(value, label) {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.name) ||
    value.full_name !== `${tapName}/${value.name}` ||
    typeof value.version !== "string" ||
    !Number.isInteger(value.formula_revision) ||
    !Number.isInteger(value.bottle_rebuild) ||
    !Array.isArray(value.dependencies)
  ) {
    throw new Error(`${label} is not a canonical Formula metadata record`);
  }
  const dependencies = value.dependencies.map((dependency, index) => {
    const dependencyLabel = `${label}.dependencies[${index}]`;
    if (
      !isRecord(dependency) ||
      typeof dependency.name !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(dependency.name) ||
      (dependency.full_name !== undefined &&
        dependency.full_name !== `${tapName}/${dependency.name}`)
    ) {
      throw new Error(
        `${dependencyLabel} is not a canonical same-tap dependency`,
      );
    }
    return dependency.name;
  });
  assertUnique(dependencies, `${label}.dependencies`);
  return { ...value, dependencies };
}

function resolveTapFormulaClosure(rootNames, byName) {
  const ordered = [];
  const state = new Map();
  const stack = [];

  function visit(name, requiredBy) {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart < 0 ? 0 : cycleStart), name];
      throw new Error(`tap metadata dependency cycle: ${cycle.join(" -> ")}`);
    }
    const pkg = byName.get(name);
    if (pkg === undefined) {
      const context =
        requiredBy === undefined
          ? "registry root"
          : `dependency of ${requiredBy}`;
      throw new Error(`tap metadata is missing ${context} Formula ${name}`);
    }
    state.set(name, "visiting");
    stack.push(name);
    for (const dependency of pkg.dependencies) visit(dependency, name);
    stack.pop();
    state.set(name, "done");
    ordered.push(`${tapName}/${name}`);
  }

  for (const name of rootNames) visit(name);
  return ordered;
}

function readDependencies(path) {
  const source = readFileSync(path, "utf8");
  const match = /(?:^|\n)depends_on\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!match) throw new Error(`cannot find depends_on array in ${path}`);
  const entries = Array.from(
    match[1].matchAll(/"([^"]+)"/g),
    (item) => item[1],
  );
  return entries.map((entry) => {
    const at = entry.lastIndexOf("@");
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(
        `dependency must be locked as name@version: ${entry} in ${path}`,
      );
    }
    const name = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error(
        `unsupported dependency ${JSON.stringify(entry)} in ${path}`,
      );
    }
    return { name, version };
  });
}

function readBrewfilePackages(path) {
  const packages = [];
  let sawTap = false;
  for (const [index, rawLine] of readFileSync(path, "utf8")
    .split("\n")
    .entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === `tap "${tapName}"`) {
      if (sawTap) throw new Error(`duplicate tap declaration in ${path}`);
      sawTap = true;
      continue;
    }
    const match = /^brew "kandelo-dev\/tap-core\/([a-z0-9][a-z0-9._-]*)"$/.exec(
      line,
    );
    if (!match) throw new Error(`unsupported ${path}:${index + 1}: ${rawLine}`);
    packages.push(match[1]);
  }
  if (!sawTap) throw new Error(`missing tap declaration in ${path}`);
  return packages;
}

function assertExactSequence(actual, expected, message, render) {
  const actualValues = actual.map(render);
  const expectedValues = expected.map(render);
  if (JSON.stringify(actualValues) === JSON.stringify(expectedValues)) return;
  const missing = expectedValues.filter(
    (value) => !actualValues.includes(value),
  );
  const extra = actualValues.filter((value) => !expectedValues.includes(value));
  throw new Error(
    `${message}\n  missing: ${missing.join(", ") || "(none)"}` +
      `\n  extra: ${extra.join(", ") || "(none)"}\n  ordering must also match`,
  );
}

function assertExactSet(actual, expected, message, render) {
  const actualValues = actual.map(render).sort();
  const expectedValues = expected.map(render).sort();
  if (JSON.stringify(actualValues) === JSON.stringify(expectedValues)) return;
  const missing = expectedValues.filter(
    (value) => !actualValues.includes(value),
  );
  const extra = actualValues.filter((value) => !expectedValues.includes(value));
  throw new Error(
    `${message}\n  missing: ${missing.join(", ") || "(none)"}` +
      `\n  extra: ${extra.join(", ") || "(none)"}`,
  );
}

function assertUnique(values, label) {
  const duplicate = values.find(
    (value, index) => values.indexOf(value) !== index,
  );
  if (duplicate) throw new Error(`${label} contains duplicate ${duplicate}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
