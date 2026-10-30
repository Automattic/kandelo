import * as React from "react";

export const PERSISTENCE_RELEASE_WARNING = "Saved computers from this release will not work in the next release. Export important files before updating Kandelo.";

export const PersistenceReleaseWarning: React.FC = () => (
  <aside className="kpersistence-release-warning" role="note" aria-label="Release compatibility warning">
    <strong>Experimental persistence — not upgradeable</strong>
    <span>{PERSISTENCE_RELEASE_WARNING}</span>
  </aside>
);
