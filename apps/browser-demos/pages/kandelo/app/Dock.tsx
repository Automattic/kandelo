import * as React from "react";
import { flushSync } from "react-dom";
import markUrl from "../assets/kandelo-mark.png";
import type { MachineStatus } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { SessionPhase } from "../../../lib/network-session";
import { CommunityLinks } from "./CommunityLinks";
import { PersistenceReleaseWarning } from "./PersistenceReleaseWarning";

export type DockPaneId = "gallery" | "library" | "activities";
export type DockViewId = "web" | "graphics" | "terminal";

const REPOSITORY_URL = "https://github.com/Automattic/kandelo";

export const NETWORK_PHASE_LABEL: Record<SessionPhase, string> = {
  offline: "not connected",
  hosting: "starting",
  joining: "joining",
  connected: "connected",
  error: "failed",
};

interface DockItem<T extends string> {
  id: T;
  label: string;
  title: string;
  icon: React.ReactNode;
}

const VIEW_ITEMS: DockItem<DockViewId | "activities">[] = [
  {
    id: "web",
    label: "Web",
    title: "Web preview",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.5" ry="6" /><path d="M2 8h12M3 5h10M3 11h10" /></svg>,
  },
  {
    id: "graphics",
    label: "Graphics",
    title: "Graphics display",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="8" rx="1.2" /><path d="M5 13.5h6M8 11v2.5" /></svg>,
  },
  {
    id: "terminal",
    label: "Terminal",
    title: "Terminal",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6.5 8 3 11.5" /><path d="M8 11.5h5" /></svg>,
  },
  {
    id: "activities",
    label: "Activities",
    title: "Activities installed on this computer",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 7 5-7 5z" /></svg>,
  },
];

const SHARE_ITEM: DockItem<"share"> = {
  id: "share",
  label: "Share setup",
  title: "Share setup",
  icon: <svg width="16" height="16" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="5.5" cy="11" r="2.4" /><circle cx="16" cy="5" r="2.4" /><circle cx="16" cy="17" r="2.4" /><path d="M7.6 10l6.4-3.6M7.6 12l6.4 3.6" /></svg>,
};

const INTERNALS_ITEM: DockItem<"internals"> = {
  id: "internals",
  label: "Internals",
  title: "Internals",
  icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 3.5h10M3 8h10M3 12.5h6" /><circle cx="1.7" cy="3.5" r=".3" /><circle cx="1.7" cy="8" r=".3" /><circle cx="1.7" cy="12.5" r=".3" /></svg>,
};

const GUIDE_ITEM: DockItem<"guide"> = {
  id: "guide",
  label: "Shortcuts",
  title: "Shortcuts",
  icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M4 2.5h6.5L13 5v8.5H4z" /><path d="M10.5 2.5V5H13" /><path d="M6 7h5M6 9.5h5M6 12h3" /></svg>,
};

const THEME_ITEM: DockItem<"theme"> = {
  id: "theme",
  label: "Appearance",
  title: "Theme",
  icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="4" /><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" /></svg>,
};

const PANE_ITEMS: DockItem<DockPaneId>[] = [
  {
    id: "library",
    label: "Library",
    title: "Saved computers",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2.5" width="3" height="11" rx=".5" /><rect x="6.5" y="2.5" width="3" height="11" rx=".5" /><path d="m11 3 2-.5 2.5 10-2 .5z" /></svg>,
  },
];

type DockPopoverAnchor = {
  x: number;
  bottom: number;
  originX: number;
};

type DockPopoverProperties = React.CSSProperties & {
  "--kdock-popover-x"?: string;
  "--kdock-popover-bottom"?: string;
  "--kdock-popover-origin-x"?: string;
  "--kdock-popover-width"?: string;
};

type DockShellProperties = React.CSSProperties & {
  "--kdock-center-x"?: string;
  "--kdock-expanded-width"?: string;
  "--kdock-viewport-offset"?: string;
  "--kdock-viewport-trailing"?: string;
};

