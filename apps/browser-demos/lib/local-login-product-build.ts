import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Plugin } from "vite";

import {
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleExactAsset,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser_fixture";
import {
  parsePrivilegedProgramProjections,
  type PrivilegedProgramProjection,
} from "../../../host/src/vfs/privileged-projection";

export const LOCAL_LOGIN_PRODUCT_INPUT_ENV =
  "KANDELO_LOCAL_LOGIN_PRODUCT_ROOT";
export const LOCAL_LOGIN_PRODUCT_ASSET_DIRECTORY =
  "homebrew-login-product";
export const LOCAL_LOGIN_PRODUCT_FIXTURE =
  "homebrew-login-lifecycle-fixture.json";
export const LOCAL_LOGIN_PRODUCT_VIRTUAL_MODULE =
  "virtual:kandelo-local-login-product";

const RESOLVED_VIRTUAL_MODULE = `\0${LOCAL_LOGIN_PRODUCT_VIRTUAL_MODULE}`;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const PROJECTION_KEYS = [
  "schema",
  "formula",
  "bottle_sha256",
  "source_path",
  "destination_path",
  "uid",
  "gid",
  "mode",
  "mount_point",
  "artifact_validation_sha256",
] as const;

export interface LocalLoginProductManifest {
  schema: 1;
  assetRoot: string;
  fixture: HomebrewGuestLifecycleBrowserFixture;
  projections: PrivilegedProgramProjection[];
}

export interface LocalLoginProductBuildAsset {
  name: string;
  bytes: Uint8Array;
}

export interface LocalLoginProductBuildInput {
  manifest: LocalLoginProductManifest;
  assets: LocalLoginProductBuildAsset[];
}

/**
 * Load one explicit private local-test product into a build-owned policy.
 *
 * Nothing inside the VFS image, fixture, or composition report can activate
 * this path by itself: the maintainer must name an absolute input directory at
 * build configuration time. The report then supplies exact values to the
 * existing closed policy parser, while the fixture binds every emitted byte.
 */
export function loadLocalLoginProductBuildInput(
  configuredRoot: string | undefined,
  base: string,
): LocalLoginProductBuildInput | null {
  if (configuredRoot === undefined || configuredRoot.trim() === "") return null;
  if (!isAbsolute(configuredRoot)) {
    throw new Error(
      `${LOCAL_LOGIN_PRODUCT_INPUT_ENV} must name an absolute private input root`,
    );
  }
  const root = regularDirectory(configuredRoot, "local login product input root");
  const fixturePath = join(root, LOCAL_LOGIN_PRODUCT_FIXTURE);
  const fixture = projectHomebrewGuestLifecycleBrowserFixture(
    parseJson(
      readRegularFile(fixturePath, "local login product fixture"),
      "local login product fixture",
    ),
  );
  if (
    fixture.transportMode !== "closed" ||
    fixture.bottleMirror.payloads === undefined ||
    fixture.loginProduct === undefined
  ) {
    throw new Error(
      "local login product fixture must declare closed bottle and login product assets",
    );
  }

  const exactAssets = [
    fixture.image,
    fixture.bootstrap.spec,
    fixture.bootstrap.archive,
    fixture.bootstrap.environment,
    fixture.bottleMirror.plan,
    fixture.loginProduct.compositionReport,
    fixture.loginProduct.privilegedProduct,
    ...fixture.bottleMirror.payloads,
  ];
  const names = new Set<string>();
  const assets = exactAssets.map((identity, index) => {
    const name = exactAssetName(identity, index);
    if (name === LOCAL_LOGIN_PRODUCT_FIXTURE || names.has(name)) {
      throw new Error(`local login product duplicates asset name ${name}`);
    }
    names.add(name);
    const bytes = readRegularFile(
      join(root, name),
      `local login product asset ${name}`,
    );
    assertExactIdentity(bytes, identity, `local login product asset ${name}`);
    return { name, bytes };
  });

  const actualNames = readdirSync(root).sort();
  const expectedNames = [LOCAL_LOGIN_PRODUCT_FIXTURE, ...names].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("local login product input root differs from its exact file set");
  }

  const compositionName = exactAssetName(
    fixture.loginProduct.compositionReport,
    -1,
  );
  const composition = parseJson(
    assets.find((asset) => asset.name === compositionName)!.bytes,
    "local login product composition report",
  );
  const report = requireRecord(
    composition,
    "local login product composition report",
  );
  if (report.image !== exactAssetName(fixture.image, -1)) {
    throw new Error("local login product report names a different shell image");
  }
  const localTest = requireRecord(
    report.local_test,
    "local login product provenance",
  );
  const provenance = requireRecord(
    localTest.provenance,
    "local login product provenance record",
  );
  if (
    !hasExactKeys(provenance, [
      "schema",
      "provenance_kind",
      "promotable",
      "published",
    ]) ||
    provenance.schema !== 1 ||
    provenance.provenance_kind !== "local-test" ||
    provenance.promotable !== false ||
    provenance.published !== false ||
    localTest.source_tap_commit !== fixture.revisions.coreRevision
  ) {
    throw new Error("local login product is not exact non-promotable local-test evidence");
  }
  const privilegedPrograms = requireRecord(
    report.privileged_programs,
    "local login product privileged programs",
  );
  if (!Array.isArray(privilegedPrograms.projections)) {
    throw new Error("local login product composition report omits projections");
  }
  const projections = parsePrivilegedProgramProjections(
    privilegedPrograms.projections.map((value, index) =>
      compileProjection(value, index)
    ),
  );

  const serializedIdentity = requireRecord(
    report.privileged_product,
    "local login product serialized privileged product identity",
  );
  const serializedName = exactAssetName(
    fixture.loginProduct.privilegedProduct,
    -1,
  );
  const serialized = assets.find((asset) => asset.name === serializedName)!;
  if (
    serializedIdentity.image !== serializedName ||
    serializedIdentity.sha256 !== sha256(serialized.bytes) ||
    serializedIdentity.bytes !== serialized.bytes.byteLength
  ) {
    throw new Error(
      "local login product serialized privileged product identity is invalid",
    );
  }

  return {
    manifest: {
      schema: 1,
      assetRoot: assetRootForBase(base),
      fixture,
      projections,
    },
    assets,
  };
}

