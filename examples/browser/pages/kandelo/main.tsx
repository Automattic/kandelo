// Kandelo entry point.
//
// Default: builds a LiveKernelHost over a real BrowserKernel (kernel.wasm
// + rootfs.vfs + bash.wasm). Shell pane attaches to a real /dev/pts/0.
//
// `?mock=1`: mounts the React tree against a MockKernelHost so the chassis
// is exercisable end-to-end without a running kernel.

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { KernelHostProvider } from "./kernel-host/react";
import { MockKernelHost } from "./kernel-host/mock";
import type { KernelHost } from "./kernel-host";

const container = document.getElementById("kandelo-root");
if (!container) {
  throw new Error('No #kandelo-root element in the page.');
}

const qs = new URLSearchParams(location.search);
const useMock = qs.get("mock") === "1";
const useIdle = qs.get("idle") === "1";
const demo = qs.get("demo");
const fbDemo = qs.get("fb"); // "test" | "doom" | null

const mount = (host: KernelHost) => {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <KernelHostProvider host={host}>
        <App />
      </KernelHostProvider>
    </React.StrictMode>,
  );
};

if (useMock) {
  mount(new MockKernelHost(
    useIdle
      ? { status: "idle" }
      : { status: "booting", bootSpeed: 4 },
  ));
} else {
  // Lazy-load so the bundle doesn't pull in BrowserKernel when running
  // against the mock host.
  void (async () => {
    try {
      const { createLiveHost } = await import("./kernel-host/live-setup");
      const host = await createLiveHost({
        demo,
        fb: fbDemo === "test" || fbDemo === "doom" ? fbDemo : "none",
      });
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
            Falling back to the mock host requires adding <code>?mock=1</code> to the URL.
            See <code>examples/browser/pages/kandelo/kernel-host/live-setup.ts</code>.
          </div>
        </div>`;
      console.error(err);
    }
  })();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
