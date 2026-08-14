import { corsProxyFetchUrl } from "../../../../host/src/networking/cors-proxy-url";

export interface CanonicalHomebrewAsset {
  inputId: string;
  package: string;
  descriptorReference: string;
  sourceUrl: string;
  sha256: string;
  bytes: number;
}

export interface CanonicalHomebrewTransportPlan {
  assets: CanonicalHomebrewAsset[];
}

interface CanonicalResolvedInput {
  bytes?: unknown;
  descriptor?: {
    bytes?: unknown;
    reference?: unknown;
    sha256?: unknown;
  };
  effective_materialization?: unknown;
  id?: unknown;
  kind?: unknown;
  reference?: unknown;
  sha256?: unknown;
}

export function browserResolvedLazySourceUrl(
  source: string,
  pageUrl: string,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    return new URL(source).href;
  }
  if (!source.startsWith("/")) {
    throw new Error(
      `lazy source must be absolute or root-relative: ${source}`,
    );
  }
  return new URL(source, pageUrl).href;
}

export function expectedBrowserLazyTransport(
  sourceUrl: string,
  pageUrl: string,
): "direct" | "proxy" {
  return new URL(sourceUrl).origin === new URL(pageUrl).origin
    ? "direct"
    : "proxy";
}

export function browserLazyFetchUrl(
  sourceUrl: string,
  pageUrl: string,
  corsProxyUrl: string,
): string {
  const resolved = browserResolvedLazySourceUrl(sourceUrl, pageUrl);
  return expectedBrowserLazyTransport(resolved, pageUrl) === "direct"
    ? resolved
    : corsProxyFetchUrl(new URL(corsProxyUrl, pageUrl).href, resolved);
}

export function canonicalAssetForPackage(
  plan: CanonicalHomebrewTransportPlan,
  fullName: string,
): CanonicalHomebrewAsset {
  const matches = plan.assets.filter((asset) => asset.package === fullName);
  if (matches.length !== 1) {
    throw new Error(
      `expected one canonical lazy asset for ${fullName}, found ${matches.length}`,
    );
  }
  const asset = matches[0]!;
  const formula =
    /^kandelo-dev\/tap-core\/([a-z0-9][a-z0-9+._-]{0,127})$/u
      .exec(fullName)?.[1];
  const descriptor =
    /^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[1-9][0-9]*\/([a-z0-9][a-z0-9+._-]{0,127})@sha256:[0-9a-f]{64}$/u
      .exec(asset.descriptorReference);
  const descriptorRepository = asset.descriptorReference
    .replace(/^ghcr\.io\//u, "")
    .replace(/@sha256:[0-9a-f]{64}$/u, "");
  if (
    formula === undefined ||
    descriptor?.[1] !== formula ||
    asset.inputId !== `homebrew-${formula}` ||
    !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.sourceUrl !==
      `https://ghcr.io/v2/${descriptorRepository}/blobs/sha256:${asset.sha256}`
  ) {
    throw new Error(`canonical lazy asset identity is invalid for ${fullName}`);
  }
  return { ...asset };
}

export function canonicalHomebrewTransportPlan(
  value: unknown,
): CanonicalHomebrewTransportPlan {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { schema?: unknown }).schema !== 1 ||
    (value as { kind?: unknown }).kind !==
      "kandelo-resolved-vfs-product-inputs" ||
    (value as { reference_class?: unknown }).reference_class !== "canonical" ||
    !Array.isArray((value as { inputs?: unknown }).inputs)
  ) {
    throw new Error("canonical resolved Homebrew inputs are invalid");
  }
  const inputs = (value as { inputs: CanonicalResolvedInput[] }).inputs;
  const assets = inputs
    .filter(({ effective_materialization, kind }) =>
      kind === "homebrew-bottle" &&
      effective_materialization === "lazy-reference"
    )
    .map((input): CanonicalHomebrewAsset => {
      const formula = typeof input.id === "string"
        ? /^homebrew-([a-z0-9][a-z0-9+._-]{0,127})$/u.exec(input.id)?.[1]
        : undefined;
      const reference = typeof input.reference === "string"
        ? /^(ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[1-9][0-9]*\/([a-z0-9][a-z0-9+._-]{0,127}))@sha256:([0-9a-f]{64})$/u
          .exec(input.reference)
        : null;
      const descriptorReference = input.descriptor?.reference;
      const descriptor = typeof descriptorReference === "string"
        ? /^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[1-9][0-9]*\/([a-z0-9][a-z0-9+._-]{0,127})@sha256:([0-9a-f]{64})$/u
          .exec(descriptorReference)
        : null;
      if (
        formula === undefined ||
        reference?.[2] !== formula ||
        reference[3] !== input.sha256 ||
        typeof descriptorReference !== "string" ||
        descriptor?.[1] !== formula ||
        descriptor?.[2] !== input.descriptor?.sha256 ||
        input.descriptor?.sha256 === undefined ||
        !/^[0-9a-f]{64}$/u.test(String(input.descriptor.sha256)) ||
        !Number.isSafeInteger(input.descriptor.bytes) ||
        Number(input.descriptor.bytes) < 1
      ) {
        throw new Error(
          `canonical lazy Homebrew input is invalid: ${String(input.id)}`,
        );
      }
      return {
        inputId: input.id as string,
        package: `kandelo-dev/tap-core/${formula}`,
        descriptorReference,
        sourceUrl:
          `https://ghcr.io/v2/${reference[1]!.replace(/^ghcr\.io\//u, "")}` +
          `/blobs/sha256:${reference[3]}`,
        sha256: String(input.sha256),
        bytes: Number(input.bytes),
      };
    })
    .sort((left, right) => left.package.localeCompare(right.package));
  if (assets.length === 0) {
    throw new Error("canonical resolved inputs contain no lazy Homebrew assets");
  }
  const plan = { assets };
  for (const asset of assets) {
    canonicalAssetForPackage(plan, asset.package);
  }
  return plan;
}
