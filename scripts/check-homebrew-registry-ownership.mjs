#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_ROLES = [
  "formula_recipe",
  "platform_artifact",
  "test_fixture_harness",
  "composite_image_policy",
  "still_unowned",
];
const VALID_RECIPE_STATES = ["tap_native", "registry_bridge"];
const VALID_ARCHITECTURES = ["wasm32", "wasm64"];
const VALID_EVIDENCE_STATES = [
  "success",
  "failed",
  "pending",
  "building",
  "deferred",
  "unavailable",
  "blocked",
  "excluded",
];
const VALID_EVIDENCE_CATEGORIES = [
  "build",
  "publication",
  "verification",
  "runtime",
  "policy",
  "unavailable",
  "unsupported",
  "excluded",
];

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameValues(left, right) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function describeSetDifference(expected, actual) {
  const missing = sorted(expected.filter((value) => !actual.includes(value)));
  const extra = sorted(actual.filter((value) => !expected.includes(value)));
  return [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
    extra.length > 0 ? `extra: ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function checkExactValues(errors, label, expected, actual) {
  if (!sameValues(expected, actual)) {
    errors.push(
      `${label} differs (${describeSetDifference(expected, actual)})`,
    );
  }
}

function requireString(errors, value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
  }
}

function requireStringArray(errors, value, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    errors.push(
      `${label} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings`,
    );
    return [];
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${label} must not contain duplicates`);
  }
  const sortedValue = sorted(value);
  if (value.some((item, index) => item !== sortedValue[index])) {
    errors.push(`${label} must be sorted`);
  }
  return value;
}

function objectEntries(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function evidenceStatus(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value.status;
  }
  return undefined;
}

