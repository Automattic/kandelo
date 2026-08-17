import { createHash } from "node:crypto";

import {
  projectHomebrewBottleDescriptor,
  type HomebrewBottleDependencyIdentity,
  type HomebrewBottleDescriptor,
} from "./homebrew-bottle-descriptor";
import type { HomebrewBottleArch } from "./homebrew-bottle-types";
import {
  assertHomebrewCanonicalText,
  compareHomebrewCanonicalText,
} from "./homebrew-lazy-layer-descriptor";
import {
  resolveHomebrewVfsResourcePolicy,
  type HomebrewVfsResourcePolicyId,
} from "./homebrew-vfs-resource-policy";

const SELECTION_KEYS = [
  "schema",
  "name",
  "arch",
  "kandeloAbi",
  "bottles",
  "requestedVfsFilename",
  "resourcePolicy",
  "linkPolicy",
  "runtimeSupport",
] as const;
const SELECTION_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const OUTPUT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.vfs\.zst$/;
const BOOTSTRAP_FULL_NAME = "kandelo-dev/tap-core/homebrew-bootstrap";

export interface HomebrewBottleSelection {
  schema: 1;
  name: string;
  arch: HomebrewBottleArch;
  kandeloAbi: number;
  bottles: HomebrewBottleDescriptor[];
  requestedVfsFilename: string;
  resourcePolicy: HomebrewVfsResourcePolicyId;
  linkPolicy: "kandelo-homebrew-link-ownership-v1";
  runtimeSupport: "kandelo-homebrew-bootstrap-v1";
}

export interface ProjectHomebrewBottleSelectionOptions {
  expectedAbi?: number;
}

export class HomebrewBottleSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewBottleSelectionError";
  }
}

