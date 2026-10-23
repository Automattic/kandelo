import * as React from "react";
import { createRoot } from "react-dom/client";
import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { useDockActions } from "../../pages/kandelo/panes/DockActions";
import { useMachineSurfaceController } from "../../pages/kandelo/views/MachineView";
import type { KernelHost, MachineStatus } from "../../../../web-libs/kandelo-session/src/kernel-host";

const presentation = { bootPrimary: "terminal", runningPrimary: ["kms", "terminal"] };
const availability = { terminal: true, syslog: true, kms: true, framebuffer: false, web: false };
const actions = [{ id: "replace", label: "Replace display", restart: "replacement" }];
let output: ((bytes: Uint8Array) => void) | undefined;
let finishStopping: (() => void) | undefined;
let failDispatch = false;
let status: MachineStatus = "running";
const statusListeners = new Set<(value: MachineStatus) => void>();
const host = {
  getStatus: () => status,
  subscribeStatus: (callback: (value: MachineStatus) => void) => {
    statusListeners.add(callback);
    return () => statusListeners.delete(callback);
  },
  getPresentation: () => presentation,
  subscribePresentation: () => () => {},
  getSurfaceAvailability: () => availability,
  subscribeSurfaceAvailability: () => () => {},
  getWebPreview: () => null,
  subscribeWebPreview: () => () => {},
  getDemoDockActions: () => actions,
  subscribeDemoDockActions: () => () => {},
  attachPty: async () => ({
    onData: (callback: typeof output) => { output = callback; return () => { output = undefined; }; },
    close() {},
  }),
  dispatchShellCommand: async (_command: string, opts?: { beforeWrite?: () => void | Promise<void> }) => {
    // A display owner's exit can precede its shell finishing the old prompt.
    output?.(new TextEncoder().encode("\r\nkandelo$ "));
    await opts?.beforeWrite?.();
    if (failDispatch) throw new Error("dispatch failed");
    output?.(new TextEncoder().encode("replacement: Preparing display\n"));
  },
} as unknown as KernelHost;

function Fixture() {
  const surface = useMachineSurfaceController();
  const [frames, setFrames] = React.useState(10);
  const [mounted, setMounted] = React.useState(true);
  React.useEffect(() => surface.onKmsOwnerChange(42), [surface.onKmsOwnerChange]);
  const stop = React.useCallback(async () => {
    surface.onKmsOwnerChange(null);
    await new Promise<void>((resolve) => { finishStopping = resolve; });
  }, [surface.onKmsOwnerChange]);
  return <>
    <output data-testid="view">{surface.activeView}</output>
    <output data-testid="available">{String(surface.canOpenDemo)}</output>
    {mounted && <Actions active={surface.activeView === "demo"} frames={frames} stop={stop} />}
    <button onClick={() => finishStopping?.()}>Finish stopping</button>
    <button onClick={() => { surface.onKmsOwnerChange(43); setFrames((n) => n + 1); }}>Replacement frame</button>
    <button onClick={() => surface.onKmsOwnerChange(null)}>Ordinary quit</button>
    <button onClick={() => output?.(new TextEncoder().encode("replacement: failed\nkandelo$ "))}>Return prompt</button>
    <button onClick={() => { failDispatch = true; }}>Fail dispatch</button>
    <button onClick={() => setMounted(false)}>Unmount actions</button>
    <button onClick={() => { status = "idle"; statusListeners.forEach((callback) => callback(status)); }}>Stop machine</button>
    <button onClick={() => { status = "running"; statusListeners.forEach((callback) => callback(status)); }}>Resume machine</button>
    <button onClick={() => surface.chooseView("terminal")}>Select terminal</button>
    <button onClick={() => surface.chooseView("demo")}>Select demo</button>
  </>;
}

function Actions({ active, frames, stop }: { active: boolean; frames: number; stop: () => Promise<void> }) {
  const { controls, toasts } = useDockActions("fixture", frames, stop);
  return active ? <div>{controls}{toasts}</div> : null;
}

createRoot(document.getElementById("root")!).render(<KernelHostProvider host={host}><Fixture /></KernelHostProvider>);
