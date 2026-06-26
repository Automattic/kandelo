import * as React from "react";
import markUrl from "../assets/kandelo-mark.png";
import type { MachineStatus } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export type DockPaneId = "new" | "gallery" | "config" | "share";
export type DockViewId = "demo" | "terminal" | "internals";

interface DockItem<T extends string> {
  id: T;
  label: string;
  title: string;
  icon: React.ReactNode;
}

const VIEW_ITEMS: DockItem<DockViewId>[] = [
  {
    id: "demo",
    label: "Demo",
    title: "Demo surface",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="8" rx="1.2" /><path d="M5 13.5h6M8 11v2.5" /></svg>,
  },
  {
    id: "terminal",
    label: "Terminal",
    title: "Terminal",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5 6.5 8 3 11.5" /><path d="M8 11.5h5" /></svg>,
  },
  {
    id: "internals",
    label: "Internals",
    title: "Internals",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 3.5h10M3 8h10M3 12.5h6" /><circle cx="1.7" cy="3.5" r=".3" /><circle cx="1.7" cy="8" r=".3" /><circle cx="1.7" cy="12.5" r=".3" /></svg>,
  },
];

const PANE_ITEMS: DockItem<DockPaneId>[] = [
  {
    id: "new",
    label: "New",
    title: "New machine",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v10M3 8h10" /></svg>,
  },
  {
    id: "gallery",
    label: "Gallery",
    title: "Gallery",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>,
  },
  {
    id: "config",
    label: "Config",
    title: "System config",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M6.7 2h2.6l.4 1.7 1.5.6 1.5-.9 1.3 2.3-1.3 1.1V9l1.3 1.1-1.3 2.3-1.5-.9-1.5.6-.4 1.9H6.7l-.4-1.9-1.5-.6-1.5.9L2 10.1 3.3 9V6.8L2 5.7l1.3-2.3 1.5.9 1.5-.6L6.7 2Z" /><circle cx="8" cy="7.9" r="2" /></svg>,
  },
  {
    id: "share",
    label: "Share",
    title: "Share machine",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="4" cy="8" r="1.8" /><circle cx="12" cy="4" r="1.8" /><circle cx="12" cy="12" r="1.8" /><path d="M5.6 7.2 10.4 4.8M5.6 8.8l4.8 2.4" /></svg>,
  },
];

type DockCssProperties = React.CSSProperties & {
  "--kdock-body-h"?: string;
  "--kdock-center"?: string;
};

