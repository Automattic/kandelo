import * as React from "react";
import type { ComputerSoftwareController, ComputerSoftwareSnapshot } from "../../../../../web-libs/kandelo-session/src/computer-software";
import { useDialogDismiss } from "./use-dialog-dismiss";

const EMPTY: ComputerSoftwareSnapshot = { available: false, targetAvailable: false, maintenance: false,
  busy: false, recovery: "none", operation: null, progress: null, error: null };

export function useComputerSoftware(controller: ComputerSoftwareController | undefined): ComputerSoftwareSnapshot {
  const [snapshot, setSnapshot] = React.useState(() => controller?.getSnapshot() ?? EMPTY);
  React.useEffect(() => {
    const refresh = () => setSnapshot(controller?.getSnapshot() ?? EMPTY);
    const off = controller?.subscribe(refresh);
    refresh();
    return off;
  }, [controller]);
  return snapshot;
}

export const SoftwarePanel: React.FC<{ controller: ComputerSoftwareController; state: ComputerSoftwareSnapshot; onClose(): void }> = ({ controller, state, onClose }) => {
  const dialog = React.useRef<HTMLDialogElement | null>(null);
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose, !state.busy);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); }
    catch (failure) { setError(String(failure)); }
  };
  const blocked = state.recovery === "pending" || state.recovery === "incomplete" || state.recovery === "unknown";
  const progress = state.progress;
  return <dialog ref={dialog} className="kopen-website kservices" aria-labelledby="ksoftware-title" {...dismiss}>
    <header className="kpopin-heading"><h2 id="ksoftware-title">Software updates</h2><button type="button" className="kshare-x" aria-label="Close Software updates" disabled={state.busy} onClick={close}>×</button></header>
    <p>Update packaged programs together while this computer is stopped. User files, posts and media stay in place. Changes to packaged files can prevent an update.</p>
    <p className="knetwork-note">Database migrations are separate. Software rollback cannot undo a database migration. Save your work before stopping programs.</p>
    <p className="knetwork-note">User-built programs that use fork may need rebuilding when the instrumentation contract changes. Their files are preserved, not automatically upgraded.</p>
    {(error || state.error) && <p role="alert">{error ?? state.error}</p>}
    {!state.maintenance ? <button type="button" className="kshare-btn" disabled={state.busy || !state.available} onClick={() => void run(() => controller.enter())}>Stop programs and enter maintenance</button> : <>
      <p role="status">Maintenance mode: guest programs are stopped. Update state: <strong>{state.recovery}</strong>.</p>
      {progress && <div aria-label="Software update progress"><p>{progress.path || "Checking packaged files"}</p><progress max={Math.max(1, Number(progress.total))} value={Number(progress.completed)} /><small>{progress.installedVerified} installed and {progress.stagedVerified} staged files verified of {progress.files}</small></div>}
      {state.busy ? <button type="button" className="kshare-btn" onClick={() => controller.cancel()}>Cancel operation</button> : <div className="kservices-actions">
        {!blocked && <button type="button" className="kshare-btn" disabled={!state.targetAvailable} onClick={() => {
          if (state.recovery !== "active" && state.recovery !== "rolled-back" || window.confirm("Replace the previous update's rollback history with this release's software? User data is not removed.")) void run(() => controller.install());
        }}>Update from this release</button>}
        {state.recovery === "pending" && <button type="button" className="kshare-btn" onClick={() => void run(() => controller.resume())}>Resume saved update</button>}
        {state.recovery === "active" && <button type="button" className="kshare-btn" onClick={() => {
          if (window.confirm("Restore the previous packaged software? User data stays in place, but database migrations are not undone.")) void run(() => controller.rollback());
        }}>Roll back software</button>}
        {(state.recovery === "pending" || state.recovery === "incomplete") && <button type="button" className="kshare-btn" onClick={() => {
          if (window.confirm("Discard the unfinished update? The installed software and user data are kept.")) void run(() => controller.discard());
        }}>Discard unfinished update</button>}
        <button type="button" className="kshare-btn" disabled={blocked} onClick={() => void run(() => controller.boot())}>Start computer</button>
      </div>}
      {!state.targetAvailable && <p>This development deployment does not publish a verified software bundle. Saved updates can still be resumed from their retained source.</p>}
      {state.recovery === "unknown" && <p role="alert">Recovery authority could not be verified. The computer stays paused; no saved files have been reset.</p>}
    </>}
  </dialog>;
};
