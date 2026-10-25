// Kandelo entry point. Builds a LiveKernelHost over a real BrowserKernel
// (kernel.wasm + rootfs.vfs + bash.wasm). Shell panes attach to real PTYs.

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { initializeTheme } from "./app/theme";
import { SessionInvitationPreview } from "./app/SessionInvitationPreview";
import { App } from "./app/App";
import { KernelHostProvider } from "./kernel-host/react";
import type { KernelHost } from "./kernel-host";
import { readKandeloBootQuery } from "./url-state";
import { sessionInvitation } from "../../lib/network-session";
import {
  BootDescriptorError,
  decodeBootDescriptor,
} from "../../../../web-libs/kandelo-session/src/boot-descriptor";

const container = document.getElementById("kandelo-root");
if (!container) {
  throw new Error('No #kandelo-root element in the page.');
}

const qs = new URLSearchParams(location.search);
const bootQuery = readKandeloBootQuery(location.search);
// `?fb=test` is an app-level dev toggle for the framebuffer probe. It is
// deliberately NOT part of any image's demo.json: it belongs to whoever is
// debugging the host, not to the machine.
const fbDemo = qs.get("fb"); // "test" | null

initializeTheme();
const root = ReactDOM.createRoot(container);
let invitationOpen = true;
let invitationDismissed = false;
const mount = (host: KernelHost) => {
  root.render(
    <React.StrictMode>
      <KernelHostProvider host={host}>
        <App invitationOpen={invitationOpen} invitationDismissed={invitationDismissed} />
      </KernelHostProvider>
    </React.StrictMode>,
  );
};

void (async () => {
  let invitation: ReturnType<typeof sessionInvitation> = null;
  let setupError: string | undefined;
  const renderStatus = () => root.render(<div style={{ padding: 32, maxWidth: 780 }}>
    <strong>{setupError ? "LiveKernelHost setup failed" : "Preparing this computer…"}</strong>
    {setupError && <pre role="alert" style={{ whiteSpace: "pre-wrap" }}>{setupError}</pre>}
  </div>);
  const closePreview = () => { invitationOpen = false; renderStatus(); };
  const dismissPreview = () => { invitationDismissed = true; closePreview(); };
  try {
    invitation = sessionInvitation(location.href);
    // Show the invitation before host imports, image activation, or boot can wait.
    if (invitation) root.render(<SessionInvitationPreview invitation={invitation} close={closePreview} dismiss={dismissPreview} />);
    const activityInvitation = invitation?.offer;
    // URL fragments are untrusted input. A malformed or oversized #k1= boot
    // link must fail loudly here, not silently boot as if it were absent.
    const linkDescriptor = await decodeBootDescriptor(location.hash).catch(
      (err) => {
        if (err instanceof BootDescriptorError) {
          throw new Error(
            `Rejected #k1= boot link fragment: [${err.code}] ${err.message}`,
          );
        }
        throw new Error(
          `Rejected #k1= boot link fragment: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
    // A pre-fold-in `#k1=` link could carry a top-level `script: { text }`
    // field (superseded by `boot.inputs` + `boot.parameters.runScript`).
    // decodeBootDescriptor tolerates unknown fields, so such a link still
    // decodes and boots, but that script is never materialized or run.
    // Detect it here so live-setup can surface a visible boot-log notice
    // instead of silently dropping it.
    const legacyScriptIgnored =
      linkDescriptor !== null &&
      typeof (linkDescriptor as { script?: unknown }).script !== "undefined";

    // WHY: the restored image owns its shell and optional runtime entries.
    // Keeping every demo on one assembler prevents a demo-specific overlay
    // from replacing immutable bottle-backed lazy files before serialization.
    const host = await import("./kernel-host/live-setup")
      .then(({ createLiveHost }) => createLiveHost({
        profile: bootQuery.profileId,
        vfsUrl: bootQuery.vfsImageUrl,
        fb: fbDemo === "test" ? "test" : "none",
        inputs: linkDescriptor?.boot.inputs ?? null,
        parameters: linkDescriptor?.boot.parameters ?? null,
        legacyScriptIgnored,
        deferActivityLaunch: activityInvitation !== undefined,
      }));
    mount(host);
  } catch (err) {
    // Surface fetch / instantiation failures in the page so the user
    // doesn't have to open devtools to find out why nothing rendered.
    const detail = err instanceof Error ? err.message : String(err);
    setupError = detail;
    if (invitation && invitationOpen) {
      root.render(<SessionInvitationPreview invitation={invitation} close={closePreview} dismiss={dismissPreview} error={detail} />);
    } else renderStatus();
    console.error(err);
  }
})();
