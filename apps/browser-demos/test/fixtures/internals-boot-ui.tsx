import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "../../pages/kandelo/app/App";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { LiveKernelHost } from "../../../../web-libs/kandelo-session/src/kernel-host";
import "../../pages/kandelo/tokens.css";
import "../../pages/kandelo/styles.css";

// This exercises the actual app's boot presentation lifecycle, without a
// kernel or guest. A profile's descriptor is enriched after image composition.
const host = new LiveKernelHost({
  status: "booting",
  presentation: {
    bootPrimary: "syslog",
    runningPrimary: ["syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
  },
});
host.setDescriptor({ ...host.getBootDescriptor(), id: "loading-profile", title: "Loading profile" });
host.pushDmesg({ t: 0, level: "info", facility: "init", msg: "Boot composition started" });
const root = createRoot(document.getElementById("root")!);
root.render(<KernelHostProvider host={host}><App invitationOpen={false} /></KernelHostProvider>);

Object.assign(window, {
  __internalsBootTest: {
    enrich(id: string, title: string, running: boolean) {
      // Flush the real subscriptions and their effects before returning to
      // the assertion, so a transient render cannot pass ahead of the reset.
      flushSync(() => {
        host.setDescriptor({ ...host.getBootDescriptor(), id, title });
        host.setPresentation(host.getPresentation());
        if (running) host.setStatus("running");
        host.pushDmesg({ t: 1, level: "info", facility: "init", msg: `Resolved ${title}` });
      });
    },
  },
});
