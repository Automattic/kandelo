/**
 * Closed byte transformations for one authenticated archive tree.
 *
 * Producers own path and packaging policy. This module only validates exact
 * source identities, applies bounded byte replacements, and leaves callers to
 * verify the declared output identity before publication.
 */

import { VFS_DEFERRED_TREE_LIMITS } from "./deferred-tree-limits";
import {
  assertUnicodeScalarText,
  compareUnicodeScalarText,
} from "./canonical-text";

export interface LazyTreeMaterializationSourceEntry {
  sourcePath: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  size: number;
}

export interface LazyTreeMaterializationSourceInventory {
  entries: readonly LazyTreeMaterializationSourceEntry[];
}

export interface LazyTreeByteIdentity {
  sha256: string;
  bytes: number;
}

export interface LazyTreeSourceAssertion {
  sourcePath: string;
  bytesHex: string;
}

export interface LazyTreeByteReplacement {
  matchHex: string;
  replacementHex: string;
}

export interface LazyTreeByteTransformRecipe {
  id: string;
  replacements: readonly LazyTreeByteReplacement[];
  rejectHex: readonly string[];
}

export interface LazyTreeByteTransform {
  sourcePath: string;
  recipe: string;
  input: LazyTreeByteIdentity;
  output: LazyTreeByteIdentity;
}

export interface LazyTreeMaterializationPlan {
  schema: 1;
  kind: "archive-byte-transforms-v1";
  assertions: readonly LazyTreeSourceAssertion[];
  recipes: readonly LazyTreeByteTransformRecipe[];
  transforms: readonly LazyTreeByteTransform[];
}

