// Network session panel — modal portaled to <body>.
//
// Creates a session on this machine, shares its link, joins a session from
// a link, and shows the members the kernel worker reports. Every value here
// comes from the controller or the worker's snapshot; nothing is inferred.

import * as React from "react";
import { createPortal } from "react-dom";
import type { NetworkSession } from "./use-network-session";
import { NETWORK_PHASE_LABEL } from "./Dock";

export const NetworkPanel: React.FC<{ session: NetworkSession; running: boolean }> = ({ session, running }) => {
  const { state, invitation } = session;
  const [name, setName] = React.useState("LAN party");
  const [copied, setCopied] = React.useState(false);
  const heading = React.useRef<HTMLDivElement>(null);
  const close = () => session.setOpen(false);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => previous?.focus();
  }, []);

  const inSession = state.phase === "hosting" || state.phase === "joining" || state.phase === "connected";
  const busy = state.phase === "hosting" || state.phase === "joining";
  const blocked = !running || !session.available || busy;
  const self = state.snapshot?.address ?? null;
  const members = state.snapshot?.members ?? [];
  const copy = async () => {
    if (!state.link) return;
    try { await navigator.clipboard.writeText(state.link); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }
    catch { /* The link stays visible and selectable. */ }
  };

  return createPortal(
    <div
      className="kshare-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
      onKeyDown={(event) => { if (event.key === "Escape") close(); }}
    >
      <div className="kshare knetwork" role="dialog" aria-modal="true" aria-labelledby="knetwork-title">
        <div className="kshare-hd">
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--k-accent)" strokeWidth="1.2" aria-hidden="true">
            <circle cx="8" cy="4" r="2" /><circle cx="3" cy="12" r="2" /><circle cx="13" cy="12" r="2" />
            <path d="M7 6l-3 4m5-4 3 4M5 12h6" />
          </svg>
          <div className="kshare-title" id="knetwork-title" ref={heading} tabIndex={-1}>Network session</div>
          <button className="kshare-x" onClick={close} title="Close" aria-label="Close">✕</button>
        </div>

        <div className="kshare-body">
          <div className="knetwork-status" data-phase={state.phase} role="status">
            <span className="knetwork-dot" aria-hidden="true" />
            <strong>{state.name ?? "No session"}</strong>
            <span>{NETWORK_PHASE_LABEL[state.phase]}{self ? ` · this computer is ${self}` : ""}</span>
          </div>
          {state.error && <div className="knetwork-error" role="alert">{state.error}</div>}
          {!session.available && (
            <p className="knetwork-note">No signalling server is configured for this deployment, so computers cannot find each other.</p>
          )}
          {!running && <p className="knetwork-note">Start a computer to create or join a session.</p>}

          {inSession ? (
            <>
              {state.link && (
                <div>
                  <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Invite link</div>
                  <div className="kshare-url" data-network-link={state.link}>{state.link}</div>
                  <p className="knetwork-note">Anyone with this link can ask to join while this computer hosts the session.</p>
                </div>
              )}
              <div>
                <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Computers</div>
                <ul className="knetwork-members" aria-label="Computers in this session">
                  {members.map((member) => (
                    <li key={member.address}>
                      <code>{member.address}</code>
                      <span>{member.hostname}</span>
                      {member.address === self && <small>this computer</small>}
                    </li>
                  ))}
                </ul>
                <p className="knetwork-note">Programs reach each other by these addresses or names. Each computer keeps its own machine and files.</p>
              </div>
            </>
          ) : (
            <>
              {invitation && (
                <form onSubmit={(event) => { event.preventDefault(); void session.join(invitation.room, invitation.name); }}>
                  <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Invitation</div>
                  <p className="knetwork-note">Join “{invitation.name}”. The hosting computer will see this computer’s network address.</p>
                  <button className="kshare-btn kshare-btn-primary" disabled={blocked}>Join session</button>
                </form>
              )}
              <form onSubmit={(event) => { event.preventDefault(); void session.create(name); }}>
                <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Host a session</div>
                <label className="knetwork-field">
                  Session name
                  <input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} disabled={busy} />
                </label>
                <button className={`kshare-btn${invitation ? "" : " kshare-btn-primary"}`} disabled={blocked}>Create session</button>
              </form>
            </>
          )}
        </div>

        <div className="kshare-actions">
          <button className="kshare-btn" onClick={close}>Close</button>
          <div style={{ flex: 1 }} />
          {inSession && <button className="kshare-btn" onClick={() => void session.leave()}>Leave session</button>}
          {state.link && <button className="kshare-btn kshare-btn-primary" onClick={() => void copy()}>{copied ? "Copied!" : "Copy link"}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
};
