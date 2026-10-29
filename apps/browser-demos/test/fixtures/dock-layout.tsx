import * as React from "react";
import { createRoot } from "react-dom/client";
import { Dock, type DockViewId } from "../../pages/kandelo/app/Dock";

const query = new URLSearchParams(location.search);
const noop = () => {};

function Fixture() {
  const [view, setView] = React.useState<DockViewId>("demo");
  const [internalsOpen, setInternalsOpen] = React.useState(false);
  return <>
    <output data-testid="view">{view}</output>
    <Dock
      minimal={query.has("minimal")}
      activePane={null}
      activeView={view}
      internalsPopup={<div>Internals popup</div>}
      themePopup={query.has("theme") ? undefined : <div>Theme popup</div>}
      guideAvailable={false}
      guideOpen={false}
      internalsAvailable
      internalsOpen={internalsOpen}
      themeOpen={false}
      shareAvailable={false}
      status="running"
      onSelectPane={noop}
      onSelectView={setView}
      onToggleGuide={noop}
      onToggleInternals={() => setInternalsOpen((open) => !open)}
      onToggleTheme={noop}
      onOpenShare={noop}
      onCloseGuide={noop}
      onCloseInternals={() => setInternalsOpen(false)}
      onCloseTheme={noop}
      onHeightChange={noop}
    />
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
