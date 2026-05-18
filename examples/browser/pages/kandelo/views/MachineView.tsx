// MachineView — phase-aware demo presentation.
//
// During boot the machine shows syslog as the primary surface. Once the demo
// reaches the useful state, the primary surface follows the active profile:
// web preview for service demos, framebuffer for Doom, terminal for shell-like
// demos. Terminal and internals stay available as drawers.

import * as React from "react";
import { usePresentation, useStatus, useSurfaceAvailability } from "../kernel-host/react";
import { Inspector } from "../panes/Inspector";
import { Display } from "../panes/Display";
import { Shell } from "../panes/Shell";
import type { PrimarySurface, SurfaceAvailability } from "../../../../../host/src/kandelo-ui/kernel-host";

export interface MachineViewProps {
  focusInternals?: boolean;
  internalsTab: string;
  onInternalsTab: (id: string) => void;
}

export const MachineView: React.FC<MachineViewProps> = ({ focusInternals = false, internalsTab, onInternalsTab }) => {
  const status = useStatus();
  const presentation = usePresentation();
  const availability = useSurfaceAvailability();
  const [activePrimary, setActivePrimary] = React.useState<PrimarySurface>(presentation.bootPrimary);
  const [primaryMode, setPrimaryMode] = React.useState<"following-demo" | "pinned">("following-demo");
  const [terminalOpen, setTerminalOpen] = React.useState(false);
  const [internalsOpen, setInternalsOpen] = React.useState(false);
  const previousAvailability = React.useRef(availability);

  const defaultPrimary = React.useMemo<PrimarySurface>(() => {
    if (status !== "running") return presentation.bootPrimary;
    return resolvePrimary(presentation.runningPrimary, availability, presentation.bootPrimary);
  }, [availability, presentation, status]);

  React.useEffect(() => {
    if (primaryMode === "following-demo" || !isSurfaceAvailable(activePrimary, availability)) {
      setActivePrimary(defaultPrimary);
    }
  }, [activePrimary, availability, defaultPrimary, primaryMode]);

  React.useEffect(() => {
    const previous = previousAvailability.current;
    previousAvailability.current = availability;
    if (status !== "running") return;
    if (activePrimary !== "terminal") return;
    const preferred = presentation.runningPrimary[0];
    if (!preferred || preferred === "terminal") return;
    if (previous[preferred] || !availability[preferred]) return;

    setActivePrimary(preferred);
    setPrimaryMode("following-demo");
  }, [activePrimary, availability, presentation.runningPrimary, status]);

  React.useEffect(() => {
    if (!focusInternals) return;
    setActivePrimary("syslog");
    setPrimaryMode("pinned");
  }, [focusInternals, internalsTab]);

  React.useEffect(() => {
    setPrimaryMode("following-demo");
    setTerminalOpen(false);
    setInternalsOpen(false);
  }, [presentation.runningPrimary, presentation.autoCommand]);

  const choosePrimary = (surface: PrimarySurface) => {
    if (!isSurfaceAvailable(surface, availability)) return;
    setActivePrimary(surface);
    setPrimaryMode(surface === defaultPrimary ? "following-demo" : "pinned");
  };

  const primaryLabel = surfaceLabel(activePrimary);
  const demoSurface = status === "running"
    ? resolvePrimary(presentation.runningPrimary, availability, presentation.bootPrimary)
    : presentation.runningPrimary[0] ?? "terminal";
  const canOpenDemo = status === "running" && isSurfaceAvailable(demoSurface, availability);

  return (
    <div className="kmachine">
      <div className="kmachine-toolbar">
        <div className="kmachine-switch" role="tablist" aria-label="Machine surfaces">
          <SurfaceButton
            active={activePrimary === demoSurface && demoSurface !== "terminal" && status === "running"}
            disabled={!canOpenDemo || demoSurface === "terminal"}
            onClick={() => choosePrimary(demoSurface)}
            label="Demo"
          />
          <SurfaceButton
            active={activePrimary === "terminal"}
            disabled={!availability.terminal}
            onClick={() => choosePrimary("terminal")}
            label="Terminal"
          />
          <SurfaceButton
            active={activePrimary === "syslog"}
            onClick={() => choosePrimary("syslog")}
            label="Internals"
          />
        </div>
        <div className="kmachine-current">{primaryLabel}</div>
      </div>

      <div className="kmachine-primary">
        {renderSurface(activePrimary, internalsTab, onInternalsTab)}
      </div>

      {activePrimary !== "terminal" && (
        <MachineDrawer
          title="Terminal"
          open={terminalOpen}
          onToggle={() => {
            setTerminalOpen((v) => !v);
          }}
        >
          <Shell autoFocus />
        </MachineDrawer>
      )}

      {activePrimary !== "syslog" && (
        <MachineDrawer
          title="Internals"
          open={internalsOpen}
          onToggle={() => {
            setInternalsOpen((v) => !v);
          }}
        >
          <Inspector tab={internalsTab} onTab={onInternalsTab} />
        </MachineDrawer>
      )}
    </div>
  );
};

const SurfaceButton: React.FC<{
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}> = ({ label, active, disabled, onClick }) => (
  <button
    type="button"
    className="kmachine-switch-btn"
    aria-current={active}
    disabled={disabled}
    onClick={onClick}
  >
    {label}
  </button>
);

const MachineDrawer: React.FC<{
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, open, onToggle, children }) => (
  <section className={`kmachine-drawer${open ? " open" : ""}`}>
    <button
      type="button"
      className="kmachine-drawer-toggle"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="kmachine-drawer-dot" />
      <span>{title}</span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d={open ? "M3 7.5 6 4.5l3 3" : "M3 4.5 6 7.5l3-3"} />
      </svg>
    </button>
    {open && <div className="kmachine-drawer-body">{children}</div>}
  </section>
);

function renderSurface(
  surface: PrimarySurface,
  internalsTab: string,
  onInternalsTab: (id: string) => void,
): React.ReactNode {
  switch (surface) {
    case "terminal":
      return <Shell autoFocus />;
    case "framebuffer":
    case "web":
      return <Display autoFocus />;
    case "syslog":
    default:
      return <Inspector tab={internalsTab} onTab={onInternalsTab} />;
  }
}

function surfaceLabel(surface: PrimarySurface): string {
  switch (surface) {
    case "terminal": return "Terminal";
    case "framebuffer": return "Framebuffer";
    case "web": return "Web Preview";
    case "syslog": return "System Internals";
  }
}

function resolvePrimary(
  preferences: readonly PrimarySurface[],
  availability: SurfaceAvailability,
  fallback: PrimarySurface,
): PrimarySurface {
  return preferences.find((surface) => isSurfaceAvailable(surface, availability)) ?? fallback;
}

function isSurfaceAvailable(surface: PrimarySurface, availability: SurfaceAvailability): boolean {
  return availability[surface] === true;
}
