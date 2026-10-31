import * as React from "react";
import { ActivityOfferForm } from "./ActivityForms";
import type { PackageSessionControls } from "./use-package-sessions";
import type { NetworkSession } from "./use-network-session";
import { randomSessionName } from "./session-name";
import { installedActivityChoices } from "./activity-launcher";

export const ActivitiesPanel: React.FC<{
  session: NetworkSession;
  activity: PackageSessionControls;
  running: boolean;
  openActivities: { id: string; title: string }[];
  stopping: boolean;
  stopError: string | null;
  onStop: (id: string) => void;
  onStarted: () => void;
}> = ({ session, activity, running, openActivities, stopping, stopError, onStop, onStarted }) => {
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const complete = () => { if (mounted.current) onStarted(); };
  const [name, setName] = React.useState(() => session.state.name ?? randomSessionName());
  const [filter, setFilter] = React.useState("");
  const [category, setCategory] = React.useState<"apps" | "shared">("apps");
  const [selection, setSelection] = React.useState<{ key?: string } | null>(null);
  const networkBusy = session.state.phase === "hosting" || session.state.phase === "joining";
  const blocked = !running || activity.busy || stopping;
  const matches = (...values: string[]) => values.join(" ").toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  const choices = installedActivityChoices(activity.catalog).filter(choice => matches(choice.type.title, choice.type.description, choice.entry.manifest.package));
  const imageChoices = activity.imageCatalog.filter(item => matches(item.title, item.summary, item.id))
    .sort((first, second) => first.title.localeCompare(second.title, "en", { sensitivity: "base" }) || first.id.localeCompare(second.id));
  return <section className="kcomputer-activities" aria-label="Installed activities">
    {!running && <p role="status">Start a computer to use its activities.</p>}
    {running && !activity.ready && !activity.error && <p role="status">Reading installed activity declarations…</p>}
    {stopError && <p role="alert">{stopError}</p>}
    {activity.error && <p role="alert">{activity.error}</p>}
    {activity.progress && <p role="status">{activity.progress}</p>}
    {openActivities.length > 0 && <div className="kactivity-open"><h4>Open activities</h4><ul>{openActivities.map(item => <li key={item.id}><span>{item.title}</span><button type="button" className="kshare-btn" disabled={blocked} onClick={() => onStop(item.id)}>Stop {item.title}</button></li>)}</ul></div>}
    {selection && <button type="button" className="kcomputer-back" disabled={blocked} onClick={() => setSelection(null)}>← {category === "apps" ? "Apps & tools" : "Group activities"}</button>}
    {!selection && <>
      <div className="kactivity-browse">
        <div role="group" aria-label="Activity categories">
          {([['apps', 'Apps & tools'], ['shared', 'Group activities']] as const).map(([value, title]) => <button type="button" className="kshare-btn" key={value} aria-pressed={category === value} onClick={() => { setCategory(value); setFilter(""); }}>{title}</button>)}
        </div>
        <input type="search" aria-label="Find activities" placeholder={category === "apps" ? "Find an app or tool…" : "Find a shared activity…"} value={filter} onChange={event => setFilter(event.target.value)} />
      </div>
      <div className="kactivity-list-heading">
        <p>{category === "apps" ? "Applications, games, and workspaces on this computer." : "Activities with other Kandelo computers. Start reuses your network session, or creates one, and provides a join link."}</p>
        {category === "shared" && <button type="button" className="kshare-btn" disabled={blocked || networkBusy} onClick={() => setSelection({})}>Set up a network session</button>}
      </div>
      <ul className="kactivity-list" aria-label={category === "apps" ? "Apps & tools" : "Group activities"}>
        {category === "apps" && imageChoices.map(item => <li className="kactivity-row" key={`image/${item.id}`} data-image-activity={item.id}>
          <div className="kactivity-description"><div className="kactivity-title"><h4>{item.title}</h4><span className="kactivity-kind">{item.launch.surface === "web" ? "Web" : item.launch.surface === "display" ? "Graphics" : "Terminal"}</span></div>
            <p>{item.summary}</p>{item.unavailable && <small>{item.unavailable}</small>}
          </div>
          <button type="button" className="kshare-btn kshare-btn-primary" disabled={blocked || !!item.unavailable} onClick={() => void activity.startImage(item.id).then(success => { if (success) complete(); })}>{item.launch.surface === "web" && item.command === ":" ? "Open" : "Start"}</button>
        </li>)}
        {category === "shared" && choices.map(choice => <li className="kactivity-row" key={choice.key} data-local-activity={choice.key}>
          <div className="kactivity-description"><div className="kactivity-title"><h4>{choice.type.title}</h4></div><p>{choice.type.description}</p></div>
          <div className="kactivity-row-actions">
            <button type="button" className="kshare-btn kshare-btn-primary" title="Start with other computers using the current network session, or create one" disabled={blocked || networkBusy} onClick={() => setSelection({ key: choice.key })}>Start</button>
          </div>
        </li>)}
      </ul>
      {activity.ready && !(category === "apps" ? imageChoices.length : choices.length) && <p>No activities match. Try another category or search.</p>}
    </>}
    {selection && <div className="kactivity-configure">
      {!session.available && <p role="status">No signalling server is configured. Apps &amp; tools remain available.</p>}
      {session.state.error && <p role="alert">{session.state.error}</p>}
      <ActivityOfferForm key={selection.key ?? "network"} initialSelection={selection.key} activity={activity} blocked={blocked || !session.available || networkBusy} name={name} setName={setName} session={session} onComplete={() => { complete(); session.setOpen(true); }} />
    </div>}
    {activity.busy && <button type="button" className="kshare-btn" onClick={activity.cancel}>Cancel preparation</button>}
  </section>;
};
