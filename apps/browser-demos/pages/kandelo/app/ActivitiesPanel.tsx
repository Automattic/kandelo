import * as React from "react";
import type { PackageSessionControls } from "./use-package-sessions";
import type { NetworkSession } from "./use-network-session";
import { activityCatalog, canLaunchLocally } from "./activity-launcher";
import { sessionDefaults } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import type { ActivityCategory } from "../../../../../web-libs/kandelo-session/src/demo-config";

const categories = { apps: "Apps & Tools", services: "Services", demos: "Demos" } as const;
const descriptions = {
  apps: "Applications, games, and tools on this computer.",
  services: "Websites, databases, and other services on this computer.",
  demos: "Try video, sound, graphics, and other examples.",
};

export const ActivitiesPanel: React.FC<{
  session: NetworkSession;
  activity: PackageSessionControls;
  running: boolean;
  onStarted: () => void;
  onShare: (selection: string, imageId?: string) => void;
}> = ({ session, activity, running, onStarted, onShare }) => {
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const complete = (success: boolean | undefined) => { if (success && mounted.current) onStarted(); };
  const [filter, setFilter] = React.useState("");
  const [category, setCategory] = React.useState<ActivityCategory>("apps");
  const networkBusy = session.state.phase === "hosting" || session.state.phase === "joining";
  const blocked = !running || activity.busy;
  const rows = activityCatalog(activity.imageCatalog, activity.catalog).filter(row => row.category === category
    && `${row.title} ${row.summary}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  return <section className="kcomputer-activities" aria-label="Installed activities">
    {!running && <p role="status">Start a computer to use its activities.</p>}
    {running && !activity.ready && !activity.error && <p role="status">Reading installed activity declarations…</p>}
    {activity.error && <p role="alert">{activity.error}</p>}
    {activity.progress && <p role="status">{activity.progress}</p>}
    <div className="kactivity-browse">
      <div role="group" aria-label="Activity categories">
        {(Object.entries(categories) as [ActivityCategory, string][]).map(([value, title]) => <button type="button" className="kshare-btn" key={value} aria-pressed={category === value} onClick={() => { setCategory(value); setFilter(""); }}>{title}</button>)}
      </div>
      <input type="search" aria-label="Find activities" placeholder="Find an activity…" value={filter} onChange={event => setFilter(event.target.value)} />
    </div>
    <div className="kactivity-list-heading"><p>{descriptions[category]}</p></div>
    <div className="kactivity-content" key={category}>
      <ul className="kactivity-list" aria-label={categories[category]}>
        {rows.map(row => {
          const { image, choice } = row;
          const canStart = image !== undefined || choice !== undefined && canLaunchLocally(choice.type);
          return <li className="kactivity-row" key={row.id} data-image-activity={image?.id} data-local-activity={choice?.key}>
            <div className="kactivity-description"><div className="kactivity-title"><h4>{row.title}</h4></div>
              <p>{row.summary}</p>{image?.unavailable && <small>{image.unavailable}</small>}
            </div>
            <div className="kactivity-row-actions">
              {choice && <button type="button" className="kshare-btn" title="Connect Kandelo computers for this activity" disabled={blocked || networkBusy || !!image?.unavailable} onClick={() => onShare(choice.key, image?.id)}>Network...</button>}
              {canStart && <button type="button" className="kshare-btn kshare-btn-primary" disabled={blocked || !!image?.unavailable} onClick={() => {
                const operation = image ? activity.startImage(image.id)
                  : activity.startLocal(choice!.entry, choice!.type.id, sessionDefaults(choice!.type.fields));
                void operation.then(complete);
              }}>Start</button>}
            </div>
          </li>;
        })}
      </ul>
      {activity.ready && rows.length === 0 && <p>No activities match. Try another category or search.</p>}
    </div>
    {activity.busy && <button type="button" className="kshare-btn" onClick={activity.cancel}>Cancel preparation</button>}
  </section>;
};
