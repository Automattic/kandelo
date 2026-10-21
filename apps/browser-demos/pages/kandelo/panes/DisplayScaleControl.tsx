import * as React from "react";

export function DisplayScaleControl({ preference, onChange }: {
  preference: { defaultScale: number | null; override: number | null };
  onChange: (scale: number | null) => void;
}) {
  const id = React.useId();
  const [anchor, setAnchor] = React.useState({ right: 12, bottom: 100 });
  return <>
    <button type="button" className="kdemo-surface-action" popoverTarget={id}
      onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setAnchor({ right: Math.max(12, window.innerWidth - rect.right),
          bottom: window.innerHeight - rect.top + 8 });
      }}>Display settings</button>
    {/* The native popover's top layer escapes the dock's scrolling clip and
        provides outside-click/Escape dismissal without capturing guest input. */}
    <div id={id} popover="auto" className="kdisplay-settings-panel" style={anchor}>
      <label>
        Preferred display scale
        <select aria-label="Preferred display scale" value={preference.override ?? "default"}
          onChange={event => onChange(event.target.value === "default" ? null : Number(event.target.value))}>
          <option value="default">Use demo default ({preference.defaultScale === null ? "native" : `${preference.defaultScale * 100}%`})</option>
          {[1, 1.25, 1.5, 1.75, 2].map(scale => <option key={scale} value={scale}>{scale * 100}%</option>)}
        </select>
      </label>
      <p>The whole display always fits this pane. Sets the preferred UI size for newly started apps. An app may keep its own resolution; use its display options if the size does not change.</p>
      <p>Kept for this machine session, including restarts. Resets when you reload the page.</p>
    </div>
  </>;
}
