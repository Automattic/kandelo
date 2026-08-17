import * as React from "react";
import { createRoot } from "react-dom/client";
import { TerminalDockControls } from "../../pages/kandelo/app/TerminalDockControls";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import type { KernelHost } from "../../../../web-libs/kandelo-session/src/kernel-host";

const removals: string[] = [];
const stateRemovals: string[] = [];
const host = {
  removePty(path: string) {
    removals.push(path);
  },
} as unknown as KernelHost;
const root = createRoot(document.getElementById("root")!);
root.render(
  <KernelHostProvider host={host}>
    <TerminalDockControls
      terminals={[
        { id: "tty-1", label: "TTY1", path: "/dev/pts/0" },
        { id: "tty-2", label: "TTY2", path: "/dev/pts/1" },
      ]}
      activeTerminalId="tty-2"
      onActiveTerminalId={() => {}}
      onAddTerminal={() => {}}
      onRemoveTerminalId={(id) => stateRemovals.push(id)}
    />
  </KernelHostProvider>,
);

Object.assign(window, {
  __terminalRemovalTest: { root, removals, stateRemovals },
});
