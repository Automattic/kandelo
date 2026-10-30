// Setup and active-session dialogs share only the controller's real room state.
import * as React from "react";
import { NetworkDialog } from "./NetworkDialog";
import type { NetworkSession } from "./use-network-session";
import { NETWORK_PHASE_LABEL } from "./Dock";
import { networkErrorHint } from "../../../lib/network-error-hint";
import type { PackageSessionControls } from "./use-package-sessions";
import { ActivityJoinForm, ActivityOfferForm, ActivityClientForm, ActivityMetadata } from "./ActivityForms";
import { SessionNotice } from "./SessionNotice";
import { randomSessionName } from "./session-name";
import { networkJoinReadiness } from "./network-join-readiness";

export const NetworkPanel: React.FC<{ session: NetworkSession; activity: PackageSessionControls; running: boolean; failed?: boolean }> = ({ session, activity, running, failed }) => {
  const { state, invitation } = session;
  const [name, setName] = React.useState(randomSessionName);
  const [editing, setEditing] = React.useState<"activity" | "new" | null>(state.phase !== "connected" ? "activity" : null);
  const active = state.phase === "connected" && !invitation && editing === null && !activity.busy;
  const close = () => session.setOpen(false);

  const inSession = state.phase === "hosting" || state.phase === "joining" || state.phase === "connected";
  const busy = state.phase === "hosting" || state.phase === "joining" || activity.busy;
  const blocked = !running || !session.available || busy;
  const self = state.snapshot?.address ?? null;
  const members = state.snapshot?.members ?? [];
  const errorHint = networkErrorHint(state.error);
  const leave = async () => { activity.cancel(); await session.leave(); setEditing("activity"); setName(randomSessionName()); };
  const joined = state.snapshot?.state === "joined";
  const canChange = !joined || activity.remoteChoices.length > 0;
  const title = invitation ? "Session invitation" : active ? "Active session" : editing === "new" ? "New session" : state.phase === "connected" ? "Change activity" : "Network session";
  const readiness = networkJoinReadiness({ failed, error: state.error ?? activity.error, invitationError: activity.invitationError,
    running, ready: activity.ready, busy, progress: activity.progress });

  const notice = invitation ? <SessionNotice readiness transfer={activity.transfer}
            tone={readiness.tone}>
            {readiness.message}
          </SessionNotice> : activity.progress || busy ? <SessionNotice transfer={activity.transfer}>
            {activity.progress ?? (state.phase === "joining" ? "Connecting to host…" : "Preparing session…")}
          </SessionNotice> : active && activity.copyStatus !== "idle" ? <SessionNotice key={activity.copySequence}
            tone={activity.copyStatus === "copied" ? "success" : "error"}
            detail={activity.copyStatus === "copied" ? "Paste it to invite someone." : "Select the invite link below to copy it manually."}>
            {activity.copyStatus === "copied" ? "Link copied." : "Couldn’t copy."}
          </SessionNotice> : null;

  return <NetworkDialog title={title} close={close} summary={<div className="knetwork-status" data-phase={state.phase} role="status">
            <span className="knetwork-dot" aria-hidden="true" />
            <strong>{invitation?.name ?? state.name ?? "No session"}</strong>
            <span>{NETWORK_PHASE_LABEL[state.phase]}{self ? ` · this computer is ${self}` : ""}</span>
          </div>} notice={notice} actions={<>
          <div style={{ flex: 1 }} />
          {activity.busy && !inSession && !state.room && <button className="kshare-btn" onClick={activity.cancel}>Cancel preparation</button>}
          {(inSession || state.room) && <button className="kshare-btn" onClick={() => void leave()}>Leave session</button>}
          {active && <>
            {canChange && <button className="kshare-btn" onClick={() => { setName(state.name ?? randomSessionName()); setEditing("activity"); }}>Change activity</button>}
            {joined && <button className="kshare-btn" onClick={() => { setName(randomSessionName()); setEditing("new"); }}>New session</button>}
            <button className="kshare-btn kshare-btn-primary" disabled={busy} onClick={() => void activity.copyLink()}>Copy link</button>
          </>}
          {!active && !invitation && state.phase === "connected" && <button className="kshare-btn" disabled={busy} onClick={() => setEditing(null)}>Back to active session</button>}
        </>}>

          {state.error && <div className="knetwork-error" role="alert">
            {state.error}
            {state.errorDetail && <div className="knetwork-detail">{state.errorDetail}</div>}
            {errorHint && <div className="knetwork-hint">{errorHint}</div>}
          </div>}
          {joined && state.activityError && <p className="knetwork-error" role="alert">{state.activityError}</p>}
          {!session.available && <p className="knetwork-note">No signalling server is configured for this deployment, so computers cannot find each other.</p>}
          {!running && !invitation && <p className="knetwork-note">Start a computer to create or join a session.</p>}

          {activity.error && <div className="knetwork-error" role="alert">{activity.error}</div>}

          {invitation ? <>
            <ActivityMetadata activity={activity} invited />
            {invitation.offer ? <ActivityJoinForm activity={activity} blocked={blocked} room={invitation.name} dismiss={session.dismissInvitation} joinNetworkOnly={() => void activity.joinNetworkOnly()} /> : <form onSubmit={event => { event.preventDefault(); void session.join(invitation.room, invitation.name).then(() => setEditing(null)); }}>
              <div className="knetwork-actions">
                <button className="kshare-btn kshare-btn-primary" disabled={blocked}>Join session</button>
                <button type="button" className="kshare-btn" disabled={busy} onClick={session.dismissInvitation}>Dismiss</button>
              </div>
            </form>}
          </> : active ? <>
            <ActivityMetadata activity={activity} />
            <div>
              <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Invite link</div>
              <div className="kshare-url" data-network-link={activity.link}>{activity.link}</div>
            </div>
            <div>
              <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Computers</div>
              <ul className="knetwork-members" aria-label="Computers in this session">
                {members.map(member => <li key={member.address}>
                  <code>{member.address}</code><span>{member.hostname}</span>
                  {member.address === self && <small>this computer</small>}
                </li>)}
              </ul>
            </div>
          </> : <>
            {state.phase === "connected" && joined && editing !== "new"
              ? <ActivityClientForm activity={activity} blocked={blocked} session={session} onComplete={() => setEditing(null)} />
              : <ActivityOfferForm key={editing} replaceSession={editing === "new"} activity={activity} blocked={blocked} name={name} setName={setName} session={session} onComplete={() => setEditing(null)} />}
          </>}
  </NetworkDialog>;
};
