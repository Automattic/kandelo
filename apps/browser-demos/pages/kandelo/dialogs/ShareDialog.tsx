// Share dialog — modal portaled to <body>.
//
// Encodes the current (or preset) boot descriptor plus an optional
// boot-time script into a #k1= URL fragment, and updates the tier bar /
// byte count as the user types.

import * as React from "react";
import { createPortal } from "react-dom";
import { useKernelHost } from "../kernel-host/react";
import {
  classifyTier, encodeBootDescriptor, HARD_CAPS,
} from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  BootDescriptor,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface ShareDialogProps {
  /**
   * Optional descriptor to share. If omitted, defaults to the host's current
   * boot descriptor. Used by Gallery to share a not-yet-applied preset.
   */
  descriptor?: BootDescriptor;
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
  descriptor: presetDesc, onClose, embedded = false,
}) => {
  const host = useKernelHost();
  const [script, setScript] = React.useState("");
  const [url, setUrl] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const baseDescriptor: BootDescriptor = React.useMemo(
    () => presetDesc ?? host.getBootDescriptor(),
    [presetDesc, host],
  );

  const scriptBytes = React.useMemo(
    () => new TextEncoder().encode(script).byteLength,
    [script],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const trimmed = script.trim();
        if (!trimmed) {
          if (!cancelled) { setUrl(workingShareUrl(null)); setError(null); }
          return;
        }
        const desc: BootDescriptor = {
          ...baseDescriptor,
          script: { text: script.endsWith("\n") ? script : `${script}\n` },
        };
        const { fragment } = await encodeBootDescriptor(desc);
        if (!cancelled) { setUrl(workingShareUrl(fragment)); setError(null); }
      } catch (err) {
        if (!cancelled) {
          setUrl("");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [baseDescriptor, script]);

  const tier = classifyTier(url.length);
  const tierPct = url.length === 0 ? 0 : Math.min(100, (url.length / (8 * 1024)) * 100);

  const copy = () => {
    if (!url) return;
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const renderUrl = () => {
    if (!url) return <span style={{ color: "var(--k-text-faint)" }}>computing…</span>;
    const m = url.match(/^(https?:\/\/)([^/]+)(\/[^#]*)(#.*)?$/);
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
          {/* Script */}
          <div className="kshare-script">
            <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>
              Run a script on open
            </div>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={'echo "hello from this link"'}
              rows={5}
              spellCheck={false}
              aria-label="Script to run when the link is opened"
            />
            <div className="kshare-script-meta">
              {scriptBytes} B / {HARD_CAPS.maxScriptBytes} B
              {" · runs in the machine's default shell, visible in the terminal"}
            </div>
            {error && <div className="kshare-script-err">{error}</div>}
          </div>

          {/* URL + tier */}
          <div>
            <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Link</div>
            <div className="kshare-url" data-share-url={url}>{renderUrl()}</div>
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

/**
 * Links must open in THIS app. The codec's buildShareUrl() path modes
 * (/c/<id>, /m/…, /p/…) have no routes here, so the working link is the
 * current page URL (which already carries ?demo=/?vfs= machine identity)
 * plus the descriptor fragment.
 */
function workingShareUrl(fragment: string | null): string {
  const url = new URL(window.location.href);
  url.hash = fragment ?? "";
  return url.href;
}
