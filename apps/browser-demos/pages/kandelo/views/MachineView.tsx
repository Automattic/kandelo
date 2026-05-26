// MachineView — phase-aware demo presentation.
//
// During boot the machine shows syslog as the primary surface. Once the demo
// reaches the useful state, the primary surface follows the active profile:
// web preview for service demos, framebuffer for Doom, terminal for shell-like
// demos. Terminal and internals stay available as drawers.

import * as React from "react";
import { useDemoGuide, usePresentation, useStatus, useSurfaceAvailability } from "../kernel-host/react";
import { Inspector } from "../panes/Inspector";
import { Display } from "../panes/Display";
import { Shell, type ShellTerminal } from "../panes/Shell";
import { DemoGuide } from "../panes/DemoGuide";
import type { PrimarySurface, SurfaceAvailability } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface MachineViewProps {
  focusInternals?: boolean;
  internalsTab: string;
  onInternalsTab: (id: string) => void;
  terminals: ShellTerminal[];
  activeTerminalId: string;
  onActiveTerminalId: (id: string) => void;
  onAddTerminal: () => void;
}

export const MachineView: React.FC<MachineViewProps> = ({
  focusInternals = false,
  internalsTab,
  onInternalsTab,
  terminals,
  activeTerminalId,
  onActiveTerminalId,
  onAddTerminal,
}) => {
  const status = useStatus();
  const presentation = usePresentation();
  const availability = useSurfaceAvailability();
  const demoGuide = useDemoGuide();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [activePrimary, setActivePrimary] = React.useState<PrimarySurface>(presentation.bootPrimary);
  const [primaryMode, setPrimaryMode] = React.useState<"following-demo" | "pinned">("following-demo");
  const [terminalOpen, setTerminalOpen] = React.useState(false);
  const [internalsOpen, setInternalsOpen] = React.useState(false);
  const [terminalDrawerHeight, setTerminalDrawerHeight] = React.useState(320);
  const [internalsDrawerHeight, setInternalsDrawerHeight] = React.useState(320);
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

  const shellProps = {
    terminals,
    activeTerminalId,
    onActiveTerminalId,
    onAddTerminal,
  };

  const primaryLabel = surfaceLabel(activePrimary);
  const demoSurface = status === "running"
    ? resolvePrimary(presentation.runningPrimary, availability, presentation.bootPrimary)
    : presentation.runningPrimary[0] ?? "terminal";
  const canOpenDemo =
    isSurfaceAvailable(demoSurface, availability) &&
    (status === "running" || demoSurface === "web");
  const shouldMountDemoSurface = demoSurface !== "terminal" && isSurfaceAvailable(demoSurface, availability);
  const showDemoGuide = demoGuide !== null;

  const beginDrawerResize = (
    event: React.PointerEvent<HTMLDivElement>,
    currentHeight: number,
    setHeight: React.Dispatch<React.SetStateAction<number>>,
  ) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = currentHeight;
    const rootHeight = rootRef.current?.getBoundingClientRect().height ?? window.innerHeight;
    const maxHeight = Math.max(180, rootHeight - 320);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    target.classList.add("dragging");

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientY - startY;
      setHeight(clamp(startHeight - delta, 180, maxHeight));
    };
    const onDone = () => {
      target.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onDone);
      window.removeEventListener("pointercancel", onDone);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onDone);
    window.addEventListener("pointercancel", onDone);
  };

  return (
    <div className="kmachine" ref={rootRef}>
      <div className="kmachine-toolbar">
        <div className="kmachine-switch" role="tablist" aria-label="Machine surfaces">
          <SurfaceButton
            active={activePrimary === demoSurface && demoSurface !== "terminal"}
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

      <div className={`kmachine-workspace${showDemoGuide ? "" : " no-demo-guide"}`}>
        <div className="kmachine-primary">
          {shouldMountDemoSurface && (
            <PrimarySurfaceSlot active={activePrimary === demoSurface}>
              <Display autoFocus={activePrimary === demoSurface} />
            </PrimarySurfaceSlot>
          )}
          {activePrimary === "terminal" && (
            <PrimarySurfaceSlot active>
              <Shell autoFocus {...shellProps} />
            </PrimarySurfaceSlot>
          )}
          {activePrimary === "syslog" && (
            <PrimarySurfaceSlot active>
              <Inspector tab={internalsTab} onTab={onInternalsTab} />
            </PrimarySurfaceSlot>
          )}
        </div>
        {showDemoGuide && (
          <DemoGuide
            onOpenTerminal={() => {
              setTerminalOpen(true);
            }}
          />
        )}
      </div>

      {activePrimary !== "terminal" && (
        <MachineDrawer
          title="Terminal"
          open={terminalOpen}
          bodyHeight={terminalDrawerHeight}
          onResizeStart={(event) => beginDrawerResize(event, terminalDrawerHeight, setTerminalDrawerHeight)}
          onToggle={() => {
            setTerminalOpen((v) => !v);
          }}
        >
          <Shell autoFocus {...shellProps} />
        </MachineDrawer>
      )}

      {activePrimary !== "syslog" && (
        <MachineDrawer
          title="Internals"
          open={internalsOpen}
          bodyHeight={internalsDrawerHeight}
          onResizeStart={(event) => beginDrawerResize(event, internalsDrawerHeight, setInternalsDrawerHeight)}
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

const PrimarySurfaceSlot: React.FC<{
  active: boolean;
  children: React.ReactNode;
}> = ({ active, children }) => (
  <div className={`kmachine-primary-slot${active ? "" : " is-hidden"}`} aria-hidden={!active}>
    {children}
  </div>
);

const MachineDrawer: React.FC<{
  title: string;
  open: boolean;
  bodyHeight: number;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, open, bodyHeight, onResizeStart, onToggle, children }) => (
  <section className={`kmachine-drawer${open ? " open" : ""}`}>
    {open && (
      <div
        className="kmachine-drawer-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${title}`}
        onPointerDown={onResizeStart}
      />
    )}
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
    {open && <div className="kmachine-drawer-body" style={{ height: bodyHeight }}>{children}</div>}
  </section>
);

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
