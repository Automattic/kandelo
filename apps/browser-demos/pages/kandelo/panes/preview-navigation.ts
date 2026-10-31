import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PreviewNavigation } from "../../../lib/preview/preview-bridge";

/**
 * Document navigations the machine's preview bridge served, per host.
 *
 * The guest frame is cross-origin, so the Display pane cannot read its
 * location or document. It learns the frame's path and HTTP status from the
 * navigation requests the owning tab answers instead. A navigation request
 * names the machine, not the frame: a nested guest frame or a viewer tab
 * showing the same machine reports here too.
 */
type Listener = (navigation: PreviewNavigation) => void;

const listeners = new WeakMap<KernelHost, Set<Listener>>();

export function notifyPreviewNavigation(host: KernelHost, navigation: PreviewNavigation): void {
  for (const listener of listeners.get(host) ?? []) listener(navigation);
}

export function subscribePreviewNavigation(host: KernelHost, listener: Listener): () => void {
  let set = listeners.get(host);
  if (!set) {
    set = new Set();
    listeners.set(host, set);
  }
  set.add(listener);
  return () => set!.delete(listener);
}
