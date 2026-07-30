#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertHomebrewBottleMirrorPlan } from "../host/src/homebrew-vfs-composer";
import { decodeHomebrewBottleMirrorPlan } from "./homebrew-closed-lazy-assets-contract";

const KIND = "kandelo-homebrew-guest-lifecycle-inputs-handoff";
const IDENTITY_KIND = "kandelo-homebrew-guest-lifecycle-inputs";
const REPOSITORY = "kandelo-dev/homebrew-tap-core";
const TAG_PREFIX = "homebrew-guest-lifecycle-inputs-sha256-";
const TITLE = "Kandelo Homebrew guest lifecycle inputs";
const MAX_HANDOFF_BYTES = 512 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const TRANSITIONAL_BOOTSTRAP = {
  state: "transitional",
  source_kind: "kandelo-package-registry",
  package: "homebrew-bootstrap",
  guest_prefix: "/home/linuxbrew/.linuxbrew",
  stable_entrypoint: "/usr/bin/brew",
} as const;

const ASSETS = [
  {
    name: "main-shell.vfs.zst",
    option: "image",
    label: "main-shell image",
  },
  {
    name: "main-shell-brew-package-tree.json",
    option: "bootstrapSpec",
    label: "Homebrew bootstrap tree spec",
  },
  {
    name: "homebrew-bootstrap.zip",
    option: "bootstrapArchive",
    label: "Homebrew bootstrap archive",
  },
  {
    name: "homebrew-brew.env",
    option: "bootstrapEnvironment",
    label: "Homebrew bootstrap environment",
  },
] as const;

const ROOT_FILES = [
  ...ASSETS.map((asset) => asset.name),
  "handoff.json",
  "publish.json",
].sort();

interface ExactAsset {
  name: string;
  sha256: string;
  bytes: number;
}

interface ExactRefs {
  kandeloRef: string;
  tapCatalogRef: string;
  tapMirrorAuthorityRef: string;
  tapCallerAuthorityRef: string;
  canaryRef: string;
}

export interface CreateHomebrewGuestLifecyclePublicationOptions extends ExactRefs {
  image: string;
  bootstrapSpec: string;
  bootstrapArchive: string;
  bootstrapEnvironment: string;
  bottleMirrorPlan: string;
  out: string;
}

export interface VerifyHomebrewGuestLifecyclePublicationOptions extends ExactRefs {
  bottleMirrorPlan: string;
  root: string;
}

export interface HomebrewGuestLifecyclePublicationIdentity {
  collectionSha256: string;
  tag: string;
  releaseRoot: string;
}

/**
 * Prepare a credential-free, bounded handoff for the public Chromium proof.
 *
 * The bottle mirror remains a separate release and source of truth. This
 * handoff owns only the fixed shell/bootstrap inputs. The shell image is a
 * package-archive member. The bootstrap ZIP and environment still come from
 * the transitional Kandelo registry package; none is a direct lazy-VFS URL.
 * The source spec and transitional ownership are bound beside them.
 */
