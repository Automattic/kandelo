/**
 * Open a machine's web preview: resolve this deployment's preview origin,
 * reuse the tab's relay frame, and bind a PreviewBridgeHost that answers the
 * preview service worker with `fetchInKernel`. Throws with an explicit
 * message when the deployment has no preview origin; previews never fall
 * back to Kandelo's own origin.
 *
 * If the preview stops reaching this tab's machine (the preview origin
 * stopped confirming its rebinds), the pane shows that as an error until a
 * later rebind succeeds.
 */
import type { BrowserKernel } from "@host/browser-kernel-host";
import type {
  LiveKernelHost,
  WebPreviewState,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { resolveBrowserCorsProxyConfig } from "../../../lib/browser-cors-proxy";
import {
  NO_PREVIEW_ORIGIN_MESSAGE,
  blobIframeInterceptorSource,
  configuredPreviewOrigin,
} from "../../../lib/preview/config";
import { PreviewBridgeHost } from "../../../lib/preview/preview-bridge";
import { PreviewRelay } from "../../../lib/preview/preview-relay";
import { observePreviewRequest } from "../panes/preview-progress";
import { notifyPreviewNavigation } from "../panes/preview-navigation";

export async function openMachinePreview(
  host: LiveKernelHost,
  kernel: BrowserKernel,
  options: {
    port: number;
    hostname?: string;
    timeoutMs?: number;
    isCurrent: () => boolean;
    debugLog?: (line: string) => void;
  },
): Promise<PreviewBridgeHost> {
  const previewOrigin = configuredPreviewOrigin();
  if (previewOrigin === null) throw new Error(NO_PREVIEW_ORIGIN_MESSAGE);
  const scope = import.meta.env.BASE_URL;
  // The pane state this preview had before it was lost, to restore it when
  // an unconfirmed rebind later succeeds.
  let beforeLoss: WebPreviewState | null = null;
  let previewUrl: string | null = null;
  const ownsPane = (): WebPreviewState | null => {
    const current = host.getWebPreview();
    return options.isCurrent() && current !== null && current.url === previewUrl ? current : null;
  };
  const bridge = await PreviewBridgeHost.open({
    relay: PreviewRelay.forPage(previewOrigin, scope),
    previewOrigin,
    scope,
    appOrigin: window.location.origin,
    kernel,
    port: options.port,
    hostname: options.hostname,
    timeoutMs: options.timeoutMs,
    interceptorSource: blobIframeInterceptorSource(),
    debugLog: options.debugLog,
    onRequestStart: (request) =>
      options.isCurrent() ? observePreviewRequest(host, request.url) : undefined,
    onPendingRequests: (count) => {
      if (options.isCurrent()) host.setWebPreviewPendingRequests(count);
    },
    onNavigation: (navigation) => {
      if (options.isCurrent()) notifyPreviewNavigation(host, navigation);
    },
    onLost: (_reason, message) => {
      const current = ownsPane();
      if (current === null) return;
      if (beforeLoss === null) beforeLoss = current;
      host.setWebPreview({ ...current, status: "error", message });
    },
    onRestored: () => {
      const current = ownsPane();
      if (current !== null && beforeLoss !== null) host.setWebPreview({ ...current, status: beforeLoss.status, message: beforeLoss.message });
      beforeLoss = null;
    },
    refusedProxyOrigins: corsProxyOrigins(),
    window,
  });
  previewUrl = bridge.url;
  exposeCookieNamesForTests(bridge);
  return bridge;
}

/** Origins of the configured CORS proxy and credential relay. */
function corsProxyOrigins(): string[] {
  const config = resolveBrowserCorsProxyConfig({
    configuredUrl: import.meta.env.VITE_CORS_PROXY_URL,
    development: import.meta.env.DEV,
    baseUrl: import.meta.env.BASE_URL,
    pageUrl: window.location.href,
  });
  const origins = new Set<string>();
  for (const url of [config.url, config.credentialRelay?.url]) {
    if (!url) continue;
    try {
      origins.add(new URL(url, window.location.href).origin);
    } catch {
      // An unusable URL is rejected where the proxy is configured.
    }
  }
  return [...origins];
}

/**
 * Development servers only: let browser tests read the names and paths (never
 * values) of a machine's cookies, which live only in this tab's memory.
 */
function exposeCookieNamesForTests(bridge: PreviewBridgeHost): void {
  if (!import.meta.env.DEV) return;
  const registry = ((window as unknown as {
    __kandeloPreviewCookieNames?: Map<string, () => Array<{ name: string; path: string }>>;
  }).__kandeloPreviewCookieNames ??= new Map());
  registry.set(bridge.name, () => bridge.cookieEntries());
}
