// LiveURLBar — single source of truth for "what URL would describe the
// currently-running computer right now."
//
// On status change, calls host.snapshot(), encodes the descriptor with the
// real `k1` envelope, and re-renders. URL is rebuilt with buildShareUrl()
// using the snapshot's mode + the encoded fragment.

import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import {
  buildShareUrl, encodeBootDescriptor,
} from "../../../../../host/src/kandelo-ui/boot-descriptor";
import type {
  MachineStatus, Snapshot,
} from "../../../../../host/src/kandelo-ui/kernel-host";

const STATUS_LABEL: Record<MachineStatus, string> = {
  idle: "Idle", booting: "Booting", running: "Running", halted: "Halted", error: "Error",
};

const NEEDS_FRAGMENT = new Set<Snapshot["mode"]>(["delta", "inline"]);

interface UrlState {
  snap: Snapshot | null;
  url: string;
  byteSize: number;
}

export const LiveUrlBar: React.FC<{ onOpenShare: () => void }> = ({ onOpenShare }) => {
  const host = useKernelHost();
  const status = useStatus();
  const [state, setState] = React.useState<UrlState>({
    snap: null,
    url: "https://kandelo.dev/c/…",
    byteSize: 0,
  });
  const [copied, setCopied] = React.useState(false);

  // Re-encode whenever status changes — that's our best proxy for "machine
  // state may have changed" until a real diff/subscription lands.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await host.snapshot();
        if (cancelled) return;
        let fragment = "";
        let byteSize = snap.byteSize;
        if (NEEDS_FRAGMENT.has(snap.mode)) {
          try {
            const enc = await encodeBootDescriptor(snap.descriptor);
            if (cancelled) return;
            fragment = enc.fragment;
            byteSize = enc.urlBytes;
          } catch {
            // Encoder failed — fall back to a fragmentless URL so the bar
            // still renders something honest.
            fragment = "";
          }
        }
        const url = buildShareUrl(snap.descriptor, {
          mode: snap.mode,
          fragment,
          presetId: snap.descriptor.id,
        });
        if (!cancelled) setState({ snap, url, byteSize });
      } catch (err) {
        if (!cancelled) {
          console.warn("[LiveURLBar] snapshot failed:", err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [host, status]);

  const copy = React.useCallback(() => {
    if (!state.url) return;
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(state.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [state.url]);

  const parts = state.url.match(/^(https:\/\/)([^/]+)(\/[^#]*)(#.*)?$/);

  return (
    <div className="kurl">
      <div className="kurl-state" data-status={status}>
        <span className="kurl-state-dot" />
        {STATUS_LABEL[status] ?? status}
      </div>
      <div className="kurl-bar">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" style={{ color: "var(--k-text-faint)", flexShrink: 0 }}>
          <path d="M5 7.5l3-3M4.5 6.5l-2 2a2 2 0 1 0 3 3l2-2M8.5 6.5l2-2a2 2 0 1 0-3-3l-2 2" />
        </svg>
        {state.snap && <span className="kurl-mode">{state.snap.mode}</span>}
        <span className="kurl-scheme">{parts?.[1] ?? "https://"}</span>
        <span className="kurl-host">{parts?.[2] ?? "kandelo.dev"}</span>
        <span className="kurl-path">{parts?.[3] ?? "/c/"}</span>
        {parts?.[4] && (
          <span className="kurl-hash" title={parts[4]}>{parts[4]}</span>
        )}
      </div>
      <div className="kurl-stat">{state.byteSize ? `${state.byteSize} B` : "—"}</div>
      <div className="kurl-actions">
        <button className="kurl-btn" onClick={copy} title="Copy link">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="6.5" height="6.5" rx="1" />
            <path d="M3 6.5H1.5V1.5h5V3" />
          </svg>
          {copied ? "Copied!" : "Copy"}
        </button>
        <button className="kurl-btn kurl-btn-primary" onClick={onOpenShare}>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="3" cy="5.5" r="1.4" />
            <circle cx="8.5" cy="2.5" r="1.4" />
            <circle cx="8.5" cy="8.5" r="1.4" />
            <path d="M4.2 4.8l3.2-1.8M4.2 6.2l3.2 1.8" />
          </svg>
          Share
        </button>
      </div>
    </div>
  );
};
