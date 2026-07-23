import { compareHomebrewCanonicalText } from "./homebrew-lazy-layer-descriptor";
import { HOMEBREW_RUNTIME_LAYER_LIMITS } from "./homebrew-runtime-layer-limits";
import { mapHomebrewBottleEntryToGuestPath } from "./homebrew-vfs-builder";
import type {
  HomebrewFederatedVfsPlan,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "./homebrew-vfs-planner";
import type { TarEntry } from "./vfs/tar";

export const HOMEBREW_VFS_FORMULA_LAYER_KIND =
  "kandelo-homebrew-vfs-formula-layer" as const;
export const HOMEBREW_VFS_FORMULA_MANIFEST_RELATIVE_PATH =
  "share/kandelo/vfs-layer.json" as const;
export const HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH =
  "libexec/kandelo-vfs-layer/rootfs" as const;

const MAX_MANIFEST_BYTES = 64 * 1024;
const FULL_PACKAGE_RE =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9._:-]*$/;

export interface HomebrewVfsFormulaLayerManifest {
  schema: 1;
  kind: typeof HOMEBREW_VFS_FORMULA_LAYER_KIND;
  package: string;
  payload: {
    root: typeof HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH;
    mount_prefix: "/";
  };
  activation: {
    mode: "boot-prefetch" | "first-use";
    capabilities: string[];
    roots: string[];
  };
}

/**
 * One bottle-owned object projected from the fixed private payload subtree to
 * its final guest path. The source path remains the original bottle TAR member;
 * immutable runtime descriptors and release URLs are derived later.
 */
export interface HomebrewVfsFormulaLayerEntry {
  path: string;
  source_path: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  size: number;
  /** Symlink text, or the absolute final guest path for a hard link. */
  target?: string;
}

export interface HomebrewVfsFormulaLayerProjection {
  manifest: HomebrewVfsFormulaLayerManifest;
  rootPackage: HomebrewVfsPackagePlan;
  /** Exact dependency-first closure, including the root Formula last. */
  packages: HomebrewVfsPackagePlan[];
  /** Ordinary Formula dependencies; this is deliberately not duplicated in the manifest. */
  dependencies: HomebrewVfsPackagePlan[];
  entries: HomebrewVfsFormulaLayerEntry[];
}

export interface HomebrewVfsFormulaLayerComposition {
  /** Canonical full-package order, independent of caller selection order. */
  layers: HomebrewVfsFormulaLayerProjection[];
  /** Every package owned by exactly one selected layer. */
  packageOrder: string[];
  /** Canonical target inventory after cross-layer ownership preflight. */
  entries: Array<HomebrewVfsFormulaLayerEntry & { package: string }>;
}

/**
 * Parse the closed, URL-free manifest installed by a VFS Formula.
 *
 * Formula dependencies remain authoritative in Homebrew metadata. Repeating
 * them here would create a second dependency graph that can drift.
 */
export function parseHomebrewVfsFormulaLayerManifest(
  value: unknown,
): HomebrewVfsFormulaLayerManifest {
  const root = exactRecord(
    value,
    ["schema", "kind", "package", "payload", "activation"],
    "Homebrew VFS Formula layer manifest",
  );
  if (root.schema !== 1 || root.kind !== HOMEBREW_VFS_FORMULA_LAYER_KIND) {
    throw new Error(
      "Homebrew VFS Formula layer manifest has an unsupported identity",
    );
  }
  const packageName = requireFullPackageName(
    root.package,
    "Homebrew VFS Formula layer package",
  );
  const payload = exactRecord(
    root.payload,
    ["root", "mount_prefix"],
    "Homebrew VFS Formula layer payload",
  );
  if (
    payload.root !== HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH ||
    payload.mount_prefix !== "/"
  ) {
    throw new Error(
      "Homebrew VFS Formula layer payload must use the conventional keg root and / mount",
    );
  }
  const activation = exactRecord(
    root.activation,
    ["mode", "capabilities", "roots"],
    "Homebrew VFS Formula layer activation",
  );
  if (activation.mode !== "boot-prefetch" && activation.mode !== "first-use") {
    throw new Error("Homebrew VFS Formula layer activation mode is invalid");
  }
  const capabilities = requireCanonicalStringArray(
    activation.capabilities,
    "Homebrew VFS Formula layer activation capabilities",
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilities,
    (capability) =>
      CAPABILITY_RE.test(capability) &&
      encodedLength(capability) <=
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilityBytes,
  );
  const roots = requireCanonicalStringArray(
    activation.roots,
    "Homebrew VFS Formula layer activation roots",
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationRoots,
    canonicalAbsolutePath,
  );

  return {
    schema: 1,
    kind: HOMEBREW_VFS_FORMULA_LAYER_KIND,
    package: packageName,
    payload: {
      root: HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH,
      mount_prefix: "/",
    },
    activation: {
      mode: activation.mode,
      capabilities,
      roots,
    },
  };
}

