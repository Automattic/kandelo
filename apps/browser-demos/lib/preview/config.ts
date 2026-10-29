/**
 * Where this deployment serves guest web previews.
 *
 * The build injects `__KANDELO_PREVIEW_ORIGIN__` (see the preview-origin
 * plugin in `vite.config.ts`):
 * - `{ kind: "origin", origin }`: an exact preview origin
 *   (`KANDELO_PREVIEW_ORIGIN` at build or dev-server start);
 * - `{ kind: "port-offset", offset }`: the Vite dev and preview servers, which
 *   serve the preview origin themselves on the app's host at the app's port
 *   plus `offset`, so `localhost` stays `localhost` and `127.0.0.1` stays
 *   `127.0.0.1` (same site);
 * - `null`: no preview origin. Web previews then fail with an explicit error;
 *   they never fall back to Kandelo's own origin.
 */

export type PreviewOriginConfig =
  | { kind: "origin"; origin: string }
  | { kind: "port-offset"; offset: number }
  | null;

declare const __KANDELO_PREVIEW_ORIGIN__: PreviewOriginConfig | undefined;
declare const __KANDELO_BLOB_IFRAME_INTERCEPTOR__: string | undefined;

export const NO_PREVIEW_ORIGIN_MESSAGE =
  "This deployment has no isolated preview origin, so web previews are unavailable.";

export function resolvePreviewOrigin(
  config: PreviewOriginConfig,
  pageUrl: string,
): string | null {
  if (config === null) return null;
  const page = new URL(pageUrl);
  if (config.kind === "origin") {
    const origin = new URL(config.origin).origin;
    if (origin === page.origin) {
      throw new Error("The preview origin must differ from Kandelo's own origin");
    }
    return origin;
  }
  const port = Number(page.port || (page.protocol === "https:" ? 443 : 80)) + config.offset;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`No preview port ${port} next to ${page.origin}`);
  }
  return `${page.protocol}//${page.hostname}:${port}`;
}

/** The preview origin for this page, or null when the deployment has none. */
export function configuredPreviewOrigin(pageUrl = window.location.href): string | null {
  const config = typeof __KANDELO_PREVIEW_ORIGIN__ === "undefined"
    ? null
    : __KANDELO_PREVIEW_ORIGIN__;
  return resolvePreviewOrigin(config, pageUrl);
}

/** Source of `public/blob-iframe-interceptor.js`, injected at build time. */
export function blobIframeInterceptorSource(): string {
  return typeof __KANDELO_BLOB_IFRAME_INTERCEPTOR__ === "undefined"
    ? ""
    : __KANDELO_BLOB_IFRAME_INTERCEPTOR__;
}
