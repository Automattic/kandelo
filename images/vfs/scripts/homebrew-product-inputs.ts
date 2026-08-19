import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  parseHomebrewOriginalBottleTreeDescriptor,
  registerHomebrewDeferredTreeCollection,
  type HomebrewOriginalBottleTreeDescriptorV1,
} from "../../../host/src/homebrew-runtime-layer-consumer";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import type { VfsProductBuild } from "./vfs-product-builder-contract";

const HOMEBREW_PREFIX = "/opt/kandelo/homebrew";
const FORMULA = /^[a-z0-9][a-z0-9@+._-]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;

export interface AppliedHomebrewProductInput {
  readonly formula: string;
  readonly package: string;
  readonly keg: string;
  readonly placement: "embedded" | "lazy-reference";
  readonly descriptor: HomebrewOriginalBottleTreeDescriptorV1;
  bin(command: string): string;
  sbin(command: string): string;
  path(relativePath: string): string;
}

interface ParsedBottleInputBase {
  descriptor: HomebrewOriginalBottleTreeDescriptorV1;
}

type ParsedBottleInput =
  | ParsedBottleInputBase & {
      placement: "embedded";
      path: string;
    }
  | ParsedBottleInputBase & {
      placement: "lazy-reference";
    };

/**
 * Register one product's exact Homebrew bottle closure in its output VFS.
 * Embedded bottles materialize immediately; lazy bottles retain only their
 * authenticated deferred-tree descriptor and transport.
 */
export async function applyHomebrewProductInputs(
  fs: MemoryFileSystem,
  build: VfsProductBuild,
  directFormulae: ReadonlySet<string>,
): Promise<Map<string, AppliedHomebrewProductInput>> {
  if (directFormulae.size === 0) {
    throw new Error(`${build.product.id} Homebrew direct Formula set is empty`);
  }
  for (const formula of directFormulae) {
    if (!FORMULA.test(formula)) {
      throw new Error(`${build.product.id} has invalid Homebrew root ${formula}`);
    }
  }

  const namespace = `homebrew-tap-core-abi-${build.targetAbi.version}` +
    (build.referenceClass === "candidate" ? "-candidates" : "");
  const parsed: ParsedBottleInput[] = [];
  const formulae = new Set<string>();
  for (const inputId of build.inputIds("homebrew-bottle")) {
    const input = build.requireHomebrewBottle(inputId);
    if (input.placement !== "embedded" && input.placement !== "lazy-reference") {
      throw new Error(`${build.product.id} Homebrew input ${inputId} is build-only`);
    }
    if (input.descriptor === undefined) {
      throw new Error(`${build.product.id} Homebrew input ${inputId} has no descriptor`);
    }
    assertManagedNamespace(input.descriptor.reference, namespace, inputId);
    const untrusted = readDescriptor(input.descriptor.path, inputId);
    const formula = descriptorFormula(untrusted, inputId);
    if (formulae.has(formula)) {
      throw new Error(`${build.product.id} duplicates Homebrew Formula ${formula}`);
    }
    formulae.add(formula);
    const descriptor = parseHomebrewOriginalBottleTreeDescriptor(untrusted, {
      architecture: build.product.architecture,
      tap: "kandelo-dev/homebrew-tap-core",
      formula,
      package: `kandelo-dev/tap-core/${formula}`,
      bottle: { sha256: input.sha256, bytes: input.bytes },
      allowedRoots: directFormulae,
    });
    for (const transport of descriptor.tree.transports) {
      assertManagedNamespace(transport.url, namespace, `${inputId} transport`);
    }
    parsed.push(input.placement === "embedded"
      ? {
          placement: "embedded",
          path: input.path,
          descriptor,
        }
      : {
          placement: "lazy-reference",
          descriptor,
        });
  }
  for (const formula of directFormulae) {
    if (!formulae.has(formula)) {
      throw new Error(`${build.product.id} omits direct Homebrew Formula ${formula}`);
    }
  }
  if (parsed.length === 0) {
    throw new Error(`${build.product.id} has no Homebrew bottle inputs`);
  }

  const registered = registerHomebrewDeferredTreeCollection({
    fs,
    id: `${build.product.id}-homebrew`,
    schema: 6,
    trees: parsed.map((item) => item.descriptor.tree),
  });
  const registeredByPackage = new Map(
    registered.map((item) => [item.package, item]),
  );
  if (registeredByPackage.size !== parsed.length) {
    throw new Error(`${build.product.id} Homebrew registration is not one tree per Formula`);
  }

  const result = new Map<string, AppliedHomebrewProductInput>();
  for (const item of parsed) {
    const packageName = item.descriptor.tree.package!;
    const tree = registeredByPackage.get(packageName);
    if (tree === undefined) {
      throw new Error(`${build.product.id} did not register ${item.descriptor.formula}`);
    }
    if (item.placement === "embedded") {
      const changed = await fs.materializeRegisteredDeferredTree(
        tree.materialization,
        new Uint8Array(readFileSync(item.path)),
      );
      if (!changed) {
        throw new Error(
          `${build.product.id} Homebrew Formula ${item.descriptor.formula} was already materialized`,
        );
      }
    }
    result.set(
      item.descriptor.formula,
      productInputIdentity(item.descriptor, item.placement),
    );
  }
  return result;
}

