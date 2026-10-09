// Saved machines — the list, with open, rename, and delete on each row.
import * as React from "react";
import type { PersistentMachines } from "./persistent-machines";
import type { PersistentMachine } from "../../../../../web-libs/kandelo-session/src/persistent-machine";

export const MachinesList: React.FC<{
  persistent: PersistentMachines;
  /** Open only, for the landing page: rename and delete stay in the Machines pane. */
  compact?: boolean;
}> = ({ persistent, compact = false }) => {
  const { machines, listFailure, current, keeping, savedElsewhere, busy, failure, saveFailure, skipped } = persistent;
  const [q, setQ] = React.useState("");

  if (listFailure !== null) {
    return (
      <div className="kmachines-failure" role="alert">
        The saved machine list in this browser could not be read: {listFailure}
      </div>
    );
  }

  const filtered = q
    ? machines.filter((m) => (m.name + " " + m.descriptor.title).toLowerCase().includes(q.toLowerCase()))
    : machines;

  return (
    <div className={compact ? "kmachines kmachines-compact" : "kgallery kmachines"}>
      {savedElsewhere !== null && (
        <p className="kmachines-elsewhere">
          This machine is {savedElsewhere}, saved on the other computer. Its changes are saved there.
        </p>
      )}
      {machines.length === 0 ? (
        <div className="kmachines-empty">
          <p>
            No saved machines in this browser yet.
            {savedElsewhere === null && (
              <>
                <br />
                Save the running machine with the Save this machine button.
              </>
            )}
          </p>
          <p>
            A saved machine keeps its home directory in this browser profile's
            storage, on this device only. Its programs are not saved: opening it
            boots the image again on the same files. Clearing this site's data
            deletes every saved machine.
          </p>
        </div>
      ) : (
        <>
          {!compact && (
            <div className="kgal-hdr">
              <div className="kgal-tools">
                <div className="kgal-search">
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--k-text-faint)" }}>
                    <circle cx="5.5" cy="5.5" r="3.2" />
                    <path d="M8 8l3 3" />
                  </svg>
                  <input
                    type="search"
                    placeholder="Filter..."
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <div className="kgal-count">
                  {filtered.length} of {machines.length}
                </div>
              </div>
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="kgal-empty">No machines match "{q}".</div>
          ) : (
            <div className="kgal-table-shell">
              <table className="kgal-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((machine) => (
                    <MachineRow
                      key={machine.id}
                      machine={machine}
                      compact={compact}
                      running={current?.id === machine.id}
                      elsewhere={keeping}
                      disabled={busy !== null}
                      onOpen={() => void persistent.open(machine).catch(() => undefined)}
                      onRename={(name) => persistent.rename(machine.id, name)}
                      onRemove={() => void persistent.remove(machine.id).catch(() => undefined)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {failure !== null && (
        <div className="kmachines-failure" role="alert">{failure}</div>
      )}
      {saveFailure !== null && (
        <div className="kmachines-failure" role="alert">
          The home directory was not saved: {saveFailure}
        </div>
      )}
      {skipped.length > 0 && (
        <div className="kmachines-failure" role="alert">
          A saved home keeps files, directories, and symbolic links. These
          devices, pipes, or sockets are not kept: {skipped.join(", ")}
        </div>
      )}
    </div>
  );
};

const MachineRow: React.FC<{
  machine: PersistentMachine;
  compact: boolean;
  running: boolean;
  /** The running machine runs on the other computer. */
  elsewhere: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}> = ({ machine, compact, running, elsewhere, disabled, onOpen, onRename, onRemove }) => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(machine.name);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const openable = !disabled && !running;

  const commitRename = () => {
    setEditing(false);
    if (draft !== machine.name) onRename(draft);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (openable) onOpen();
  };

  return (
    <tr
      className="kgal-row kmachines-row"
      data-current={running ? "true" : undefined}
      tabIndex={0}
      onClick={() => {
        if (openable && !editing) onOpen();
      }}
      onKeyDown={handleKeyDown}
      aria-label={`Open ${machine.name}`}
    >
      <td>
        {editing ? (
          <input
            className="kmachines-name-input"
            aria-label="Machine name"
            value={draft}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                setDraft(machine.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="kgal-machine-title-row">
            <span className="kgal-machine-title kmachines-name">{machine.name}</span>
            {!compact && (
              <button
                type="button"
                className="kmachines-rename"
                title={`Rename ${machine.name}`}
                aria-label={`Rename ${machine.name}`}
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  setDraft(machine.name);
                  setEditing(true);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                  <path d="M8.2 1.6l2.2 2.2-6.5 6.5-2.8.6.6-2.8z" />
                  <path d="M7 2.8l2.2 2.2" />
                </svg>
              </button>
            )}
            {running && (
              <span className="kgal-current-badge">
                {elsewhere ? "Running on the other computer" : "Running"}
              </span>
            )}
          </span>
        )}
      </td>
      <td className="kmachines-type">{machine.descriptor.title}</td>
      <td className="kgal-actions-cell">
        <div className="kgal-row-actions" onClick={(event) => event.stopPropagation()}>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="kgal-row-btn kmachines-btn-danger"
                disabled={disabled}
                onClick={() => {
                  setConfirmingDelete(false);
                  onRemove();
                }}
              >
                Confirm
              </button>
              <button
                type="button"
                className="kgal-row-btn"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : running ? null : (
            <>
              {!compact && (
                <button
                  type="button"
                  className="kgal-row-btn"
                  disabled={disabled}
                  title="Delete this machine"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                className="kgal-row-btn kgal-row-btn-primary"
                disabled={disabled}
                onClick={onOpen}
              >
                Open
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
};