/**
 * Bind one resolved, single-root Homebrew closure to the manifest and payload
 * carried by its root Formula bottle.
 *
 * This is producer-side source truth. It does not create a runtime descriptor,
 * choose a public mirror, or mutate a filesystem.
 */
export function projectHomebrewVfsFormulaLayer(
  plan: HomebrewVfsPlan,
  rootPackage: string,
  bottleEntries: readonly TarEntry[],
): HomebrewVfsFormulaLayerProjection {
  const packages = validateSingleRootClosure(plan, rootPackage);
  const root = packages[packages.length - 1]!;
  const guestEntries = indexBottleGuestEntries(root, bottleEntries);
  const manifestPath = `${root.keg}/${HOMEBREW_VFS_FORMULA_MANIFEST_RELATIVE_PATH}`;
  const manifestSource = guestEntries.get(manifestPath);
  if (manifestSource === undefined) {
    throw new Error(
      `Homebrew VFS Formula ${root.fullName} is missing ${manifestPath}`,
    );
  }
  if (
    manifestSource.type !== "file" ||
    manifestSource.data.byteLength === 0 ||
    manifestSource.data.byteLength > MAX_MANIFEST_BYTES
  ) {
    throw new Error(
      `Homebrew VFS Formula ${root.fullName} manifest must be a regular file ` +
        `between 1 and ${MAX_MANIFEST_BYTES} bytes`,
    );
  }

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestSource.data),
    );
  } catch (error) {
    throw new Error(
      `Homebrew VFS Formula ${root.fullName} manifest is not valid UTF-8 JSON: ` +
        errorMessage(error),
    );
  }
  const manifest = parseHomebrewVfsFormulaLayerManifest(manifestValue);
  if (manifest.package !== root.fullName) {
    throw new Error(
      `Homebrew VFS Formula manifest names ${manifest.package}, expected ${root.fullName}`,
    );
  }

  const payloadRoot = `${root.keg}/${HOMEBREW_VFS_FORMULA_PAYLOAD_RELATIVE_PATH}`;
  const payloadSource = guestEntries.get(payloadRoot);
  if (payloadSource?.type !== "directory") {
    throw new Error(
      `Homebrew VFS Formula ${root.fullName} payload root must be a directory at ${payloadRoot}`,
    );
  }
  const entries = projectPayloadEntries(root, payloadRoot, guestEntries);
  validateActivationOwnership(manifest, entries);

  return {
    manifest,
    rootPackage: root,
    packages,
    dependencies: packages.slice(0, -1),
    entries,
  };
}

/**
 * Canonicalize selected VFS Formula layers and reject package/path ownership
 * conflicts before a descriptor builder or staged filesystem can mutate state.
 *
 * The runtime consumer repeats this check against the exact base filesystem
 * and publishes only its successfully staged result.
 */
