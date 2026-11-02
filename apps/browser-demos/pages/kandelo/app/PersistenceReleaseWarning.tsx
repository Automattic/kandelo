import * as React from "react";
import { useDialogDismiss } from "./use-dialog-dismiss";

export const PERSISTENCE_RELEASE_WARNING = "Software updates keep your files, posts and media, but programs you built yourself may need rebuilding. Computers saved by earlier preview releases cannot be updated. Browser storage is not a backup, so export anything important.";

export const PersistenceReleaseWarning: React.FC = () => (
  <aside className="kpersistence-release-warning" role="note" aria-label="Release compatibility warning">
    <strong>Experimental persistence</strong>
    <span>{PERSISTENCE_RELEASE_WARNING}</span>
  </aside>
);

/** Shows the warning for a saved computer, or asks before keeping one when `onKeep` is set. */
export const PersistenceWarningDialog: React.FC<{ title: string; onKeep?: () => void; onClose: () => void }> = ({ title, onKeep, onClose }) => {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose);
  React.useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="kopen-website kpersistence-dialog" aria-labelledby="kpersistence-title" {...dismiss}>
    <header className="kpopin-heading"><h2 id="kpersistence-title">{onKeep ? `Keep “${title}” on this device?` : `“${title}” is saved on this device`}</h2><button type="button" className="kshare-x" title="Close" aria-label="Close" onClick={close}>×</button></header>
    <PersistenceReleaseWarning />
    {onKeep && <p>It will stay in your Library until you delete it.</p>}
    <div className="kservices-actions">
      {onKeep
        ? <>
          <button type="button" className="kshare-btn" autoFocus onClick={close}>Cancel</button>
          <button type="button" className="kshare-btn kshare-btn-primary" onClick={() => { close(); onKeep(); }}>Keep on this device</button>
        </>
        : <button type="button" className="kshare-btn" autoFocus onClick={close}>Close</button>}
    </div>
  </dialog>;
};
