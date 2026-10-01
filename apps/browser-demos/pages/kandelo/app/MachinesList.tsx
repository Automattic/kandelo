// Saved machines — the list, with open, rename, and delete on each row.
import * as React from "react";
import type { PersistentMachines } from "./persistent-machines";
import type { PersistentMachine } from "../../../../../web-libs/kandelo-session/src/persistent-machine";

export const MachinesList: React.FC<{
  persistent: PersistentMachines;
  /** Fewer words per row, for the landing page. */
  compact?: boolean;
}> = ({ persistent, compact = false }) => {
  const { machines, listFailure, current, busy, failure } = persistent;

  if (listFailure !== null) {
    return (
      <div className="kmachines-failure" role="alert">
        The saved machine list in this browser could not be read: {listFailure}
      </div>
    );
  }

  return (
    <div className={`kmachines${compact ? " kmachines-compact" : ""}`}>
      {machines.length === 0 ? (
        <div className="kmachines-empty">
          No saved machines in this browser yet. Save the running machine from the
          dock's Save button.
        </div>
      ) : (
        <ul className="kmachines-list" aria-label="Saved machines">
          {machines.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              running={current?.id === machine.id}
              disabled={busy !== null}
              onOpen={() => void persistent.open(machine).catch(() => undefined)}
              onRename={(name) => persistent.rename(machine.id, name)}
              onRemove={() => void persistent.remove(machine.id).catch(() => undefined)}
            />
          ))}
        </ul>
      )}
      {failure !== null && (
        <div className="kmachines-failure" role="alert">{failure}</div>
      )}
      {!compact && (
        <p className="kmachines-note">
          A saved machine keeps its home directory in this browser profile's
          storage, on this device only. Its programs are not saved: opening it
          boots the image again on the same files. Clearing this site's data
          deletes every saved machine.
        </p>
      )}
    </div>
  );
};

const MachineRow: React.FC<{
  machine: PersistentMachine;
  running: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}> = ({ machine, running, disabled, onOpen, onRename, onRemove }) => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(machine.name);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  const commitRename = () => {
    setEditing(false);
    if (draft !== machine.name) onRename(draft);
  };

  return (
    <li className="kmachines-row" data-running={running ? "true" : undefined}>
      <div className="kmachines-main">
        {editing ? (
          <input
            className="kmachines-name-input"
            aria-label="Machine name"
            value={draft}
            autoFocus
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
          <button
            type="button"
            className="kmachines-name"
            title={`Open ${machine.name}`}
            disabled={disabled || running}
            onClick={onOpen}
          >
            {machine.name}
          </button>
        )}
        <div className="kmachines-meta">
          {machine.descriptor.title}
          {" · "}
          {running ? "running here" : `opened ${formatInstant(machine.openedAt)}`}
        </div>
      </div>
      <div className="kmachines-actions">
        {confirmingDelete ? (
          <>
            <button
              type="button"
              className="kmachines-btn kmachines-btn-danger"
              disabled={disabled}
              onClick={() => {
                setConfirmingDelete(false);
                onRemove();
              }}
            >
              Delete for good
            </button>
            <button
              type="button"
              className="kmachines-btn"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="kmachines-btn kmachines-btn-primary"
              disabled={disabled || running}
              onClick={onOpen}
            >
              {running ? "Running" : "Open"}
            </button>
            <button
              type="button"
              className="kmachines-btn"
              disabled={disabled}
              onClick={() => {
                setDraft(machine.name);
                setEditing(true);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="kmachines-btn"
              disabled={disabled || running}
              title={running ? "Halt this machine before deleting it" : "Delete this machine"}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
};

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
