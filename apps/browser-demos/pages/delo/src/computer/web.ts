// The web device of a delo computer: the page its web preview serves, in a
// frame, or the preview's status while it has no page to show.

import type { KernelHost, WebPreviewState } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { buildPreviewUrl, relativePathFromHref } from "../../../kandelo/panes/preview-url";
import type { OpenSurface } from "./surface";

export interface OpenWeb extends OpenSurface {
  /** Show the guest path `path` in the frame; null while no web server runs. */
  open(path: string): string | null;
  /** The page the frame shows; null while no web server runs. */
  read(): WebPage | null;
}

export interface WebPage {
  /** The guest path of the page, or null while it is outside the web server. */
  path: string | null;
  title: string;
  loaded: boolean;
  text: string;
}

export function openWeb(host: KernelHost, frame: HTMLIFrameElement, message: HTMLElement): OpenWeb {
  let path: string | null = null;
  const render = (state: WebPreviewState | null) => {
    const running = state?.status === "running";
    frame.hidden = !running;
    message.hidden = running;
    message.textContent = state === null ? "no web server is running" : state.message ?? `the web server is ${state.status}`;
    if (!running) return;
    const url = path === null ? state.url : buildPreviewUrl(state.url, path);
    if (frame.src !== new URL(url, window.location.href).href) frame.src = url;
  };
  host.subscribeWebPreview(render);
  render(host.getWebPreview());
  return {
    focus: () => frame.focus(),
    open: (next) => {
      const state = host.getWebPreview();
      if (state?.status !== "running") return null;
      path = next;
      render(state);
      return frame.src;
    },
    read: () => {
      const state = host.getWebPreview();
      const page = frame.contentDocument;
      if (state?.status !== "running" || page === null) return null;
      return {
        path: relativePathFromHref(state.url, page.location.href),
        title: page.title,
        loaded: page.readyState === "complete",
        text: page.body?.innerText ?? "",
      };
    },
  };
}
