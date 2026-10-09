// Save button — the top right of the Machines pane. It saves the running
// machine in this browser while the machine keeps running.
import * as React from "react";
import type { PersistentMachines } from "./persistent-machines";

export const SaveButton: React.FC<{
  /** The login session's home directory, or null when the host cannot name it. */
  home: string | null;
  persistent: PersistentMachines;
}> = ({ home, persistent }) => {
  const { current, savedElsewhere, busy } = persistent;
  if (current !== null || savedElsewhere !== null) return null;

  return (
    <button
      type="button"
      className="ksave-button"
      disabled={home === null || busy !== null}
      title={home === null
        ? "This machine sets no home directory, so there is nothing to save."
        : `Keep the files under ${home} in this browser's storage.`}
      onClick={() => void persistent.save().catch(() => undefined)}
    >
      {busy === "saving" ? "Saving…" : "Save this machine"}
    </button>
  );
};
