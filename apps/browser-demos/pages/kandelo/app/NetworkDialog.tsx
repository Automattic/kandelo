import * as React from "react";
import { createPortal } from "react-dom";

/** A stable frame shared by invitation boot, setup, and the active session. */
export function NetworkDialog({ title, close, actions, summary, notice, children }: {
  title: string; close: () => void; actions: React.ReactNode; summary?: React.ReactNode; notice?: React.ReactNode; children: React.ReactNode;
}) {
  const heading = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  React.useEffect(() => { heading.current?.focus(); }, [title]);
  return createPortal(<div className="kshare-backdrop"
    onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
    onKeyDown={event => { if (event.key === "Escape") close(); }}>
    <div className="kshare knetwork" role="dialog" aria-modal="true" aria-labelledby="knetwork-title">
      <div className="kshare-hd">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--k-accent)" strokeWidth="1.2" aria-hidden="true">
          <circle cx="8" cy="4" r="2" /><circle cx="3" cy="12" r="2" /><circle cx="13" cy="12" r="2" />
          <path d="M7 6l-3 4m5-4 3 4M5 12h6" />
        </svg>
        <div className="kshare-title" id="knetwork-title" ref={heading} tabIndex={-1}>{title}</div>
        <button className="kshare-x" onClick={close} title="Close" aria-label="Close">✕</button>
      </div>
      {summary && <div className="knetwork-summary">{summary}</div>}
      {notice && <div className="knetwork-notice-slot">{notice}</div>}
      <div className="kshare-body">{children}</div>
      <div className="kshare-actions">{actions}</div>
    </div>
  </div>, document.body);
}
