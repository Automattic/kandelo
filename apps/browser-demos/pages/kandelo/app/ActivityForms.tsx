import * as React from "react";
import { sessionDefaults, type SessionOffer, type SessionValues } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import { sessionPresentation, type SessionPresentation } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import { resolveDependencies } from "../../../../../web-libs/kandelo-session/src/session-dependencies";
import { activityRequiresHost } from "./activity-dependencies";
import type { DependencySelections } from "./activity-dependencies";
import type { PackageSessionControls } from "./use-package-sessions";
import type { NetworkSession } from "./use-network-session";
import { SessionFields } from "./SessionFields";
import { useActivityLevels } from "./use-activity-levels";

const NO_FIELDS: [] = [];
const NO_DEPENDENCIES: [] = [];

export function ActivityMetadata({ activity, invited = false }: { activity: PackageSessionControls; invited?: boolean }) {
  const offer = invited ? activity.invited : activity.offered;
  if (!offer) return <p className="knetwork-note">Shared network · no activity selected</p>;
  const manifest = activity.catalog.find(entry => entry.manifest.package === offer.package)?.manifest;
  const type = manifest?.offers.find(type => type.id === offer.offer);
  const verified = invited ? activity.invitation : null;
  const presentation = invited ? verified ? sessionPresentation(verified.manifest, verified.type, offer) : offer.presentation
    : manifest && type ? sessionPresentation(manifest, type, offer) : offer.presentation;
  return <InvitationMetadata offer={offer} presentation={presentation} invited={invited} />;
}

export function InvitationMetadata({ offer, presentation = offer?.presentation, invited = true }: {
  offer?: SessionOffer | null; presentation?: SessionPresentation; invited?: boolean;
}) {
  if (!offer) return <p className="knetwork-note">Shared network · no activity selected</p>;
  const settings = presentation?.settings ?? Object.entries(offer.values).map(([id, value]) => ({ id, label: id, value }));
  return <div className="knetwork-metadata">
    <div className="kshare-sect-lbl">{presentation?.title ?? `${offer.package} · ${offer.offer}`}</div>
    {invited && settings.length > 0 && <div className="kshare-sect-lbl">Host setup</div>}
    <dl className="knetwork-details">{settings.map(setting => <React.Fragment key={setting.id}>
      <dt>{setting.label}</dt><dd>{setting.value}</dd>
    </React.Fragment>)}</dl>
    {presentation?.warnings?.map(warning => <p className="knetwork-note" data-activity-warning key={warning}>{warning}</p>)}
    <details className="knetwork-note"><summary>About this activity</summary>
      <p>{presentation?.description}</p><p>{offer.package} {offer.packageVersion}</p>
    </details>
  </div>;
}