function validateNonSuccessEvidence(errors, value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be a complete non-success evidence object`);
    return;
  }
  const expectedFields = [
    "attempt",
    "category",
    "first_error_or_artifact",
    "last_green",
    "next_action",
    "owner",
    "reason",
    "status",
  ];
  checkExactValues(
    errors,
    `${label} fields`,
    expectedFields,
    Object.keys(value),
  );
  if (!VALID_EVIDENCE_CATEGORIES.includes(value.category)) {
    errors.push(`${label}.category is invalid`);
  }
  for (const field of [
    "attempt",
    "first_error_or_artifact",
    "last_green",
    "next_action",
    "owner",
    "reason",
  ]) {
    requireString(errors, value[field], `${label}.${field}`);
  }
}

function listRegistryDirectories(repoRoot) {
  const registryRoot = join(repoRoot, "packages", "registry");
  return sorted(
    readdirSync(registryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

function formulaArchitectureTags(source) {
  return sorted(
    [
      ...source.matchAll(/\bwasm(32|64)_kandelo\s*:/g),
      ...source.matchAll(/:\s*wasm(32|64)_kandelo\b/g),
    ].map((match) => `wasm${match[1]}`),
  ).filter((value, index, all) => index === 0 || value !== all[index - 1]);
}

function validateTapCheckout(ledger, tapRoot, errors) {
  const tapSource = ledger.sources.tap;
  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tapRoot,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    errors.push(`cannot read tap Git revision at ${tapRoot}: ${error.message}`);
    return;
  }
  if (head !== tapSource.commit) {
    errors.push(
      `tap checkout is ${head}, but ledger records ${tapSource.commit}`,
    );
  }

  const formulaRoot = join(tapRoot, tapSource.formula_directory);
  const sidecarRoot = join(tapRoot, tapSource.sidecar_directory);
  const actualFormulae = sorted(
    readdirSync(formulaRoot)
      .filter((name) => name.endsWith(".rb"))
      .map((name) => name.slice(0, -3)),
  );
  const ledgerFormulae = sorted(Object.keys(ledger.tap_formulae));
  checkExactValues(
    errors,
    "tap Formula inventory",
    ledgerFormulae,
    actualFormulae,
  );

  const actualSidecars = sorted(
    readdirSync(sidecarRoot)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5)),
  );
  const expectedSidecars = sorted(
    objectEntries(ledger.tap_formulae)
      .filter(([, formula]) =>
        Object.values(formula.architecture_evidence ?? {}).some(
          (value) => evidenceStatus(value) === "success",
        ),
      )
      .map(([name]) => name),
  );
  checkExactValues(
    errors,
    "tap sidecar inventory",
    expectedSidecars,
    actualSidecars,
  );

  for (const formulaName of actualFormulae) {
    const record = ledger.tap_formulae[formulaName];
    if (!record) continue;

    const formulaPath = join(formulaRoot, `${formulaName}.rb`);
    const source = readFileSync(formulaPath, "utf8");
    const architectures = formulaArchitectureTags(source);
    checkExactValues(
      errors,
      `tap Formula ${formulaName} architecture declarations`,
      record.declared_architectures,
      architectures,
    );

    const recipeState = source.includes("KANDELO_REGISTRY_BRIDGE")
      ? "registry_bridge"
      : "tap_native";
    if (recipeState !== record.recipe_state) {
      errors.push(
        `tap Formula ${formulaName} recipe state is ${recipeState}, ledger records ${record.recipe_state}`,
      );
    }

    const sidecarPath = join(sidecarRoot, `${formulaName}.json`);
    if (!existsSync(sidecarPath)) continue;
    let sidecar;
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    } catch (error) {
      errors.push(`cannot parse ${sidecarPath}: ${error.message}`);
      continue;
    }
    if (sidecar.name !== formulaName) {
      errors.push(
        `tap sidecar ${formulaName}.json names ${String(sidecar.name)}`,
      );
    }
    const sidecarEvidence = Object.fromEntries(
      (sidecar.bottles ?? []).map((bottle) => [bottle.arch, bottle.status]),
    );
    for (const [arch, status] of Object.entries(sidecarEvidence)) {
      if (evidenceStatus(record.architecture_evidence?.[arch]) !== status) {
        errors.push(
          `tap sidecar ${formulaName} ${arch} is ${status}, ledger records ${String(evidenceStatus(record.architecture_evidence?.[arch]))}`,
        );
      }
    }
    const expectedSuccessfulArchitectures = objectEntries(
      record.architecture_evidence,
    )
      .filter(([, value]) => evidenceStatus(value) === "success")
      .map(([arch]) => arch);
    checkExactValues(
      errors,
      `tap sidecar ${formulaName} successful architectures`,
      expectedSuccessfulArchitectures,
      Object.keys(sidecarEvidence),
    );
  }
}

export function validateLedger(ledger, { repoRoot, tapRoot } = {}) {
  const errors = [];
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return ["ledger must be a JSON object"];
  }
  if (ledger.schema !== 1) {
    errors.push(`ledger schema must be 1, found ${String(ledger.schema)}`);
  }
  requireString(errors, ledger.as_of, "as_of");
  requireString(errors, ledger.purpose, "purpose");

  const source = ledger.sources ?? {};
  requireString(
    errors,
    source.kandelo?.repository,
    "sources.kandelo.repository",
  );
  requireString(errors, source.kandelo?.commit, "sources.kandelo.commit");
  requireString(
    errors,
    source.historical_inventory?.git_blob,
    "sources.historical_inventory.git_blob",
  );
  requireString(errors, source.tap?.repository, "sources.tap.repository");
  requireString(errors, source.tap?.commit, "sources.tap.commit");
  requireString(
    errors,
    source.tap?.formula_directory,
    "sources.tap.formula_directory",
  );
  requireString(
    errors,
    source.tap?.sidecar_directory,
    "sources.tap.sidecar_directory",
  );

  checkExactValues(
    errors,
    "role definitions",
    VALID_ROLES,
    Object.keys(ledger.role_definitions ?? {}),
  );

  const registryEntries = ledger.registry_entries ?? {};
  const historicalOnly = ledger.historical_only_entries ?? {};
  const tapFormulae = ledger.tap_formulae ?? {};
  const registryNames = sorted(Object.keys(registryEntries));
  const historicalOnlyNames = sorted(Object.keys(historicalOnly));
  const historicalNames = requireStringArray(
    errors,
    source.historical_inventory?.entries,
    "sources.historical_inventory.entries",
  );

  if (repoRoot) {
    const actualRegistryNames = listRegistryDirectories(repoRoot);
    checkExactValues(
      errors,
      "packages/registry inventory",
      registryNames,
      actualRegistryNames,
    );
  }

  for (const historicalName of historicalNames) {
    const current = Object.hasOwn(registryEntries, historicalName);
    const historical = Object.hasOwn(historicalOnly, historicalName);
    if (current === historical) {
      errors.push(
        `historical entry ${historicalName} must appear in exactly one of registry_entries or historical_only_entries`,
      );
    }
  }
  for (const name of historicalOnlyNames) {
    if (!historicalNames.includes(name)) {
      errors.push(
        `historical-only entry ${name} is absent from the historical inventory`,
      );
    }
  }

  const historicalManifestCount = source.historical_inventory?.manifest_count;
  const historicalSupportCount =
    source.historical_inventory?.support_directory_count;
  if (
    !Number.isInteger(historicalManifestCount) ||
    !Number.isInteger(historicalSupportCount) ||
    historicalManifestCount + historicalSupportCount !== historicalNames.length
  ) {
    errors.push(
      "historical manifest and support counts must be integers that sum to the historical entry inventory",
    );
  }

  for (const [name, entry] of objectEntries(registryEntries)) {
    if (!VALID_ROLES.includes(entry.role)) {
      errors.push(
        `registry entry ${name} has unknown role ${String(entry.role)}`,
      );
      continue;
    }
    if (entry.role === "formula_recipe") {
      const formulae = requireStringArray(
        errors,
        entry.formulae,
        `registry entry ${name}.formulae`,
      );
      if (!VALID_RECIPE_STATES.includes(entry.recipe_state)) {
        errors.push(
          `registry entry ${name} has unknown recipe_state ${String(entry.recipe_state)}`,
        );
      }
      for (const formula of formulae) {
        if (!Object.hasOwn(tapFormulae, formula)) {
          errors.push(
            `registry entry ${name} names missing tap Formula ${formula}`,
          );
          continue;
        }
        if (!(tapFormulae[formula].registry_entries ?? []).includes(name)) {
          errors.push(
            `registry entry ${name} maps to ${formula}, but its tap record does not map back`,
          );
        }
      }
      continue;
    }

    if (Object.hasOwn(entry, "formulae")) {
      errors.push(
        `registry entry ${name} cannot claim authoritative formulae with role ${entry.role}`,
      );
    }
    requireString(errors, entry.owner, `registry entry ${name}.owner`);
    if (entry.role === "still_unowned") {
      requireString(errors, entry.reason, `registry entry ${name}.reason`);
    }
    if (entry.role !== "test_fixture_harness" || !entry.disposition) {
      requireString(
        errors,
        entry.next_action,
        `registry entry ${name}.next_action`,
      );
    }

    const candidates = entry.candidate_formulae ?? [];
    if (candidates.length > 0) {
      requireStringArray(
        errors,
        candidates,
        `registry entry ${name}.candidate_formulae`,
      );
      for (const formula of candidates) {
        if (!Object.hasOwn(tapFormulae, formula)) {
          errors.push(
            `registry entry ${name} names missing candidate tap Formula ${formula}`,
          );
        } else if (
          !(tapFormulae[formula].candidate_registry_entries ?? []).includes(
            name,
          )
        ) {
          errors.push(
            `registry entry ${name} is a candidate for ${formula}, but its tap record does not map back`,
          );
        }
      }
    }
  }

  for (const [name, entry] of objectEntries(historicalOnly)) {
    if (!VALID_ROLES.includes(entry.role)) {
      errors.push(
        `historical-only entry ${name} has unknown role ${String(entry.role)}`,
      );
    }
    requireString(errors, entry.disposition, `${name}.disposition`);
    requireString(errors, entry.owner, `${name}.owner`);
  }

  for (const [name, formula] of objectEntries(tapFormulae)) {
    const mappedRegistry = requireStringArray(
      errors,
      formula.registry_entries,
      `tap Formula ${name}.registry_entries`,
      { allowEmpty: true },
    );
    const candidateRegistry = formula.candidate_registry_entries ?? [];
    if (candidateRegistry.length > 0) {
      requireStringArray(
        errors,
        candidateRegistry,
        `tap Formula ${name}.candidate_registry_entries`,
      );
    }
    if (mappedRegistry.length === 0) {
      requireString(
        errors,
        formula.tap_native_role,
        `tap Formula ${name}.tap_native_role`,
      );
    }
    if (!VALID_RECIPE_STATES.includes(formula.recipe_state)) {
      errors.push(
        `tap Formula ${name} has unknown recipe_state ${String(formula.recipe_state)}`,
      );
    }

    for (const registryName of mappedRegistry) {
      const registry = registryEntries[registryName];
      if (!registry) {
        errors.push(
          `tap Formula ${name} maps to missing registry entry ${registryName}`,
        );
      } else if (registry.role !== "formula_recipe") {
        errors.push(
          `tap Formula ${name} claims ${registryName}, whose role is ${registry.role}`,
        );
      } else if (!(registry.formulae ?? []).includes(name)) {
        errors.push(
          `tap Formula ${name} maps to ${registryName}, but its registry record does not map back`,
        );
      }
    }
    for (const registryName of candidateRegistry) {
      const registry = registryEntries[registryName];
      if (!registry) {
        errors.push(
          `tap Formula ${name} names missing candidate registry entry ${registryName}`,
        );
      } else if (registry.role !== "still_unowned") {
        errors.push(
          `tap Formula ${name} candidate ${registryName} must remain still_unowned until accepted`,
        );
      } else if (!(registry.candidate_formulae ?? []).includes(name)) {
        errors.push(
          `tap Formula ${name} candidate ${registryName} does not map back`,
        );
      }
    }

    const architectures = requireStringArray(
      errors,
      formula.declared_architectures,
      `tap Formula ${name}.declared_architectures`,
    );
    for (const arch of architectures) {
      if (!VALID_ARCHITECTURES.includes(arch)) {
        errors.push(`tap Formula ${name} has unknown architecture ${arch}`);
      }
    }
    const evidence = formula.architecture_evidence ?? {};
    checkExactValues(
      errors,
      `tap Formula ${name} architecture evidence`,
      architectures,
      Object.keys(evidence),
    );
    for (const [arch, value] of objectEntries(evidence)) {
      const status = evidenceStatus(value);
      if (!VALID_EVIDENCE_STATES.includes(status)) {
        errors.push(
          `tap Formula ${name} ${arch} has unknown evidence state ${String(status)}`,
        );
      } else if (status !== "success") {
        validateNonSuccessEvidence(
          errors,
          value,
          `tap Formula ${name}.${arch}`,
        );
      } else if (value !== "success") {
        errors.push(
          `tap Formula ${name}.${arch} success evidence must use the canonical string value`,
        );
      }
    }
  }

  if (tapRoot) validateTapCheckout(ledger, resolve(tapRoot), errors);
  return errors;
}

export function formatReport(ledger) {
  const byRole = Object.fromEntries(VALID_ROLES.map((role) => [role, []]));
  for (const [name, entry] of objectEntries(ledger.registry_entries)) {
    byRole[entry.role]?.push(name);
  }
  const bridgeFormulae = objectEntries(ledger.tap_formulae)
    .filter(([, formula]) => formula.recipe_state === "registry_bridge")
    .map(([name]) => name);
  const evidence = {};
  for (const [name, formula] of objectEntries(ledger.tap_formulae)) {
    for (const [arch, value] of objectEntries(formula.architecture_evidence)) {
      const status = evidenceStatus(value);
      (evidence[status] ??= []).push(`${name}:${arch}`);
    }
  }

  const lines = [
    "# Homebrew registry ownership",
    "",
    `Snapshot: Kandelo \`${ledger.sources.kandelo.commit}\`, tap \`${ledger.sources.tap.commit}\`.`,
    "",
    `Current registry entries: ${Object.keys(ledger.registry_entries).length}. Historical-only entries: ${Object.keys(ledger.historical_only_entries).length}. Tap Formulae: ${Object.keys(ledger.tap_formulae).length}.`,
    "",
    "## Registry roles",
    "",
  ];
  for (const role of VALID_ROLES) {
    lines.push(
      `- ${role} (${byRole[role].length}): ${byRole[role].join(", ")}`,
    );
  }
  lines.push(
    "",
    "## Explicit migration gaps",
    "",
    `- Still unowned (${byRole.still_unowned.length}): ${byRole.still_unowned.join(", ")}`,
    `- Registry-bridge Formulae (${bridgeFormulae.length}): ${bridgeFormulae.join(", ")}`,
  );
  for (const status of sorted(Object.keys(evidence))) {
    lines.push(
      `- Formula architecture ${status} (${evidence[status].length}): ${evidence[status].join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = {
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    ledgerPath: undefined,
    tapRoot: undefined,
    report: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo-root") {
      options.repoRoot = resolve(argv[++index]);
    } else if (argument === "--ledger") {
      options.ledgerPath = resolve(argv[++index]);
    } else if (argument === "--tap-root") {
      options.tapRoot = resolve(argv[++index]);
    } else if (argument === "--report") {
      options.report = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  options.ledgerPath ??= join(
    options.repoRoot,
    "docs",
    "homebrew-registry-ownership.json",
  );
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(options.ledgerPath, "utf8"));
  } catch (error) {
    console.error(`cannot load ${options.ledgerPath}: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const errors = validateLedger(ledger, options);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (options.report) {
    process.stdout.write(formatReport(ledger));
  } else {
    const current = Object.keys(ledger.registry_entries).length;
    const historical = Object.keys(ledger.historical_only_entries).length;
    const formulae = Object.keys(ledger.tap_formulae).length;
    console.log(
      `Homebrew registry ownership ledger is complete: ${current} current registry entries, ${historical} historical-only entries, ${formulae} tap Formulae.`,
    );
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