export function createHomebrewGuestLifecyclePublication(
  options: CreateHomebrewGuestLifecyclePublicationOptions,
): HomebrewGuestLifecyclePublicationIdentity {
  assertExactRefs(options);
  const out = resolve(options.out);
  assertAbsent(out, "Homebrew guest lifecycle publication handoff");
  assertDirectory(dirname(out), "Homebrew guest lifecycle publication parent");

  const sourceAssets = ASSETS.map((asset) => {
    const source = resolve(options[asset.option]);
    const bytes = readRegularFile(source, asset.label);
    return {
      exact: exactAsset(asset.name, bytes),
      bytes,
    };
  });
  assertAggregateBytes(sourceAssets.map((asset) => asset.exact));

  const planPath = resolve(options.bottleMirrorPlan);
  const planBytes = readRegularFile(planPath, "Homebrew bottle mirror plan");
  const plan = decodeHomebrewBottleMirrorPlan(
    planBytes,
    "Homebrew bottle mirror plan",
  );
  assertHomebrewBottleMirrorPlan(plan);
  if (plan.repository !== REPOSITORY) {
    throw new Error(
      `Homebrew bottle mirror belongs to ${plan.repository}, expected ${REPOSITORY}`,
    );
  }
  const planIdentity = {
    url: `${plan.release_root}/${plan.manifest_asset}`,
    sha256: sha256(planBytes),
    bytes: planBytes.byteLength,
  };
  const identity = deriveIdentity(
    options,
    sourceAssets.map((asset) => asset.exact),
    planIdentity,
  );
  const manifest = publicationManifest(
    options.tapCallerAuthorityRef,
    identity,
    sourceAssets.map((asset) => asset.exact),
    planIdentity,
  );

  mkdirSync(out, { mode: 0o755 });
  try {
    for (const asset of sourceAssets) {
      writeFileSync(join(out, asset.exact.name), asset.bytes, {
        flag: "wx",
        mode: 0o644,
      });
    }
    const publishBytes = jsonBytes(manifest);
    writeFileSync(join(out, "publish.json"), publishBytes, {
      flag: "wx",
      mode: 0o644,
    });
    const files = Object.fromEntries([
      ...sourceAssets.map((asset) => [
        asset.exact.name,
        {
          sha256: asset.exact.sha256,
          bytes: asset.exact.bytes,
        },
      ]),
      [
        "publish.json",
        {
          sha256: sha256(publishBytes),
          bytes: publishBytes.byteLength,
        },
      ],
    ]);
    const handoff = {
      schema: 1,
      kind: KIND,
      kandelo_ref: options.kandeloRef,
      tap_catalog_ref: options.tapCatalogRef,
      tap_mirror_authority_ref: options.tapMirrorAuthorityRef,
      tap_caller_authority_ref: options.tapCallerAuthorityRef,
      canary_ref: options.canaryRef,
      bootstrap: TRANSITIONAL_BOOTSTRAP,
      bottle_mirror: planIdentity,
      release: {
        repository: REPOSITORY,
        collection_sha256: identity.collectionSha256,
        tag: identity.tag,
        root: identity.releaseRoot,
      },
      files,
    };
    writeFileSync(join(out, "handoff.json"), jsonBytes(handoff), {
      flag: "wx",
      mode: 0o644,
    });
    verifyHomebrewGuestLifecyclePublication({
      root: out,
      bottleMirrorPlan: planPath,
      ...exactRefs(options),
    });
  } catch (error) {
    // WHY: `out` was proven absent and created by this invocation. Remove
    // only that incomplete private handoff so a retry cannot publish a
    // mixture of old and new exact inputs.
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
  return identity;
}

export function verifyHomebrewGuestLifecyclePublication(
  options: VerifyHomebrewGuestLifecyclePublicationOptions,
): HomebrewGuestLifecyclePublicationIdentity {
  assertExactRefs(options);
  const root = assertDirectory(
    resolve(options.root),
    "Homebrew guest lifecycle publication handoff",
  );
  const entries = readdirSync(root, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    JSON.stringify(entries.map((entry) => entry.name).sort()) !==
      JSON.stringify(ROOT_FILES)
  ) {
    throw new Error(
      "Homebrew guest lifecycle publication handoff files differ",
    );
  }

  const exactAssets = ASSETS.map((asset) => {
    const bytes = readRegularFile(join(root, asset.name), asset.label);
    return exactAsset(asset.name, bytes);
  });
  assertAggregateBytes(exactAssets);

  const planBytes = readRegularFile(
    resolve(options.bottleMirrorPlan),
    "Homebrew bottle mirror plan",
  );
  const plan = decodeHomebrewBottleMirrorPlan(
    planBytes,
    "Homebrew bottle mirror plan",
  );
  assertHomebrewBottleMirrorPlan(plan);
  if (plan.repository !== REPOSITORY) {
    throw new Error(
      `Homebrew bottle mirror belongs to ${plan.repository}, expected ${REPOSITORY}`,
    );
  }
  const planIdentity = {
    url: `${plan.release_root}/${plan.manifest_asset}`,
    sha256: sha256(planBytes),
    bytes: planBytes.byteLength,
  };
  const identity = deriveIdentity(options, exactAssets, planIdentity);
  const expectedManifest = publicationManifest(
    options.tapCallerAuthorityRef,
    identity,
    exactAssets,
    planIdentity,
  );
  const publishBytes = readRegularFile(
    join(root, "publish.json"),
    "Homebrew guest lifecycle publication manifest",
  );
  assertJsonEqual(
    parseJson(publishBytes, "Homebrew guest lifecycle publication manifest"),
    expectedManifest,
    "Homebrew guest lifecycle publication manifest differs",
  );

  const handoffBytes = readRegularFile(
    join(root, "handoff.json"),
    "Homebrew guest lifecycle publication handoff manifest",
  );
  const expectedHandoff = {
    schema: 1,
    kind: KIND,
    kandelo_ref: options.kandeloRef,
    tap_catalog_ref: options.tapCatalogRef,
    tap_mirror_authority_ref: options.tapMirrorAuthorityRef,
    tap_caller_authority_ref: options.tapCallerAuthorityRef,
    canary_ref: options.canaryRef,
    bootstrap: TRANSITIONAL_BOOTSTRAP,
    bottle_mirror: planIdentity,
    release: {
      repository: REPOSITORY,
      collection_sha256: identity.collectionSha256,
      tag: identity.tag,
      root: identity.releaseRoot,
    },
    files: Object.fromEntries([
      ...exactAssets.map((asset) => [
        asset.name,
        { sha256: asset.sha256, bytes: asset.bytes },
      ]),
      [
        "publish.json",
        {
          sha256: sha256(publishBytes),
          bytes: publishBytes.byteLength,
        },
      ],
    ]),
  };
  assertJsonEqual(
    parseJson(
      handoffBytes,
      "Homebrew guest lifecycle publication handoff manifest",
    ),
    expectedHandoff,
    "Homebrew guest lifecycle publication handoff manifest differs",
  );
  if (
    handoffBytes.byteLength +
      publishBytes.byteLength +
      exactAssets.reduce((total, asset) => total + asset.bytes, 0) >
    MAX_HANDOFF_BYTES
  ) {
    throw new Error(
      `Homebrew guest lifecycle publication exceeds ${MAX_HANDOFF_BYTES} bytes`,
    );
  }
  return identity;
}

function publicationManifest(
  targetCommitish: string,
  identity: HomebrewGuestLifecyclePublicationIdentity,
  assets: readonly ExactAsset[],
  plan: { url: string; sha256: string; bytes: number },
) {
  return {
    schema: 1,
    repository: REPOSITORY,
    tag: identity.tag,
    target_commitish: targetCommitish,
    title: TITLE,
    body:
      "Immutable direct inputs for Kandelo's public Chromium stock-Homebrew " +
      `lifecycle proof. Collection SHA-256: ${identity.collectionSha256}. ` +
      `Bottle mirror plan: ${plan.sha256}. The Homebrew bootstrap remains ` +
      "the transitional Kandelo registry package at " +
      `${TRANSITIONAL_BOOTSTRAP.guest_prefix}; ` +
      `${TRANSITIONAL_BOOTSTRAP.stable_entrypoint} remains stable.`,
    assets,
    preferred_asset_names: assets.map((asset) => asset.name),
    accepted_existing_asset_sets: [],
  };
}

function deriveIdentity(
  refs: ExactRefs,
  assets: readonly ExactAsset[],
  plan: { url: string; sha256: string; bytes: number },
): HomebrewGuestLifecyclePublicationIdentity {
  const identityBytes = jsonBytes({
    schema: 1,
    kind: IDENTITY_KIND,
    repository: REPOSITORY,
    kandelo_ref: refs.kandeloRef,
    tap_catalog_ref: refs.tapCatalogRef,
    tap_mirror_authority_ref: refs.tapMirrorAuthorityRef,
    tap_caller_authority_ref: refs.tapCallerAuthorityRef,
    canary_ref: refs.canaryRef,
    bootstrap: TRANSITIONAL_BOOTSTRAP,
    bottle_mirror: plan,
    assets,
  });
  const collectionSha256 = sha256(identityBytes);
  const tag = `${TAG_PREFIX}${collectionSha256}`;
  return {
    collectionSha256,
    tag,
    releaseRoot: `https://github.com/${REPOSITORY}/releases/download/${tag}/`,
  };
}

function exactRefs(value: ExactRefs): ExactRefs {
  return {
    kandeloRef: value.kandeloRef,
    tapCatalogRef: value.tapCatalogRef,
    tapMirrorAuthorityRef: value.tapMirrorAuthorityRef,
    tapCallerAuthorityRef: value.tapCallerAuthorityRef,
    canaryRef: value.canaryRef,
  };
}

function assertExactRefs(value: ExactRefs): void {
  for (const [label, ref] of [
    ["Kandelo", value.kandeloRef],
    ["tap catalog", value.tapCatalogRef],
    ["tap mirror authority", value.tapMirrorAuthorityRef],
    ["tap caller authority", value.tapCallerAuthorityRef],
    ["canary", value.canaryRef],
  ] as const) {
    if (!GIT_SHA_RE.test(ref)) {
      throw new Error(`${label} ref must be one exact lowercase Git SHA`);
    }
  }
  if (value.tapMirrorAuthorityRef === value.tapCallerAuthorityRef) {
    throw new Error(
      "tap mirror and caller authorities must be distinct commits",
    );
  }
}

function exactAsset(name: string, bytes: Uint8Array): ExactAsset {
  if (bytes.byteLength <= 0 || !Number.isSafeInteger(bytes.byteLength)) {
    throw new Error(
      `Homebrew guest lifecycle input ${name} is empty or too large`,
    );
  }
  return { name, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function assertAggregateBytes(assets: readonly ExactAsset[]): void {
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_HANDOFF_BYTES) {
    throw new Error(
      `Homebrew guest lifecycle inputs exceed ${MAX_HANDOFF_BYTES} bytes`,
    );
  }
}

function readRegularFile(path: string, label: string): Uint8Array {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is not readable: ${path}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} must be a nonempty regular non-symlink file`);
  }
  return new Uint8Array(readFileSync(path));
}

function assertDirectory(path: string, label: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is not readable: ${path}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return path;
}

function assertAbsent(path: string, label: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

function assertJsonEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

function sha256(bytes: Uint8Array): string {
  const result = createHash("sha256").update(bytes).digest("hex");
  if (!SHA256_RE.test(result)) {
    throw new Error("internal SHA-256 encoder returned an invalid digest");
  }
  return result;
}

function parseFlagMap(
  args: readonly string[],
  expected: readonly string[],
): Map<string, string> {
  if (args.length !== expected.length * 2) usage();
  const allowed = new Set(expected);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !allowed.has(flag) ||
      values.has(flag) ||
      value.length === 0
    ) {
      usage();
    }
    values.set(flag, value);
  }
  return values;
}

function refsFromFlags(values: ReadonlyMap<string, string>): ExactRefs {
  return {
    kandeloRef: values.get("--kandelo-ref")!,
    tapCatalogRef: values.get("--tap-catalog-ref")!,
    tapMirrorAuthorityRef: values.get("--tap-mirror-authority-ref")!,
    tapCallerAuthorityRef: values.get("--tap-caller-authority-ref")!,
    canaryRef: values.get("--canary-ref")!,
  };
}

function main(args: readonly string[]): void {
  const command = args[0];
  if (command === "create") {
    const values = parseFlagMap(args.slice(1), [
      "--image",
      "--homebrew-bootstrap-spec",
      "--homebrew-bootstrap-archive",
      "--homebrew-bootstrap-env",
      "--bottle-mirror-plan",
      "--kandelo-ref",
      "--tap-catalog-ref",
      "--tap-mirror-authority-ref",
      "--tap-caller-authority-ref",
      "--canary-ref",
      "--out",
    ]);
    const identity = createHomebrewGuestLifecyclePublication({
      image: values.get("--image")!,
      bootstrapSpec: values.get("--homebrew-bootstrap-spec")!,
      bootstrapArchive: values.get("--homebrew-bootstrap-archive")!,
      bootstrapEnvironment: values.get("--homebrew-bootstrap-env")!,
      bottleMirrorPlan: values.get("--bottle-mirror-plan")!,
      out: values.get("--out")!,
      ...refsFromFlags(values),
    });
    process.stdout.write(`${identity.releaseRoot}\n`);
    return;
  }
  if (command === "verify") {
    const values = parseFlagMap(args.slice(1), [
      "--root",
      "--bottle-mirror-plan",
      "--kandelo-ref",
      "--tap-catalog-ref",
      "--tap-mirror-authority-ref",
      "--tap-caller-authority-ref",
      "--canary-ref",
    ]);
    const identity = verifyHomebrewGuestLifecyclePublication({
      root: values.get("--root")!,
      bottleMirrorPlan: values.get("--bottle-mirror-plan")!,
      ...refsFromFlags(values),
    });
    process.stdout.write(`${identity.releaseRoot}\n`);
    return;
  }
  usage();
}

function usage(): never {
  throw new Error(
    "usage: homebrew-guest-lifecycle-publication.ts create " +
      "--image <shell.vfs.zst> --homebrew-bootstrap-spec <tree.json> " +
      "--homebrew-bootstrap-archive <bootstrap.zip> " +
      "--homebrew-bootstrap-env <brew.env> --bottle-mirror-plan <plan.json> " +
      "--kandelo-ref <M> --tap-catalog-ref <TF> " +
      "--tap-mirror-authority-ref <TA0> --tap-caller-authority-ref <TA1> " +
      "--canary-ref <C> --out <new-directory>\n" +
      "or: homebrew-guest-lifecycle-publication.ts verify " +
      "--root <directory> --bottle-mirror-plan <plan.json> " +
      "--kandelo-ref <M> --tap-catalog-ref <TF> " +
      "--tap-mirror-authority-ref <TA0> --tap-caller-authority-ref <TA1> " +
      "--canary-ref <C>",
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2));
}
