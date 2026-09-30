// Share dialog — modal portaled to <body>.
//
// Encodes the current (or preset) boot descriptor plus an optional
// boot-time script and, for a machine whose image declares one, an optional
// checkpoint of where it is now, into a #k1= URL fragment, and updates the
// tier bar / byte count as the user types.

import * as React from "react";
import { createPortal } from "react-dom";
import { useDemoCheckpoint, useKernelHost } from "../kernel-host/react";
import {
  classifyTier, encodeBootDescriptor, HARD_CAPS,
} from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import {
  createInlineBootInput,
  decodeInlineBootInputText,
} from "../../../../../web-libs/kandelo-session/src/boot-inputs";
import { createCheckpointBootInputs } from "../../../../../web-libs/kandelo-session/src/demo-checkpoint";
import type {
  BootDescriptor,
  BootInput,
  BootParameters,
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
  const checkpoint = useDemoCheckpoint();
  const [script, setScript] = React.useState("");
  // A checkpoint is taken once, when asked for: the link then describes the
  // moment the box was ticked, not whatever the machine is doing when the
  // visitor gets around to copying.
  const [checkpointState, setCheckpointState] = React.useState<
    | { kind: "off" }
    | { kind: "capturing" }
    | { kind: "ready"; inputs: BootInput[]; parameters?: BootParameters; bytes: number }
    | { kind: "error"; message: string }
  >({ kind: "off" });
  const [url, setUrl] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const baseDescriptor: BootDescriptor = React.useMemo(
    () => presetDesc ?? host.getBootDescriptor(),
    [presetDesc, host],
  );

  const takeCheckpoint = React.useCallback(async () => {
    if (!checkpoint) return;
    setCheckpointState({ kind: "capturing" });
    // Inputs the machine booted with still describe its content until
    // something is ingested; the link script is not part of that content.
    const runScript = baseDescriptor.boot.parameters?.runScript;
    const carried = (baseDescriptor.boot.inputs ?? []).filter(
      (input) => input.id !== runScript,
    );
    try {
      const { inputs, parameters } = await createCheckpointBootInputs(
        host,
        checkpoint,
        carried,
      );
      const state = inputs[inputs.length - 1];
      setCheckpointState({
        kind: "ready",
        inputs,
        ...(parameters ? { parameters } : {}),
        bytes: state.byteLength,
      });
    } catch (err) {
      setCheckpointState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [baseDescriptor, checkpoint, host]);

  const scriptBytes = React.useMemo(
    () => new TextEncoder().encode(script).byteLength,
    [script],
  );

  // When this machine was booted from a script-carrying link, pre-fill the
  // editor with that script so it can be tweaked and re-shared. Only an
  // untouched (empty) editor is filled — never clobber the user's typing.
  React.useEffect(() => {
    const runScript = baseDescriptor.boot.parameters?.runScript;
    const input = typeof runScript === "string"
      ? baseDescriptor.boot.inputs?.find((entry) => entry.id === runScript)
      : undefined;
    if (!input) return;
    let cancelled = false;
    void decodeInlineBootInputText(input)
      .then((text) => {
        if (cancelled || text === null) return;
        setScript((current) => (current === "" ? text : current));
      })
      .catch(() => {
        // A malformed inherited input just leaves the editor empty; the
        // link that carried it already failed loudly at boot if it was bad.
      });
    return () => { cancelled = true; };
  }, [baseDescriptor]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const trimmed = script.trim();
        const checkpointInputs = checkpointState.kind === "ready"
          ? checkpointState.inputs
          : [];
        const checkpointParameters = checkpointState.kind === "ready"
          ? checkpointState.parameters
          : undefined;
        if (!trimmed && checkpointInputs.length === 0) {
          if (!cancelled) { setUrl(workingShareUrl(null)); setError(null); }
          return;
        }
        const scriptInputs = trimmed
          ? [await createInlineBootInput({
            id: "script",
            filename: "kandelo-link.sh",
            bytes: new TextEncoder().encode(
              script.endsWith("\n") ? script : `${script}\n`,
            ),
            compression: "gzip",
          })]
          : [];
        const desc: BootDescriptor = {
          ...baseDescriptor,
          boot: {
            // BOOT IDENTITY COMES FROM THE IMAGE: argv/cwd/env carried here
            // would just be the CURRENT machine's, which the opener's boot
            // ignores (with a visible log line) in favour of its own image's
            // init. This placeholder only satisfies validateBootDescriptor's
            // non-empty-argv/cwd/env schema requirement; every Kandelo
            // browser image can run this default interactive login session,
            // so it is truthful even though it is never actually launched.
            argv: ["bash", "-l", "-i"],
            cwd: "/",
            env: {},
            inputs: [...checkpointInputs, ...scriptInputs],
            // Record the shell that should run the script so the opener's
            // machine executes it directly (`<shell> script`) with no visible
            // `command -v bash` probe. Every Kandelo browser image provides
            // bash as its default shell, and the opener boots the same image
            // this link carries, so the choice is a property of the link.
            ...(trimmed || checkpointParameters
              ? {
                parameters: {
                  ...(checkpointParameters ?? {}),
                  ...(trimmed ? { runScript: "script", runScriptShell: "bash" } : {}),
                },
              }
              : {}),
          },
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
  }, [baseDescriptor, script, checkpointState]);

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
          {checkpoint && (
            <div className="kshare-script">
              <label className="kshare-sect-lbl" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  data-testid="share-checkpoint-toggle"
                  checked={checkpointState.kind !== "off"}
                  disabled={checkpointState.kind === "capturing"}
                  onChange={(e) => {
                    if (e.target.checked) void takeCheckpoint();
                    else setCheckpointState({ kind: "off" });
                  }}
                />
                {checkpoint.label ?? "Include a checkpoint"}
              </label>
              <div className="kshare-script-meta" data-testid="share-checkpoint-status">
                {checkpointState.kind === "off" && "The link opens this machine from the start."}
                {checkpointState.kind === "capturing" && "Taking a checkpoint…"}
                {checkpointState.kind === "ready" && (
                  <>
                    {`Checkpoint taken (${checkpointState.bytes} B). The link opens where this machine was then. `}
                    <button type="button" className="kshare-btn" onClick={() => void takeCheckpoint()}>
                      Take again
                    </button>
                  </>
                )}
              </div>
              {checkpointState.kind === "error" && (
                <div className="kshare-script-err" data-testid="share-checkpoint-error">
                  {checkpointState.message}
                </div>
              )}
            </div>
          )}

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
              {scriptBytes} B / {HARD_CAPS.maxInlineInflatedInputBytes} B
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
 * current page URL (which already carries ?vfs=<image>&profile=<id> machine
 * identity) plus the descriptor fragment.
 */
function workingShareUrl(fragment: string | null): string {
  const url = new URL(window.location.href);
  url.hash = fragment ?? "";
  return url.href;
}