export function preflightHomebrewVfsFormulaLayers(
  selected: readonly HomebrewVfsFormulaLayerProjection[],
): HomebrewVfsFormulaLayerComposition {
  if (
    selected.length === 0 ||
    selected.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxLayers
  ) {
    throw new Error(
      `Homebrew VFS Formula composition must contain 1 to ` +
        `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxLayers} layers`,
    );
  }
  const layers = [...selected].sort((left, right) =>
    compareHomebrewCanonicalText(
      left.rootPackage.fullName,
      right.rootPackage.fullName,
    ),
  );
  const packageOwner = new Map<
    string,
    { owner: string; package: HomebrewVfsPackagePlan }
  >();
  const pathOwner = new Map<
    string,
    HomebrewVfsFormulaLayerEntry & { package: string }
  >();

  for (const layer of layers) {
    const owner = layer.rootPackage.fullName;
    for (const pkg of layer.packages) {
      const prior = packageOwner.get(pkg.fullName);
      if (prior !== undefined) {
        if (!sameHomebrewPackageIdentity(prior.package, pkg)) {
          throw new Error(
            `Homebrew VFS Formula layers ${prior.owner} and ${owner} resolve ` +
              `${pkg.fullName} to different immutable package identities`,
          );
        }
        continue;
      }
      packageOwner.set(pkg.fullName, { owner, package: pkg });
    }
    for (const entry of layer.entries) {
      const candidate = { ...entry, package: owner };
      const prior = pathOwner.get(entry.path);
      if (prior !== undefined) {
        const mergeableDirectory =
          prior.type === "directory" &&
          entry.type === "directory" &&
          prior.mode === entry.mode;
        if (!mergeableDirectory) {
          throw new Error(
            `Homebrew VFS Formula layers ${prior.package} and ${owner} ` +
              `conflict at ${entry.path}`,
          );
        }
        continue;
      }
      pathOwner.set(entry.path, candidate);
    }
  }

  for (const [path, entry] of pathOwner) {
    for (const ancestor of ancestorPaths(path)) {
      const ownedAncestor = pathOwner.get(ancestor);
      if (ownedAncestor !== undefined && ownedAncestor.type !== "directory") {
        throw new Error(
          `Homebrew VFS Formula layer ${entry.package} path ${path} descends ` +
            `through non-directory ${ancestor} owned by ${ownedAncestor.package}`,
        );
      }
    }
  }

  return {
    layers,
    packageOrder: [...packageOwner.keys()],
    entries: [...pathOwner.values()].sort((left, right) =>
      compareHomebrewCanonicalText(left.path, right.path),
    ),
  };
}

/**
 * Two selected layers may share an ordinary Formula dependency only when both
 * immutable plans name the exact same bottle, link projection, and provenance.
 * The bottle digest alone is insufficient because tap metadata owns the guest
 * link manifest and dependency closure as well as the archive bytes.
 */
function sameHomebrewPackageIdentity(
  left: HomebrewVfsPackagePlan,
  right: HomebrewVfsPackagePlan,
): boolean {
  return (
    JSON.stringify(packageIdentity(left)) ===
    JSON.stringify(packageIdentity(right))
  );
}

function packageIdentity(pkg: HomebrewVfsPackagePlan): unknown[] {
  return [
    pkg.name,
    pkg.fullName,
    pkg.tapRepository,
    pkg.tapName,
    pkg.tapCommit,
    pkg.kandeloRepository,
    pkg.kandeloCommit,
    pkg.version,
    pkg.formulaRevision,
    pkg.bottleRebuild,
    pkg.arch,
    pkg.kandeloAbi,
    pkg.metadataStatus,
    pkg.sourceStatus,
    pkg.url,
    pkg.sha256,
    pkg.bytes,
    pkg.cacheKeySha,
    pkg.prefix,
    pkg.cellar,
    pkg.keg,
    pkg.payloadRoot,
    pkg.linkManifestPath,
    pkg.linkManifest,
    pkg.dependencies,
    pkg.runtimeSupport,
    pkg.browserCompatible,
    pkg.builtFrom ?? null,
  ];
}

