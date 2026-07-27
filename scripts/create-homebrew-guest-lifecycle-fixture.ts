#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertHomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";
import {
  decodeHomebrewBottleMirrorPlan,
} from "./homebrew-closed-lazy-assets-contract";
import {
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleExactAsset,
} from "../homebrew/test/homebrew_guest_lifecycle_browser_fixture";

export interface CreateHomebrewGuestLifecycleFixtureOptions {
  image: string;
  bootstrapSpec: string;
  bootstrapArchive: string;
  bootstrapEnvironment: string;
  bottleMirror: string;
  fixedAssetUrlRoot: string;
  coreRevision: string;
  canaryRevision: string;
  timeoutMs: number;
  out: string;
}

const MIRROR_PLAN_ASSET =
  "kandelo-homebrew-bottle-mirror-plan.json";
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function createHomebrewGuestLifecycleFixture(
  options: CreateHomebrewGuestLifecycleFixtureOptions,
): void {
  if (
    !GIT_SHA_RE.test(options.coreRevision) ||
    !GIT_SHA_RE.test(options.canaryRevision) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 30 * 60 * 1_000
  ) {
    throw new Error("Homebrew lifecycle fixture revisions or timeout are invalid");
  }
  const fixedAssetUrlRoot = canonicalHttpsRoot(
    options.fixedAssetUrlRoot,
  );
  const out = resolve(options.out);
  if (pathExists(out)) {
    throw new Error(`fixture output already exists: ${out}`);
  }
  regularDirectory(dirname(out), "fixture output directory");
  const image = exactLocalAsset(
    options.image,
    fixedAssetUrl(fixedAssetUrlRoot, options.image),
    "main-shell image",
  );
  const bootstrapSpec = exactLocalAsset(
    options.bootstrapSpec,
    fixedAssetUrl(fixedAssetUrlRoot, options.bootstrapSpec),
    "Homebrew bootstrap spec",
  );
  const bootstrapArchive = exactLocalAsset(
    options.bootstrapArchive,
    fixedAssetUrl(fixedAssetUrlRoot, options.bootstrapArchive),
    "Homebrew bootstrap archive",
  );
  const bootstrapEnvironment = exactLocalAsset(
    options.bootstrapEnvironment,
    fixedAssetUrl(
      fixedAssetUrlRoot,
      options.bootstrapEnvironment,
    ),
    "Homebrew bootstrap environment",
  );

  const mirrorDirectory = regularDirectory(
    options.bottleMirror,
    "Homebrew bottle mirror",
  );
  const planPath = resolve(mirrorDirectory, MIRROR_PLAN_ASSET);
  const planBytes = readRegularFile(planPath, "Homebrew bottle mirror plan");
  const plan = decodeHomebrewBottleMirrorPlan(
    planBytes,
    "Homebrew bottle mirror plan",
  );
  assertHomebrewBottleMirrorPlan(plan);
  const expectedFiles = [
    MIRROR_PLAN_ASSET,
    ...plan.assets.map((asset) => asset.asset),
  ].sort();
  const actualFiles = readdirSync(mirrorDirectory, {
    withFileTypes: true,
  }).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `Homebrew bottle mirror contains non-regular entry ${entry.name}`,
      );
    }
    return entry.name;
  }).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      "Homebrew bottle mirror files differ from its exact plan",
    );
  }

  const payloads = plan.assets.map((asset) => {
    const payloadPath = resolve(mirrorDirectory, asset.asset);
    const payload = exactLocalAsset(
      payloadPath,
      asset.url,
      `Homebrew bottle mirror payload ${asset.asset}`,
    );
    if (
      payload.sha256 !== asset.sha256 ||
      payload.bytes !== asset.bytes
    ) {
      throw new Error(
        `Homebrew bottle mirror payload ${asset.asset} changed identity`,
      );
    }
    return { asset: asset.asset, ...payload };
  });
  const planUrl = `${plan.release_root}/${plan.manifest_asset}`;
  const planAsset = exactBytesAsset(planBytes, planUrl);

  const fixture: HomebrewGuestLifecycleBrowserFixture = {
    schema: 1,
    allowLiveNetwork: true,
    transportMode: "closed",
    image,
    bootstrap: {
      spec: bootstrapSpec,
      archive: bootstrapArchive,
      environment: bootstrapEnvironment,
    },
    bottleMirror: {
      plan: planAsset,
      payloads,
    },
    revisions: {
      coreRevision: options.coreRevision,
      canaryRevision: options.canaryRevision,
    },
    timeoutMs: options.timeoutMs,
  };
  const validated = projectHomebrewGuestLifecycleBrowserFixture(fixture);
  writeNewJson(out, validated);
}

