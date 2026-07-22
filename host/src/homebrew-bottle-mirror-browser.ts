import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  projectHomebrewBottleMirrorPlan,
  type HomebrewBottleMirrorPlan,
} from "./homebrew-bottle-mirror-plan";
import {
  type ClosedLazyAsset,
} from "./vfs/closed-lazy-assets";

const MAX_MIRROR_PLAN_BYTES = 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Load a pre-publication bundle under one same-origin path while preserving
 * the final immutable GitHub URLs as the only keys visible to the guest VFS.
 */
export async function loadHomebrewBottleMirrorClosedAssets(options: {
  embeddedPlanBytes: Uint8Array;
  bundleRoot: string;
  fetchImpl?: FetchLike;
  maxConcurrency?: number;
}): Promise<{ plan: HomebrewBottleMirrorPlan; assets: ClosedLazyAsset[] }> {
  const plan = await parseHomebrewBottleMirrorPlan(options.embeddedPlanBytes);
  const bundleRoot = canonicalBundleRoot(options.bundleRoot);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxConcurrency = options.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
    throw new Error("Homebrew bottle mirror concurrency must be an integer from 1 to 16");
  }
  const assets = await mapWithConcurrency(plan.assets, maxConcurrency, async (asset) => {
    const localUrl = `${bundleRoot}/${encodeURIComponent(asset.asset)}`;
    const response = await fetchImpl(localUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Homebrew bottle mirror fetch failed for ${asset.asset}: HTTP ${response.status}`);
    }
    const bytes = await readExactResponseBytes(response, asset.bytes, asset.asset);
    const actualSha256 = await sha256(bytes);
    if (actualSha256 !== asset.sha256) {
      throw new Error(`Homebrew bottle mirror asset ${asset.asset} changed SHA-256`);
    }
    return {
      url: asset.url,
      sha256: asset.sha256,
      size: asset.bytes,
      bytes,
    };
  });
  return { plan, assets };
}

async function readExactResponseBytes(
  response: Response,
  expectedBytes: number,
  asset: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new Error(
        `Homebrew bottle mirror asset ${asset} has invalid Content-Length`,
      );
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength !== expectedBytes) {
      throw new Error(
        `Homebrew bottle mirror asset ${asset} declares ${declaredLength} bytes, ` +
          `expected ${expectedBytes}`,
      );
    }
  }

  const output = new Uint8Array(expectedBytes);
  if (response.body === null) {
    throw new Error(
      `Homebrew bottle mirror asset ${asset} has 0 bytes, expected ${expectedBytes}`,
    );
  }
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedBytes - offset) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `Homebrew bottle mirror asset ${asset} exceeds ${expectedBytes} bytes`,
        );
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) {
    throw new Error(
      `Homebrew bottle mirror asset ${asset} has ${offset} bytes, ` +
        `expected ${expectedBytes}`,
    );
  }
  return output;
}

export async function parseHomebrewBottleMirrorPlan(
  bytes: Uint8Array,
): Promise<HomebrewBottleMirrorPlan> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MIRROR_PLAN_BYTES) {
    throw new Error(`Homebrew bottle mirror plan must be 1-${MAX_MIRROR_PLAN_BYTES} bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("Homebrew bottle mirror plan is not valid UTF-8 JSON", { cause: error });
  }
  const plan = projectHomebrewBottleMirrorPlan(decoded);
  const canonicalBytes = encodeHomebrewBottleMirrorPlan(plan);
  if (!equalBytes(bytes, canonicalBytes)) {
    throw new Error("Homebrew bottle mirror plan bytes are not canonical");
  }
  const collectionSha256 = await sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(plan.repository, plan.assets),
  );
  const expectedTag = `homebrew-shell-bottles-sha256-${collectionSha256}`;
  const expectedRoot = `https://github.com/${plan.repository}/releases/download/${expectedTag}`;
  if (
    plan.collection_sha256 !== collectionSha256 || plan.tag !== expectedTag ||
    plan.release_root !== expectedRoot ||
    plan.assets.some((asset) => asset.url !== `${expectedRoot}/${asset.asset}`)
  ) {
    throw new Error("Homebrew bottle mirror plan has inconsistent derived identity");
  }
  return plan;
}

function canonicalBundleRoot(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")) {
    throw new Error("Homebrew bottle mirror bundle root must be an absolute same-origin path");
  }
  const parsed = new URL(value, "https://kandelo.invalid/");
  const normalized = parsed.pathname.replace(/\/+$/, "");
  if (
    parsed.origin !== "https://kandelo.invalid" || parsed.search !== "" ||
    parsed.hash !== "" || normalized === "" || normalized === "/" ||
    normalized.split("/").includes("..") || normalized !== value.replace(/\/+$/, "")
  ) {
    throw new Error("Homebrew bottle mirror bundle root is not canonical");
  }
  return normalized;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        output[index] = await map(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}