function validateSingleRootClosure(
  plan: HomebrewVfsPlan,
  rootFullName: string,
): HomebrewVfsPackagePlan[] {
  requireFullPackageName(rootFullName, "Homebrew VFS Formula root package");
  if (!Array.isArray(plan.packages) || plan.packages.length === 0) {
    throw new Error("Homebrew VFS Formula plan has no packages");
  }
  if (plan.packages.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages) {
    throw new Error("Homebrew VFS Formula plan exceeds the package-count cap");
  }

  const byFullName = new Map<string, HomebrewVfsPackagePlan>();
  const indexByFullName = new Map<string, number>();
  for (const [index, pkg] of plan.packages.entries()) {
    const fullName = requireFullPackageName(
      pkg.fullName,
      `Homebrew VFS Formula plan package ${index}`,
    );
    const parts = fullName.split("/");
    if (pkg.tapName !== `${parts[0]}/${parts[1]}` || pkg.name !== parts[2]) {
      throw new Error(
        `Homebrew VFS Formula plan package ${fullName} differs from its tap or name`,
      );
    }
    if (byFullName.has(pkg.fullName)) {
      throw new Error(
        `Homebrew VFS Formula plan duplicates package ${pkg.fullName}`,
      );
    }
    byFullName.set(pkg.fullName, pkg);
    indexByFullName.set(pkg.fullName, index);
  }
  const root = byFullName.get(rootFullName);
  if (root === undefined) {
    throw new Error(
      `Homebrew VFS Formula root ${rootFullName} is absent from its plan`,
    );
  }
  const requestedFullNames =
    "requestedFullNames" in plan
      ? (plan as HomebrewFederatedVfsPlan).requestedFullNames
      : plan.requestedPackages.map((name) => `${plan.tapName}/${name}`);
  if (
    requestedFullNames.length !== 1 ||
    requestedFullNames[0] !== rootFullName
  ) {
    throw new Error(
      `Homebrew VFS Formula plan must request only ${rootFullName}`,
    );
  }

  const dependencies = new Map<string, string[]>();
  for (const [index, pkg] of plan.packages.entries()) {
    const fullNames = pkg.dependencies.map((dependency) => {
      const fullName =
        dependency.full_name ?? `${pkg.tapName}/${dependency.name}`;
      const parsedName = requireFullPackageName(
        fullName,
        `Homebrew VFS Formula dependency of ${pkg.fullName}`,
      ).split("/")[2]!;
      if (parsedName !== dependency.name) {
        throw new Error(
          `Homebrew VFS Formula dependency ${fullName} does not match name ` +
            `${dependency.name}`,
        );
      }
      return fullName;
    });
    if (new Set(fullNames).size !== fullNames.length) {
      throw new Error(
        `Homebrew VFS Formula package ${pkg.fullName} duplicates a dependency`,
      );
    }
    for (const dependency of fullNames) {
      const dependencyIndex = indexByFullName.get(dependency);
      if (dependencyIndex === undefined) {
        throw new Error(
          `Homebrew VFS Formula package ${pkg.fullName} depends on missing ` +
            `${dependency}`,
        );
      }
      if (dependencyIndex >= index) {
        throw new Error(
          `Homebrew VFS Formula plan is not dependency-first at ${pkg.fullName}`,
        );
      }
    }
    dependencies.set(pkg.fullName, fullNames);
  }

  const closure = new Set<string>();
  const visit = (fullName: string) => {
    if (closure.has(fullName)) return;
    for (const dependency of dependencies.get(fullName) ?? [])
      visit(dependency);
    closure.add(fullName);
  };
  visit(rootFullName);
  if (
    closure.size !== plan.packages.length ||
    plan.packages.some((pkg) => !closure.has(pkg.fullName))
  ) {
    throw new Error(
      "Homebrew VFS Formula plan contains packages outside its root dependency closure",
    );
  }
  if (plan.packages[plan.packages.length - 1] !== root) {
    throw new Error(
      `Homebrew VFS Formula root ${rootFullName} must follow its dependencies`,
    );
  }
  return [...plan.packages];
}

function indexBottleGuestEntries(
  pkg: HomebrewVfsPackagePlan,
  entries: readonly TarEntry[],
): Map<string, TarEntry> {
  const sources = new Set<string>();
  const byGuestPath = new Map<string, TarEntry>();
  for (const entry of entries) {
    if (sources.has(entry.path)) {
      throw new Error(
        `Homebrew VFS Formula ${pkg.fullName} bottle duplicates source ${entry.path}`,
      );
    }
    sources.add(entry.path);
    const guestPath = mapHomebrewBottleEntryToGuestPath(pkg, entry.path);
    if (guestPath === null) continue;
    if (byGuestPath.has(guestPath)) {
      throw new Error(
        `Homebrew VFS Formula ${pkg.fullName} bottle maps multiple entries to ${guestPath}`,
      );
    }
    byGuestPath.set(guestPath, entry);
  }
  return byGuestPath;
}