/** Validate untrusted flat-selection JSON without changing bottle order. */
export function projectHomebrewBottleSelection(
  value: unknown,
  options: ProjectHomebrewBottleSelectionOptions = {},
): HomebrewBottleSelection {
  const root = exactRecord(value, SELECTION_KEYS, "Homebrew bottle selection");
  if (root.schema !== 1) fail("Homebrew bottle selection.schema must be 1");
  const name = stringValue(root.name, "Homebrew bottle selection.name");
  if (!SELECTION_NAME_RE.test(name)) fail("Homebrew bottle selection.name is invalid");
  const arch = bottleArch(root.arch, "Homebrew bottle selection.arch");
  const kandeloAbi = positiveInteger(
    root.kandeloAbi,
    "Homebrew bottle selection.kandeloAbi",
  );
  if (options.expectedAbi !== undefined) {
    const expectedAbi = positiveInteger(options.expectedAbi, "expected ABI");
    if (kandeloAbi !== expectedAbi) {
      fail(`Homebrew bottle selection uses ABI ${kandeloAbi}, expected ABI ${expectedAbi}`);
    }
  }
  if (!Array.isArray(root.bottles) || root.bottles.length === 0) {
    fail("Homebrew bottle selection.bottles must be a nonempty array");
  }
  const bottles = root.bottles.map((bottle, index) => {
    try {
      return projectHomebrewBottleDescriptor(bottle);
    } catch (error) {
      fail(
        `Homebrew bottle selection.bottles[${index}] is invalid: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const requestedVfsFilename = stringValue(
    root.requestedVfsFilename,
    "Homebrew bottle selection.requestedVfsFilename",
  );
  const requiredAbiToken = `abi${kandeloAbi}`;
  const hasExactAbiToken = new RegExp(
    `(?:^|[._-])${requiredAbiToken}(?:[._-]|$)`,
  ).test(requestedVfsFilename);
  if (
    !OUTPUT_FILENAME_RE.test(requestedVfsFilename) ||
    !requestedVfsFilename.includes("experimental") ||
    !hasExactAbiToken
  ) {
    fail(
      "Homebrew bottle selection.requestedVfsFilename must be a safe .vfs.zst " +
        `basename containing experimental and ${requiredAbiToken}`,
    );
  }
  if (
    root.resourcePolicy !== "kandelo-homebrew-vfs-generous-v1" &&
    root.resourcePolicy !== "kandelo-homebrew-vfs-main-shell-v1"
  ) {
    fail(
      "Homebrew bottle selection fields do not form a supported tuple for " +
        "requestedVfsFilename and resourcePolicy",
    );
  }
  const resourcePolicy = root.resourcePolicy;
  const experimentalProduct =
    name.startsWith("experimental-") &&
    arch === "wasm32" &&
    kandeloAbi === 42 &&
    requestedVfsFilename.includes("experimental") &&
    requestedVfsFilename.includes("abi42") &&
    resourcePolicy === "kandelo-homebrew-vfs-generous-v1";
  const mainShellProduct =
    name === "main-shell-abi42-wasm32" &&
    arch === "wasm32" &&
    kandeloAbi === 42 &&
    requestedVfsFilename === "shell.vfs.zst" &&
    resourcePolicy === "kandelo-homebrew-vfs-main-shell-v1";
  if (!experimentalProduct && !mainShellProduct) {
    fail(
      "Homebrew bottle selection fields do not form a supported tuple for " +
        "requestedVfsFilename and resourcePolicy",
    );
  }
  if (root.linkPolicy !== "kandelo-homebrew-link-ownership-v1") {
    fail("Homebrew bottle selection.linkPolicy is invalid");
  }
  if (root.runtimeSupport !== "kandelo-homebrew-bootstrap-v1") {
    fail("Homebrew bottle selection.runtimeSupport is invalid");
  }

  validateBottleClosure(bottles, arch, kandeloAbi);
  validateKnownResourceUse(bottles, resourcePolicy);
  return {
    schema: 1,
    name,
    arch,
    kandeloAbi,
    bottles,
    requestedVfsFilename,
    resourcePolicy,
    linkPolicy: root.linkPolicy,
    runtimeSupport: root.runtimeSupport,
  };
}

function validateKnownResourceUse(
  bottles: readonly HomebrewBottleDescriptor[],
  resourcePolicy: HomebrewVfsResourcePolicyId,
): void {
  const policy = resolveHomebrewVfsResourcePolicy(resourcePolicy);
  let compressedBytes = 0;
  for (const bottle of bottles) {
    if (bottle.bytes > policy.bottle.maxCompressedBytes) {
      fail(
        `${bottle.fullName} exceeds the per-bottle compressed-byte cap of ` +
          `${policy.bottle.maxCompressedBytes}`,
      );
    }
    compressedBytes += bottle.bytes;
    if (!Number.isSafeInteger(compressedBytes)) {
      fail("Homebrew bottle selection compressed-byte sum is unsafe");
    }
  }
  if (compressedBytes > policy.aggregate.maxCompressedBytes) {
    fail(
      "Homebrew bottle selection exceeds the aggregate compressed-byte cap of " +
        `${policy.aggregate.maxCompressedBytes}`,
    );
  }
  const bootstrap = bottles.find((bottle) =>
    bottle.materialization === "homebrew-runtime-support-v1"
  )!;
  const supportZip = bootstrap.supportOutputs.find((output) =>
    output.name === "homebrew-bootstrap"
  )!;
  if (supportZip.bytes > policy.supportZip.maxCompressedBytes) {
    fail(
      "Homebrew bootstrap support ZIP exceeds the compressed-byte cap of " +
        `${policy.supportZip.maxCompressedBytes}`,
    );
  }
}

/** Normative compact canonical JSON, recursively key-sorted and LF-terminated. */
export function encodeHomebrewBottleSelection(
  selection: HomebrewBottleSelection,
): Uint8Array {
  const canonical = projectHomebrewBottleSelection(selection);
  return new TextEncoder().encode(`${JSON.stringify(sortJson(canonical))}\n`);
}

/** Parse only the normative byte representation of one flat selection. */
export function parseCanonicalHomebrewBottleSelection(
  bytes: Uint8Array,
  options: ProjectHomebrewBottleSelectionOptions = {},
): HomebrewBottleSelection {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Homebrew bottle selection is not valid UTF-8 JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("Homebrew bottle selection is not valid UTF-8 JSON");
  }
  const selection = projectHomebrewBottleSelection(parsed, options);
  const canonical = encodeHomebrewBottleSelection(selection);
  if (!equalBytes(bytes, canonical)) {
    fail("Homebrew bottle selection bytes are not canonical JSON");
  }
  return selection;
}

/** Digest exact canonical selection bytes; callers decide whether to parse first. */
export function homebrewBottleSelectionSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateBottleClosure(
  bottles: readonly HomebrewBottleDescriptor[],
  arch: HomebrewBottleArch,
  kandeloAbi: number,
): void {
  const bootstraps = bottles.filter((bottle) =>
    bottle.fullName === BOOTSTRAP_FULL_NAME &&
    bottle.materialization === "homebrew-runtime-support-v1"
  );
  if (bootstraps.length !== 1) {
    fail("Homebrew bottle selection must contain exactly one Homebrew bootstrap runtime descriptor");
  }

  const byFullName = new Map<string, HomebrewBottleDescriptor>();
  const kegPaths = new Set<string>();
  for (const bottle of bottles) {
    if (byFullName.has(bottle.fullName)) {
      fail(`Homebrew bottle selection has duplicate Formula identity ${bottle.fullName}`);
    }
    byFullName.set(bottle.fullName, bottle);
    if (kegPaths.has(bottle.keg)) {
      fail(`Homebrew bottle selection has duplicate Cellar keg path ${bottle.keg}`);
    }
    kegPaths.add(bottle.keg);
    if (bottle.arch !== arch) {
      fail(`Homebrew bottle selection mixes architecture at ${bottle.fullName}`);
    }
    if (bottle.kandeloAbi !== kandeloAbi) {
      fail(`Homebrew bottle selection mixes ABI at ${bottle.fullName}`);
    }
    if (bottle.bottleTag !== `${arch}_kandelo`) {
      fail(`Homebrew bottle selection mixes bottle tag at ${bottle.fullName}`);
    }
    if (bottle.layout !== "kandelo-homebrew-v1") {
      fail(`Homebrew bottle selection mixes layout at ${bottle.fullName}`);
    }
    assertSortedDependencies(bottle);
  }

  for (const bottle of bottles) {
    for (const dependency of bottle.dependencies) {
      const selected = byFullName.get(dependency.fullName);
      if (!selected) {
        fail(
          `Homebrew bottle selection dependency ${dependency.fullName} of ` +
            `${bottle.fullName} is a missing dependency node`,
        );
      }
      if (!sameDependencyIdentity(dependency, selected)) {
        fail(
          `Homebrew bottle selection dependency ${dependency.fullName} of ` +
            `${bottle.fullName} identity does not match the selected descriptor`,
        );
      }
    }
  }

  assertAcyclic(bottles, byFullName);
  const indexByFullName = new Map(
    bottles.map((bottle, index) => [bottle.fullName, index] as const),
  );
  for (const [consumerIndex, bottle] of bottles.entries()) {
    for (const dependency of bottle.dependencies) {
      if (indexByFullName.get(dependency.fullName)! >= consumerIndex) {
        fail(
          `Homebrew bottle selection dependency ${dependency.fullName} is listed after its ` +
            `consumer ${bottle.fullName}`,
        );
      }
    }
  }
}

function assertSortedDependencies(bottle: HomebrewBottleDescriptor): void {
  for (let index = 1; index < bottle.dependencies.length; index += 1) {
    if (
      compareHomebrewCanonicalText(
        bottle.dependencies[index - 1]!.fullName,
        bottle.dependencies[index]!.fullName,
      ) >= 0
    ) {
      fail(`${bottle.fullName} dependencies must be sorted by canonical full name`);
    }
  }
}

function assertAcyclic(
  bottles: readonly HomebrewBottleDescriptor[],
  byFullName: ReadonlyMap<string, HomebrewBottleDescriptor>,
): void {
  const remainingDependencies = new Map(
    bottles.map((bottle) => [bottle.fullName, bottle.dependencies.length] as const),
  );
  const consumers = new Map<string, string[]>();
  for (const bottle of bottles) {
    for (const dependency of bottle.dependencies) {
      const selected = byFullName.get(dependency.fullName)!;
      const entries = consumers.get(selected.fullName) ?? [];
      entries.push(bottle.fullName);
      consumers.set(selected.fullName, entries);
    }
  }
  const ready = bottles
    .filter((bottle) => bottle.dependencies.length === 0)
    .map((bottle) => bottle.fullName);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const dependency = ready[cursor]!;
    visited += 1;
    for (const consumer of consumers.get(dependency) ?? []) {
      const remaining = remainingDependencies.get(consumer)! - 1;
      remainingDependencies.set(consumer, remaining);
      if (remaining === 0) ready.push(consumer);
    }
  }
  if (visited !== bottles.length) {
    fail("Homebrew bottle selection has a dependency cycle");
  }
}

function sameDependencyIdentity(
  dependency: HomebrewBottleDependencyIdentity,
  selected: HomebrewBottleDescriptor,
): boolean {
  return dependency.fullName === selected.fullName &&
    dependency.version === selected.version &&
    dependency.revision === selected.revision &&
    dependency.bottleRebuild === selected.bottleRebuild &&
    dependency.bottleSha256 === selected.sha256;
}

function bottleArch(value: unknown, label: string): HomebrewBottleArch {
  if (value === "wasm32" || value === "wasm64") return value;
  fail(`${label} must be wasm32 or wasm64`);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
  try {
    assertHomebrewCanonicalText(value);
  } catch {
    fail(`${label} must contain Unicode scalar values`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) {
    fail(`${label} has unknown or missing fields`);
  }
  return record;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "string") {
    assertHomebrewCanonicalText(value);
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareHomebrewCanonicalText(left, right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function fail(message: string): never {
  throw new HomebrewBottleSelectionError(message);
}
