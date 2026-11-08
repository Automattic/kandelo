import * as React from "react";
import { createRoot } from "react-dom/client";
import { LiveKernelHost } from "../../../../web-libs/kandelo-session/src/kernel-host";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { Display } from "../../pages/kandelo/panes/Display";

export function mountPreviewNavigationFixture(container: HTMLElement) {
  const host = new LiveKernelHost({ status: "running" });
  host.setWebPreview({
    status: "running", label: "Navigation target",
    url: new URL("/navigation-contract/", location.href).href,
    initialPath: "/source.html",
  });
  function Fixture() {
    const [controls, setControls] = React.useState<React.ReactNode>(null);
    return <KernelHostProvider host={host}>
      <Display surface="web" autoFocus onDockControlsChange={setControls} />
      {controls}
    </KernelHostProvider>;
  }
  const root = createRoot(container);
  root.render(<Fixture />);
  return { dispose() { root.unmount(); } };
}
