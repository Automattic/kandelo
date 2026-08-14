export { LiveKernelHost } from "../../../web-libs/kandelo-session/src/kernel-host";

import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { PackagePrefetchToasts } from "../pages/kandelo/app/App";
import type { HomebrewPackagePrefetchState } from "../../../web-libs/kandelo-session/src/kernel-host";

let packagePrefetchFixtureRoot: ReactDOM.Root | null = null;

export function mountPackagePrefetchToastFixture(
  container: HTMLElement,
  states: HomebrewPackagePrefetchState[],
): void {
  packagePrefetchFixtureRoot?.unmount();
  packagePrefetchFixtureRoot = ReactDOM.createRoot(container);
  packagePrefetchFixtureRoot.render(React.createElement(PackagePrefetchToasts, {
    states,
    onRetry: (id: string) => {
      container.dataset.retryId = id;
    },
  }));
}
