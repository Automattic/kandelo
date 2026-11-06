/**
 * Kandelo exchange in the app: a toast per offered batch, the output tray,
 * and the file picker behind the dock's "Send files" button. A small
 * `text/uri-list` output (what the guest's `xdg-open` publishes) is a link
 * the machine asks to open; it shows every URI in full, and only a click on
 * Open, which is the user activation `window.open` needs, opens it.
 *
 * Everything shown comes from the session's exchange view
 * (web-libs/kandelo-session/src/exchange-session.ts); the app only decides
 * how to save an output. Chromium's `showSaveFilePicker` streams to disk;
 * elsewhere a stored output is saved through a Blob and `<a download>`, and a
 * streamed one is buffered first ("Buffer and download").
 */
import * as React from "react";
import type {
  ExchangeBatchView,
  ExchangeOutputView,
} from "../../../../../web-libs/kandelo-session/src/exchange-session";
import { useExchangeBatches, useExchangeOutputs, useKernelHost } from "../kernel-host/react";
import { pickedItems } from "./exchange-drop";

const DONE_VISIBLE_MS = 6000;
const LINK_MAX_BYTES = 8192;
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function batchTitle(batch: ExchangeBatchView): string {
  const [first, ...rest] = batch.names;
  const what = rest.length ? `${first} and ${rest.length} more` : (first ?? "files");
  switch (batch.phase) {
    case "waiting":
    case "active":
      return `Sending ${what}`;
    case "done":
      return `Sent ${what}`;
    case "failed":
      return `Could not send ${what}`;
  }
}

const BatchToast: React.FC<{ batch: ExchangeBatchView; onDismiss: (key: string) => void }> = ({ batch, onDismiss }) => {
  React.useEffect(() => {
    if (batch.phase !== "done") return;
    const timer = setTimeout(() => onDismiss(batch.key), DONE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [batch.key, batch.phase, onDismiss]);
  const finished = batch.phase === "done" || batch.phase === "failed";
  return (
    <div
      className={`kdownload-toast kexchange-toast kexchange-toast-${batch.phase}`}
      role={batch.phase === "failed" ? "alert" : "status"}
      data-testid="exchange-batch-toast"
      data-phase={batch.phase}
    >
      <div className="kdownload-toast-top">
        <span className="kdownload-toast-title">{batchTitle(batch)}</span>
        {finished && (
          <button
            type="button"
            className="kdownload-toast-close"
            aria-label="Dismiss"
            onClick={() => onDismiss(batch.key)}
          >
            ×
          </button>
        )}
      </div>
      {batch.status && <div className="kdownload-toast-detail" data-testid="exchange-batch-status">{batch.status}</div>}
      {!finished && <div className="kdownload-toast-bar indeterminate" aria-hidden="true"><span style={{ width: "44%" }} /></div>}
    </div>
  );
};

type SaveFilePicker = (options: { suggestedName?: string }) => Promise<{
  createWritable(): Promise<WritableStream<Uint8Array>>;
}>;

async function saveOutput(output: ExchangeOutputView, read: () => ReadableStream<Uint8Array>): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker({ suggestedName: output.name });
    } catch (error) {
      // Only a cancelled dialog is quiet; a refusal (SecurityError when the
      // page lacks activation, say) is shown on the row.
      if (error instanceof DOMException && error.name === "AbortError") return false;
      throw error;
    }
    await read().pipeTo(await handle.createWritable());
    return true;
  }
  // No streaming save here: the whole output is held in memory once.
  const blob = await new Response(read()).blob();
  const typed = output.mimeType ? new Blob([blob], { type: output.mimeType }) : blob;
  const url = URL.createObjectURL(typed);
  const link = document.createElement("a");
  link.href = url;
  link.download = output.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

