// Share dialog — modal portaled to <body>.
//
// Re-runs host.snapshot() whenever the user changes the mode picker or the
// overlay/encrypt toggles, encodes the descriptor, builds the URL, and
// updates the tier bar / byte count.

import * as React from "react";
import { createPortal } from "react-dom";
import { useKernelHost } from "../kernel-host/react";
import {
  buildShareUrl, classifyTier, encodeBootDescriptor,
  SHARE_MODE_INFO,
} from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  BootDescriptor, ShareMode, Snapshot,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

// Order of mode chips after the Auto card.
const MODE_ORDER: ShareMode[] = ["preset", "delta", "inline", "manifest", "private", "local"];

export interface ShareDialogProps {
  /**
   * Optional descriptor to share. If omitted, defaults to the host's current
   * boot descriptor. Used by Gallery to share a not-yet-applied preset.
   */
  descriptor?: BootDescriptor;
  /** Preset id to embed in the URL path. Falls back to descriptor.id. */
  presetId?: string;
  onClose: () => void;
}

export interface SharePanelProps extends ShareDialogProps {
  embedded?: boolean;
}

export const ShareDialog: React.FC<ShareDialogProps> = (props) => {
  const onBackdropClick: React.MouseEventHandler = (event) => {
    if (event.target === event.currentTarget) props.onClose();
  };

  const onKeyDown: React.KeyboardEventHandler = (event) => {
    if (event.key === "Escape") props.onClose();
  };

  return createPortal(
    <div className="kshare-backdrop" onMouseDown={onBackdropClick} onKeyDown={onKeyDown}>
      <SharePanel {...props} />
    </div>,
    document.body,
  );
};

