// Credits dialog, opened from the dock's More menu.
//
// Renders the shared credits list (web-libs/kandelo-session/src/credits.ts),
// the same list the docs site's Credits page renders.

import * as React from "react";
import { CREDITS, CREDITS_DEVELOPER } from "../../../../../web-libs/kandelo-session/src/credits";
import { useDialogDismiss } from "./use-dialog-dismiss";

export const CreditsDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const { close, ...dismiss } = useDialogDismiss(dialog, onClose);
  React.useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="kabout-dialog kcredits" aria-labelledby="kcredits-title" data-testid="credits-dialog" {...dismiss}>
    <header className="kpopin-heading"><h2 id="kcredits-title">Credits</h2><button type="button" autoFocus className="kshare-x" title="Close" aria-label="Close" onClick={close}>×</button></header>
    <p>
      Kandelo is developed by{" "}
      <a href={CREDITS_DEVELOPER.url} target="_blank" rel="noopener noreferrer">{CREDITS_DEVELOPER.name}</a>,
      with help from many open source projects. These have been the most
      helpful, and we are grateful to them.
    </p>
    {CREDITS.map((section) => (
      <section key={section.title}>
        <h3>{section.title}</h3>
        {section.intro && <p>{section.intro}</p>}
        <dl className="kcredits-list">
          {section.entries.map((entry) => (
            <React.Fragment key={entry.name}>
              <dt>
                <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.name}</a>
                {entry.by && <span className="kcredits-by"> · {entry.by}</span>}
              </dt>
              <dd>{entry.use}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
    ))}
  </dialog>;
};
