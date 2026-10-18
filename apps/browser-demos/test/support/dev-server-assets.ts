import type { Page } from "@playwright/test";

/**
 * The URL the app's dev server serves a package artifact at, obtained through
 * the same aliases the app itself imports (`@kernel-wasm`,
 * `@binaries/programs/...`).
 *
 * WHY not `/@fs/${resolveBinary(...)}`: under the SourceOnly resolution policy
 * (what `./run.sh prepare-browser` sets for the dev server), projection files
 * are served only after the server has resolved them itself, at an approved,
 * content-addressed `/__kandelo_source_only_assets__/<sha256>/...` URL; a raw
 * `/@fs/` read of the same file is refused with 403 by design. Asking the
 * server through the alias works under either policy.
 *
 * `page` must already be on a page served by the dev server.
 */
export async function devServerAssetUrl(
  page: Page,
  specifier: string,
): Promise<string> {
  return page.evaluate(async (spec) => {
    const module = await import(`/@id/${spec}?import&url`);
    return new URL(module.default as string, location.href).href;
  }, specifier);
}
