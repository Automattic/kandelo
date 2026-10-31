// MachineView — phase-aware demo presentation.
//
// During boot the machine shows syslog as the primary surface. Once the demo
// reaches the useful state, the primary surface follows the active profile:
// web preview for service demos, framebuffer for Doom, terminal for shell-like
// demos. The dock owns switching between demo, terminal, and internals views.

import * as React from "react";
import {
  usePresentation,
  useStatus,
  useSurfaceAvailability,
  useWebPreview,
} from "../kernel-host/react";
import { BootLog, Inspector } from "../panes/Inspector";
import { Display, type DisplayHandle, type WordPressLoginOptions } from "../panes/Display";
import type { WebPreviewTarget } from "../../../../../web-libs/kandelo-session/src/web-preview-address";
import { Shell, type ShellTerminal } from "../panes/Shell";
import { DemoGuide } from "../panes/DemoGuide";
import type { DemoActionConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import type { ComputerServiceStatus } from "../../../../../web-libs/kandelo-session/src/computer-services";
import type {
  DemoPresentation,
  MachineStatus,
  PrimarySurface,
  SurfaceAvailability,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

export type MachineSurfaceView = "web" | "graphics" | "terminal" | "internals";

export interface MachineSurfaceController {
  status: MachineStatus;
  presentation: DemoPresentation;
  availability: SurfaceAvailability;
  activePrimary: PrimarySurface;
  activeView: MachineSurfaceView;
  primaryLabel: string;
  canOpenWeb: boolean;
  canOpenGraphics: boolean;
  canUseTerminal: boolean;
  canUseInternals: boolean;
  choosePrimary: (surface: PrimarySurface) => void;
  chooseView: (view: MachineSurfaceView) => void;
  focusInternals: () => void;
  onKmsOwnerChange: (pid: number | null) => void;
  requestActivityDisplay: (kind: "framebuffer" | "kms") => void;
  requestActivityWeb: () => void;
  displayOccupied: boolean;
  kmsAvailable: boolean;
}

export function useMachineSurfaceController(): MachineSurfaceController {
  const status = useStatus();
  const presentation = usePresentation();
  const rawAvailability = useSurfaceAvailability();
  const [requestedSurface, setRequestedSurface] = React.useState<"framebuffer" | "kms" | "web" | null>(null);
  const [lastGraphics, setLastGraphics] = React.useState<"framebuffer" | "kms">("framebuffer");
  const [kmsOwnerPid, onKmsOwnerChange] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (status !== "running") { setRequestedSurface(null); onKmsOwnerChange(null); }
  }, [status]);
  React.useEffect(() => {
    if (!rawAvailability.kms) onKmsOwnerChange(null);
  }, [rawAvailability.kms]);
  const webPreview = useWebPreview();
  const availability = React.useMemo<SurfaceAvailability>(() => ({
    ...rawAvailability,
    kms: rawAvailability.kms && kmsOwnerPid !== null,
    // Keep the web surface mounted while a machine is offline/reconnecting so
    // its pane can show that state instead of the view falling back elsewhere.
    web: rawAvailability.web &&
      (webPreview?.status === "running" ||
        webPreview?.status === "offline" ||
        webPreview?.status === "reconnecting"),
  }), [rawAvailability, kmsOwnerPid, webPreview?.status]);
  const [activePrimary, setActivePrimary] = React.useState<PrimarySurface>(presentation.bootPrimary);
  const requestActivityDisplay = React.useCallback((kind: "framebuffer" | "kms" | "web") => {
    setRequestedSurface(kind);
  }, []);
  const requestActivityWeb = React.useCallback(() => requestActivityDisplay("web"), [requestActivityDisplay]);
  React.useEffect(() => {
    if (activePrimary === "framebuffer" || activePrimary === "kms") setLastGraphics(activePrimary);
  }, [activePrimary]);
  const [primaryMode, setPrimaryMode] = React.useState<"following-demo" | "pinned">("following-demo");
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
    const preferred = !previous.framebuffer && availability.framebuffer ? "framebuffer"
      : !previous.kms && availability.kms ? "kms" : presentation.runningPrimary[0];
    if (!preferred || preferred === "terminal") return;
    if (previous[preferred] || !availability[preferred]) return;

    setActivePrimary(preferred);
    setPrimaryMode(preferred === defaultPrimary ? "following-demo" : "pinned");
  }, [activePrimary, availability, defaultPrimary, presentation.runningPrimary, status]);

  React.useEffect(() => {
    setPrimaryMode("following-demo");
  }, [presentation.runningPrimary]);

  const choosePrimary = React.useCallback((surface: PrimarySurface) => {
    setRequestedSurface(null);
    if (status !== "running" && surface !== "syslog") return;
    if (!isSurfaceAvailable(surface, availability)) return;
    setActivePrimary(surface);
    setPrimaryMode(surface === defaultPrimary ? "following-demo" : "pinned");
  }, [availability, defaultPrimary, status]);

  const graphicsSurface = availability[lastGraphics] ? lastGraphics
    : availability.framebuffer ? "framebuffer" : availability.kms ? "kms" : null;
  const canOpenWeb = status === "running" && availability.web;
  const canOpenGraphics = status === "running" && graphicsSurface !== null;
  const canUseInternals = status !== "idle" && isSurfaceAvailable("syslog", availability);

  React.useEffect(() => {
    if (status !== "running" || !requestedSurface || !isSurfaceAvailable(requestedSurface, availability)) return;
    setRequestedSurface(null);
    setActivePrimary(requestedSurface);
    setPrimaryMode(requestedSurface === defaultPrimary ? "following-demo" : "pinned");
  }, [requestedSurface, availability, defaultPrimary, status]);

  const chooseView = React.useCallback((view: MachineSurfaceView) => {
    if (view === "graphics") {
      if (graphicsSurface) choosePrimary(graphicsSurface);
      return;
    }
    choosePrimary(view === "web" ? "web" : view === "terminal" ? "terminal" : "syslog");
  }, [choosePrimary, graphicsSurface]);

  const focusInternals = React.useCallback(() => {
    setActivePrimary("syslog");
    setPrimaryMode("pinned");
  }, []);

  const activeView: MachineSurfaceView =
    activePrimary === "terminal"
      ? "terminal"
      : activePrimary === "syslog"
        ? "internals"
        : activePrimary === "web" ? "web" : "graphics";

  return {
    status,
    presentation,
    availability,
    activePrimary,
    activeView,
    primaryLabel: surfaceLabel(activePrimary),
    canOpenWeb,
    canOpenGraphics,
    canUseTerminal,
    canUseInternals,
    choosePrimary,
    chooseView,
    focusInternals,
    onKmsOwnerChange,
    requestActivityDisplay,
    requestActivityWeb,
    displayOccupied: availability.framebuffer || kmsOwnerPid !== null,
    kmsAvailable: rawAvailability.kms && (status === "booting" || status === "running"),
  };
}

