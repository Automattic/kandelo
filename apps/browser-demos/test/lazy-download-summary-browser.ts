import "../pages/kandelo/tokens.css";
import "../pages/kandelo/styles.css";
import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { KernelHostProvider, useLazyDownloads } from "../pages/kandelo/kernel-host/react";
import { LazyDownloadToasts } from "../pages/kandelo/app/LazyDownloadToasts";
import type { KernelHost } from "../../../web-libs/kandelo-session/src/kernel-host";
export { LiveKernelHost } from "../../../web-libs/kandelo-session/src/kernel-host";

export function mountLazyDownloadToasts(host: KernelHost): () => void {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const Downloads = () => React.createElement(LazyDownloadToasts, { downloads: useLazyDownloads() });
  flushSync(() => root.render(React.createElement(KernelHostProvider, { host, children: React.createElement(Downloads) })));
  return () => { root.unmount(); element.remove(); };
}
