// Mounts the boot screen over a real LiveKernelHost so a test can drive the
// VFS image progress channel directly. Nothing here stubs the UI: the bar
// under test is the one the Kandelo page renders while a machine boots.

import * as React from "react";
import * as ReactDOM from "react-dom/client";

// Load the page's real stylesheets so the bar under test has the dimensions
// a user actually sees; an unstyled bar is a zero-height div.
import "../../pages/kandelo/tokens.css";
import "../../pages/kandelo/styles.css";

import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { Shell } from "../../pages/kandelo/panes/Shell";
import { BootProgressBar } from "../../pages/kandelo/panes/BootProgressBar";
import {
  LiveKernelHost,
  type BootProgress,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export interface BootProgressFixture {
  setProgress(progress: BootProgress | null): void;
  finishBoot(): void;
  unmount(): void;
}

export function mountBootScreen(container: HTMLElement): BootProgressFixture {
  const host = new LiveKernelHost({ status: "booting" });
  const root = ReactDOM.createRoot(container);
  root.render(
    React.createElement(
      KernelHostProvider,
      { host },
      React.createElement(BootProgressBar, {}),
      React.createElement(Shell, {}),
    ),
  );
  return {
    setProgress(progress) {
      host.setBootProgress(progress);
    },
    finishBoot() {
      host.setStatus("running");
    },
    unmount() {
      root.unmount();
    },
  };
}
