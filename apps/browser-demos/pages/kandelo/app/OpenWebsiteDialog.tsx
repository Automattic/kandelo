import * as React from "react";
import { useKernelHost } from "../kernel-host/react";
import { parseWebPreviewAddress, type WebPreviewTarget } from "../../../../../web-libs/kandelo-session/src/web-preview-address";
import type { RemoteSessionSnapshot } from "../../../../../host/src/networking/remote-segment-runtime";
import { useDialogDismiss } from "./use-dialog-dismiss";

export const OpenWebsiteDialog: React.FC<{ session: RemoteSessionSnapshot | null; initialTarget?: WebPreviewTarget; onClose: () => void }> = ({ session, initialTarget, onClose }) => {
  const host = useKernelHost();
  const dialog = React.useRef<HTMLDialogElement>(null);
  const computerSelect = React.useRef<HTMLSelectElement>(null);
  const portInput = React.useRef<HTMLInputElement>(null);
  const mounted = React.useRef(false);
  const initialHostname = initialTarget?.hostname ?? "localhost";
  const [hostname, setHostname] = React.useState(initialHostname === "127.0.0.1" ? "localhost"
    : initialHostname === "host" ? "10.89.0.1" : initialHostname.replace(/^peer-/, "10.89.0."));
  const [port, setPort] = React.useState(String(initialTarget?.port ?? 3000));
  const [path, setPath] = React.useState(initialTarget?.path ?? "/");
  const computers = session?.members.filter(member => member.address !== session.address) ?? [];
  const localOnly = computers.length === 0 && hostname === "localhost";
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose);
  React.useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    if (localOnly) portInput.current?.focus();
    else computerSelect.current?.focus();
    return () => { mounted.current = false; dialog.current?.close(); };
  }, []);
  return <dialog ref={dialog} className="kopen-website" aria-labelledby="kopen-website-title" {...dismiss}>
    <form onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setError(null);
      try {
        if (hostname !== "localhost" && !computers.some(member => member.address === hostname)) throw new Error("This computer is no longer connected. Choose a connected computer.");
        if (!path.startsWith("/") || path.startsWith("//")) throw new Error("The path must start with a single /.");
        const target = parseWebPreviewAddress(`http://${hostname}:${port}${path}`);
        if (!host.openWebPreview) throw new Error("This computer cannot open a web preview");
        setBusy(true);
        void host.openWebPreview(target).then(() => { if (mounted.current) onClose(); }, failure => {
          if (mounted.current) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); }
        });
      } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }}>
      <header className="kpopin-heading"><h2 id="kopen-website-title">Open website</h2><button type="button" className="kshare-x" title="Close" aria-label="Close" onClick={close}>×</button></header>
      <div className="kopen-website-address">
        <label>Protocol<select defaultValue="http:" disabled><option value="http:">http://</option></select></label>
        <label>Computer<select ref={computerSelect} aria-describedby="kopen-website-help" value={hostname} disabled={busy || localOnly} onChange={event => setHostname(event.target.value)}>
          <option value="localhost">This computer (localhost)</option>
          {computers.map(member => <option key={member.address} value={member.address}>{member.hostname || "Computer"}{member.address === "10.89.0.1" ? " · Host" : ""} · {member.address}</option>)}
          {hostname !== "localhost" && !computers.some(member => member.address === hostname) && <option value={hostname} disabled>{hostname} · disconnected</option>}
        </select></label>
        <label>Port<input ref={portInput} type="number" min={1} max={65535} step={1} value={port} required disabled={busy} onChange={event => setPort(event.target.value)} /></label>
      </div>
      <label>Path<input value={path} maxLength={4096} required spellCheck={false} disabled={busy} onChange={event => setPath(event.target.value)} /></label>
      <p id="kopen-website-help">Run your HTTP server first. Choose this computer or a connected Kandelo computer. Remote servers must listen on the network interface, not only loopback. No image configuration is required. Only HTTP is supported.</p>
      {computers.length === 0 && <p>Connect computers through a network session to preview a remote service.</p>}
      <p>From Terminal: <code>kandelo-preview http://localhost:3000/</code></p>
      {error && <p className="kopen-website-warning" role="alert"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 2 1.5 17h17Z" /><path d="M10 7v5m0 1.5v1" /></svg><span>{error}</span></p>}
      {busy && <p role="status">Connecting… The working preview stays open until this server answers. Closing this form does not cancel the connection.</p>}
      <div className="kcomputer-actions"><button type="submit" className="kshare-btn kshare-btn-primary" disabled={busy}>{busy ? "Connecting…" : "Open website"}</button></div>
    </form>
  </dialog>;
};
