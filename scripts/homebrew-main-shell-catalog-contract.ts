export interface MainShellCatalogIdentity {
  tapRepository: string;
  tapName: string;
  tapCommit: string;
}

/**
 * Validate the immutable catalog identity from the guest-visible composition
 * descriptor without importing Node-only image-build helpers.
 */
export function assertMainShellGuestCatalogIdentity(
  guestManifest: unknown,
  expected: MainShellCatalogIdentity,
): void {
  const guest = requiredRecord(guestManifest, "guest Homebrew manifest");
  expectEqual(guest.schema, 1, "guest Homebrew manifest schema");
  const catalog = requiredRecord(
    guest.catalog,
    "guest Homebrew catalog",
  );
  expectEqual(
    catalog.tap_repository,
    expected.tapRepository,
    "guest Homebrew catalog tap_repository",
  );
  expectEqual(
    catalog.tap_name,
    expected.tapName,
    "guest Homebrew catalog tap_name",
  );
  expectEqual(
    catalog.checkout_commit,
    expected.tapCommit,
    "guest Homebrew catalog checkout_commit",
  );
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Homebrew main-shell image contract: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `Homebrew main-shell image contract: ${label} is ` +
        `${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}
