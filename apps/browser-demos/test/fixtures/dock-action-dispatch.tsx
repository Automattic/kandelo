import * as React from "react";
import { createRoot } from "react-dom/client";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { useDockActions } from "../../pages/kandelo/panes/DockActions";
import type { KernelHost, MachineStatus } from "../../../../web-libs/kandelo-session/src/kernel-host";

const actions = [{ id: "restart", label: "Restart", restart: "replacement" }];
const statusListeners = new Set<(status: MachineStatus) => void>();
let status: MachineStatus = "running";
let finishQueue: (() => void) | undefined;
let report: (result: "queued" | "written" | "cancelled") => void;
let writes = 0;
const host = {
  getStatus: () => status,
  subscribeStatus: (callback: (value: MachineStatus) => void) => {
    statusListeners.add(callback);
    return () => statusListeners.delete(callback);
  },
  getDemoDockActions: () => actions,
  subscribeDemoDockActions: () => () => {},
  attachPty: async () => ({ onData: () => () => {}, close() {} }),
  dispatchShellCommand: async (_command: string, opts: Parameters<KernelHost["dispatchShellCommand"]>[1]) => {
    report("queued");
    await new Promise<void>((resolve) => { finishQueue = resolve; });
    try {
      await opts?.beforeWrite?.();
      writes++;
      report("written");
    } catch (error) {
      report("cancelled");
      throw error;
    }
  },
} as unknown as KernelHost;

function Actions() {
  const stop = React.useCallback(async () => {}, []);
  const { controls, toasts } = useDockActions("fixture", 0, stop);
  return <>{controls}{toasts}</>;
}

function Fixture() {
  const [mounted, setMounted] = React.useState(true);
  const [result, setResult] = React.useState("idle");
  report = setResult;
  return <>
    <output data-testid="result">{result}</output>
    <output data-testid="writes">{writes}</output>
    <KernelHostProvider host={host}>{mounted && <Actions />}</KernelHostProvider>
    <button onClick={() => setMounted(false)}>Unmount pane</button>
    <button onClick={() => {
      status = "halted";
      statusListeners.forEach((callback) => callback(status));
    }}>Stop machine</button>
    <button onClick={() => finishQueue?.()}>Finish old command</button>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
