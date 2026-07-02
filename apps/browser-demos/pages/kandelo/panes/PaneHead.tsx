// Shared pane chrome — drag grip (when draggable), pulsing accent dot,
// icon, title, optional tab strip, optional `right` slot, and the
// standard right-cluster (Collapse / Maximize) drawn from props.

import * as React from "react";

export interface PaneHeadDragProps {
  draggable: true;
  onDragStart: React.DragEventHandler;
}

export interface PaneHeadProps {
  icon: React.ReactNode;
  title: string;
  /** Extra UI to inject into the right cluster, BEFORE the standard tools. */
  right?: React.ReactNode;
  tabs?: { id: string; label: string }[];
  activeTab?: string;
  onTab?: (id: string) => void;
  /** When provided, renders a grip handle on the left + makes the head draggable. */
  dragProps?: PaneHeadDragProps;
  /** When provided, renders a Collapse button in the right cluster. */
  onCollapse?: () => void;
  /** When provided, renders a Maximize button in the right cluster. */
  onMaximize?: () => void;
  /** True when the pane is currently maximized — swaps the maximize icon. */
  isMax?: boolean;
}

export const PaneHead: React.FC<PaneHeadProps> = ({
  icon, title, right, tabs, activeTab, onTab,
  dragProps, onCollapse, onMaximize, isMax,
}) => {
  // Standard tools always render after `right` so per-pane chips (like the
  // Framebuffer focus indicator) stay flush against them.
  const showTools = !!(onCollapse || onMaximize);
  return (
    <div className="kpane-head" {...(dragProps ?? {})}>
      {dragProps && <DragGrip />}
      <span className="kpane-head-dot" />
      {icon}
      <div className="kpane-head-title">{title}</div>
      {tabs && (
        <div role="tablist" style={{ display: "flex", gap: 2, marginLeft: "auto" }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === activeTab}
              aria-current={t.id === activeTab}
              onClick={() => onTab?.(t.id)}
              style={{
                padding: "3px 8px",
                borderRadius: "var(--k-radius-sm)",
                border: 0,
                background: "transparent",
                color: "var(--k-text-muted)",
                fontFamily: "inherit",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {right && (
        <div style={{ display: "flex", gap: 2, marginLeft: tabs ? 4 : "auto", alignItems: "center" }}>
          {right}
        </div>
      )}
      {showTools && (
        <div style={{ display: "flex", gap: 2, marginLeft: tabs || right ? 4 : "auto" }}>
          {onCollapse && (
            <IconBtn title="Collapse" onClick={onCollapse}>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M1.5 5.5h8" />
                <path d="M3.5 3.5L1.5 5.5l2 2" />
                <path d="M7.5 3.5l2 2-2 2" />
              </svg>
            </IconBtn>
          )}
          {onMaximize && (
            <IconBtn title={isMax ? "Restore" : "Maximize"} onClick={onMaximize}>
              {isMax ? (
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <rect x="1.5" y="3.5" width="6" height="6" />
                  <path d="M3.5 1.5h6v6" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <path d="M1.5 4V1.5h2.5M7 1.5h2.5V4M9.5 7v2.5H7M4 9.5H1.5V7" />
                </svg>
              )}
            </IconBtn>
          )}
        </div>
      )}
    </div>
  );
};

const DragGrip: React.FC = () => (
  <div
    className="kpane-grip"
    title="Drag to rearrange"
    aria-hidden="true"
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: 14,
      height: 18,
      marginRight: 2,
      color: "var(--k-text-faint)",
      cursor: "grab",
      borderRadius: 2,
      flexShrink: 0,
      transition: "color 0.12s, background 0.12s",
    }}
  >
    <svg width="7" height="11" viewBox="0 0 7 11" fill="currentColor">
      <circle cx="1.5" cy="1.5" r="1" />
      <circle cx="5.5" cy="1.5" r="1" />
      <circle cx="1.5" cy="5.5" r="1" />
      <circle cx="5.5" cy="5.5" r="1" />
      <circle cx="1.5" cy="9.5" r="1" />
      <circle cx="5.5" cy="9.5" r="1" />
    </svg>
  </div>
);

const IconBtn: React.FC<{
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => (
  <button
    type="button"
    title={title}
    onClick={(e) => {
      // Prevent the parent's drag handler from firing on click.
      e.stopPropagation();
      onClick();
    }}
    style={{
      width: 22,
      height: 22,
      borderRadius: "var(--k-radius-sm)",
      border: 0,
      background: "transparent",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--k-text-muted)",
      transition: "background 0.12s, color 0.12s",
    }}
  >
    {children}
  </button>
);
