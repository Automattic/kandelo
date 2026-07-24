import {
  loadClosedLazyAssetSources,
  MAX_CLOSED_LAZY_ASSET_BYTES,
  MAX_CLOSED_LAZY_ASSETS,
  validateClosedLazyAssetSources,
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
const FIXED_EXACT_ASSET_COUNT = 5;

/**
 * Reject ambient or partially specified live inputs before any browser fetch.
 * A lifecycle proof may use network transport, but every accepted byte source
 * remains bound to one canonical URL, exact length, and SHA-256.
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

export function loadHomebrewGuestLifecycleBrowserFixture(
  value: unknown,
  options: {
    fetchImpl?: FetchLike;
    sourceUrl: (canonicalUrl: string) => string;
    signal?: AbortSignal;
  },
): Promise<LoadedHomebrewGuestLifecycleBrowserFixture> {
  const loading = loadHomebrewGuestLifecycleBrowserFixtureImpl(value, options);
  return settleFixtureLoadOnAbort(loading, options.signal);
}

async function loadHomebrewGuestLifecycleBrowserFixtureImpl(
  value: unknown,
  options: {
    fetchImpl?: FetchLike;
    sourceUrl: (canonicalUrl: string) => string;
    signal?: AbortSignal;
  },
): Promise<LoadedHomebrewGuestLifecycleBrowserFixture> {
  const fixture = projectHomebrewGuestLifecycleBrowserFixture(value);
  const fetchImpl = options.fetchImpl ?? fetch;
  const payloads = fixture.bottleMirror.payloads ?? [];
  const exactAssets = [
    fixture.image,
    fixture.bootstrap.spec,
    fixture.bootstrap.archive,
    fixture.bootstrap.environment,
    fixture.bottleMirror.plan,
    ...payloads,
  ];
  // WHY: validate the entire transport set before I/O so staging the
  // authority plan ahead of its payloads cannot accidentally grant each
  // stage a separate count/byte budget or permit a duplicate canonical URL.
  const sources = validateClosedLazyAssetSources(
    exactAssets.map((asset) => ({
      url: asset.url,
      sourceUrl: options.sourceUrl(asset.url),
      sha256: asset.sha256,
      size: asset.bytes,
    })),
  );
  const transportController = new AbortController();
  // WHY: the mirror plan is the authority for its payload URLs and exact
  // identities. Fetch fixed inputs and that plan first; do not issue payload
  // requests until the decoded plan proves the fixture declared the same set.
  const loadedFixedAssets = await loadFixtureAssetSources(
    sources.slice(0, FIXED_EXACT_ASSET_COUNT),
    fetchImpl,
    options.signal,
    transportController,
  );
  const [
    image,
    bootstrapSpec,
    bootstrapArchive,
    bootstrapEnvironment,
    bottleMirrorPlan,
  ] = loadedFixedAssets;
  const imageBytes = image!.bytes;
  const bootstrapSpecBytes = bootstrapSpec!.bytes;
  const bootstrapArchiveBytes = bootstrapArchive!.bytes;
  const bootstrapEnvironmentBytes = bootstrapEnvironment!.bytes;
  const bottleMirrorPlanBytes = bottleMirrorPlan!.bytes;
  const plan = decodeHomebrewBottleMirrorPlan(
    bottleMirrorPlanBytes,
    "live Homebrew bottle mirror plan",
  );
  await assertHomebrewBottleMirrorPlanIdentity(plan);
  throwIfFixtureAborted(options.signal, transportController);
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
  for (const asset of plan.assets) {
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
  }

  const loadedPayloads = await loadFixtureAssetSources(
    sources.slice(FIXED_EXACT_ASSET_COUNT),
    fetchImpl,
    options.signal,
    transportController,
  );
  const loadedPayloadByAsset = new Map(
    payloads.map((payload, index) => [
      payload.asset,
      loadedPayloads[index]!,
    ]),
  );
  const closedBottleAssets: ClosedLazyAsset[] = plan.assets.map((asset) => {
    const payload = payloadFixtureByAsset.get(asset.asset);
    const loaded = loadedPayloadByAsset.get(asset.asset);
    if (
      payload === undefined ||
      loaded === undefined ||
      payload.url !== asset.url ||
      payload.sha256 !== asset.sha256 ||
      payload.bytes !== asset.bytes ||
      loaded.url !== asset.url ||
      loaded.sha256 !== asset.sha256 ||
      loaded.size !== asset.bytes
    ) {
      throw new Error(
        `live bottle payload fixture differs from mirror asset ${asset.asset}`,
      );
    }
    return loaded;
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

function settleFixtureLoadOnAbort<T>(
  loading: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return loading;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (finish()) reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Keep observing the underlying staged load after a deadline wins. Its
    // loader still cancels active bodies and preserves first-failure cleanup,
    // while the advertised total deadline can settle even if injected fetch
    // or Web Crypto work does not cooperate with AbortSignal.
    void loading.then(
      (value) => {
        if (finish()) resolve(value);
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function throwIfFixtureAborted(
  signal: AbortSignal | undefined,
  transportController: AbortController,
): void {
  if (signal?.aborted !== true) return;
  // The stage loader removes its listener after transport cleanup. Preserve
  // the same cancellation reason if the caller aborts while asynchronous plan
  // identity validation runs between the fixed and dependent fetch stages.
  transportController.abort(signal.reason);
  throw signal.reason;
}

async function loadFixtureAssetSources(
  sources: readonly ClosedLazyAssetSource[],
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  transportController: AbortController,
): Promise<ClosedLazyAsset[]> {
  try {
    return await loadClosedLazyAssetSources(sources, {
      fetchImpl,
      maxConcurrency: 4,
      signal,
      transportController,
    });
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      throw error;
    }
    throw new Error(
      `failed to load exact Homebrew browser lifecycle fixture assets: ` +
        `${String(error)}`,
      { cause: error },
    );
  }
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
  if (
    value.payloads !== undefined &&
    value.payloads.length >
      MAX_CLOSED_LAZY_ASSETS - FIXED_EXACT_ASSET_COUNT
  ) {
    throw new Error(
      `Homebrew browser lifecycle fixture exceeds ` +
        `${MAX_CLOSED_LAZY_ASSETS} exact assets`,
    );
  }
  let payloads: HomebrewGuestLifecycleBottlePayloadFixture[] | undefined;
  if (value.payloads !== undefined) {
    payloads = new Array(value.payloads.length);
    const seenAssets = new Set<string>();
    for (let index = 0; index < value.payloads.length; index += 1) {
      if (!Object.hasOwn(value.payloads, index)) {
        throw new Error(
          `Homebrew browser lifecycle bottle payload ${index} is missing`,
        );
      }
      const payload = projectBottlePayload(value.payloads[index], index);
      if (seenAssets.has(payload.asset)) {
        throw new Error(
          `Homebrew browser lifecycle bottle payloads duplicate asset ` +
            `${payload.asset}`,
        );
      }
      seenAssets.add(payload.asset);
      payloads[index] = payload;
    }
  }
  return {
    plan: projectExactAsset(value.plan, "bottle mirror plan"),
    ...(payloads === undefined ? {} : { payloads }),
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
    throw new Error(
      `${label} must use one canonical HTTPS URL without userinfo or a fragment`,
    );
  }
  return {
    url: value.url,
    sha256: value.sha256,
    bytes: value.bytes as number,
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}