export function createLocalLoginProductPlugin(options: {
  base: string;
  configuredRoot?: string;
}): Plugin {
  const input = loadLocalLoginProductBuildInput(
    options.configuredRoot,
    options.base,
  );
  return {
    name: "kandelo-local-login-product",
    enforce: "pre",
    resolveId(source) {
      return source === LOCAL_LOGIN_PRODUCT_VIRTUAL_MODULE
        ? RESOLVED_VIRTUAL_MODULE
        : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE) return null;
      return `export default ${JSON.stringify(input?.manifest ?? null)};\n`;
    },
    generateBundle() {
      if (input === null) return;
      for (const asset of input.assets) {
        this.emitFile({
          type: "asset",
          fileName: `${LOCAL_LOGIN_PRODUCT_ASSET_DIRECTORY}/${asset.name}`,
          source: asset.bytes,
        });
      }
    },
  };
}

function compileProjection(value: unknown, index: number) {
  const record = requireRecord(value, `local login product projection ${index}`);
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...PROJECTION_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`local login product projection ${index} must use the closed schema`);
  }
  return {
    schema: record.schema,
    formula: record.formula,
    bottleSha256: record.bottle_sha256,
    sourcePath: record.source_path,
    destinationPath: record.destination_path,
    uid: record.uid,
    gid: record.gid,
    mode: record.mode,
    mountPoint: record.mount_point,
    artifactValidationSha256: record.artifact_validation_sha256,
  };
}

function assetRootForBase(base: string): string {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}${LOCAL_LOGIN_PRODUCT_ASSET_DIRECTORY}/`;
}

function exactAssetName(
  identity: HomebrewGuestLifecycleExactAsset,
  index: number,
): string {
  let url: URL;
  try {
    url = new URL(identity.url);
  } catch (error) {
    throw new Error(`local login product asset ${index} has an invalid URL`, {
      cause: error,
    });
  }
  const encoded = url.pathname.split("/").at(-1) ?? "";
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch (error) {
    throw new Error(`local login product asset ${index} has an invalid name`, {
      cause: error,
    });
  }
  if (!ASSET_NAME_RE.test(name)) {
    throw new Error(`local login product asset ${index} has an invalid name`);
  }
  return name;
}

function assertExactIdentity(
  bytes: Uint8Array,
  identity: HomebrewGuestLifecycleExactAsset,
  label: string,
): void {
  if (
    !SHA256_RE.test(identity.sha256) ||
    bytes.byteLength !== identity.bytes ||
    sha256(bytes) !== identity.sha256
  ) {
    throw new Error(`${label} differs from its exact digest or byte identity`);
  }
}

function regularDirectory(pathValue: string, label: string): string {
  const path = resolve(pathValue);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is missing`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return realpathSync(path);
}

function readRegularFile(path: string, label: string): Uint8Array {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is missing`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return readFileSync(path);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not UTF-8 JSON`, { cause: error });
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
