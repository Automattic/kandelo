// Kandelo sidebar — permanently collapsed primary navigation.

import * as React from "react";
import markUrl from "../assets/kandelo-mark.png";

export type ViewId = "machine" | "gallery" | "config" | "internals" | "browse" | "share" | "export";
export type InternalsTab = "syslog" | "procs" | "vfs" | "lazy-load" | "config" | "syscalls";

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ReactNode;
}

const NAV_PRIMARY: NavItem[] = [
  { id: "machine", label: "Current Machine", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M5 13.5h6M8 11v2.5" /></svg> },
  { id: "gallery", label: "Gallery", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="2" width="5.5" height="5.5" rx="1" /><rect x="8.5" y="2" width="5.5" height="5.5" rx="1" /><rect x="2" y="8.5" width="5.5" height="5.5" rx="1" /><rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" /></svg> },
];

const REPOSITORY_URL = "https://github.com/Automattic/kandelo";

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

    <div className="ksb-links">
      <a
        className="ksb-link"
        href={REPOSITORY_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="GitHub repository"
        title="GitHub repository"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M8 0.2a8 8 0 0 0-2.53 15.59c0.4 0.07 0.55-0.17 0.55-0.38l-0.01-1.5c-2.24 0.49-2.71-0.95-2.71-0.95-0.37-0.93-0.9-1.18-0.9-1.18-0.73-0.5 0.06-0.49 0.06-0.49 0.81 0.06 1.24 0.83 1.24 0.83 0.72 1.23 1.89 0.88 2.35 0.67 0.07-0.52 0.28-0.88 0.51-1.08-1.79-0.2-3.67-0.9-3.67-3.98 0-0.88 0.31-1.6 0.83-2.16-0.08-0.2-0.36-1.02 0.08-2.13 0 0 0.68-0.22 2.2 0.83a7.59 7.59 0 0 1 4 0c1.53-1.05 2.2-0.83 2.2-0.83 0.44 1.11 0.16 1.93 0.08 2.13 0.52 0.56 0.83 1.28 0.83 2.16 0 3.09-1.88 3.77-3.67 3.97 0.29 0.25 0.54 0.74 0.54 1.49l-0.01 2.2c0 0.21 0.14 0.46 0.55 0.38A8 8 0 0 0 8 0.2Z" />
        </svg>
        <span>GitHub repository</span>
      </a>
    </div>
  </aside>
);