function projectPayloadEntries(
  pkg: HomebrewVfsPackagePlan,
  payloadRoot: string,
  guestEntries: ReadonlyMap<string, TarEntry>,
): HomebrewVfsFormulaLayerEntry[] {
  const payloadPrefix = `${payloadRoot}/`;
  const projected: HomebrewVfsFormulaLayerEntry[] = [];
  const projectedBySource = new Map<string, HomebrewVfsFormulaLayerEntry>();
  const sourceByPath = new Map<string, TarEntry>();
  let aggregatePayloadBytes = 0;

  for (const [guestPath, source] of guestEntries) {
    sourceByPath.set(source.path, source);
    if (!guestPath.startsWith(payloadPrefix)) continue;
    const relativePath = guestPath.slice(payloadPrefix.length);
    const path = requireAbsolutePath(
      `/${relativePath}`,
      `Homebrew VFS Formula ${pkg.fullName} payload target`,
    );
    const size = source.type === "file" ? source.data.byteLength : 0;
    aggregatePayloadBytes += size;
    const entry: HomebrewVfsFormulaLayerEntry = {
      path,
      source_path: source.path,
      type: source.type,
      mode: requireMode(
        source.mode,
        `Homebrew VFS Formula ${pkg.fullName} payload ${path}`,
      ),
      size,
      ...(source.type === "symlink"
        ? {
            target: requireSafeSymlinkTarget(
              source.linkName,
              path,
              pkg.fullName,
            ),
          }
        : {}),
    };
    projected.push(entry);
    projectedBySource.set(source.path, entry);
  }
  if (
    projected.length === 0 ||
    !projected.some((entry) => entry.type !== "directory")
  ) {
    throw new Error(
      `Homebrew VFS Formula ${pkg.fullName} payload has no files or links`,
    );
  }
  if (projected.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxEntries) {
    throw new Error(
      `Homebrew VFS Formula ${pkg.fullName} payload exceeds the entry-count cap`,
    );
  }
  if (
    aggregatePayloadBytes >
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxCollectionPayloadBytes
  ) {
    throw new Error(
      `Homebrew VFS Formula ${pkg.fullName} payload exceeds the byte-count cap`,
    );
  }

  const byPath = new Map(projected.map((entry) => [entry.path, entry]));
  if (byPath.size !== projected.length) {
    throw new Error(
      `Homebrew VFS Formula ${pkg.fullName} payload duplicates a target path`,
    );
  }
  for (const entry of projected) {
    for (const ancestor of ancestorPaths(entry.path)) {
      const directory = byPath.get(ancestor);
      if (directory?.type !== "directory") {
        throw new Error(
          `Homebrew VFS Formula ${pkg.fullName} payload omits directory ${ancestor}`,
        );
      }
    }
    const source = sourceByPath.get(entry.source_path);
    if (source?.type === "hardlink") {
      const target = resolvePayloadHardlink(
        source,
        sourceByPath,
        projectedBySource,
        pkg.fullName,
      );
      if (entry.mode !== target.mode) {
        throw new Error(
          `Homebrew VFS Formula ${pkg.fullName} hard link ${entry.path} ` +
            "mode differs from its regular target",
        );
      }
      entry.target = target.path;
      entry.size = target.size;
    }
  }
  projected.sort((left, right) =>
    compareHomebrewCanonicalText(left.path, right.path),
  );
  return projected;
}

