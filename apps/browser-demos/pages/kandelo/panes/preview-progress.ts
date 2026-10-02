import type { KernelHost } from '../../../../../web-libs/kandelo-session/src/kernel-host';

export type PreviewProgress = {
  navigationId: number;
  requestedPath: string;
  navigationAccepted: boolean;
  http: { state: 'pending' | 'received' | 'failed' | 'not_requested'; status: number | null; error?: string };
  documentLoaded: boolean;
  rendered: boolean;
};
const states = new WeakMap<KernelHost, PreviewProgress>();
export function getPreviewProgress(host: KernelHost): PreviewProgress | null { return states.get(host) ?? null; }
export function resetPreviewProgress(host: KernelHost) { states.delete(host); }
export function beginPreviewNavigation(host: KernelHost, path: string): PreviewProgress {
  const state: PreviewProgress = { navigationId: (states.get(host)?.navigationId ?? 0) + 1, requestedPath: path, navigationAccepted: true, http: { state: 'pending', status: null }, documentLoaded: false, rendered: false };
  states.set(host, state);
  return state;
}
/** Capture at request start so late responses cannot complete a newer navigation. */
export function observePreviewRequest(host: KernelHost, url: string) {
  const state = states.get(host);
  const request = new URL(url, 'https://guest.invalid');
  if (!state || `${request.pathname}${request.search}` !== state.requestedPath.split('#')[0]) return undefined;
  return (status: number | null, error?: string) => {
    if (states.get(host) !== state) return;
    state.http = { state: error ? 'failed' : 'received', status, ...(error ? { error } : {}) };
  };
}
export function previewDocumentLoaded(host: KernelHost, path: string): PreviewProgress | null {
  const state = states.get(host);
  if (!state || state.requestedPath !== path) return null;
  state.documentLoaded = true;
  return state;
}
export function previewRendered(host: KernelHost, state: PreviewProgress) {
  if (states.get(host) === state) state.rendered = true;
}
