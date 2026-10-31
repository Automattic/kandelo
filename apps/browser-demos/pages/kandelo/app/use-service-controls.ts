import * as React from "react";
import type { KernelHost, MachineStatus } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { ComputerServiceAction, ComputerServiceStatus } from "../../../../../web-libs/kandelo-session/src/computer-services";
import { ServiceSupervisorStartingError } from "../../../../../web-libs/kandelo-session/src/computer-services";

export function useServiceControls(host: KernelHost, status: MachineStatus) {
  const [entries, setEntries] = React.useState<ComputerServiceStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const generation = React.useRef(0);
  const reading = React.useRef<symbol | null>(null);
  const changing = React.useRef(false);
  const refresh = React.useCallback(async () => {
    const controller = host.services;
    if (!controller || status !== "running" || reading.current) return;
    const current = generation.current;
    const token = Symbol();
    reading.current = token;
    try {
      const next = await controller.list();
      if (current !== generation.current) return;
      setEntries(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      setError(null);
      setStarting(false);
    } catch (failure) {
      if (current === generation.current) {
        setEntries([]);
        setStarting(failure instanceof ServiceSupervisorStartingError);
        setError(failure instanceof ServiceSupervisorStartingError ? null : failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (reading.current === token) reading.current = null;
    }
  }, [host, status]);
  React.useEffect(() => {
    generation.current++;
    reading.current = null;
    changing.current = false;
    setEntries([]); setError(null); setBusy(false); setStarting(false);
    if (status !== "running" || !host.services) return;
    void refresh();
    const visibleRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visibleRefresh, 10_000);
    window.addEventListener("focus", visibleRefresh);
    const off = host.subscribeVfsChanges("/etc/kandelo", visibleRefresh);
    const offSupervisor = host.subscribeVfsChanges("/run/kandelo-services", visibleRefresh);
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener("focus", visibleRefresh); off(); offSupervisor(); };
  }, [host, status, refresh]);
  const change = async (action: ComputerServiceAction, id: string) => {
    const controller = host.services;
    if (!controller || status !== "running" || changing.current) return false;
    const current = generation.current;
    changing.current = true; setBusy(true); setError(null);
    try {
      await controller.change(action, id);
      if (current !== generation.current) return false;
      await refresh();
      return current === generation.current;
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (current === generation.current) { changing.current = false; setBusy(false); }
    }
  };
  return { entries, error, busy, starting, refresh, change };
}

export type ServiceControls = ReturnType<typeof useServiceControls>;