export function ActivityOfferForm({ activity, blocked, name, setName, session, onComplete, replaceSession = false }: {
  activity: PackageSessionControls; blocked: boolean; name: string; setName: (name: string) => void; session: NetworkSession; onComplete: () => void; replaceSession?: boolean;
}) {
  const [selected, setSelected] = React.useState("");
  const [values, setValues] = React.useState<SessionValues>({});
  const [existing, setExisting] = React.useState(false);
  const [replace, setReplace] = React.useState(replaceSession);
  const [selections, setSelections] = React.useState<DependencySelections>({});
  const [delivery, setDelivery] = React.useState<"peer" | "hint">("peer");
  const connected = session.state.phase === "connected";
  const choices = activity.catalog.flatMap(entry => entry.manifest.offers.filter(type => !entry.clientOnly && !entry.unavailableOffers?.includes(type.id)).map(type => ({ entry, type, key: `${entry.manifest.package}/${type.id}` })))
    .sort((a, b) => a.type.title.localeCompare(b.type.title, "en", { sensitivity: "base" }) || a.key.localeCompare(b.key));
  const choice = choices.find(choice => choice.key === selected);
  const dependencies = choice?.entry.manifest.dependencies ?? NO_DEPENDENCIES;
  const levelChoices = useActivityLevels(choice?.type.fields ?? NO_FIELDS, dependencies, selections, values, setValues);
  const guestHosting = connected && session.state.snapshot?.state === "joined" && !!choice && activityRequiresHost(choice.entry.manifest, choice.type) && !replace;
  return <form aria-label="Host activity" onSubmit={event => {
    event.preventDefault();
    void activity.offer(choice?.entry ?? null, choice?.type.id ?? "", values, existing || !!choice && !choice.type.launch, name, connected && replace, selections, delivery).then(success => { if (success) onComplete(); });
  }}>
    {connected && !replaceSession && <label className="knetwork-field">Session
      <select aria-label="Session" value={replace ? "replace" : "keep"} disabled={blocked} onChange={e => setReplace(e.target.value === "replace")}>
        <option value="keep">Keep current session</option><option value="replace">Replace current session</option>
      </select>
    </label>}
    {connected && replace && session.state.snapshot?.state === "hosting" && <p className="knetwork-note">Replacing this room disconnects its guests.</p>}
    {(!connected || replace) && <label className="knetwork-field">Session name
      <input value={name} maxLength={64} onChange={e => setName(e.target.value)} disabled={blocked} />
    </label>}
    <label className="knetwork-field">Activity (optional)
      <select aria-label="Activity" value={selected} disabled={blocked || !activity.ready} onChange={event => {
        const next = choices.find(choice => choice.key === event.target.value);
        setSelected(event.target.value); setValues(next ? sessionDefaults(next.type.fields) : {}); setExisting(!!next && !next.type.launch); setSelections({});
      }}>
        <option value="">No activity — just join the network</option>
        {choices.map(choice => <option key={choice.key} value={choice.key}>{choice.type.title}</option>)}
      </select>
    </label>
    {choice && <>
      {choice.type.warning && <p className="knetwork-note" data-activity-warning>{choice.type.warning}</p>}
      {connected && activity.offered && !existing && choice.type.launch && <p className="knetwork-note">Replaces the current activity.</p>}
      <SessionFields fields={choice.type.fields.filter(field => field.type !== "level")} values={values} onChange={setValues} disabled={blocked} />
      {choice.type.attachExisting && choice.type.launch && <label className="knetwork-field">
        <span><input type="checkbox" checked={existing} disabled={blocked} onChange={event => setExisting(event.target.checked)} /> Already running</span>
      </label>}
      {dependencies.map(dependency => {
        const selected = selections[dependency.id]?.source ?? dependency.sources[0]?.id ?? "file";
        const source = dependency.sources.find(source => source.id === selected);
        const warning = selected === "file" ? dependency.fileWarning : source?.warning;
        return <div key={dependency.id}>
        <label className="knetwork-field">{dependency.title}
          <select aria-label={dependency.title} value={selections[dependency.id]?.source ?? dependency.sources[0]?.id ?? "file"} disabled={blocked}
            onChange={e => {
              setSelections({ ...selections, [dependency.id]: { source: e.target.value } });
              const defaults = dependency.sources.find(source => source.id === e.target.value)?.offerDefaults;
              if (defaults) setValues({ ...values, ...defaults });
            }}>
            {dependency.sources.map(source => <option key={source.id} value={source.id}>{source.title} ({(source.size / 1048576).toFixed(1)} MiB)</option>)}
            {dependency.allowFile && <option value="file">Choose a local file…</option>}
          </select>
        </label>
        {(selections[dependency.id]?.source === "file" || !dependency.sources.length) && <label className="knetwork-field">File for {dependency.title}
          <input type="file" disabled={blocked} onChange={e => setSelections({ ...selections, [dependency.id]: { source: "file", file: e.target.files?.[0] } })} />
        </label>}
        {selected === "file" && <p className="knetwork-note">{dependency.hint}</p>}
        {warning && <p className="knetwork-note" data-activity-warning>{warning}</p>}
        {source?.informationUrl && <a className="knetwork-note" target="_blank" rel="noreferrer" href={source.informationUrl}>About this data</a>}
      </div>;
      })}
      <SessionFields fields={choice.type.fields.filter(field => field.type === "level")} values={values} onChange={setValues} disabled={blocked} levels={levelChoices.levels} sources={Object.fromEntries(dependencies.map(d => [d.id, selections[d.id]?.source ?? d.sources[0]?.id ?? "file"]))} />
      {existing && choice.type.existingWarning && <p className="knetwork-note" data-activity-warning>{choice.type.existingWarning}</p>}
      {levelChoices.errors.map(error => <p className="knetwork-error" role="alert" key={error}>{error}</p>)}
      {dependencies.length > 0 && <label className="knetwork-field">Guest data
        <select aria-label="Guest data" value={delivery} disabled={blocked} onChange={e => setDelivery(e.target.value as "peer" | "hint")}>
          <option value="peer">Send files to guests</option>
          <option value="hint">Guests get their own copy</option>
        </select>
      </label>}
    </>}
    {guestHosting && <p className="knetwork-note">Choose Replace current session to host this activity.</p>}
    {choice && <details className="knetwork-note"><summary>About this activity</summary>{choice.type.description}</details>}
    <button className="kshare-btn kshare-btn-primary" disabled={blocked || guestHosting || !levelChoices.ready}>{activity.busy ? "Preparing invitation…" : choice ? existing || !choice.type.launch ? "Share running activity" : "Start and invite" : "Create invite"}</button>
  </form>;
}

