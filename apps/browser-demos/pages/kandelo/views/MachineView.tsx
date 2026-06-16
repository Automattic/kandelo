// MachineView — phase-aware demo presentation.
//
// During boot the machine shows syslog as the primary surface. Once the demo
// reaches the useful state, the primary surface follows the active profile:
// web preview for service demos, framebuffer for Doom, terminal for shell-like
// demos. Terminal is exposed after boot; internals stay available as a drawer.

import * as React from "react";
import {
  useDemoGuide,
  useLazyDownloads,
  usePresentation,
  useStatus,
  useSurfaceAvailability,
  useWebPreview,
} from "../kernel-host/react";
import { Inspector } from "../panes/Inspector";
import { Display, type DisplayHandle, type WordPressLoginOptions } from "../panes/Display";
import { Shell, type ShellTerminal } from "../panes/Shell";
import { DemoGuide } from "../panes/DemoGuide";
import type { DemoActionConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import type { LazyDownloadEvent, PrimarySurface, SurfaceAvailability } from "../../../../../web-libs/kandelo-session/src/kernel-host";

const DEMO_GUIDE_DEFAULT_WIDTH = 300;
const DEMO_GUIDE_MIN_WIDTH = 220;
const DEMO_GUIDE_MAX_WIDTH = 480;
const DEMO_GUIDE_PRIMARY_MIN_WIDTH = 480;

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
  const rawAvailability = useSurfaceAvailability();
  const webPreview = useWebPreview();
  const availability = React.useMemo<SurfaceAvailability>(() => ({
    ...rawAvailability,
    web: rawAvailability.web && webPreview?.status === "running",
  }), [rawAvailability, webPreview?.status]);
  const demoGuide = useDemoGuide();
  const lazyDownloads = useLazyDownloads();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const displayRef = React.useRef<DisplayHandle | null>(null);
  const [activePrimary, setActivePrimary] = React.useState<PrimarySurface>(presentation.bootPrimary);
  const [primaryMode, setPrimaryMode] = React.useState<"following-demo" | "pinned">("following-demo");
  const [terminalOpen, setTerminalOpen] = React.useState(false);
  const [internalsOpen, setInternalsOpen] = React.useState(false);
  const [terminalDrawerHeight, setTerminalDrawerHeight] = React.useState(320);
  const [internalsDrawerHeight, setInternalsDrawerHeight] = React.useState(320);
  const [demoGuideWidth, setDemoGuideWidth] = React.useState(DEMO_GUIDE_DEFAULT_WIDTH);
  const previousAvailability = React.useRef(availability);
  const canUseTerminal = status === "running" && availability.terminal;

  const defaultPrimary = React.useMemo<PrimarySurface>(() => {
    if (status !== "running") {
      return isSurfaceAvailable(presentation.bootPrimary, availability)
        ? presentation.bootPrimary
        : "syslog";
    }
    return resolvePrimary(presentation.runningPrimary, availability, presentation.bootPrimary);
  }, [availability, presentation, status]);

  React.useEffect(() => {
    if (status !== "running" || primaryMode === "following-demo" || !isSurfaceAvailable(activePrimary, availability)) {
      setActivePrimary(defaultPrimary);
    }
  }, [activePrimary, availability, defaultPrimary, primaryMode, status]);

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

  React.useEffect(() => {
    if (!canUseTerminal) setTerminalOpen(false);
  }, [canUseTerminal]);

  const choosePrimary = (surface: PrimarySurface) => {
    if (status !== "running" && surface !== "syslog") return;
    if (!isSurfaceAvailable(surface, availability)) return;
    setActivePrimary(surface);
    setPrimaryMode(surface === defaultPrimary ? "following-demo" : "pinned");
  };

  const primaryLabel = surfaceLabel(activePrimary);
  const demoSurface = resolveDemoSurface(presentation.runningPrimary);

  const runWebAction = React.useCallback(async (action: DemoActionConfig): Promise<string | void> => {
    if (action.kind === "web.wordpressLogin") {
      if (demoSurface) {
        setActivePrimary(demoSurface);
        setPrimaryMode("following-demo");
      }
      const preview = displayRef.current;
      if (!preview) throw new Error("Web preview is not available");
      await preview.loginToWordPress(parseWordPressLoginPayload(action.payload));
      return "Logged into WordPress";
    }
    throw new Error(`Unsupported web action: ${action.kind}`);
  }, [demoSurface]);

  const shellProps = {
    terminals,
    activeTerminalId,
    onActiveTerminalId,
    onAddTerminal,
  };

  const canOpenDemo =
    demoSurface !== null &&
    isSurfaceAvailable(demoSurface, availability) &&
    status === "running";
  const shouldMountDemoSurface =
    demoSurface !== null &&
    status === "running" &&
    isSurfaceAvailable(demoSurface, availability);
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

  const demoGuideBounds = React.useCallback(() => {
    const rootWidth = rootRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    return {
      min: DEMO_GUIDE_MIN_WIDTH,
      max: Math.max(
        DEMO_GUIDE_MIN_WIDTH,
        Math.min(DEMO_GUIDE_MAX_WIDTH, rootWidth - DEMO_GUIDE_PRIMARY_MIN_WIDTH),
      ),
    };
  }, []);

  const setClampedDemoGuideWidth = React.useCallback((next: number) => {
    const bounds = demoGuideBounds();
    setDemoGuideWidth(clamp(next, bounds.min, bounds.max));
  }, [demoGuideBounds]);

  const beginDemoGuideResize = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = demoGuideWidth;
    const bounds = demoGuideBounds();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    target.classList.add("dragging");

    const onMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      setDemoGuideWidth(clamp(startWidth + delta, bounds.min, bounds.max));
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
  }, [demoGuideBounds, demoGuideWidth]);

  const onDemoGuideResizeKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setClampedDemoGuideWidth(demoGuideWidth + 20);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setClampedDemoGuideWidth(demoGuideWidth - 20);
    } else if (event.key === "Home") {
      event.preventDefault();
      setClampedDemoGuideWidth(DEMO_GUIDE_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setClampedDemoGuideWidth(DEMO_GUIDE_MAX_WIDTH);
    }
  }, [demoGuideWidth, setClampedDemoGuideWidth]);

  return (
    <div className="kmachine" ref={rootRef}>
      <div className="kmachine-toolbar">
        <div className="kmachine-switch" role="tablist" aria-label="Machine surfaces">
          <SurfaceButton
            active={demoSurface !== null && activePrimary === demoSurface}
            disabled={!canOpenDemo}
            onClick={() => {
              if (demoSurface) choosePrimary(demoSurface);
            }}
            label="Demo"
          />
          <SurfaceButton
            active={activePrimary === "terminal"}
            disabled={!canUseTerminal}
            onClick={() => choosePrimary("terminal")}
            label="Terminal"
          />
          <SurfaceButton
            active={activePrimary === "syslog"}
            onClick={() => choosePrimary("syslog")}
            label="Internals"
          />
        </div>
        <div className="kmachine-current">
          <LazyDownloadIndicator downloads={lazyDownloads} />
          <span className="kmachine-current-label">{primaryLabel}</span>
        </div>
      </div>

      <div
        className={`kmachine-workspace${showDemoGuide ? "" : " no-demo-guide"}`}
        style={showDemoGuide
          ? { "--kmachine-demo-guide-width": `${demoGuideWidth}px` } as React.CSSProperties
          : undefined}
      >
        <div className="kmachine-primary">
          {shouldMountDemoSurface && (
            <PrimarySurfaceSlot active={activePrimary === demoSurface}>
              <Display
                ref={displayRef}
                autoFocus={activePrimary === demoSurface}
                surface={demoSurface ?? undefined}
              />
            </PrimarySurfaceSlot>
          )}
          {activePrimary === "terminal" && canUseTerminal && (
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
          <DemoGuideResizer
            width={demoGuideWidth}
            onPointerDown={beginDemoGuideResize}
            onKeyDown={onDemoGuideResizeKeyDown}
          />
        )}
        {showDemoGuide && (
          <DemoGuide
            onOpenTerminal={() => {
              if (canUseTerminal) setTerminalOpen(true);
            }}
            onRunWebAction={runWebAction}
          />
        )}
      </div>

      {activePrimary !== "terminal" && canUseTerminal && (
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

const DemoGuideResizer: React.FC<{
  width: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}> = ({ width, onPointerDown, onKeyDown }) => (
  <div
    className="kmachine-guide-resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize demo actions"
    aria-valuemin={DEMO_GUIDE_MIN_WIDTH}
    aria-valuemax={DEMO_GUIDE_MAX_WIDTH}
    aria-valuenow={width}
    tabIndex={0}
    onPointerDown={onPointerDown}
    onKeyDown={onKeyDown}
  />
);

function parseWordPressLoginPayload(payload: string): WordPressLoginOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = {};
  }
  const value = typeof parsed === "object" && parsed !== null
    ? parsed as Record<string, unknown>
    : {};
  return {
    username: typeof value.username === "string" ? value.username : "admin",
    password: typeof value.password === "string" ? value.password : "password",
    loginPath: typeof value.loginPath === "string" ? value.loginPath : "/wp-login.php",
    adminPath: typeof value.adminPath === "string" ? value.adminPath : "/wp-admin/",
  };
}

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
    <span className="kmachine-switch-label">{label}</span>
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

const LazyDownloadIndicator: React.FC<{
  downloads: LazyDownloadEvent[];
}> = ({ downloads }) => {
  if (downloads.length === 0) return null;
  const current = downloads[0];
  const pct = current.totalBytes && current.totalBytes > 0
    ? Math.min(100, Math.max(0, (current.loadedBytes / current.totalBytes) * 100))
    : null;
  const title = `${downloadStatusVerb(current)} ${downloadLabel(current)} (${humanBytes(current.loadedBytes)}${
    current.totalBytes ? ` / ${humanBytes(current.totalBytes)}` : ""
  })`;
  const label = downloadLabel(current);
  const progressLabel = downloadProgressLabel(current, pct);

  return (
    <span
      className={`kmachine-download kmachine-download-${current.status}`}
      title={current.error ? `${title}: ${current.error}` : title}
      aria-live="polite"
      aria-label={current.error ? `${title}: ${current.error}` : title}
    >
      <span className="kmachine-download-label" aria-hidden="true">{label}</span>
      <span className="kmachine-download-pct" aria-hidden="true">{progressLabel}</span>
      {downloads.length > 1 && <span className="kmachine-download-count">+{downloads.length - 1}</span>}
      <span className={`kmachine-download-bar${pct === null ? " indeterminate" : ""}`} aria-hidden="true">
        <span style={{ width: pct === null ? "44%" : `${pct}%` }} />
      </span>
    </span>
  );
};

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
    case "kms": return "Modeset";
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

function resolveDemoSurface(preferences: readonly PrimarySurface[]): PrimarySurface | null {
  return preferences.find((surface) =>
    surface === "web" || surface === "framebuffer" || surface === "kms",
  ) ?? null;
}

function isSurfaceAvailable(surface: PrimarySurface, availability: SurfaceAvailability): boolean {
  return availability[surface] === true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function downloadStatusVerb(event: LazyDownloadEvent): string {
  switch (event.status) {
    case "complete": return "Downloaded";
    case "error": return "Failed";
    default: return "Downloading";
  }
}

function downloadLabel(event: LazyDownloadEvent): string {
  const raw = event.kind === "archive"
    ? event.url
    : event.path ?? event.mountPrefix ?? event.url;
  const clean = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  return clean.split("/").pop() || event.kind;
}

function downloadProgressLabel(event: LazyDownloadEvent, pct: number | null): string {
  if (event.status === "complete") return "OK";
  if (event.status === "error") return "ERR";
  return pct === null ? "..." : `${Math.round(pct)}%`;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}
