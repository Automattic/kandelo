// Save popup — whether the running machine is saved in this browser, and the
// button that saves it.
//
// A machine on memory loses its home directory with the tab. Saving copies
// that directory into a browser-storage workspace and reboots the machine on
// it, so the reboot is said before the button is pressed: the files survive
// it, the running programs do not.
import * as React from "react";
import { presentableMachineName } from "../../../../../web-libs/kandelo-session/src/machine-name";
import { homeDirectoryOf } from "../../../../../web-libs/kandelo-session/src/persistent-machine";
import type { BootDescriptor } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PersistentMachines } from "./persistent-machines";

export const SavePopup: React.FC<{
  descriptor: BootDescriptor;
  persistent: PersistentMachines;
  onOpenMachines: () => void;
}> = ({ descriptor, persistent, onOpenMachines }) => {
  const { current, busy, failure, lastSave } = persistent;
  const home = homeDirectory(descriptor);

  return (
    <div className="ksave-popup">
      {current === null ? (
        <>
          <section className="ksave-section">
            <div className="ksave-label">This machine runs on memory</div>
            <p className="ksave-text">
              {home === null
                ? "This machine sets no home directory, so there is nothing here to save."
                : `Files under ${home} vanish when this tab closes.`}
            </p>
          </section>
          <section className="ksave-section">
            <button
              type="button"
              className="ksave-button ksave-button-primary"
              disabled={home === null || busy !== null}
              onClick={() => void persistent.save().catch(() => undefined)}
            >
              {busy === "saving" ? "Saving…" : "Save this machine"}
            </button>
            <p className="ksave-text">
              Saving copies {home ?? "the home directory"} into this browser's
              storage and restarts the machine on it. Running programs stop;
              the files carry over.
            </p>
          </section>
        </>
      ) : (
        <>
          <section className="ksave-section">
            <div className="ksave-label">Saved in this browser</div>
            <MachineNameField
              name={current.name}
              onRename={(name) => persistent.rename(current.id, name)}
            />
            <p className="ksave-text">
              {home} lives in this browser profile's storage on this device.
              Every write lands there as it happens; only this tab may run
              this machine at a time.
            </p>
          </section>
          {lastSave !== null && lastSave.skipped.length > 0 && (
            <section className="ksave-section">
              <div className="ksave-label">Not carried over</div>
              <p className="ksave-text">
                Browser storage holds regular files and directories only.
                These stayed behind:
              </p>
              <ul className="ksave-skipped">
                {lastSave.skipped.map((entry) => (
                  <li key={entry.path}>
                    <code>{entry.path}</code> ({describeKind(entry.kind)})
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="ksave-section">
            <button type="button" className="ksave-button" onClick={onOpenMachines}>
              Saved machines…
            </button>
          </section>
        </>
      )}
      {failure !== null && (
        <div className="ksave-failure" role="alert">{failure}</div>
      )}
    </div>
  );
};

const MachineNameField: React.FC<{
  name: string;
  onRename: (name: string) => void;
}> = ({ name, onRename }) => {
  const [draft, setDraft] = React.useState(name);
  React.useEffect(() => setDraft(name), [name]);
  const commit = () => {
    if (presentableMachineName(draft) === name) return;
    onRename(draft);
  };
  return (
    <label className="ksave-name">
      <span className="ksave-name-label">Name</span>
      <input
        className="ksave-name-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </label>
  );
};

function homeDirectory(descriptor: BootDescriptor): string | null {
  try {
    return homeDirectoryOf(descriptor);
  } catch {
    return null;
  }
}

function describeKind(kind: "symlink" | "other"): string {
  return kind === "symlink" ? "symbolic link" : "device, pipe, or socket";
}