export type DockLayoutState = {
  collapsed: boolean;
  fullWidth: boolean;
};

export const Dock: React.FC<{
  /** Open the file picker that sends files to the machine (Kandelo exchange). */
  onSendFiles?: () => void;
  networkPhase?: SessionPhase;
  onOpenNetwork?: () => void;
  activePane: DockPaneId | null;
  activeView: DockViewId | null;
  serviceNotice?: string | null;
  persistenceWarning?: boolean;
  viewControls?: React.ReactNode;
  guidePopup?: React.ReactNode;
  internalsPopup?: React.ReactNode;
  themePopup?: React.ReactNode;
  guideAvailable: boolean;
  guideOpen: boolean;
  internalsAvailable: boolean;
  internalsOpen: boolean;
  themeOpen: boolean;
  shareAvailable: boolean;
  status: MachineStatus;
  machineTitle?: string;
  temporary?: boolean;
  onKeepComputer?: () => void;
  viewDisabled?: Partial<Record<DockViewId, boolean>>;
  onSelectPane: (pane: DockPaneId | null) => void;
  onSelectView: (view: DockViewId) => void;
  onToggleGuide: () => void;
  onToggleInternals: () => void;
  onToggleTheme: () => void;
  onOpenShare: () => void;
  onOpenAbout: () => void;
  servicesAvailable?: boolean;
  onOpenServices?: () => void;
  onCloseGuide: () => void;
  onCloseInternals: () => void;
  onCloseTheme: () => void;
  onHeightChange: (height: number) => void;
  onLayoutChange?: (layout: DockLayoutState) => void;
}> = ({
  onSendFiles,
  networkPhase = "offline",
  onOpenNetwork,
  activePane,
  activeView,
  serviceNotice,
  persistenceWarning = false,
  viewControls,
  guidePopup,
  internalsPopup,
  themePopup,
  guideAvailable,
  guideOpen,
  internalsAvailable,
  internalsOpen,
  themeOpen,
  shareAvailable,
  status,
  machineTitle,
  temporary = false,
  onKeepComputer,
  viewDisabled = {},
  onSelectPane,
  onSelectView,
  onToggleGuide,
  onToggleInternals,
  onToggleTheme,
  onOpenShare,
  onOpenAbout,
  servicesAvailable = false,
  onOpenServices,
  onCloseGuide,
  onCloseInternals,
  onCloseTheme,
  onHeightChange,
  onLayoutChange,
}) => {
  const shellRef = React.useRef<HTMLElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const guideButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const internalsButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const themeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const moreRef = React.useRef<HTMLDivElement | null>(null);
  const moreButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const moreId = React.useId();
  const guidePopoverRef = React.useRef<HTMLDivElement | null>(null);
  const internalsPopoverRef = React.useRef<HTMLDivElement | null>(null);
  const themePopoverRef = React.useRef<HTMLDivElement | null>(null);
  const compactClampPausedUntilRef = React.useRef(0);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startCenter: number;
    width: number;
    moved: boolean;
  } | null>(null);
  const suppressCenterClickRef = React.useRef(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [fullWidth, setFullWidth] = React.useState(true);
  const [dockCenter, setDockCenter] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [viewportWidth, setViewportWidth] = React.useState(() => window.innerWidth);
  const guideAnchor = useDockPopoverAnchor(guideOpen, guidePopup, shellRef, guideButtonRef, 380);
  const internalsAnchor = useDockPopoverAnchor(internalsOpen, internalsPopup, shellRef, internalsButtonRef, 980);
  const themeAnchor = useDockPopoverAnchor(themeOpen, themePopup, shellRef, themeButtonRef, 360);
  const moreAnchor = useDockPopoverAnchor(moreOpen, true, shellRef, moreButtonRef, 260);
  const statusLabel = formatMachineStatus(status);
  const title = machineTitle || "Kandelo computer";

  const clampDockCenter = React.useCallback((center: number, width?: number): number => {
    const viewportWidth = window.innerWidth;
    const margin = 12;
    const dockWidth = width ?? shellRef.current?.getBoundingClientRect().width ?? 0;
    if (dockWidth + margin * 2 >= viewportWidth) {
      return viewportWidth / 2;
    }
    const half = dockWidth / 2;
    return Math.min(viewportWidth - half - margin, Math.max(half + margin, center));
  }, []);

  React.useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      onHeightChange(0);
      return;
    }

    const updateHeight = () => {
      const rect = shell.getBoundingClientRect();
      onHeightChange(Math.ceil(rect.height));
      if (!fullWidth && performance.now() >= compactClampPausedUntilRef.current) {
        setDockCenter((center) => center === null ? null : clampDockCenter(center, rect.width));
      }
    };
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(shell);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
      onHeightChange(0);
    };
  }, [clampDockCenter, fullWidth, onHeightChange]);

  React.useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
      setDockCenter((center) => center === null ? null : clampDockCenter(center));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampDockCenter]);

  React.useEffect(() => {
    onLayoutChange?.({ collapsed, fullWidth });
  }, [collapsed, fullWidth, onLayoutChange]);

  React.useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (collapsed) {
      row.setAttribute("inert", "");
      row.setAttribute("aria-hidden", "true");
    } else {
      row.removeAttribute("inert");
      row.removeAttribute("aria-hidden");
    }
  }, [collapsed]);

  React.useEffect(() => {
    if (!collapsed) return;
    moreRef.current?.hidePopover();
    onCloseGuide();
    onCloseInternals();
    onCloseTheme();
  }, [collapsed, onCloseGuide, onCloseInternals, onCloseTheme]);

  React.useEffect(() => {
    if (!guideOpen && !internalsOpen && !themeOpen) return;

    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (moreRef.current?.contains(target)) return;

      if (guideOpen) {
        if (!guidePopoverRef.current?.contains(target) && !guideButtonRef.current?.contains(target)) {
          onCloseGuide();
        }
      }

      if (internalsOpen) {
        if (!internalsPopoverRef.current?.contains(target) && !internalsButtonRef.current?.contains(target)) {
          onCloseInternals();
        }
      }

      if (themeOpen) {
        if (!themePopoverRef.current?.contains(target) && !themeButtonRef.current?.contains(target)) {
          onCloseTheme();
        }
      }
    };

    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [guideOpen, internalsOpen, themeOpen, onCloseGuide, onCloseInternals, onCloseTheme]);

  const guidePopoverStyle = popoverStyle(guideAnchor, 380);
  const internalsPopoverStyle = popoverStyle(internalsAnchor, 980);
  const themePopoverStyle = popoverStyle(themeAnchor, 360);
  const expandedDockWidth = dockCenter !== null
    ? Math.ceil(2 * Math.max(dockCenter, viewportWidth - dockCenter))
    : viewportWidth;
  const viewportOffset = dockCenter !== null
    ? Math.max(0, Math.round(expandedDockWidth / 2 - dockCenter))
    : 0;
  const viewportTrailing = dockCenter !== null
    ? Math.max(0, Math.round(expandedDockWidth - viewportWidth - viewportOffset))
    : 0;
  const dockStyle: DockShellProperties | undefined = dockCenter !== null
    ? {
      left: `${Math.round(dockCenter)}px`,
      "--kdock-center-x": `${Math.round(dockCenter)}px`,
      "--kdock-expanded-width": `${expandedDockWidth}px`,
      "--kdock-viewport-offset": `${viewportOffset}px`,
      "--kdock-viewport-trailing": `${viewportTrailing}px`,
    }
    : undefined;

  const onDockPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || fullWidth) {
      return;
    }

    const target = event.target as Element | null;
    if (target?.closest("button,input,textarea,select,a,[role='button'],[role='textbox'],[role='combobox']")) {
      return;
    }

    const shell = shellRef.current;
    if (!shell) return;

    const rect = shell.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startCenter: dockCenter ?? rect.left + rect.width / 2,
      width: rect.width,
      moved: false,
    };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events used by tests may not have an active pointer.
    }
  }, [dockCenter, fullWidth]);

  const onDockPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) > 3) {
      drag.moved = true;
      setDragging(true);
    }

    if (drag.moved) {
      event.preventDefault();
      setDockCenter(clampDockCenter(drag.startCenter + deltaX, drag.width));
    }
  }, [clampDockCenter]);

  const onDockPointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      suppressCenterClickRef.current = true;
      window.setTimeout(() => {
        suppressCenterClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const onToggleCollapsed = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressCenterClickRef.current) {
      suppressCenterClickRef.current = false;
      event.preventDefault();
      return;
    }
    setCollapsed((value) => !value);
  }, []);

  const onToggleFullWidth = React.useCallback(() => {
    setFullWidth((value) => {
      if (value) {
        compactClampPausedUntilRef.current = performance.now() + 260;
      }
      return !value;
    });
  }, []);

  return (
    <>
      <nav
        ref={shellRef}
        className={`kdock-shell${collapsed ? " kdock-collapsed" : ""}${fullWidth ? " kdock-full-width" : " kdock-compact"}${!fullWidth && dockCenter !== null ? " kdock-moved" : ""}${dragging ? " kdock-dragging" : ""}`}
        style={dockStyle}
        aria-label="Kandelo tools"
      >
        {persistenceWarning && <PersistenceReleaseWarning />}
        {serviceNotice && (
          <div className="kweb-service-notice" role="status">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M7.1 2.6a1 1 0 0 1 1.8 0l5.4 9.7a1 1 0 0 1-.9 1.5H2.6a1 1 0 0 1-.9-1.5zM8 6v3" />
              <circle cx="8" cy="11.3" r=".7" fill="currentColor" stroke="none" />
            </svg>
            <span>{serviceNotice}</span>
          </div>
        )}
        <div
          ref={bodyRef}
          className="kdock-body"
          onPointerDown={onDockPointerDown}
          onPointerMove={onDockPointerMove}
          onPointerUp={onDockPointerUp}
          onPointerCancel={onDockPointerUp}
        >
          <div className="kdock-top-row">
            <div className="kdock-view-controls" data-empty={viewControls ? "false" : "true"}>
              {viewControls}
            </div>
            <div className="kdock-toggle-pill" aria-label="Dock layout controls">
              {onSendFiles && (
                <button
                  type="button"
                  className="kdock-header-btn kexchange-send-button"
                  aria-label="Send files to this machine"
                  title="Send files to this machine"
                  data-testid="exchange-send-files"
                  onClick={onSendFiles}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 11V3M5 6l3-3 3 3" />
                    <path d="M3 10v2.5h10V10" />
                  </svg>
                </button>
              )}
              {onOpenNetwork && (
                <button
                  type="button"
                  className="kdock-header-btn knetwork-button"
                  data-state={networkPhase}
                  aria-label={`Network session: ${NETWORK_PHASE_LABEL[networkPhase]}`}
                  title={`Network session: ${NETWORK_PHASE_LABEL[networkPhase]}`}
                  onClick={onOpenNetwork}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="4" r="2" /><circle cx="3" cy="12" r="2" /><circle cx="13" cy="12" r="2" />
                    <path d="M7 6l-3 4m5-4 3 4M5 12h6" />
                  </svg>
                </button>
              )}
              <a
                className="kdock-header-btn kdock-github-link"
                href={REPOSITORY_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View Kandelo on GitHub"
                title="View Kandelo on GitHub"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1.5a6.5 6.5 0 0 0-2.06 12.67c.33.06.45-.14.45-.32v-1.27c-1.83.4-2.22-.78-2.22-.78-.3-.76-.73-.96-.73-.96-.6-.41.05-.4.05-.4.66.05 1.01.68 1.01.68.59 1.01 1.54.72 1.92.55.06-.43.23-.72.42-.89-1.46-.17-3-.73-3-3.21 0-.71.25-1.29.68-1.75-.07-.17-.3-.83.06-1.72 0 0 .55-.18 1.79.67A6.2 6.2 0 0 1 8 4.75c.55 0 1.1.07 1.62.22 1.24-.85 1.79-.67 1.79-.67.36.89.13 1.55.06 1.72.42.46.68 1.04.68 1.75 0 2.49-1.54 3.04-3 3.2.24.21.44.61.44 1.23v1.65c0 .18.12.38.45.32A6.5 6.5 0 0 0 8 1.5Z" />
                </svg>
              </a>
              <button
                type="button"
                className="kdock-header-btn kdock-collapse-btn"
                aria-label={collapsed ? "Show dock tools" : "Hide dock tools"}
                aria-expanded={!collapsed}
                title={collapsed ? "Show dock tools" : "Hide dock tools"}
                onClick={onToggleCollapsed}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 6.5 8 10l3.5-3.5" />
                </svg>
              </button>
              <button
                type="button"
                className="kdock-header-btn"
                aria-label={fullWidth ? "Use compact dock" : "Use full-width dock"}
                aria-pressed={fullWidth}
                title={fullWidth ? "Use compact dock" : "Use full-width dock"}
                onClick={onToggleFullWidth}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2.5" y="4" width="11" height="8" rx="1.2" />
                  <path d="M5 6.5H3M11 6.5h2M5 9.5H3M11 9.5h2" />
                </svg>
              </button>
            </div>
          </div>

          <div ref={rowRef} className="kdock-row">
            <div className="kdock-status">
              <img src={markUrl} alt="" />
              <span className="kdock-status-copy">
                <button type="button" className="kdock-status-title" onClick={() => onSelectPane(null)} title={`${title}: ${statusLabel}`} aria-label={`Current computer: ${title}, ${statusLabel}`}>{title}</button>
                <span className="kdock-status-text" data-status={status}>
                  <span className="kdock-status-dot" />
                  {statusLabel}
                  {temporary && <button type="button" className="kdock-temporary-badge" title="Keep this temporary computer on this device" aria-label="Keep this temporary computer" disabled={!onKeepComputer} onClick={onKeepComputer}>Temporary</button>}
                </span>
              </span>
            </div>
            <div className="kdock">
              <div className="kdock-section" aria-label="Computer tools">
                {PANE_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="kdock-item"
                    aria-current={activePane === item.id}
                    title={item.title}
                    onClick={() => onSelectPane(item.id)}
                  >
                    <span className="kdock-icon">{item.icon}</span>
                    <span className="kdock-label">{item.label}</span>
                  </button>
                ))}
              </div>
              <div className="kdock-separator" aria-hidden="true" />
              <div className="kdock-section" aria-label="Computer views">
                {VIEW_ITEMS.map((item) => {
                  const disabled = item.id !== "activities" && viewDisabled[item.id] === true;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="kdock-item"
                      aria-current={item.id === "activities" ? activePane === "activities" : activePane === null && activeView === item.id}
                      title={item.title}
                      disabled={disabled}
                      onClick={() => item.id === "activities" ? onSelectPane(item.id) : onSelectView(item.id)}
                    >
                      <span className="kdock-icon">{item.icon}</span>
                      <span className="kdock-label">{item.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="kdock-separator" aria-hidden="true" />
              <div className="kdock-section kdock-section-actions" aria-label="Computer overlays">
                <button type="button" className="kdock-item" popoverTarget={moreId} aria-haspopup="dialog" title="More tools and help" ref={button => { moreButtonRef.current = button; internalsButtonRef.current = button; themeButtonRef.current = button; }}>
                  <span className="kdock-icon"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></svg></span>
                  <span className="kdock-label">More</span>
                </button>
                <div id={moreId} ref={moreRef} popover="auto" className="kdock-more-popover" role="dialog" aria-label="More tools and help" onBeforeToggle={event => { if (event.newState === "open") flushSync(() => setMoreOpen(true)); else setMoreOpen(false); }} style={popoverStyle(moreAnchor, 260)}>
                  <button type="button" autoFocus={shareAvailable} disabled={!shareAvailable} onClick={() => { moreRef.current?.hidePopover(); moreButtonRef.current?.focus(); onOpenShare(); }}><span className="kdock-menu-icon" aria-hidden="true">{SHARE_ITEM.icon}</span>Share setup…</button>
                  {servicesAvailable && <button type="button" onClick={() => { moreRef.current?.hidePopover(); moreButtonRef.current?.focus(); onOpenServices?.(); }}><span className="kdock-menu-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 4h12M2 8h12M2 12h12" /><circle cx="5" cy="4" r="1.5" fill="var(--k-surface)" /><circle cx="10" cy="8" r="1.5" fill="var(--k-surface)" /><circle cx="6" cy="12" r="1.5" fill="var(--k-surface)" /></svg></span>Services</button>}
                  <button type="button" autoFocus={!shareAvailable && internalsAvailable} disabled={!internalsAvailable} aria-pressed={internalsOpen} onClick={() => { moreRef.current?.hidePopover(); onToggleInternals(); }}><span className="kdock-menu-icon" aria-hidden="true">{INTERNALS_ITEM.icon}</span>{INTERNALS_ITEM.label}</button>
                  <button type="button" autoFocus={!shareAvailable && !internalsAvailable} aria-pressed={themeOpen} onClick={() => { moreRef.current?.hidePopover(); onToggleTheme(); }}><span className="kdock-menu-icon" aria-hidden="true">{THEME_ITEM.icon}</span>{THEME_ITEM.label}</button>
                  <button type="button" onClick={() => { moreRef.current?.hidePopover(); moreButtonRef.current?.focus(); onOpenAbout(); }}><span className="kdock-menu-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6" /><path d="M8 7v5M8 4v1" /></svg></span>About Kandelo</button>
                  <h3>Help &amp; About</h3>
                  <CommunityLinks />
                </div>
                {guideAvailable && <button
                  ref={guideButtonRef}
                  type="button"
                  className="kdock-item"
                  aria-pressed={guideOpen}
                  aria-expanded={guideOpen}
                  title={GUIDE_ITEM.title}
                  aria-label={GUIDE_ITEM.title}
                  disabled={!guideAvailable}
                  onClick={onToggleGuide}
                >
                  <span className="kdock-icon">{GUIDE_ITEM.icon}</span>
                  <span className="kdock-label">{GUIDE_ITEM.label}</span>
                </button>}
              </div>
            </div>
          </div>
        </div>
      </nav>

      {internalsOpen && internalsPopup && internalsPopoverStyle && (
        <>
          <div
            className="kdock-popover-dismiss-layer"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.stopPropagation();
              onCloseInternals();
            }}
          />
          <div
            ref={internalsPopoverRef}
            className="kdock-popover kdock-internals-popover"
            role="dialog"
            aria-label="Internals"
            style={internalsPopoverStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <PopoverHeading title="Internals" onClose={onCloseInternals} />
            {internalsPopup}
          </div>
        </>
      )}

      {themeOpen && themePopup && themePopoverStyle && (
        <>
          <div
            className="kdock-popover-dismiss-layer"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.stopPropagation();
              onCloseTheme();
            }}
          />
          <div
            ref={themePopoverRef}
            className="kdock-popover kdock-theme-popover"
            role="dialog"
            aria-label="Theme"
            style={themePopoverStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <PopoverHeading title="Appearance" onClose={onCloseTheme} />
            {themePopup}
          </div>
        </>
      )}

      {guideOpen && guidePopup && guidePopoverStyle && (
        <>
          <div
            className="kdock-popover-dismiss-layer"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.stopPropagation();
              onCloseGuide();
            }}
          />
          <div
            ref={guidePopoverRef}
            className="kdock-popover kdock-guide-popover"
            role="dialog"
            aria-label="Shortcuts"
            style={guidePopoverStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {guidePopup}
          </div>
        </>
      )}
    </>
  );
};

