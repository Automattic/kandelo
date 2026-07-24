import {
  loadClosedLazyAssetSources,
  MAX_CLOSED_LAZY_ASSET_BYTES,
  type ClosedLazyAsset,
  type ClosedLazyAssetSource,
} from "../../host/src/vfs/closed-lazy-assets";
import {
  assertHomebrewBottleMirrorPlanIdentity,
  decodeHomebrewBottleMirrorPlan,
  isRecord,
} from "../../scripts/homebrew-closed-lazy-assets-contract";
import {
  assertHomebrewGuestLifecycleRevisions,
  type HomebrewGuestLifecycleRevisions,
} from "./homebrew_guest_lifecycle_contract";
import type {
  HomebrewGuestLifecycleTransportMode,
} from "./homebrew_guest_lifecycle_runtime_inputs";

export interface HomebrewGuestLifecycleExactAsset {
  url: string;
  sha256: string;
  bytes: number;
}

export interface HomebrewGuestLifecycleBottlePayloadFixture
  extends HomebrewGuestLifecycleExactAsset {
  asset: string;
}

export interface HomebrewGuestLifecycleBrowserFixture {
  schema: 1;
  allowLiveNetwork: true;
  transportMode: HomebrewGuestLifecycleTransportMode;
  image: HomebrewGuestLifecycleExactAsset;
  bootstrap: {
    spec: HomebrewGuestLifecycleExactAsset;
    archive: HomebrewGuestLifecycleExactAsset;
    environment: HomebrewGuestLifecycleExactAsset;
  };
  bottleMirror: {
    plan: HomebrewGuestLifecycleExactAsset;
    payloads?: HomebrewGuestLifecycleBottlePayloadFixture[];
  };
  revisions: HomebrewGuestLifecycleRevisions;
  timeoutMs: number;
}

export interface LoadedHomebrewGuestLifecycleBrowserFixture {
  fixture: HomebrewGuestLifecycleBrowserFixture;
  imageBytes: Uint8Array;
  bootstrapSpecBytes: Uint8Array;
  bootstrapArchiveBytes: Uint8Array;
  bootstrapEnvironmentBytes: Uint8Array;
  bottleMirrorPlanBytes: Uint8Array;
  closedBottleAssets?: readonly ClosedLazyAsset[];
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const TOP_LEVEL_KEYS = [
  "schema",
  "allowLiveNetwork",
  "transportMode",
  "image",
  "bootstrap",
  "bottleMirror",
  "revisions",
  "timeoutMs",
] as const;
const BOOTSTRAP_KEYS = ["spec", "archive", "environment"] as const;
const MIRROR_KEYS = ["plan", "payloads"] as const;
const REVISION_KEYS = ["coreRevision", "canaryRevision"] as const;
const ASSET_KEYS = ["url", "sha256", "bytes"] as const;
const PAYLOAD_KEYS = ["asset", "url", "sha256", "bytes"] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Reject ambient or partially specified live inputs before any browser fetch.
 * A lifecycle proof may use network transport, but every accepted byte source
 * remains bound to an immutable URL, exact length, and SHA-256.
 */
export function projectHomebrewGuestLifecycleBrowserFixture(
  value: unknown,
): HomebrewGuestLifecycleBrowserFixture {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, TOP_LEVEL_KEYS)
  ) {
    throw new Error(
      "Homebrew browser lifecycle fixture has unknown or missing fields",
    );
  }
  if (value.schema !== 1 || value.allowLiveNetwork !== true) {
    throw new Error(
      "Homebrew browser lifecycle requires explicit live-network opt-in",
    );
  }
  if (value.transportMode !== "closed" && value.transportMode !== "public") {
    throw new Error(
      "Homebrew browser lifecycle transport mode must be closed or public",
    );
  }
  if (
    !isRecord(value.bootstrap) ||
    !hasExactKeys(value.bootstrap, BOOTSTRAP_KEYS)
  ) {
    throw new Error(
      "Homebrew browser lifecycle bootstrap has unknown or missing fields",
    );
  }
  if (
    !isRecord(value.revisions) ||
    !hasExactKeys(value.revisions, REVISION_KEYS) ||
    typeof value.revisions.coreRevision !== "string" ||
    typeof value.revisions.canaryRevision !== "string"
  ) {
    throw new Error("Homebrew browser lifecycle revisions are invalid");
  }
  const revisions = {
    coreRevision: value.revisions.coreRevision,
    canaryRevision: value.revisions.canaryRevision,
  };
  assertHomebrewGuestLifecycleRevisions(revisions);
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 1_000 ||
    (value.timeoutMs as number) > 30 * 60 * 1_000
  ) {
    throw new Error(
      "Homebrew browser lifecycle timeout must be 1000..1800000 milliseconds",
    );
  }

  const bottleMirror = projectBottleMirror(value.bottleMirror);
  if (
    (
      value.transportMode === "closed" &&
      bottleMirror.payloads === undefined
    ) ||
    (
      value.transportMode === "public" &&
      bottleMirror.payloads !== undefined
    )
  ) {
    throw new Error(
      "closed browser lifecycle transport requires exact bottle payloads, " +
        "while public transport forbids local payload bytes",
    );
  }

  return {
    schema: 1,
    allowLiveNetwork: true,
    transportMode: value.transportMode,
    image: projectExactAsset(value.image, "image"),
    bootstrap: {
      spec: projectExactAsset(value.bootstrap.spec, "bootstrap spec"),
      archive: projectExactAsset(
        value.bootstrap.archive,
        "bootstrap archive",
      ),
      environment: projectExactAsset(
        value.bootstrap.environment,
        "bootstrap environment",
      ),
    },
    bottleMirror,
    revisions,
    timeoutMs: value.timeoutMs as number,
  };
}

