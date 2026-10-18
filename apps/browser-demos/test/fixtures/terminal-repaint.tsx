import * as React from "react";
import { createRoot } from "react-dom/client";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { Shell, createShellTerminal } from "../../pages/kandelo/panes/Shell";
import type { KernelHost } from "../../../../web-libs/kandelo-session/src/kernel-host";

const encoder = new TextEncoder();
const sessions = new Map<string, {
  history: Uint8Array[];
  listeners: Set<(bytes: Uint8Array) => void>;
}>();
const attachments: string[] = [];
const inputs: string[] = [];
const host = {
  getStatus: () => "running",
  subscribeStatus: () => () => {},
  getWebPreview: () => null,
  attachPty: async (path: string) => {
    attachments.push(path);
    let session = sessions.get(path);
    if (!session) {
      session = { history: [], listeners: new Set() };
      sessions.set(path, session);
    }
    const state = session;
    return {
      onData(callback: (bytes: Uint8Array) => void) {
        state.listeners.add(callback);
        for (const chunk of state.history) callback(chunk);
        return () => { state.listeners.delete(callback); };
      },
      resize() {},
      write(data: string) { inputs.push(`${path}:${data}`); },
      close() {},
    };
  },
} as unknown as KernelHost;

function Fixture() {
  const [active, setActive] = React.useState("tty-1");
  const [visible, setVisible] = React.useState(true);
  const [terminals, setTerminals] = React.useState([
    createShellTerminal(1), createShellTerminal(2),
  ]);
  return <KernelHostProvider host={host}>
    <button onClick={() => setActive("tty-1")}>TTY1</button>
    <button onClick={() => setActive("tty-2")}>TTY2</button>
    <button onClick={() => setVisible((current) => !current)}>Toggle terminal view</button>
    <button onClick={() => setTerminals([createShellTerminal(2)])}>Remove TTY1</button>
    <Shell visible={visible} autoFocus terminals={terminals} activeTerminalId={active}
      onActiveTerminalId={setActive} />
  </KernelHostProvider>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
Object.assign(window, {
  __terminalRepaint: {
    attachments, inputs,
    emit(path: string, data: string) {
      const session = sessions.get(path)!;
      const bytes = encoder.encode(data);
      session.history.push(bytes);
      if (session.history.length > 2048) session.history.shift();
      for (const listener of session.listeners) listener(bytes);
    },
    listeners(path: string) { return sessions.get(path)?.listeners.size ?? 0; },
  },
});