const OutputRow: React.FC<{ output: ExchangeOutputView }> = ({ output }) => {
  const host = useKernelHost();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const exchange = host.getExchange();
  const streamWithoutPicker = output.kind === "stream"
    && !(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  const detail = [
    output.size !== undefined ? humanBytes(output.size) : output.kind === "stream" ? "stream" : null,
    output.mimeType ?? null,
    output.derivedFrom.length ? `from ${output.derivedFrom.join(", ")}` : null,
    output.withdrawn ? "removed by the machine" : null,
  ].filter(Boolean).join(" · ");
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (await saveOutput(output, () => exchange.readOutput(output.id))) exchange.finishOutput(output.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="kdownload-toast kexchange-output" data-testid="exchange-output" data-output-name={output.name}>
      <div className="kdownload-toast-top">
        <span className="kdownload-toast-title">{output.name}</span>
      </div>
      <div className="kdownload-toast-detail">{error ?? detail}</div>
      <div className="kexchange-output-actions">
        <button type="button" disabled={saving || output.withdrawn} onClick={save} data-testid="exchange-output-save">
          {saving ? "Saving…" : streamWithoutPicker ? "Buffer and download" : "Save"}
        </button>
        <button type="button" onClick={() => exchange.finishOutput(output.id)} data-testid="exchange-output-dismiss">
          Dismiss
        </button>
      </div>
    </div>
  );
};

function isLink(output: ExchangeOutputView): boolean {
  return output.mimeType === "text/uri-list" && output.kind === "stored"
    && output.size !== undefined && output.size <= LINK_MAX_BYTES;
}

/** RFC 2483: one URI per line; lines starting with '#' are comments. */
function parseUriList(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function openable(uri: string): boolean {
  try {
    return LINK_PROTOCOLS.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

const LinkRow: React.FC<{ output: ExchangeOutputView; machineTitle: string }> = ({ output, machineTitle }) => {
  const host = useKernelHost();
  const exchange = host.getExchange();
  const [uris, setUris] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let current = true;
    new Response(exchange.readOutput(output.id)).text().then(
      (text) => { if (current) setUris(parseUriList(text)); },
      (cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { current = false; };
  }, [exchange, output.id]);
  const open = () => {
    for (const uri of uris ?? []) if (openable(uri)) window.open(uri, "_blank", "noopener,noreferrer");
    exchange.finishOutput(output.id);
  };
  const refused = (uris ?? []).filter((uri) => !openable(uri));
  return (
    <div className="kdownload-toast kexchange-output" data-testid="exchange-link" data-output-name={output.name}>
      <div className="kdownload-toast-top">
        <span className="kdownload-toast-title">
          {machineTitle} wants to open {uris && uris.length > 1 ? "links" : "a link"}
        </span>
      </div>
      {error && <div className="kdownload-toast-detail">{error}</div>}
      {(uris ?? []).map((uri) => (
        <div key={uri} className="kdownload-toast-detail kexchange-link-uri" data-testid="exchange-link-uri">{uri}</div>
      ))}
      {refused.length > 0 && <div className="kdownload-toast-detail">Only http, https and mailto links open.</div>}
      <div className="kexchange-output-actions">
        <button
          type="button"
          disabled={!uris || uris.length === refused.length || output.withdrawn}
          onClick={open}
          data-testid="exchange-link-open"
        >
          Open
        </button>
        <button type="button" onClick={() => exchange.finishOutput(output.id)} data-testid="exchange-link-dismiss">
          Dismiss
        </button>
      </div>
    </div>
  );
};

/** Batch toasts and the output tray. */
export const ExchangeToasts: React.FC<{ machineTitle: string }> = ({ machineTitle }) => {
  const host = useKernelHost();
  const batches = useExchangeBatches();
  const outputs = useExchangeOutputs();
  const dismiss = React.useCallback((key: string) => host.getExchange().dismissBatch(key), [host]);
  if (batches.length === 0 && outputs.length === 0) return null;
  return (
    <aside className="kdownload-toasts kexchange-toasts" aria-label="Files sent to and from this machine" aria-live="polite">
      {batches.slice(-3).map((batch) => <BatchToast key={batch.key} batch={batch} onDismiss={dismiss} />)}
      {outputs.map((output) => isLink(output)
        ? <LinkRow key={output.id} output={output} machineTitle={machineTitle} />
        : <OutputRow key={output.id} output={output} />)}
    </aside>
  );
};

/**
 * The file picker behind the dock's "Send files" button; the picker also
 * covers touch devices with no drag and drop.
 */
export function useExchangePicker(): { open: () => void; input: React.ReactNode } {
  const host = useKernelHost();
  const ref = React.useRef<HTMLInputElement>(null);
  const open = React.useCallback(() => ref.current?.click(), []);
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      hidden
      data-testid="exchange-picker-input"
      onChange={(event) => {
        const files = event.currentTarget.files;
        if (files && files.length > 0) void host.getExchange().offer(pickedItems(files), "picker");
        event.currentTarget.value = "";
      }}
    />
  );
  return { open, input };
}

/** What a surface shows while files are dragged over it. */
export const ExchangeDropOverlay: React.FC<{ active: boolean; refused: boolean; testId: string }> = ({ active, refused, testId }) =>
  active ? (
    <div className="kexchange-dropzone" data-refused={refused ? "true" : "false"} data-testid={testId}>
      {refused ? "This machine doesn't accept files" : "Drop to send to this machine"}
    </div>
  ) : null;

/**
 * A surface's own "send a file" button, from the image's exchange hints: the
 * label ("Load WAD") and the picker's extension filter. The guest's handler
 * rules still decide what happens to what is picked.
 */
export const ExchangePickControl: React.FC<{ label: string; accept?: readonly string[]; testIdPrefix: string }> = ({ label, accept, testIdPrefix }) => {
  const host = useKernelHost();
  const ref = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        hidden
        {...(accept?.length ? { accept: accept.join(",") } : {})}
        data-testid={`${testIdPrefix}-exchange-input`}
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files && files.length > 0) void host.getExchange().offer(pickedItems(files), "picker");
          event.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        className="kdemo-surface-action"
        data-testid={`${testIdPrefix}-exchange-button`}
        onClick={() => ref.current?.click()}
      >
        {label}
      </button>
    </>
  );
};