function parseOptions(
  args: readonly string[],
): CreateHomebrewGuestLifecycleFixtureOptions {
  const allowed = new Set([
    "--image",
    "--homebrew-bootstrap-spec",
    "--homebrew-bootstrap-archive",
    "--homebrew-bootstrap-env",
    "--bottle-mirror",
    "--fixed-asset-url-root",
    "--core-revision",
    "--canary-revision",
    "--timeout-ms",
    "--out",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !allowed.has(option) ||
      values.has(option) ||
      value.length === 0
    ) {
      usage();
    }
    values.set(option, value);
  }
  if (values.size !== allowed.size) usage();

  const coreRevision = values.get("--core-revision")!;
  const canaryRevision = values.get("--canary-revision")!;
  const timeoutText = values.get("--timeout-ms")!;
  if (
    !GIT_SHA_RE.test(coreRevision) ||
    !GIT_SHA_RE.test(canaryRevision) ||
    !/^[1-9][0-9]*$/.test(timeoutText)
  ) {
    usage();
  }
  const timeoutMs = Number(timeoutText);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 30 * 60 * 1_000
  ) {
    usage();
  }
  const fixedAssetUrlRoot = canonicalHttpsRoot(
    values.get("--fixed-asset-url-root")!,
  );
  const out = resolve(values.get("--out")!);
  if (pathExists(out)) {
    throw new Error(`fixture output already exists: ${out}`);
  }
  regularDirectory(dirname(out), "fixture output directory");
  return {
    image: resolve(values.get("--image")!),
    bootstrapSpec: resolve(values.get("--homebrew-bootstrap-spec")!),
    bootstrapArchive: resolve(
      values.get("--homebrew-bootstrap-archive")!,
    ),
    bootstrapEnvironment: resolve(
      values.get("--homebrew-bootstrap-env")!,
    ),
    bottleMirror: resolve(values.get("--bottle-mirror")!),
    fixedAssetUrlRoot,
    coreRevision,
    canaryRevision,
    timeoutMs,
    out,
  };
}

function canonicalHttpsRoot(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("fixed asset URL root is invalid", { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith("/") ||
    url.href !== value
  ) {
    throw new Error(
      "fixed asset URL root must be one canonical HTTPS directory URL",
    );
  }
  return url.href;
}

function fixedAssetUrl(root: string, path: string): string {
  const name = basename(path);
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(name)
  ) {
    throw new Error(`fixed fixture asset name is invalid: ${name}`);
  }
  return new URL(name, root).href;
}

function exactLocalAsset(
  path: string,
  url: string,
  label: string,
): HomebrewGuestLifecycleExactAsset {
  return exactBytesAsset(readRegularFile(path, label), url);
}

function exactBytesAsset(
  bytes: Uint8Array,
  url: string,
): HomebrewGuestLifecycleExactAsset {
  return {
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function readRegularFile(path: string, label: string): Uint8Array {
  const absolute = resolve(path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new Error(`${label} is not readable: ${absolute}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} must be a nonempty regular non-symlink file`);
  }
  return new Uint8Array(readFileSync(absolute));
}

function regularDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new Error(`${label} is not readable: ${absolute}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return absolute;
}

function writeNewJson(
  path: string,
  value: HomebrewGuestLifecycleBrowserFixture,
): void {
  writeFileSync(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function usage(): never {
  throw new Error(
    "usage: create-homebrew-guest-lifecycle-fixture.ts " +
      "--image <main-shell.vfs.zst> " +
      "--homebrew-bootstrap-spec <tree.json> " +
      "--homebrew-bootstrap-archive <homebrew-bootstrap.zip> " +
      "--homebrew-bootstrap-env <homebrew-brew.env> " +
      "--bottle-mirror <directory> --fixed-asset-url-root <https-url/> " +
      "--core-revision <sha> --canary-revision <sha> " +
      "--timeout-ms <milliseconds> --out <new-fixture.json>",
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  createHomebrewGuestLifecycleFixture(parseOptions(process.argv.slice(2)));
}