function resolvePayloadHardlink(
  start: Extract<TarEntry, { type: "hardlink" }>,
  sourceByPath: ReadonlyMap<string, TarEntry>,
  projectedBySource: ReadonlyMap<string, HomebrewVfsFormulaLayerEntry>,
  packageName: string,
): HomebrewVfsFormulaLayerEntry & { type: "file" } {
  const seen = new Set<string>();
  let current: TarEntry = start;
  while (current.type === "hardlink") {
    if (seen.has(current.path)) {
      throw new Error(
        `Homebrew VFS Formula ${packageName} has a hard-link cycle at ` +
          `${current.path}`,
      );
    }
    seen.add(current.path);
    const target = sourceByPath.get(current.linkName);
    if (
      target === undefined ||
      projectedBySource.get(target.path) === undefined
    ) {
      throw new Error(
        `Homebrew VFS Formula ${packageName} hard link ${start.path} ` +
          "targets outside its payload",
      );
    }
    if (target.type !== "file" && target.type !== "hardlink") {
      throw new Error(
        `Homebrew VFS Formula ${packageName} hard link ${start.path} ` +
          "has no regular payload target",
      );
    }
    current = target;
  }
  if (current.type !== "file") {
    throw new Error(
      `Homebrew VFS Formula ${packageName} hard link ${start.path} ` +
        "has no regular payload target",
    );
  }
  return projectedBySource.get(
    current.path,
  )! as HomebrewVfsFormulaLayerEntry & {
    type: "file";
  };
}

function validateActivationOwnership(
  manifest: HomebrewVfsFormulaLayerManifest,
  entries: readonly HomebrewVfsFormulaLayerEntry[],
): void {
  for (const root of manifest.activation.roots) {
    if (
      !entries.some(
        (entry) => entry.path === root || entry.path.startsWith(`${root}/`),
      )
    ) {
      throw new Error(
        `Homebrew VFS Formula activation root ${root} owns no payload path`,
      );
    }
  }
  if (manifest.activation.mode !== "first-use") return;
  for (const entry of entries) {
    if (
      entry.type !== "directory" &&
      !manifest.activation.roots.some(
        (root) => entry.path === root || entry.path.startsWith(`${root}/`),
      )
    ) {
      throw new Error(
        `Homebrew VFS Formula first-use payload path ${entry.path} has no ` +
          "activation root",
      );
    }
  }
}

function requireSafeSymlinkTarget(
  value: string,
  path: string,
  packageName: string,
): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    hasControlCharacter(value) ||
    encodedLength(value) >
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxSymlinkTargetBytes ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    throw new Error(
      `Homebrew VFS Formula ${packageName} symlink ${path} has an unsafe target`,
    );
  }
  if (value.startsWith("/")) {
    requireAbsolutePath(
      value,
      `Homebrew VFS Formula ${packageName} symlink ${path} target`,
    );
    return value;
  }
  const resolved = path.split("/").slice(1, -1);
  for (const component of value.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (resolved.length === 0) {
        throw new Error(
          `Homebrew VFS Formula ${packageName} symlink ${path} escapes /`,
        );
      }
      resolved.pop();
    } else {
      resolved.push(component);
    }
  }
  return value;
}

function ancestorPaths(path: string): string[] {
  const components = path.split("/").slice(1);
  const ancestors: string[] = [];
  for (let length = 1; length < components.length; length += 1) {
    ancestors.push(`/${components.slice(0, length).join("/")}`);
  }
  return ancestors;
}

function canonicalAbsolutePath(value: string): boolean {
  try {
    requireAbsolutePath(value, "path");
    return true;
  } catch {
    return false;
  }
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.startsWith("/") ||
    value === "/" ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    hasControlCharacter(value) ||
    value
      .slice(1)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    encodedLength(value) > HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes
  ) {
    throw new Error(`${label} must be a canonical bounded absolute path`);
  }
  return value;
}

function requireCanonicalStringArray(
  value: unknown,
  label: string,
  maximum: number,
  valid: (item: string) => boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || !valid(item))
  ) {
    throw new Error(`${label} must contain 1 to ${maximum} valid strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} contains duplicates`);
  }
  const canonical = [...value].sort(compareHomebrewCanonicalText);
  if (value.some((item, index) => item !== canonical[index])) {
    throw new Error(`${label} is not in canonical order`);
  }
  return [...value];
}

function requireFullPackageName(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_PACKAGE_RE.test(value)) {
    throw new Error(`${label} must be a canonical owner/tap/formula name`);
  }
  return value;
}

function requireMode(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) {
    throw new Error(`${label} has an invalid mode`);
  }
  return value;
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
  const actual = Object.keys(record).sort(compareHomebrewCanonicalText);
  const expected = [...keys].sort(compareHomebrewCanonicalText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
