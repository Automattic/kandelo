import {
  createClosedFixtureSourceUrl,
  loadHomebrewGuestLifecycleBrowserFixture,
} from "../../../../../homebrew/test/homebrew_guest_lifecycle_browser_fixture";
import { deriveHomebrewGuestLifecycleRuntimeInputs } from "../../../../../homebrew/test/homebrew_guest_lifecycle_runtime_inputs";
import {
  createClosedLazyAssetFetcher,
  type ClosedLazyAsset,
} from "../../../../../host/src/vfs/closed-lazy-assets";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  createReviewedPrivilegedProgramPolicy,
  publishPrivilegedProgramProduct,
  type PrivilegedProgramProjection,
  type PublishedPrivilegedProgramProduct,
} from "../../../../../host/src/vfs/privileged-projection";
import type { LocalLoginProductManifest } from "../../../lib/local-login-product-build";

export interface LoadedLocalLoginProduct {
  vfsUrl: string;
  vfsImageBytes: Uint8Array;
  closedLazyAssets: readonly ClosedLazyAsset[];
  privilegedProduct: PublishedPrivilegedProgramProduct;
}

/**
 * Fetch and authenticate the exact local-test product compiled into this app.
 * The manifest itself is emitted by build-owned code; fetched image or report
 * data cannot cause a normal build to enter this path or mint policy authority.
 */
export async function loadLocalLoginProduct(
  manifest: LocalLoginProductManifest,
): Promise<LoadedLocalLoginProduct> {
  const loaded = await loadHomebrewGuestLifecycleBrowserFixture(
    manifest.fixture,
    {
      sourceUrl: (canonicalUrl) =>
        createClosedFixtureSourceUrl(manifest.assetRoot, canonicalUrl),
    },
  );
  if (
    loaded.closedBottleAssets === undefined ||
    loaded.privilegedProductBytes === undefined ||
    loaded.compositionReportBytes === undefined
  ) {
    throw new Error("compiled local login product omits its exact closed assets");
  }
  const runtime = await deriveHomebrewGuestLifecycleRuntimeInputs({
    imageBytes: loaded.imageBytes.slice(),
    bootstrapSpecBytes: loaded.bootstrapSpecBytes,
    bootstrapArchiveBytes: loaded.bootstrapArchiveBytes,
    bootstrapArchiveSha256: manifest.fixture.bootstrap.archive.sha256,
    bootstrapEnvironmentBytes: loaded.bootstrapEnvironmentBytes,
    coreRevision: manifest.fixture.revisions.coreRevision,
    transportMode: "closed",
    expectedEmbeddedBottlePlanBytes: loaded.bottleMirrorPlanBytes,
    lazyUrlBase: new URL(".", manifest.fixture.bootstrap.archive.url).href,
    closedBottleAssets: loaded.closedBottleAssets,
  });
  if (runtime.lazyAssets === undefined) {
    throw new Error("compiled local login product has no closed lazy assets");
  }
  const privilegedProduct = await publishCompiledLocalLoginPrograms({
    imageBytes: runtime.imageBytes.slice(),
    projections: manifest.projections,
    serializedProductBytes: loaded.privilegedProductBytes,
    closedLazyAssets: runtime.lazyAssets,
  });
  return {
    vfsUrl: createClosedFixtureSourceUrl(
      manifest.assetRoot,
      manifest.fixture.image.url,
    ),
    vfsImageBytes: loaded.imageBytes,
    closedLazyAssets: runtime.lazyAssets,
    privilegedProduct,
  };
}

export async function publishCompiledLocalLoginPrograms(options: {
  imageBytes: Uint8Array;
  projections: readonly PrivilegedProgramProjection[];
  serializedProductBytes: Uint8Array;
  closedLazyAssets?: readonly ClosedLazyAsset[];
}): Promise<PublishedPrivilegedProgramProduct> {
  const fs = MemoryFileSystem.fromImage(options.imageBytes);
  await fs.verifyImportedLazyAtomicGroupSeals();
  if (options.closedLazyAssets !== undefined) {
    fs.setLazyFetcher(createClosedLazyAssetFetcher(options.closedLazyAssets));
  }
  const policy = createReviewedPrivilegedProgramPolicy(options.projections);
  for (const projection of options.projections) {
    await fs.preparePath(homebrewCellarPath(projection.sourcePath));
  }
  const product = await publishPrivilegedProgramProduct({
    policy,
    sources: options.projections.map((projection) => ({
      formula: projection.formula,
      bottleSha256: projection.bottleSha256,
      fs,
      inventory: {
        entries: [{
          sourcePath: projection.sourcePath,
          type: "file" as const,
          size: fs.stat(homebrewCellarPath(projection.sourcePath)).size,
        }],
      },
      guestPathForSource: homebrewCellarPath,
    })),
    writableBottleFileSystems: [fs],
  });
  if (!bytesEqual(product.imageBytes, options.serializedProductBytes)) {
    throw new Error(
      "published privileged product differs from the exact serialized artifact",
    );
  }
  return product;
}

function homebrewCellarPath(sourcePath: string): string {
  return `/opt/kandelo/homebrew/Cellar/${sourcePath}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}