export function ActivityJoinForm({ activity, blocked, room, dismiss, joinNetworkOnly }: {
  activity: PackageSessionControls; blocked: boolean; room: string; dismiss: () => void; joinNetworkOnly?: () => void;
}) {
  const invitation = activity.invitation;
  const [selections, setSelections] = React.useState<DependencySelections>({});
  const [values, setValues] = React.useState<SessionValues>(() => sessionDefaults(activity.invited?.presentation?.join.fields ?? []));
  React.useEffect(() => { if (invitation) setValues(sessionDefaults(invitation.join.fields)); }, [invitation?.join.id, invitation?.manifest.package]);
  if (activity.ready && !invitation) return <div>
    {/* The session notice above is the one alert; this explains it. */}
    <p className="knetwork-note">{activity.invitationError ?? "This activity is unavailable on this computer."}</p>
    {joinNetworkOnly && <button type="button" className="kshare-btn" disabled={blocked} onClick={joinNetworkOnly}>Join network only</button>}
    <button type="button" className="kshare-btn" onClick={dismiss}>Dismiss</button>
  </div>;
  const presentation = invitation && activity.invited ? sessionPresentation(invitation.manifest, invitation.type, activity.invited) : activity.invited?.presentation;
  if (!presentation || !activity.invited) return <p className="knetwork-note">Activity details will appear after startup.</p>;
  const dependencies = invitation ? resolveDependencies(invitation.manifest.dependencies ?? [], activity.invited.dependencies ?? []) : [];
  const missingFile = dependencies.some(d => d.content.delivery === "hint" && !d.source && !selections[d.dependency.id]?.file);
  return <JoinActivityForm offer={activity.invited} presentation={presentation} room={room} values={values} setValues={setValues}
    blocked={blocked || !invitation} verified={!!invitation} missingFile={missingFile} selections={selections} setSelections={setSelections}
    onJoin={() => void activity.join(values, selections)} dismiss={dismiss} />;
}

