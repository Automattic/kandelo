import * as React from "react";
import { useDialogDismiss } from "./use-dialog-dismiss";
import type { ServiceControls } from "./use-service-controls";
import type { ComputerServiceStatus } from "../../../../../web-libs/kandelo-session/src/computer-services";

export const ServicesPanel: React.FC<{ controls: ServiceControls; onClose: () => void; onStarted?: (service: ComputerServiceStatus) => void }> = ({ controls, onClose, onStarted }) => {
  const dialog = React.useRef<HTMLDialogElement | null>(null);
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose);
  React.useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="kopen-website kservices" aria-label="Services" {...dismiss}>
    <header className="kpopin-heading"><h2>Services</h2><button type="button" className="kshare-x" aria-label="Close Services" onClick={close}>×</button></header>
    <p>Current state comes from the service supervisor. Boot preferences take effect next time this computer starts.</p>
    <button type="button" className="kshare-btn" disabled={controls.busy} onClick={() => void controls.refresh()}>Refresh services</button>
    {controls.error && <p role="alert">{controls.error}</p>}
    {controls.busy && <p role="status">Updating service…</p>}
    {controls.starting && <p role="status">Service supervisor is starting…</p>}
    <ul className="kservices-list" aria-label="Installed services">{controls.entries.map(service => <li key={service.id} data-service-id={service.id}>
      <div><strong>{service.title}</strong><small>{service.id}</small><span>State: {service.state}</span></div>
      <div className="kservices-actions">
        <button type="button" className="kshare-btn" disabled={controls.busy || service.state === "running" || controls.entries.some(entry => entry.state === "starting" || entry.state === "stopping")} onClick={() => void controls.change("start", service.id).then(started => { if (started) onStarted?.(service); })}>Start</button>
        <button type="button" className="kshare-btn" disabled={controls.busy || !["running", "starting"].includes(service.state)} onClick={() => void controls.change("stop", service.id)}>Stop</button>
        <label><input type="checkbox" checked={service.enabled} disabled={controls.busy} onChange={event => void controls.change(event.target.checked ? "enable" : "disable", service.id)} /> Start on boot</label>
      </div>
    </li>)}</ul>
    {!controls.entries.length && !controls.error && !controls.starting && <p>No services are declared by this computer.</p>}
    <p className="knetwork-note">Status refreshes every 10 seconds while this page is visible. Starting a service can stop conflicting services.</p>
  </dialog>;
};
