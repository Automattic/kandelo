// Kandelo sidebar — permanently collapsed primary navigation.

import * as React from "react";
import markUrl from "../assets/kandelo-mark.png";

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
];

export interface SidebarProps {
  view: ViewId;
  onNav: (id: ViewId) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  view, onNav,
}) => (
  <aside className="ksb collapsed">
    <div className="ksb-brand">
      <img src={markUrl} alt="" />
    </div>

    <nav className="ksb-nav">
      {NAV_PRIMARY.map((n) => (
        <button
          key={n.id}
          className="ksb-item"
          aria-current={view === n.id}
          aria-label={n.label}
          title={n.label}
          onClick={() => onNav(n.id)}
        >
          {n.icon}
          <span>{n.label}</span>
        </button>
      ))}
    </nav>
  </aside>
);