/** A room member chooses an advertised join, not a local hosting recipe. */
export function ActivityClientForm({ activity, session, blocked, onComplete }: {
  activity: PackageSessionControls; session: NetworkSession; blocked: boolean; onComplete: () => void;
}) {
  const choices = [...activity.remoteChoices].sort((a, b) =>
    (a.presentation?.title ?? a.offer).localeCompare(b.presentation?.title ?? b.offer, "en", { sensitivity: "base" }));
  const key = (offer: SessionOffer) => `${offer.package}/${offer.offer}`;
  const selected = activity.invited && choices.some(offer => key(offer) === key(activity.invited!)) ? key(activity.invited) : "";
  return <div className="knetwork-client-activity">
    <label className="knetwork-field">Activity (optional)
      <select aria-label="Activity" value={selected} disabled={blocked || !activity.ready || session.state.remoteActivities == null} onChange={event => activity.selectRemote(choices.find(offer => key(offer) === event.target.value) ?? null)}>
        <option value="">{activity.offered ? "Keep current activity" : "No activity — stay on the network"}</option>
        {choices.map(offer => <option value={key(offer)} key={key(offer)}>{offer.presentation?.title ?? `${offer.package} · ${offer.offer}`}</option>)}
      </select>
    </label>
    {session.state.activityError ? <p className="knetwork-error" role="alert">{session.state.activityError}</p>
      : session.state.remoteActivities == null ? <p className="knetwork-note" role="status">Waiting for the host’s activities…</p>
      : !choices.length && <p className="knetwork-note">No other shared activities.</p>}
    {selected ? <>
      <ActivityMetadata activity={activity} invited />
      <ActivityJoinForm key={selected} activity={activity} blocked={blocked} room={session.state.name ?? "Network session"} dismiss={() => activity.selectRemote(null)} />
    </> : <button className="kshare-btn kshare-btn-primary" disabled={blocked} onClick={onComplete}>Keep current session</button>}
  </div>;
}

/** Render the same informational form before and after installed metadata is ready. */
export function JoinActivityForm({ offer, presentation, room, values, setValues, blocked, verified = false, missingFile = false, selections = {}, setSelections = () => {}, onJoin = () => {}, dismiss }: {
  offer: SessionOffer; presentation: SessionPresentation; room: string; values: SessionValues;
  setValues: (values: SessionValues) => void; blocked: boolean; verified?: boolean; missingFile?: boolean;
  selections?: DependencySelections; setSelections?: (selections: DependencySelections) => void; onJoin?: () => void; dismiss: () => void;
}) {
  return <form aria-label="Join activity" onSubmit={event => { event.preventDefault(); if (verified && !blocked && !missingFile) onJoin(); }}>
    <SessionFields fields={presentation.join.fields} values={values} onChange={setValues} disabled={blocked} />
    {presentation.dependencies.map(dependency => {
      const content = offer.dependencies?.find(content => content.id === dependency.id);
      if (!content) return null;
      return <div key={dependency.id}>
        <div className="kshare-sect-lbl">{content.name}</div>
        <p className="knetwork-note">{(content.size / 1048576).toFixed(1)} MiB · {content.delivery === "peer" ? "Receive from host" : "Get a matching copy"}</p>
        {!dependency.source && content.delivery === "hint" && <p className="knetwork-note">{dependency.hint}</p>}
        {dependency.source && (verified ? <a href={dependency.source.url} target="_blank" rel="noreferrer">Get {dependency.source.title}</a> : <p className="knetwork-note">Source: {dependency.source.title}</p>)}
        <details className="knetwork-note" open={!dependency.source && content.delivery === "hint"}>
        <summary>{dependency.source || content.delivery === "peer" ? "Use a local file" : "Choose a file"}</summary>
        <label className="knetwork-field">{dependency.source || content.delivery === "peer" ? "Use a local file instead (optional)" : `File for ${dependency.title}`}
          <input type="file" disabled={blocked} onChange={e => setSelections({ ...selections, [dependency.id]: { source: "file", file: e.target.files?.[0] } })} />
        </label>
        <code className="knetwork-note" style={{ overflowWrap: "anywhere" }}>SHA-256: {content.sha256}</code>
        </details>
      </div>;
    })}
    <div className="knetwork-actions">
      <button className="kshare-btn kshare-btn-primary" disabled={blocked || !verified || missingFile}>Join and {presentation.join.title[0].toLowerCase() + presentation.join.title.slice(1)}</button>
      <button type="button" className="kshare-btn" disabled={verified && blocked} onClick={dismiss}>Dismiss</button>
    </div>
  </form>;
}