/** Parse and bound the generic materialization-plan wire contract. */
export function validateLazyTreeMaterializationPlan(
  value: unknown,
  inventory: LazyTreeMaterializationSourceInventory,
): LazyTreeMaterializationPlan {
  if (inventory === undefined) {
    throw new Error("Lazy tree materialization plan requires complete source truth");
  }
  if (
    !Array.isArray(inventory.entries) ||
    inventory.entries.length > VFS_DEFERRED_TREE_LIMITS.maxEntries
  ) {
    throw new Error("Lazy tree materialization source inventory is unbounded");
  }
  const sourceByPath = new Map<string, LazyTreeMaterializationSourceEntry>();
  for (const [index, entry] of inventory.entries.entries()) {
    const sourcePath = requireCanonicalSourcePath(
      entry.sourcePath,
      `Lazy tree materialization source ${index} path`,
    );
    if (sourceByPath.has(sourcePath)) {
      throw new Error(`Lazy tree materialization source repeats ${sourcePath}`);
    }
    if (
      entry.type !== "directory" && entry.type !== "file" &&
      entry.type !== "symlink" && entry.type !== "hardlink"
    ) {
      throw new Error(`Lazy tree materialization source ${sourcePath} has invalid type`);
    }
    requireInteger(
      entry.size,
      `Lazy tree materialization source ${sourcePath} byte count`,
      0,
      VFS_DEFERRED_TREE_LIMITS.maxPayloadBytes,
    );
    sourceByPath.set(sourcePath, entry);
  }

  const record = exactRecord(
    value,
    ["schema", "kind", "assertions", "recipes", "transforms"],
    "Lazy tree materialization plan",
  );
  if (record.schema !== 1 || record.kind !== "archive-byte-transforms-v1") {
    throw new Error("Lazy tree materialization plan has an unsupported identity");
  }

  let decodedPlanBytes = 0;
  const assertionPaths = new Set<string>();
  const assertions = requireArray(
    record.assertions,
    "Lazy tree materialization assertions",
    0,
    VFS_DEFERRED_TREE_LIMITS.maxMaterializationAssertions,
  ).map((value, index): LazyTreeSourceAssertion => {
    const assertion = exactRecord(
      value,
      ["sourcePath", "bytesHex"],
      `Lazy tree materialization assertion ${index}`,
    );
    const sourcePath = requireCanonicalSourcePath(
      assertion.sourcePath,
      `Lazy tree materialization assertion ${index} source path`,
    );
    if (assertionPaths.has(sourcePath)) {
      throw new Error(`Lazy tree materialization repeats assertion ${sourcePath}`);
    }
    assertionPaths.add(sourcePath);
    const source = sourceByPath.get(sourcePath);
    if (source?.type !== "file") {
      throw new Error(
        `Lazy tree materialization assertion ${sourcePath} is not a regular source`,
      );
    }
    const bytesHex = requireCanonicalHex(
      assertion.bytesHex,
      `Lazy tree materialization assertion ${sourcePath} bytes`,
      VFS_DEFERRED_TREE_LIMITS.maxMaterializationAssertionBytes,
      true,
    );
    decodedPlanBytes = addDecodedPlanBytes(
      decodedPlanBytes,
      bytesHex.length / 2,
    );
    if (bytesHex.length / 2 !== source.size) {
      throw new Error(
        `Lazy tree materialization assertion ${sourcePath} size differs from source`,
      );
    }
    return { sourcePath, bytesHex };
  });

  const recipesById = new Map<string, LazyTreeByteTransformRecipe>();
  const recipes = requireArray(
    record.recipes,
    "Lazy tree materialization recipes",
    0,
    VFS_DEFERRED_TREE_LIMITS.maxMaterializationRecipes,
  ).map((value, index): LazyTreeByteTransformRecipe => {
    const validated = validateRecipe(
      value,
      `Lazy tree materialization recipe ${index}`,
    );
    if (recipesById.has(validated.recipe.id)) {
      throw new Error(`Lazy tree materialization duplicates recipe ${validated.recipe.id}`);
    }
    decodedPlanBytes = addDecodedPlanBytes(
      decodedPlanBytes,
      validated.decodedBytes,
    );
    recipesById.set(validated.recipe.id, validated.recipe);
    return validated.recipe;
  });

  const transformPaths = new Set<string>();
  const usedRecipes = new Set<string>();
  const transforms = requireArray(
    record.transforms,
    "Lazy tree materialization transforms",
    0,
    VFS_DEFERRED_TREE_LIMITS.maxMaterializationTransforms,
  ).map((value, index): LazyTreeByteTransform => {
    const transform = exactRecord(
      value,
      ["sourcePath", "recipe", "input", "output"],
      `Lazy tree materialization transform ${index}`,
    );
    const sourcePath = requireCanonicalSourcePath(
      transform.sourcePath,
      `Lazy tree materialization transform ${index} source path`,
    );
    if (transformPaths.has(sourcePath)) {
      throw new Error(`Lazy tree materialization repeats transform ${sourcePath}`);
    }
    transformPaths.add(sourcePath);
    const source = sourceByPath.get(sourcePath);
    if (source?.type !== "file") {
      throw new Error(
        `Lazy tree materialization transform ${sourcePath} is not a regular source`,
      );
    }
    const recipe = requireString(
      transform.recipe,
      `Lazy tree materialization transform ${sourcePath} recipe`,
      VFS_DEFERRED_TREE_LIMITS.maxStringBytes,
    );
    if (!recipesById.has(recipe)) {
      throw new Error(
        `Lazy tree materialization transform ${sourcePath} has no recipe ${recipe}`,
      );
    }
    usedRecipes.add(recipe);
    const input = validateByteIdentity(
      transform.input,
      `Lazy tree materialization transform ${sourcePath} input`,
    );
    const output = validateByteIdentity(
      transform.output,
      `Lazy tree materialization transform ${sourcePath} output`,
    );
    if (input.bytes !== source.size) {
      throw new Error(
        `Lazy tree materialization transform ${sourcePath} input size differs from source`,
      );
    }
    return { sourcePath, recipe, input, output };
  });

  if (assertions.length === 0 && transforms.length === 0) {
    throw new Error("Lazy tree materialization plan has no assertions or transforms");
  }
  if (recipes.some((recipe) => !usedRecipes.has(recipe.id))) {
    throw new Error("Lazy tree materialization plan contains an unused recipe");
  }
  if (
    !isCanonical(assertions.map((assertion) => assertion.sourcePath)) ||
    !isCanonical(recipes.map((recipe) => recipe.id)) ||
    !isCanonical(transforms.map((transform) => transform.sourcePath))
  ) {
    throw new Error("Lazy tree materialization plan is not in canonical order");
  }

  return {
    schema: 1,
    kind: "archive-byte-transforms-v1",
    assertions,
    recipes,
    transforms,
  };
}

