import { resolveDependencies, verifyDependency } from "../../../../../web-libs/kandelo-session/src/session-dependencies";
import { selectedDependency, localDependency, fetchActivityDependency, activityRequiresHost, type DependencySelections } from "./activity-dependencies";
import * as React from "react";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  loadPackageSessions, resolveSessionOffer, sessionCommand, validateSessionValues, validateSessionLevels,
  type SessionLaunch, type InstalledPackageSessions, type SessionOffer, type SessionValues,
} from "../../../../../web-libs/kandelo-session/src/package-sessions";
import { sessionPresentation } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import { encodeSessionInvitation } from "../../../../../web-libs/kandelo-session/src/session-invitation";
import type { NetworkSession } from "./use-network-session";
import type { SessionTransfer } from "./SessionNotice";
import { readGameLevels } from "../../../../../web-libs/kandelo-session/src/game-levels";
import { activityPorts, canLaunchLocally } from "./activity-launcher";
import type { ImageActivity } from "../../../../../web-libs/kandelo-session/src/image-activities";

export function usePackageSessions(
  host: KernelHost, network: NetworkSession,
  launch: (command: string, title: string, assertCurrent: () => void, procedure: SessionLaunch, identity: string, ports?: number[]) => Promise<void>,
  clientImageUrl?: string,
) {
  const [catalog, setCatalog] = React.useState<InstalledPackageSessions[]>([]);
  const [imageCatalog, setImageCatalog] = React.useState<ImageActivity[]>([]);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [offered, setOffered] = React.useState<SessionOffer | null>(null);
  const [selectedRemote, setSelectedRemote] = React.useState<SessionOffer | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [transfer, setTransfer] = React.useState<SessionTransfer | null>(null);
  const [copySequence, setCopySequence] = React.useState(0);
  const [copyResult, setCopyResult] = React.useState<{ link: string | null; status: "idle" | "copied" | "blocked" }>({ link: null, status: "idle" });
  const copyLink = async (link: string | null) => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopyResult({ link, status: "copied" }); setCopySequence(value => value + 1); }
    catch { setCopyResult({ link, status: "blocked" }); }
  };
  const operationAbort = React.useRef<AbortController | null>(null);
  const cancel = () => operationAbort.current?.abort();
  const generation = React.useRef(0);
  const locked = React.useRef(false);

  React.useEffect(() => {
    let disposed = false;
    const load = () => {
      operationAbort.current?.abort();
      const current = ++generation.current;
      setReady(false); setCatalog([]); setImageCatalog([]); setOffered(null); setError(null);
      if (host.getStatus() !== "running") return;
      void Promise.all([loadPackageSessions(host), host.imageActivities?.list() ?? Promise.resolve([])]).then(([entries, imageEntries]) => {
        if (!disposed && generation.current === current) { setCatalog(entries); setImageCatalog(imageEntries); setReady(true); }
      }, err => {
        if (!disposed && generation.current === current) setError(String(err));
      });
    };
    load();
    const off = host.subscribeStatus(load);
    return () => { operationAbort.current?.abort(); disposed = true; generation.current++; off(); };
  }, [host]);
  React.useEffect(() => {
    if (network.state.phase === "offline" || network.state.roomClosed) { setOffered(null); setSelectedRemote(null); }
  }, [network.state.phase, network.state.roomClosed]);
  React.useEffect(() => {
    if (selectedRemote && !(network.state.remoteActivities ?? []).some(offer => JSON.stringify(offer) === JSON.stringify(selectedRemote))) setSelectedRemote(null);
  }, [network.state.remoteActivities, selectedRemote]);

  React.useEffect(() => {
    if (!ready || network.state.phase !== "connected" || network.state.snapshot?.state !== "hosting") return;
    const advertised: SessionOffer[] = offered ? [offered] : [];
    // Services started by an image can advertise their other join surfaces
    // (e.g. website and SQL). Installed but unstarted games are not sessions.
    for (const entry of catalog) if (!entry.clientOnly) for (const type of entry.manifest.offers) {
      if (type.launch || !type.attachExisting || type.fields.length || entry.manifest.dependencies?.length
        || entry.unavailableOffers?.includes(type.id) || advertised.some(offer => offer.package === entry.manifest.package && offer.offer === type.id)) continue;
      const offer: SessionOffer = { version: 1, package: entry.manifest.package, packageVersion: entry.manifest.packageVersion,
        manifestSha256: entry.sha256, procedureSha256: entry.procedureSha256?.[type.id], offer: type.id, values: {} };
      offer.presentation = sessionPresentation(entry.manifest, type, offer);
      advertised.push(offer);
    }
    try { network.publishActivities(advertised); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [ready, catalog, offered, network.state.phase, network.state.room, network.state.snapshot?.state]);

  const run = async (operation: (assertCurrent: () => void, signal: AbortSignal) => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null); setTransfer(null); setProgress(null);
    const abort = new AbortController(); operationAbort.current = abort;
    const timeout = setTimeout(() => abort.abort(), 120_000);
    const current = generation.current;
    const assertCurrent = () => {
      if (abort.signal.aborted) throw new Error("Activity preparation cancelled");
      if (generation.current !== current || host.getStatus() !== "running") throw new Error("The activity's computer was replaced or stopped");
    };
    try { await operation(assertCurrent, abort.signal); return true; }
    catch (err) { if (generation.current === current) setError(err instanceof Error ? err.message : String(err)); return false; }
    finally { clearTimeout(timeout); operationAbort.current = null; locked.current = false; setBusy(false); setProgress(null); setTransfer(null); }
  };
  const offer = (entry: InstalledPackageSessions | null, id: string, values: SessionValues, existing: boolean, name: string,
    replace = false, selections: DependencySelections = {}, delivery: "peer" | "hint" = "peer", local = false) => run(async (assertCurrent, signal) => {
    const initialRoom = !local && network.getState().phase === "connected" ? network.getState().room : null;
    const assertPreparing = () => {
      assertCurrent();
      if (initialRoom && (network.getState().phase !== "connected" || network.getState().room !== initialRoom)) throw new Error("The session ended while preparing the invitation");
    };
    if (entry?.clientOnly) throw new Error("This computer has the client procedure, but no installed hosting procedure");
    const type = entry?.manifest.offers.find(type => type.id === id);
    if (entry && !type) throw new Error("Unknown activity");
    if (local && (!type || !canLaunchLocally(type) || existing)) throw new Error("This activity does not declare a local launch procedure");
    if (type) {
      validateSessionValues(type.fields, values);
      if (existing && !type.attachExisting) throw new Error("This activity must be configured before starting");
      for (const path of type.hostRequires ?? []) if (!(await host.stat(path))) throw new Error(`This activity requires an installed service: ${path}`);
      if (type.launch && type.launch.surface !== "web" && !(await host.stat(type.launch.executable))) throw new Error(`This activity requires an installed program: ${type.launch.executable}`);
    }
    const requiresHost = entry && type ? activityRequiresHost(entry.manifest, type) : false;
    if (requiresHost && !replace && initialRoom && (await host.remoteNetworkSnapshot()).state === "joined") throw new Error("This activity requires the room’s hosting computer. Choose Restart network session to host it yourself.");
    assertPreparing();
    // Prepare data before disrupting an existing room, so a cancelled picker or
    // failed download does not disconnect the people already there.
    const prepared = [];
    for (const dependency of entry?.manifest.dependencies ?? []) {
      setProgress(`Preparing ${dependency.title}…`);
      prepared.push({ dependency, ...await selectedDependency(host, dependency, selections[dependency.id], delivery, signal) });
      assertPreparing();
    }
    if (type) {
      validateSessionLevels(type.fields, values, prepared.map(p => p.content));
      for (const field of type.fields) if (field.type === "level") {
        const data = prepared.find(p => p.dependency.id === field.dependency);
        if (data && !data.content.source && !readGameLevels(data.bytes, field.format).includes(String(values[field.id]))) throw new Error("The selected starting level is not in the uploaded game data");
      }
    }
    if (type?.launch && type.launch.surface !== "web" && !existing) for (const path of type.launch.requires) {
      if (!(entry?.manifest.dependencies ?? []).some(d => d.path === path) && !(await host.stat(path))) throw new Error(`This activity requires an installed file: ${path}`);
    }
    assertPreparing();
    const next: SessionOffer | null = entry && type ? { version: 1, package: entry.manifest.package, packageVersion: entry.manifest.packageVersion, manifestSha256: entry.sha256, procedureSha256: entry.procedureSha256?.[id], offer: id, values: { ...values }, ...(prepared.length ? { dependencies: prepared.map(p => p.content) } : {}) } : null;
    if (next && entry && type) next.presentation = sessionPresentation(entry.manifest, type, next);
    if (next && !local) encodeSessionInvitation(next); // Fail before replacing a room or starting software if the display snapshot exceeds the URL limit.
    if (local && type?.launch) {
      setOffered(null);
      for (const { dependency, bytes } of prepared) { await host.writeFile(dependency.path, bytes, 0o644); assertCurrent(); }
      setProgress("Starting activity…");
      await launch(type.launch.surface === "web" ? "" : sessionCommand(type, null, values, {}, prepared.map(item => item.content)), type.title, assertCurrent, type.launch, `${entry!.manifest.package}/${type.id}`, activityPorts(entry!, type));
      assertCurrent();
      return;
    }
    if (replace && network.getState().room) { await network.leave(); assertCurrent(); }
    if (!network.getState().link) { await network.create(name); assertCurrent(); }
    const room = network.getState().room;
    const assertSessionCurrent = () => {
      assertCurrent();
      const state = network.getState();
      if (!room || state.phase !== "connected" || state.room !== room) throw new Error("The network session ended before the invitation was ready");
    };
    assertSessionCurrent();
    if (type) {
      const snapshot = await host.remoteNetworkSnapshot();
      if (snapshot.state !== "hosting" && (requiresHost || snapshot.state !== "joined")) throw new Error("The activity’s network did not start");
    }
    assertSessionCurrent();
    for (const { dependency, bytes } of prepared) { await host.writeFile(dependency.path, bytes, 0o644); assertSessionCurrent(); }
    if (type?.launch && !existing) { await launch(type.launch.surface === "web" ? "" : sessionCommand(type, null, values, {}, prepared.map(p => p.content)), type.title, assertSessionCurrent, type.launch, `${entry!.manifest.package}/${type.id}`, activityPorts(entry!, type)); assertSessionCurrent(); }
    network.publishDependencies(new Map(prepared.filter(p => p.content.delivery === "peer").map(p => [p.content.sha256, p.bytes])));
    setOffered(next);
    await copyLink(invitationLink(network.getState().link, next));
  });

  // Display-only edits do not make the activity someone already joined a
  // new destination. Changed settings or data do (e.g. a new server port).
  const remoteChoices = (network.state.remoteActivities ?? []).filter(next => !offered
    || next.package !== offered.package || next.packageVersion !== offered.packageVersion || next.offer !== offered.offer
    || (next.procedureSha256 && offered.procedureSha256 ? next.procedureSha256 !== offered.procedureSha256 : next.manifestSha256 !== offered.manifestSha256)
    || Object.keys(next.values).length !== Object.keys(offered.values).length
    || Object.entries(next.values).some(([key, value]) => offered.values[key] !== value)
    || (next.dependencies ?? []).length !== (offered.dependencies ?? []).length
    || (next.dependencies ?? []).some(dependency => !(offered.dependencies ?? []).some(current =>
      current.id === dependency.id && current.sha256 === dependency.sha256 && current.size === dependency.size && current.source === dependency.source)));

  const invited = network.invitation?.offer ?? selectedRemote;
  const target = network.invitation ?? (selectedRemote && network.state.room
    ? { room: network.state.room, name: network.state.name ?? "Network session", offer: selectedRemote } : null);
  let invitation: ReturnType<typeof resolveSessionOffer> | null = null;
  let invitationError: string | null = null;
  if (ready && invited) {
    try { invitation = resolveSessionOffer(catalog, invited); }
    catch (err) { invitationError = err instanceof Error ? err.message : String(err); }
  }
  const join = (values: SessionValues, selections: DependencySelections = {}) => run(async (assertCurrent, signal) => {
    if (!invited || !invitation || !target) throw new Error("No compatible activity invitation");
    const assertAdvertised = () => {
      if (selectedRemote && !(network.getState().remoteActivities ?? []).some(offer => JSON.stringify(offer) === JSON.stringify(invited))) throw new Error("The host changed this activity. Choose its current activity before joining.");
    };
    assertAdvertised();
    validateSessionValues(invitation.join.fields, values);
    const command = invitation.join.launch.surface === "web" ? "" : sessionCommand(invitation.type, invitation.join, invited.values, values, invited.dependencies);
    const dependencies = resolveDependencies(invitation.manifest.dependencies ?? [], invited.dependencies ?? []);
    if (invitation.join.launch.surface !== "web") for (const path of [invitation.join.launch.executable, ...invitation.join.launch.requires.filter(path => !dependencies.some(d => d.dependency.path === path))]) {
      if (!(await host.stat(path))) throw new Error(`This activity requires an installed file: ${path}`);
    }
    assertCurrent();
    if (network.getState().phase !== "connected" || network.getState().room !== target.room) {
      setProgress("Connecting to host…");
      await network.join(target.room, target.name);
    }
    assertCurrent();
    const snapshot = await host.remoteNetworkSnapshot();
    assertCurrent();
    if (snapshot.state !== "joined") throw new Error("The network connection did not complete; the activity was not launched");
    const room = target.room;
    const assertSessionCurrent = () => {
      assertCurrent();
      const state = network.getState();
      if (state.phase !== "connected" || state.room !== room) throw new Error("The network session ended before the activity could start");
      assertAdvertised();
    };
    assertSessionCurrent();
    for (const { dependency, content, source } of dependencies) {
      setProgress(`Preparing ${dependency.title}…`);
      const selection = selections[dependency.id];
      let bytes = await localDependency(host, dependency.path, content);
      if (!bytes && selection?.file) {
        if (selection.file.size !== content.size) throw new Error("The selected file has a different size from the host's file");
        bytes = new Uint8Array(await selection.file.arrayBuffer());
      }
      if (!bytes && source?.installedPath) bytes = await localDependency(host, source.installedPath, content);
      if (!bytes && content.delivery === "peer") {
        setProgress(`Receiving ${dependency.title}…`);
        setTransfer({ received: 0, total: content.size });
        bytes = await network.receiveDependency(content, signal, received => setTransfer({ received, total: content.size }));
        setTransfer(null); setProgress(`Verifying ${dependency.title}…`);
      }
      if (!bytes && source) {
        bytes = await fetchActivityDependency(source, signal);
      }
      if (!bytes) throw new Error(`Select your own matching file for ${dependency.title}. ${dependency.hint}`);
      await verifyDependency(bytes, content); assertSessionCurrent();
      for (const field of invitation.type.fields) if (field.type === "level" && field.dependency === dependency.id && !content.source
        && !readGameLevels(bytes, field.format).includes(String(invited.values[field.id]))) throw new Error("The invited starting level is not in the uploaded game data");
      await host.writeFile(dependency.path, bytes, 0o644); assertSessionCurrent();
    }
    setProgress("Starting activity…");
    await launch(command, invitation.join.title, assertSessionCurrent, invitation.join.launch, `${invitation.manifest.package}/${invitation.type.id}`);
    assertSessionCurrent();
    setOffered(invited);
    setSelectedRemote(null);
    network.dismissInvitation();
    network.setOpen(false);
  });
  function invitationLink(link: string | null, offered: SessionOffer | null) {
    if (!link || !offered) return link;
    const url = new URL(link);
    const manifest = catalog.find(entry => entry.manifest.package === offered.package)?.manifest;
    const type = manifest?.offers.find(type => type.id === offered.offer);
    if (manifest?.joins.find(join => join.id === type?.join)?.computer === "default") {
      if (!clientImageUrl) throw new Error("No default client computer is available");
      url.searchParams.set("vfs", clientImageUrl);
      url.searchParams.delete("profile");
    }
    url.hash = encodeSessionInvitation(offered);
    return url.href;
  }
  const link = invitationLink(network.state.link, offered);
  const copyStatus = copyResult.link === link ? copyResult.status : "idle";
  const offeredTitle = offered ? catalog.find(entry => entry.manifest.package === offered.package)?.manifest.offers.find(type => type.id === offered.offer)?.title : null;
  return { catalog, imageCatalog, ready, error, busy, progress, transfer, remoteChoices, cancel, offered, offeredTitle, offer, invited, invitation, invitationError, join, link, copyStatus, copySequence,
    startImage: (id: string) => run(async assertCurrent => {
      if (!host.imageActivities) throw new Error("This computer has no image activity controller");
      const activity = await host.imageActivities.prepare(id, setProgress, assertCurrent);
      assertCurrent();
      await launch(activity.command, activity.title, assertCurrent, activity.launch, `image/${activity.id}`);
      assertCurrent();
    }),
    startLocal: (entry: InstalledPackageSessions, id: string, values: SessionValues, selections: DependencySelections = {}) => offer(entry, id, values, false, "", false, selections, "hint", true),
    selectRemote: setSelectedRemote,
    joinNetworkOnly: () => run(async assertCurrent => {
      if (!target) throw new Error("No session invitation");
      setProgress("Connecting to host…");
      await network.join(target.room, target.name); assertCurrent();
      if (network.getState().phase === "connected") { network.dismissInvitation(); setSelectedRemote(null); network.setOpen(false); }
    }),
    copyLink: () => copyLink(link) };
}
export type PackageSessionControls = ReturnType<typeof usePackageSessions>;