export const Dock: React.FC<{
  activePane: DockPaneId | null;
  activeView: DockViewId | null;
  status: MachineStatus;
  machineTitle?: string;
  viewDisabled?: Partial<Record<DockViewId, boolean>>;
  onSelectPane: (pane: DockPaneId | null) => void;
  onSelectView: (view: DockViewId) => void;
}> = ({ activePane, activeView, status, machineTitle, viewDisabled = {}, onSelectPane, onSelectView }) => {
  const shellRef = React.useRef<HTMLElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startCenter: number;
    width: number;
    moved: boolean;
  } | null>(null);
  const suppressHeaderClickRef = React.useRef(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [bodyHeight, setBodyHeight] = React.useState(72);
  const [dockCenter, setDockCenter] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const statusLabel = formatMachineStatus(status);
  const title = machineTitle || "Kandelo machine";

  const clampCenter = React.useCallback((center: number, width?: number): number => {
    const viewportWidth = window.innerWidth;
    const margin = 8;
    const dockWidth = width ?? shellRef.current?.getBoundingClientRect().width ?? 0;

    if (dockWidth + margin * 2 >= viewportWidth) {
      return viewportWidth / 2;
    }

    const half = dockWidth / 2;
    return Math.min(viewportWidth - half - margin, Math.max(half + margin, center));
  }, []);

  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }

    const updateBodyHeight = () => {
      setBodyHeight(Math.ceil(body.getBoundingClientRect().height));
    };
    updateBodyHeight();

    const observer = new ResizeObserver(updateBodyHeight);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const onResize = () => {
      setDockCenter((center) => center === null ? null : clampCenter(center));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampCenter]);

  const onHeaderPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey) {
      return;
    }

    const shell = shellRef.current;
    if (!shell || window.matchMedia("(max-width: 860px)").matches) {
      return;
    }

    const rect = shell.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startCenter: dockCenter ?? rect.left + rect.width / 2,
      width: rect.width,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [dockCenter]);

  const onHeaderPointerMove = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
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
      setDockCenter(clampCenter(drag.startCenter + deltaX, drag.width));
    }
  }, [clampCenter]);

  const onHeaderPointerUp = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      suppressHeaderClickRef.current = true;
      window.setTimeout(() => {
        suppressHeaderClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const onHeaderClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressHeaderClickRef.current) {
      suppressHeaderClickRef.current = false;
      event.preventDefault();
      return;
    }
    setCollapsed((value) => !value);
  }, []);

  const dockStyle: DockCssProperties = {
    "--kdock-body-h": `${bodyHeight}px`,
  };
  if (dockCenter !== null) {
    dockStyle["--kdock-center"] = `${Math.round(dockCenter)}px`;
  }

  return (
  <nav
    ref={shellRef}
    className={`kdock-shell${collapsed ? " kdock-collapsed" : ""}${dockCenter !== null ? " kdock-moved" : ""}${dragging ? " kdock-dragging" : ""}`}
    style={dockStyle}
    aria-label="Kandelo tools"
  >
    <button
      type="button"
      className="kdock-header"
      aria-label={collapsed ? "Expand dock" : "Collapse dock"}
      aria-expanded={!collapsed}
      title={collapsed ? "Show dock" : "Hide dock"}
      onPointerDown={onHeaderPointerDown}
      onPointerMove={onHeaderPointerMove}
      onPointerUp={onHeaderPointerUp}
      onPointerCancel={onHeaderPointerUp}
      onClick={onHeaderClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.5 6.5 8 10l3.5-3.5" />
      </svg>
    </button>

    <div ref={bodyRef} className="kdock-body" aria-hidden={collapsed}>
      <button
        type="button"
        className="kdock-status"
        onClick={() => onSelectPane(null)}
        title={`${title}: ${statusLabel}`}
        aria-label={`Current machine: ${title}, ${statusLabel}`}
        tabIndex={collapsed ? -1 : undefined}
      >
        <img src={markUrl} alt="" />
        <span className="kdock-status-copy">
          <span className="kdock-status-title">{title}</span>
          <span className="kdock-status-text" data-status={status}>
            <span className="kdock-status-dot" />
            {statusLabel}
          </span>
        </span>
      </button>

      <div className="kdock">
        <div className="kdock-section" aria-label="Machine views">
          {VIEW_ITEMS.map((item) => {
            const disabled = viewDisabled[item.id] === true;
            return (
              <button
                key={item.id}
                type="button"
                className="kdock-item"
                aria-current={activePane === null && activeView === item.id}
                title={item.title}
                disabled={disabled}
                tabIndex={collapsed ? -1 : undefined}
                onClick={() => onSelectView(item.id)}
              >
                <span className="kdock-icon">{item.icon}</span>
                <span className="kdock-label">{item.label}</span>
              </button>
            );
          })}
        </div>
        <div className="kdock-separator" aria-hidden="true" />
        <div className="kdock-section" aria-label="Machine tools">
          {PANE_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="kdock-item"
              aria-current={activePane === item.id}
              title={item.title}
              tabIndex={collapsed ? -1 : undefined}
              onClick={() => onSelectPane(item.id)}
            >
              <span className="kdock-icon">{item.icon}</span>
              <span className="kdock-label">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  </nav>
  );
};

function formatMachineStatus(status: MachineStatus): string {
  switch (status) {
    case "idle":
      return "No machine";
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