const PopoverHeading: React.FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <header className="kdock-popover-heading"><h2>{title}</h2><button type="button" className="kdock-pane-close" onClick={onClose} title="Close" aria-label="Close"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 3l7 7M10 3l-7 7" /></svg></button></header>
);

function useDockPopoverAnchor(
  open: boolean,
  popup: React.ReactNode | undefined,
  shellRef: React.RefObject<HTMLElement | null>,
  buttonRef: React.RefObject<HTMLButtonElement | null>,
  maxWidth: number,
): DockPopoverAnchor | null {
  const [anchor, setAnchor] = React.useState<DockPopoverAnchor | null>(null);

  const updateAnchor = React.useCallback(() => {
    const button = buttonRef.current;
    if (!button) {
      setAnchor(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    const dockTop = shellRef.current?.getBoundingClientRect().top ?? rect.top;
    const popoverWidth = Math.min(maxWidth, Math.max(0, window.innerWidth - 24));
    const half = popoverWidth / 2;
    const x = Math.min(
      window.innerWidth - half - 12,
      Math.max(half + 12, rect.left + rect.width / 2),
    );
    setAnchor({
      x,
      bottom: Math.max(12, window.innerHeight - dockTop + 10),
      originX: rect.left + rect.width / 2 - (x - half),
    });
  }, [buttonRef, maxWidth, shellRef]);

  React.useLayoutEffect(() => {
    if (!open || !popup) {
      setAnchor(null);
      return;
    }

    updateAnchor();
    const frame = window.requestAnimationFrame(updateAnchor);
    const observer = new ResizeObserver(updateAnchor);
    if (shellRef.current) observer.observe(shellRef.current);
    if (buttonRef.current) observer.observe(buttonRef.current);
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [buttonRef, open, popup, shellRef, updateAnchor]);

  return anchor;
}

function popoverStyle(anchor: DockPopoverAnchor | null, width: number): DockPopoverProperties | undefined {
  if (!anchor) return undefined;
  return {
    "--kdock-popover-x": `${Math.round(anchor.x)}px`,
    "--kdock-popover-bottom": `${Math.round(anchor.bottom)}px`,
    "--kdock-popover-origin-x": `${Math.round(anchor.originX)}px`,
    "--kdock-popover-width": `${width}px`,
  };
}

function formatMachineStatus(status: MachineStatus): string {
  switch (status) {
    case "idle":
      return "No computer";
    case "booting":
      return "Booting";
    case "running":
      return "Running";
    case "halted":
      return "Halted";
    case "error":
      return "Error";
    default:
      return status;
  }
}

export const DockPane: React.FC<{
  pane: DockPaneId;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ pane, title, subtitle, onClose, children }) => (
  <section className={`kdock-pane kdock-pane-${pane}`} role="dialog" aria-label={title}>
    <header className="kdock-pane-header">
      <div className="kdock-pane-title-row">
        <h2>{title}</h2>
        <button type="button" className="kdock-pane-close" onClick={onClose} aria-label="Close">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M3 3l7 7M10 3l-7 7" />
          </svg>
        </button>
      </div>
      {subtitle && <p>{subtitle}</p>}
    </header>
    <div className="kdock-pane-body">{children}</div>
  </section>
);