function productInputIdentity(
  descriptor: HomebrewOriginalBottleTreeDescriptorV1,
  placement: "embedded" | "lazy-reference",
): AppliedHomebrewProductInput {
  const roots = descriptor.tree.activation.roots;
  if (roots.length !== 1) {
    throw new Error(`${descriptor.formula} bottle must declare one keg root`);
  }
  const keg = roots[0]!;
  const expectedKegPrefix = `${HOMEBREW_PREFIX}/Cellar/${descriptor.formula}/`;
  if (!keg.startsWith(expectedKegPrefix)) {
    throw new Error(`${descriptor.formula} bottle keg leaves its Formula Cellar`);
  }
  const entries = new Map(
    descriptor.tree.inventory.entries.map((entry) => [`/${entry.path}`, entry]),
  );
  const relativePath = (value: string): string => {
    if (
      value.length === 0 ||
      value.startsWith("/") ||
      value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new Error(`${descriptor.formula} bottle path is not canonical: ${value}`);
    }
    const path = `${keg}/${value}`;
    if (!entries.has(path)) {
      throw new Error(`${descriptor.formula} bottle does not own ${path}`);
    }
    return path;
  };
  const publicProgram = (directory: "bin" | "sbin", command: string): string => {
    if (!PATH_SEGMENT.test(command)) {
      throw new Error(`${descriptor.formula} command is invalid: ${command}`);
    }
    const path = `${HOMEBREW_PREFIX}/${directory}/${command}`;
    const entry = entries.get(path);
    if (
      entry === undefined ||
      (entry.type !== "file" && entry.type !== "hardlink" && entry.type !== "symlink") ||
      (entry.mode & 0o111) === 0
    ) {
      throw new Error(`${descriptor.formula} bottle has no executable ${path}`);
    }
    if (entry.type === "symlink") {
      const target = posix.resolve(posix.dirname(path), entry.target!);
      if (target !== keg && !target.startsWith(`${keg}/`)) {
        throw new Error(`${descriptor.formula} public executable leaves its keg: ${path}`);
      }
    }
    return path;
  };
  return Object.freeze({
    formula: descriptor.formula,
    package: descriptor.tree.package!,
    keg,
    placement,
    descriptor,
    bin: (command: string) => publicProgram("bin", command),
    sbin: (command: string) => publicProgram("sbin", command),
    path: relativePath,
  });
}

function readDescriptor(path: string, inputId: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${inputId} Homebrew descriptor is not valid JSON`, {
      cause: error,
    });
  }
}

function descriptorFormula(value: unknown, inputId: string): string {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !FORMULA.test(String((value as Record<string, unknown>).formula ?? ""))
  ) {
    throw new Error(`${inputId} Homebrew descriptor has an invalid Formula`);
  }
  return (value as { formula: string }).formula;
}

function assertManagedNamespace(
  reference: string,
  namespace: string,
  label: string,
): void {
  if (!reference.includes(`/${namespace}/`)) {
    throw new Error(`${label} leaves its exact target ABI namespace ${namespace}`);
  }
}
