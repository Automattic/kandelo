// Kandelo entry point. Builds a LiveKernelHost over a real BrowserKernel
// (kernel.wasm + rootfs.vfs + bash.wasm). Shell panes attach to real PTYs.

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { KernelHostProvider } from "./kernel-host/react";
import type { KernelHost } from "./kernel-host";
import { readKandeloBootQuery } from "./url-state";

const container = document.getElementById("kandelo-root");
if (!container) {
  throw new Error('No #kandelo-root element in the page.');
}

const qs = new URLSearchParams(location.search);
const demo = qs.get("demo");
const fbDemo = qs.get("fb"); // "test" | null

const mount = (host: KernelHost) => {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <KernelHostProvider host={host}>
        <App />
      </KernelHostProvider>
    </React.StrictMode>,
  );
};

void (async () => {
  try {
    const bootQuery = readKandeloBootQuery(location.search);
    if (bootQuery.vfsImageUrl && bootQuery.homebrewVfsDescriptorUrl) {
      throw new Error(
        "Choose either the vfs query parameter or homebrewVfs, not both.",
      );
    }
    const useSpiderMonkeyNodeHost = !bootQuery.vfsImageUrl &&
      !bootQuery.homebrewVfsDescriptorUrl &&
      (demo === "node" || demo === "spidermonkey-node" || demo === "spidermonkey");
    const host = useSpiderMonkeyNodeHost
      ? await import("./kernel-host/live-spidermonkey-node-setup")
        .then(({ createLiveSpiderMonkeyNodeHost }) => createLiveSpiderMonkeyNodeHost(demo))
      : await import("./kernel-host/live-setup")
        .then(({ createLiveHost }) => createLiveHost({
          demo,
          vfsUrl: bootQuery.vfsImageUrl,
          homebrewVfsDescriptorUrl: bootQuery.homebrewVfsDescriptorUrl,
          fb: fbDemo === "test" ? "test" : "none",
        }));
    mount(host);
  } catch (err) {
    // Surface fetch / instantiation failures in the page so the user
    // doesn't have to open devtools to find out why nothing rendered.
    const detail = err instanceof Error ? err.message : String(err);
    container.innerHTML = `
      <div style="padding:32px;font-family:var(--k-font-mono);color:var(--k-err);max-width:780px;">
        <div style="font-weight:600;margin-bottom:8px">LiveKernelHost setup failed</div>
        <pre style="white-space:pre-wrap;font-size:12px;color:var(--k-text-muted)">${escapeHtml(detail)}</pre>
        <div style="margin-top:12px;font-size:12px;color:var(--k-text-faint)">
          See <code>apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts</code>.
        </div>
      </div>`;
    console.error(err);
  }
})();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