/** Encode arbitrary bytes in the canonical lowercase wire form. */
export function encodeMaterializationBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Decode a canonical bounded wire byte string. */
export function decodeMaterializationBytes(hex: string): Uint8Array {
  const canonical = requireCanonicalHex(
    hex,
    "Materialization bytes",
    VFS_DEFERRED_TREE_LIMITS.maxMaterializationDecodedBytes,
    true,
  );
  const bytes = new Uint8Array(canonical.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(canonical.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Apply one closed recipe under the global deferred-tree byte limit. */
export function applyLazyTreeByteTransformRecipe(
  source: Uint8Array,
  recipe: LazyTreeByteTransformRecipe,
): Uint8Array {
  if (source.byteLength > VFS_DEFERRED_TREE_LIMITS.maxPayloadBytes) {
    throw new Error("Lazy tree byte transform exceeds its source-byte limit");
  }
  const validated = validateRecipe(recipe, "Lazy tree byte transform recipe").recipe;
  let transformed = source;
  for (const replacement of validated.replacements) {
    transformed = replaceBytesBounded(
      transformed,
      decodeMaterializationBytes(replacement.matchHex),
      decodeMaterializationBytes(replacement.replacementHex),
    );
  }
  for (const rejected of validated.rejectHex) {
    if (containsBytes(transformed, decodeMaterializationBytes(rejected))) {
      throw new Error(
        `Lazy tree byte transform retains rejected byte sequence ${rejected}`,
      );
    }
  }
  return transformed;
}

function validateRecipe(
  value: unknown,
  label: string,
): { recipe: LazyTreeByteTransformRecipe; decodedBytes: number } {
  const recipe = exactRecord(value, ["id", "replacements", "rejectHex"], label);
  const id = requireString(
    recipe.id,
    `${label} id`,
    VFS_DEFERRED_TREE_LIMITS.maxStringBytes,
  );
  if (!isRecipeId(id)) throw new Error(`${label} id is invalid`);
  let decodedBytes = 0;
  const replacements = requireArray(
    recipe.replacements,
    `${label} replacements`,
    0,
    VFS_DEFERRED_TREE_LIMITS.maxTransformReplacements,
  ).map((value, index): LazyTreeByteReplacement => {
    const replacement = exactRecord(
      value,
      ["matchHex", "replacementHex"],
      `${label} replacement ${index}`,
    );
    const matchHex = requireCanonicalHex(
      replacement.matchHex,
      `${label} match`,
      VFS_DEFERRED_TREE_LIMITS.maxTransformPatternBytes,
      false,
    );
    const replacementHex = requireCanonicalHex(
      replacement.replacementHex,
      `${label} replacement`,
      VFS_DEFERRED_TREE_LIMITS.maxTransformPatternBytes,
      true,
    );
    decodedBytes = addDecodedPlanBytes(
      decodedBytes,
      matchHex.length / 2 + replacementHex.length / 2,
    );
    return { matchHex, replacementHex };
  });
  const rejectHex = requireArray(
    recipe.rejectHex,
    `${label} rejected patterns`,
    0,
    VFS_DEFERRED_TREE_LIMITS.maxTransformReplacements,
  ).map((value, index) => {
    const pattern = requireCanonicalHex(
      value,
      `${label} rejected pattern ${index}`,
      VFS_DEFERRED_TREE_LIMITS.maxTransformPatternBytes,
      false,
    );
    decodedBytes = addDecodedPlanBytes(decodedBytes, pattern.length / 2);
    return pattern;
  });
  if (
    replacements.length === 0 && rejectHex.length === 0 ||
    new Set(rejectHex).size !== rejectHex.length
  ) {
    throw new Error(`${label} is empty or ambiguous`);
  }
  return { recipe: { id, replacements, rejectHex }, decodedBytes };
}

function replaceBytesBounded(
  source: Uint8Array,
  match: Uint8Array,
  replacement: Uint8Array,
): Uint8Array {
  let count = 0;
  for (let offset = 0; offset <= source.byteLength - match.byteLength;) {
    if (bytesEqualAt(source, match, offset)) {
      count += 1;
      offset += match.byteLength;
    } else {
      offset += 1;
    }
  }
  if (count === 0) return source;
  const delta = replacement.byteLength - match.byteLength;
  const outputBytes = source.byteLength + count * delta;
  if (
    !Number.isSafeInteger(outputBytes) || outputBytes < 0 ||
    outputBytes > VFS_DEFERRED_TREE_LIMITS.maxPayloadBytes
  ) {
    throw new Error("Lazy tree byte transform exceeds its transformed-byte limit");
  }
  const output = new Uint8Array(outputBytes);
  let sourceOffset = 0;
  let outputOffset = 0;
  while (sourceOffset < source.byteLength) {
    if (bytesEqualAt(source, match, sourceOffset)) {
      output.set(replacement, outputOffset);
      sourceOffset += match.byteLength;
      outputOffset += replacement.byteLength;
    } else {
      output[outputOffset] = source[sourceOffset]!;
      sourceOffset += 1;
      outputOffset += 1;
    }
  }
  return output;
}

function containsBytes(source: Uint8Array, match: Uint8Array): boolean {
  if (match.byteLength > source.byteLength) return false;
  for (let offset = 0; offset <= source.byteLength - match.byteLength; offset += 1) {
    if (bytesEqualAt(source, match, offset)) return true;
  }
  return false;
}

function bytesEqualAt(
  source: Uint8Array,
  match: Uint8Array,
  offset: number,
): boolean {
  if (offset + match.byteLength > source.byteLength) return false;
  for (let index = 0; index < match.byteLength; index += 1) {
    if (source[offset + index] !== match[index]) return false;
  }
  return true;
}

function validateByteIdentity(
  value: unknown,
  label: string,
): LazyTreeByteIdentity {
  const record = exactRecord(value, ["sha256", "bytes"], label);
  if (typeof record.sha256 !== "string" || !isLowerHex(record.sha256, 64)) {
    throw new Error(`${label} has an invalid SHA-256 digest`);
  }
  return {
    sha256: record.sha256,
    bytes: requireInteger(
      record.bytes,
      `${label} byte count`,
      0,
      VFS_DEFERRED_TREE_LIMITS.maxPayloadBytes,
    ),
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function requireArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} items`);
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid or exceeds ${maximumBytes} bytes`);
  }
  assertUnicodeScalarText(value, label);
  if (
    value.length === 0 || value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error(`${label} is invalid or exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function requireCanonicalHex(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    value.length % 2 !== 0 || value.length / 2 > maximumBytes ||
    !isLowerHex(value)
  ) {
    throw new Error(`${label} is not canonical bounded hexadecimal bytes`);
  }
  return value;
}

function requireCanonicalSourcePath(value: unknown, label: string): string {
  const path = requireString(value, label, VFS_DEFERRED_TREE_LIMITS.maxPathBytes);
  if (
    path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`${label} is not a canonical relative path`);
  }
  return path;
}

function addDecodedPlanBytes(current: number, additional: number): number {
  const total = current + additional;
  if (
    !Number.isSafeInteger(total) ||
    total > VFS_DEFERRED_TREE_LIMITS.maxMaterializationDecodedBytes
  ) {
    throw new Error("Lazy tree materialization plan exceeds its decoded byte limit");
  }
  return total;
}

function isCanonical(values: readonly string[]): boolean {
  return values.every((value, index) =>
    index === 0 || compareUnicodeScalarText(values[index - 1]!, value) < 0
  );
}

function isRecipeId(value: string): boolean {
  if (!isLowerLetterOrDigit(value.charCodeAt(0))) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !isLowerLetterOrDigit(code) && code !== 0x3a && code !== 0x2e &&
      code !== 0x5f && code !== 0x2d
    ) return false;
  }
  return true;
}

function isLowerLetterOrDigit(code: number): boolean {
  return code >= 0x61 && code <= 0x7a || code >= 0x30 && code <= 0x39;
}

function isLowerHex(value: string, exactLength?: number): boolean {
  if (exactLength !== undefined && value.length !== exactLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(code >= 0x30 && code <= 0x39) &&
      !(code >= 0x61 && code <= 0x66)
    ) return false;
  }
  return true;
}
