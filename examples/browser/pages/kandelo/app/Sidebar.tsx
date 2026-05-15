// Kandelo sidebar — brand row + 3-section nav + status footer.
//
// Mirrors the visual structure of design_handoff_kandelo_ui/reference/src/
// app.jsx's <Sidebar />. Differences: navigation items dispatch via the
// `onNav` prop instead of fiddling with router state directly, so the
// router lives in App.tsx.

import * as React from "react";
import markUrl from "../assets/kandelo-mark.png";
import type { MachineStatus } from "../../../../../host/src/kandelo-ui/kernel-host";

export type ViewId = "machine" | "gallery" | "config" | "internals" | "browse" | "share" | "export";
export type InternalsTab = "syslog" | "procs" | "vfs" | "config" | "syscalls";

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ReactNode;
}

const NAV_PRIMARY: NavItem[] = [
  { id: "machine", label: "Current Machine", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M5 13.5h6M8 11v2.5" /></svg> },
  { id: "gallery", label: "Gallery", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="2" width="5.5" height="5.5" rx="1" /><rect x="8.5" y="2" width="5.5" height="5.5" rx="1" /><rect x="2" y="8.5" width="5.5" height="5.5" rx="1" /><rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" /></svg> },
  { id: "config", label: "System Config", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2.4" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5" /></svg> },
];

const NAV_INTERNALS: { id: InternalsTab; label: string }[] = [
  { id: "syslog", label: "Syslog" },
  { id: "procs", label: "Processes" },
  { id: "vfs", label: "VFS" },
  { id: "syscalls", label: "Syscall Trace" },
  { id: "config", label: "Config" },
];

const NAV_BROWSE: NavItem[] = [
  { id: "browse", label: "Browse Systems", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg> },
  { id: "share", label: "Share Machine", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="4" cy="8" r="1.8" /><circle cx="12" cy="3.5" r="1.8" /><circle cx="12" cy="12.5" r="1.8" /><path d="M5.5 7.2L10.5 4.3M5.5 8.8L10.5 11.7" /></svg> },
  { id: "export", label: "Export VFS", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 2v8M5 7l3 3 3-3M2.5 13.5h11" /></svg> },
];

const STATUS_LABEL: Record<MachineStatus, string> = {
  idle: "Idle", booting: "Booting", running: "Running", halted: "Halted", error: "Error",
};

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  view: ViewId;
  onNav: (id: ViewId) => void;
  internalsTab: InternalsTab;
  onInternalsTab: (id: InternalsTab) => void;
  status: MachineStatus;
  descriptorTitle: string;
  descriptorId: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  collapsed, onToggleCollapsed, view, onNav, internalsTab, onInternalsTab,
  status, descriptorTitle, descriptorId,
}) => (
  <aside className={"ksb" + (collapsed ? " collapsed" : "")}>
    <div className="ksb-brand">
      <img src={markUrl} alt="" />
      {!collapsed && (
        <>
          <div className="ksb-brand-text">
            <div className="ksb-name">Kandelo</div>
            <div className="ksb-tag">Fold a computer into a URL.</div>
          </div>
          <button className="ksb-collapse" onClick={onToggleCollapsed} title="Collapse sidebar">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M6.5 2L3 5.5l3.5 3.5" />
            </svg>
          </button>
        </>
      )}
    </div>

    <nav className="ksb-nav">
      {NAV_PRIMARY.map((n) => (
        <button key={n.id} className="ksb-item" aria-current={view === n.id} onClick={() => onNav(n.id)}>
          {n.icon}
          {!collapsed && <span>{n.label}</span>}
        </button>
      ))}

      {!collapsed && <div className="ksb-section">Interactive Internals</div>}
      <button className="ksb-item" aria-current={view === "internals"} onClick={() => onNav("internals")}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M3 8a5 5 0 0 1 10 0M3 8a5 5 0 0 0 10 0" />
          <circle cx="8" cy="8" r="1.4" />
        </svg>
        {!collapsed && <span>Inspector</span>}
      </button>
      {!collapsed && view === "internals" && (
        <div className="ksb-sub">
          {NAV_INTERNALS.map((n) => (
            <button key={n.id} className="ksb-item" aria-current={internalsTab === n.id} onClick={() => onInternalsTab(n.id)}>
              <span>{n.label}</span>
            </button>
          ))}
        </div>
      )}

      {!collapsed && <div className="ksb-section">Share</div>}
      {NAV_BROWSE.map((n) => (
        <button key={n.id} className="ksb-item" aria-current={view === n.id} onClick={() => onNav(n.id)}>
          {n.icon}
          {!collapsed && <span>{n.label}</span>}
        </button>
      ))}
    </nav>

    {collapsed ? (
      <button
        className="ksb-item"
        onClick={onToggleCollapsed}
        title="Expand sidebar"
        style={{ borderRadius: 0, justifyContent: "center", padding: "10px 0" }}
      >
        <svg viewBox="0 0 11 11" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4.5 2L8 5.5 4.5 9" />
        </svg>
      </button>
    ) : (
      <div className="ksb-foot">
        <div className="ksb-foot-row">
          <span className="ksb-foot-dot" data-status={status} />
          <span className="ksb-foot-status">{STATUS_LABEL[status] ?? status}</span>
          <span className="ksb-foot-id">{descriptorId}</span>
        </div>
        <div className="ksb-foot-title">{descriptorTitle}</div>
      </div>
    )}
  </aside>
);