export const SharePanel: React.FC<SharePanelProps> = ({
  descriptor: presetDesc, presetId, onClose, embedded = false,
}) => {
  const host = useKernelHost();
  const [mode, setMode] = React.useState<ShareMode>("auto");
  const [includeOverlay, setIncludeOverlay] = React.useState(true);
  const [encrypt, setEncrypt] = React.useState(false);
  const [snap, setSnap] = React.useState<Snapshot | null>(null);
  const [url, setUrl] = React.useState<string>("");
  const [copied, setCopied] = React.useState(false);

  const baseDescriptor: BootDescriptor = React.useMemo(
    () => presetDesc ?? host.getBootDescriptor(),
    [presetDesc, host],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Bias the host's snapshot toward the user's preference.
        const s = await host.snapshot({ preferMode: mode });
        if (cancelled) return;
        // If we're sharing a preset descriptor (Gallery context), the
        // host's snapshot may not be relevant — replace it with our base.
        const desc = stripOverlayIfDisabled(
          presetDesc ?? s.descriptor,
          includeOverlay,
        );
        setSnap({ ...s, descriptor: desc });

        let fragment = "";
        let resolvedMode = mode === "auto" ? s.mode : (mode as Exclude<ShareMode, "auto">);

        if (resolvedMode === "delta" || resolvedMode === "inline") {
          try {
            const enc = await encodeBootDescriptor(desc);
            if (cancelled) return;
            fragment = enc.fragment;
          } catch {
            fragment = "";
          }
        }
        const builtUrl = buildShareUrl(desc, {
          mode: resolvedMode,
          fragment,
          presetId: presetId ?? desc.id,
        });
        if (!cancelled) setUrl(builtUrl);
      } catch (err) {
        if (!cancelled) {
          console.warn("[ShareDialog] snapshot/encode failed:", err);
          setUrl("");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [host, mode, includeOverlay, encrypt, presetDesc, presetId]);

  const tier = classifyTier(url.length);
  const tierPct = url.length === 0 ? 0 : Math.min(100, (url.length / (8 * 1024)) * 100);
  const shareTargetLabel = presetDesc ? "selected preset" : "current machine";
  const overlaySummary = includeOverlay
    ? "Overlay-capable modes may include current descriptor edits when KernelHost can encode them."
    : "The link is limited to the base preset/descriptor; local edits stay in this browser.";

  const copy = () => {
    if (!url) return;
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const renderUrl = () => {
    if (!url) return <span style={{ color: "var(--k-text-faint)" }}>computing…</span>;
    const m = url.match(/^(https:\/\/)([^/]+)(\/[^#]*)(#.*)?$/);
    if (!m) return url;
    return (
      <>
        <span className="kurl-scheme">{m[1]}</span>
        <span className="kurl-host">{m[2]}</span>
        <span style={{ color: "var(--k-text-muted)" }}>{m[3]}</span>
        {m[4] && <span className="kurl-hash">{m[4]}</span>}
      </>
    );
  };

  return (
      <div
        className={`kshare${embedded ? " kshare-embedded" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        role={embedded ? undefined : "dialog"}
        aria-modal={embedded ? undefined : true}
      >
        {!embedded && (
        <div className="kshare-hd">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="var(--k-accent)" strokeWidth="1.6">
            <circle cx="5.5" cy="11" r="2.4" />
            <circle cx="16" cy="5" r="2.4" />
            <circle cx="16" cy="17" r="2.4" />
            <path d="M7.6 10l6.4-3.6M7.6 12l6.4 3.6" />
          </svg>
          <div className="kshare-title">Share this machine</div>
          <button className="kshare-x" onClick={onClose} title="Close" aria-label="Close">✕</button>
        </div>
        )}

        <div className="kshare-body">
          <div className="kshare-summary">
            <div className="kshare-summary-card">
              <div className="kshare-summary-k">Share target</div>
              <div className="kshare-summary-v">{shareTargetLabel}</div>
              <p>{overlaySummary}</p>
            </div>
            <div className="kshare-summary-card">
              <div className="kshare-summary-k">Export boundary</div>
              <div className="kshare-summary-v">No VFS archive export</div>
              <p>Use this URL flow for descriptor sharing. Full image export is not simulated here.</p>
            </div>
          </div>

          {/* URL + tier */}
          <div>
            <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Link</div>
            <div className="kshare-url">{renderUrl()}</div>
            <div className="kshare-tier">
              <div className="kshare-tier-track">
                <div
                  className="kshare-tier-fill"
                  data-tier={tier}
                  style={{ width: `${Math.max(2, tierPct)}%` }}
                />
              </div>
              <div className="kshare-tier-label">
                {url ? `${url.length} B` : "—"} · {tier}
              </div>
            </div>
          </div>

          {/* Mode picker */}
          <div>
            <div className="kshare-sect-lbl" style={{ marginBottom: 8 }}>
              Mode
              {snap && mode === "auto" && (
                <span style={{
                  marginLeft: 6,
                  color: "var(--k-text-muted)",
                  fontWeight: 400,
                  textTransform: "none",
                  letterSpacing: 0,
                }}>
                  {snap.reason}
                </span>
              )}
            </div>
            <div className="kshare-modes">
              <button className="kshare-mode" aria-current={mode === "auto"} onClick={() => setMode("auto")}>
                <div className="kshare-mode-name">
                  Auto
                  {snap && mode === "auto" && (
                    <span className="kshare-mode-auto">→ {snap.mode}</span>
                  )}
                </div>
                <div className="kshare-mode-blurb">Kandelo picks the smallest viable mode.</div>
              </button>
              {MODE_ORDER.map((m) => (
                <button key={m} className="kshare-mode" aria-current={mode === m} onClick={() => setMode(m)}>
                  <div className="kshare-mode-name">{SHARE_MODE_INFO[m].label}</div>
                  <div className="kshare-mode-blurb">{SHARE_MODE_INFO[m].blurb}</div>
                </button>
              ))}
            </div>
          </div>

          {/* What's in this link */}
          <div>
            <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>What's in this link</div>
            <div className="kshare-prev">
              <PrevRow k="base" v={<span className="accent">{baseDescriptor.base}</span>} />
              <PrevRow
                k="runtime"
                v={`${baseDescriptor.runtime.arch} · ${baseDescriptor.runtime.memoryPages} pages · time: ${baseDescriptor.runtime.time}`}
              />
              <PrevRow
                k="kernel"
                v={baseDescriptor.runtime.kernel.replace(/^kernel@sha256:/, "")}
              />
              <PrevRow
                k="packages"
                v={baseDescriptor.packages.map((p) => p.split("@")[0]).join(" · ") || "none"}
              />
              <PrevRow
                k="mounts"
                v={baseDescriptor.mounts.map((m) => `${m.path} (${m.source})`).join(" · ") || "none"}
              />
              <PrevRow
                k="boot"
                v={`${baseDescriptor.boot.argv.join(" ")} · cwd ${baseDescriptor.boot.cwd}`}
              />
              <PrevRow
                k="caps"
                v={
                  Object.entries(baseDescriptor.caps ?? {})
                    .filter(([, v]) => v && v !== false)
                    .map(([k]) => k)
                    .join(" · ") || "none"
                }
              />
            </div>
          </div>

          {/* Options */}
          <div className="kshare-opts">
            <div className="kshare-opt">
              <div style={{ flex: 1 }}>
                <div className="kshare-opt-lbl">Include my overlay</div>
                <div className="kshare-opt-sub">
                  If off, the link is just the preset — your edits stay on this machine.
                </div>
              </div>
              <Toggle on={includeOverlay} onChange={setIncludeOverlay} />
            </div>
            <div className="kshare-opt">
              <div style={{ flex: 1 }}>
                <div className="kshare-opt-lbl">Encrypt overlay</div>
                <div className="kshare-opt-sub">
                  Ciphertext goes to the server; the key stays in the URL fragment.
                </div>
              </div>
              <Toggle on={encrypt} onChange={setEncrypt} />
            </div>
          </div>
        </div>

        <div className="kshare-actions">
          <button className="kshare-btn" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button
            className="kshare-btn"
            onClick={() => url && window.open(url, "_blank")}
            disabled={!url}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 2h3M2 2v3M6 9h3v-3M2 2l7 7" />
            </svg>
            Open
          </button>
          <button
            className="kshare-btn kshare-btn-primary"
            onClick={copy}
            disabled={!url}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="3" width="6.5" height="6.5" rx="1" />
              <path d="M3 6.5H1.5V1.5h5V3" />
            </svg>
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
      </div>
  );
};

const PrevRow: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div className="kshare-prev-row">
    <div className="kshare-prev-k">{k}</div>
    <div className="kshare-prev-v">{v}</div>
  </div>
);

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!on)}
    aria-pressed={on}
    style={{
      width: 32,
      height: 18,
      borderRadius: 999,
      border: 0,
      padding: 0,
      cursor: "pointer",
      background: on ? "var(--k-accent)" : "color-mix(in oklch, var(--k-text) 14%, transparent)",
      position: "relative",
      transition: "background 0.15s",
    }}
  >
    <span style={{
      position: "absolute",
      top: 2,
      left: 2,
      width: 14,
      height: 14,
      borderRadius: "50%",
      background: "#fff",
      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
      transform: on ? "translateX(14px)" : "translateX(0)",
      transition: "transform 0.15s",
    }} />
  </button>
);

function stripOverlayIfDisabled(d: BootDescriptor, include: boolean): BootDescriptor {
  if (include) return d;
  return {
    ...d,
    mounts: d.mounts.filter((m) => m.source !== "inline-overlay"),
  };
}