export async function loadHomebrewGuestLifecycleBrowserFixture(
  value: unknown,
  options: {
    fetchImpl?: FetchLike;
    sourceUrl: (canonicalUrl: string) => string;
  },
): Promise<LoadedHomebrewGuestLifecycleBrowserFixture> {
  const fixture = projectHomebrewGuestLifecycleBrowserFixture(value);
  const fetchImpl = options.fetchImpl ?? fetch;
  const [
    imageBytes,
    bootstrapSpecBytes,
    bootstrapArchiveBytes,
    bootstrapEnvironmentBytes,
  ] = await Promise.all([
    loadExactAsset(fixture.image, "image", options.sourceUrl, fetchImpl),
    loadExactAsset(
      fixture.bootstrap.spec,
      "bootstrap spec",
      options.sourceUrl,
      fetchImpl,
    ),
    loadExactAsset(
      fixture.bootstrap.archive,
      "bootstrap archive",
      options.sourceUrl,
      fetchImpl,
    ),
    loadExactAsset(
      fixture.bootstrap.environment,
      "bootstrap environment",
      options.sourceUrl,
      fetchImpl,
    ),
  ]);

  const bottleMirrorPlanBytes = await loadExactAsset(
    fixture.bottleMirror.plan,
    "bottle mirror plan",
    options.sourceUrl,
    fetchImpl,
  );
  const plan = decodeHomebrewBottleMirrorPlan(
    bottleMirrorPlanBytes,
    "live Homebrew bottle mirror plan",
  );
  await assertHomebrewBottleMirrorPlanIdentity(plan);
  const expectedPlanUrl = `${plan.release_root}/${plan.manifest_asset}`;
  if (fixture.bottleMirror.plan.url !== expectedPlanUrl) {
    throw new Error(
      "live bottle mirror plan URL differs from its canonical release URL",
    );
  }

  if (fixture.bottleMirror.payloads === undefined) {
    return {
      fixture,
      imageBytes,
      bootstrapSpecBytes,
      bootstrapArchiveBytes,
      bootstrapEnvironmentBytes,
      bottleMirrorPlanBytes,
    };
  }

  const payloadFixtureByAsset = new Map(
    fixture.bottleMirror.payloads.map((payload) => [payload.asset, payload]),
  );
  if (
    payloadFixtureByAsset.size !== fixture.bottleMirror.payloads.length ||
    payloadFixtureByAsset.size !== plan.assets.length
  ) {
    throw new Error(
      "live bottle payload fixtures must cover each mirror asset exactly once",
    );
  }
  const payloadSources: ClosedLazyAssetSource[] = plan.assets.map((asset) => {
    const payload = payloadFixtureByAsset.get(asset.asset);
    if (
      payload === undefined ||
      payload.url !== asset.url ||
      payload.sha256 !== asset.sha256 ||
      payload.bytes !== asset.bytes
    ) {
      throw new Error(
        `live bottle payload fixture differs from mirror asset ${asset.asset}`,
      );
    }
    return {
      url: asset.url,
      sourceUrl: options.sourceUrl(asset.url),
      sha256: asset.sha256,
      size: asset.bytes,
    };
  });
  const closedBottleAssets = await loadClosedLazyAssetSources(payloadSources, {
    fetchImpl,
    maxConcurrency: 4,
  });

  return {
    fixture,
    imageBytes,
    bootstrapSpecBytes,
    bootstrapArchiveBytes,
    bootstrapEnvironmentBytes,
    bottleMirrorPlanBytes,
    closedBottleAssets,
  };
}