export interface MachineViewProps {
  shortcuts: ComputerServiceStatus[];
  servicesBusy: boolean;
  onChangeWebTarget?: (target?: WebPreviewTarget) => void;
  onPreviewError?: (message: string) => void;
  activityTerminalPath?: string;
  webMcpPreviewRef?: React.RefObject<DisplayHandle | null>;
  surface: MachineSurfaceController;
  demoGuideOpen: boolean;
  onDemoGuideOpenChange: (open: boolean) => void;
  onDemoDockControlsChange: (controls: React.ReactNode | null) => void;
  onDemoGuidePopupChange: (popup: React.ReactNode | null) => void;
  internalsTab: string;
  terminals: ShellTerminal[];
  activeTerminalId: string;
  onActiveTerminalId: (id: string) => void;
  onAddTerminal: () => void;
}

export const MachineView: React.FC<MachineViewProps> = ({
  shortcuts,
  servicesBusy,
  onChangeWebTarget,
  onPreviewError,
  activityTerminalPath,
  surface,
  webMcpPreviewRef,
  demoGuideOpen,
  onDemoGuideOpenChange,
  onDemoDockControlsChange,
  onDemoGuidePopupChange,
  internalsTab,
  terminals,
  activeTerminalId,
  onActiveTerminalId,
  onAddTerminal,
}) => {
  const [kmsControls, setKmsControls] = React.useState<React.ReactNode>(null);
  const [framebufferControls, setFramebufferControls] = React.useState<React.ReactNode>(null);
  const [webControls, setWebControls] = React.useState<React.ReactNode>(null);
  const localDisplayRef = React.useRef<DisplayHandle | null>(null);
  const displayRef = webMcpPreviewRef ?? localDisplayRef;
  const {
    activePrimary,
    canUseTerminal,
    chooseView,
  } = surface;
  const terminalActive = activePrimary === "terminal" && canUseTerminal;
  const [terminalVisited, setTerminalVisited] = React.useState(false);
  React.useEffect(() => {
    if (!canUseTerminal) setTerminalVisited(false);
    else if (terminalActive) setTerminalVisited(true);
  }, [canUseTerminal, terminalActive]);

  const runWebAction = React.useCallback(async (action: DemoActionConfig): Promise<string | void> => {
    if (action.kind === "web.wordpressLogin") {
      chooseView("web");
      const preview = displayRef.current;
      if (!preview) throw new Error("Web preview is not available");
      await preview.loginToWordPress(parseWordPressLoginPayload(action.payload));
      return "Logged into WordPress";
    }
    throw new Error(`Unsupported web action: ${action.kind}`);
  }, [chooseView, displayRef]);

  const shellProps = {
    terminals,
    activeTerminalId,
    onActiveTerminalId,
    onAddTerminal,
  };

  const showDemoGuide = shortcuts.length > 0 && demoGuideOpen;

  React.useEffect(() => {
    onDemoDockControlsChange(activePrimary === "kms" ? kmsControls : activePrimary === "framebuffer" ? framebufferControls : activePrimary === "web" ? webControls : null);
  }, [activePrimary, kmsControls, framebufferControls, webControls, onDemoDockControlsChange]);

  const openTerminalFromGuide = React.useCallback(() => {
    if (canUseTerminal) chooseView("terminal");
  }, [canUseTerminal, chooseView]);

  const demoGuidePopup = React.useMemo(() => {
    if (!showDemoGuide) return null;
    return (
      <div>{shortcuts.map(service => <DemoGuide key={service.id} guide={service.shortcuts!} busy={servicesBusy}
        onClose={() => onDemoGuideOpenChange(false)}
        onOpenTerminal={openTerminalFromGuide}
        onRunWebAction={runWebAction}
      />)}</div>
    );
  }, [onDemoGuideOpenChange, openTerminalFromGuide, runWebAction, showDemoGuide, shortcuts, servicesBusy]);

  React.useEffect(() => {
    onDemoGuidePopupChange(demoGuidePopup);
    return () => onDemoGuidePopupChange(null);
  }, [demoGuidePopup, onDemoGuidePopupChange]);

  return (
    <div className="kmachine">
      <div className="kmachine-workspace">
        <div className="kmachine-primary">
          {surface.kmsAvailable && (
            <PrimarySurfaceSlot active={activePrimary === "kms"} measureWhileHidden>
              <Display active={activePrimary === "kms"} autoFocus={activePrimary === "kms"} surface="kms" activityTerminalPath={activityTerminalPath}
                onDockControlsChange={setKmsControls} onKmsOwnerChange={surface.onKmsOwnerChange} />
            </PrimarySurfaceSlot>
          )}
          {surface.status === "running" && (
            <PrimarySurfaceSlot active={activePrimary === "framebuffer"}>
              <Display
                active={activePrimary === "framebuffer"} autoFocus={activePrimary === "framebuffer"}
                surface="framebuffer" onDockControlsChange={setFramebufferControls} activityTerminalPath={activityTerminalPath}
              />
            </PrimarySurfaceSlot>
          )}
          {surface.availability.web && (
            <PrimarySurfaceSlot active={activePrimary === "web"}>
              <Display ref={displayRef} active={activePrimary === "web"} autoFocus={activePrimary === "web"}
                surface="web" onDockControlsChange={setWebControls} onChangeWebTarget={onChangeWebTarget} />
            </PrimarySurfaceSlot>
          )}
          {canUseTerminal && (terminalActive || terminalVisited) && (
            <PrimarySurfaceSlot active={terminalActive}>
              <Shell visible={terminalActive} autoFocus={terminalActive} onPreviewError={onPreviewError} {...shellProps} />
            </PrimarySurfaceSlot>
          )}
          {activePrimary === "syslog" && (
            <PrimarySurfaceSlot active>
              {surface.status === "running" ? <Inspector tab={internalsTab} /> : <BootLog />}
            </PrimarySurfaceSlot>
          )}
        </div>
      </div>
    </div>
  );
};

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

/**
 * One primary surface. A hidden slot is `display: none` -- out of layout and
 * paint -- except with `measureWhileHidden`, which keeps it laid out (and
 * invisible) so its pane still has a real size. Only the KMS display needs
 * that: it reports its size to the kernel before the machine's command picks
 * a video mode, while the boot view is still in front.
 */
const PrimarySurfaceSlot: React.FC<{
  active: boolean;
  measureWhileHidden?: boolean;
  children: React.ReactNode;
}> = ({ active, measureWhileHidden = false, children }) => (
  <div
    className={`kmachine-primary-slot${
      active ? "" : measureWhileHidden ? " is-hidden is-measured" : " is-hidden"
    }`}
    aria-hidden={!active}
  >
    {children}
  </div>
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

function isSurfaceAvailable(surface: PrimarySurface, availability: SurfaceAvailability): boolean {
  return availability[surface] === true;
}