function projectBottleMirror(value: unknown):
  HomebrewGuestLifecycleBrowserFixture["bottleMirror"] {
  if (
    !isRecord(value) ||
    (
      !hasExactKeys(value, ["plan"]) &&
      !hasExactKeys(value, MIRROR_KEYS)
    )
  ) {
    throw new Error(
      "Homebrew browser lifecycle bottle mirror has unknown or missing fields",
    );
  }
  if (
    value.payloads !== undefined &&
    (!Array.isArray(value.payloads) || value.payloads.length === 0)
  ) {
    throw new Error(
      "Homebrew browser lifecycle bottle payloads must be a non-empty array",
    );
  }
  return {
    plan: projectExactAsset(value.plan, "bottle mirror plan"),
    ...(value.payloads === undefined
      ? {}
      : {
          payloads: value.payloads.map((payload, index) =>
            projectBottlePayload(payload, index)
          ),
        }),
  };
}

function projectBottlePayload(
  value: unknown,
  index: number,
): HomebrewGuestLifecycleBottlePayloadFixture {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAYLOAD_KEYS) ||
    typeof value.asset !== "string" ||
    value.asset.length === 0 ||
    value.asset.includes("/") ||
    value.asset === "." ||
    value.asset === ".."
  ) {
    throw new Error(`Homebrew bottle payload fixture ${index} is invalid`);
  }
  return {
    asset: value.asset,
    ...projectExactAssetFields(value, `bottle payload ${index}`),
  };
}

function projectExactAsset(
  value: unknown,
  label: string,
): HomebrewGuestLifecycleExactAsset {
  if (!isRecord(value) || !hasExactKeys(value, ASSET_KEYS)) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return projectExactAssetFields(value, label);
}

function projectExactAssetFields(
  value: Record<string, unknown>,
  label: string,
): HomebrewGuestLifecycleExactAsset {
  if (
    typeof value.url !== "string" ||
    typeof value.sha256 !== "string" ||
    !SHA256_RE.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0 ||
    (value.bytes as number) > MAX_CLOSED_LAZY_ASSET_BYTES
  ) {
    throw new Error(`${label} has invalid exact identity fields`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch (error) {
    throw new Error(`${label} URL is invalid`, { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    value.url.includes("#") ||
    parsed.href !== value.url
  ) {
    throw new Error(`${label} must use one canonical credential-free HTTPS URL`);
  }
  return {
    url: value.url,
    sha256: value.sha256,
    bytes: value.bytes as number,
  };
}

async function loadExactAsset(
  asset: HomebrewGuestLifecycleExactAsset,
  label: string,
  sourceUrl: (canonicalUrl: string) => string,
  fetchImpl: FetchLike,
): Promise<Uint8Array> {
  try {
    const [loaded] = await loadClosedLazyAssetSources([{
      url: asset.url,
      sourceUrl: sourceUrl(asset.url),
      sha256: asset.sha256,
      size: asset.bytes,
    }], { fetchImpl });
    return loaded!.bytes;
  } catch (error) {
    throw new Error(
      `failed to load exact Homebrew browser lifecycle ${label}: ${String(error)}`,
      { cause: error },
    );
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}
