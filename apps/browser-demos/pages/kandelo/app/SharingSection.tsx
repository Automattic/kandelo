// Sharing section of the network session panel — one machine between this
// computer and one partner in the session.

import * as React from "react";
import type { MachineHandover } from "./machine-handover";
import type { MachineReplication } from "./machine-replication";
import type { FramebufferSharing } from "./shared-framebuffer";
import type { NetworkSession } from "./use-network-session";
import type { PrimarySurface } from "../../../../../web-libs/kandelo-session/src/kernel-host";

/**
 * Say what the partner is being shown, or why it is being shown nothing.
 *
 * One machine sends one surface: the one its holder is presenting. Two of the
 * five have a mirror, and the rest are gaps rather than subtleties, so each
 * says which surface it is and that the surface has none. A viewer looking at
 * an empty page is owed the reason, and "nothing is drawing yet" is the wrong
 * one when a fluid simulation is drawing at sixty frames a second through a
 * device this build cannot forward.
 */
function surfaceSummary(
  presenting: PrimarySurface,
  terminal: boolean,
  screen: FramebufferSharing,
): string {
  switch (presenting) {
    case "terminal":
      return terminal
        ? "Sharing this machine's terminal."
        : "No terminal open here yet; open one to share it.";
    case "framebuffer":
      if (screen.refusal) {
        return `This machine's screen cannot be mirrored: ${screen.refusal}.`;
      }
      return screen.sharing
        ? "Sharing this machine's screen."
        : "Nothing is drawing to this machine's screen yet.";
    case "kms":
      return "This machine draws through /dev/dri/card0. That surface has no "
        + "mirror yet, so the other computer sees no screen. Handing the "
        + "machine over still works, and it draws there.";
    case "web":
      return "This machine's surface is a web preview, which has no mirror "
        + "yet, so the other computer sees no screen. Handing the machine "
        + "over still works.";
    case "syslog":
      return "You are looking at Internals, which is not a surface the other "
        + "computer can be shown. Open the terminal or the screen to share "
        + "one.";
  }
}

/**
 * Say which computer holds the machine, then what it is sharing.
 *
 * Holding the machine is what decides who types, so it leads. A computer
 * running a replica holds a machine and is still the watcher, so it is named
 * as one: its machine is a copy of the partner's, kept the same by the
 * decisions crossing the wire.
 */
function sharedSummary(
  partner: string,
  hasMachine: boolean,
  peerHasMachine: boolean,
  presenting: PrimarySurface | null,
  terminal: boolean,
  screen: FramebufferSharing,
  machine: boolean,
  replication: MachineReplication,
): string {
  if (replication.replicating) {
    return `${partner} holds the machine, so it is the one that types. This `
      + "computer is running a copy of it, following the decisions it makes "
      + "rather than the pixels it draws. Take it over to run it here and "
      + "type into it.";
  }
  if (!hasMachine || presenting === null) {
    return peerHasMachine
      ? `${partner} holds the machine, so it is the one that types. You are `
        + "watching it. Take it over to run it here and type into it."
      : "Neither computer is running a machine yet.";
  }
  const lines = [
    `You hold the machine, so you are the one that types; ${partner} can `
    + "watch it.",
    replication.publishing
      ? `${partner} is running a copy of this machine, following every `
        + "decision this one makes."
      : surfaceSummary(presenting, terminal, screen),
  ];
  if (machine) {
    lines.push(
      `${partner} can take this machine over; it would then run there and `
      + "type there, and stop here.",
    );
  }
  return lines.join(" ");
}

/**
 * Report a take that is running or one that did not finish. Null while
 * nothing is happening: the button already says what it does.
 */
function takeNote(handover: MachineHandover): string | null {
  if (handover.failure) return `Take over failed: ${handover.failure}`;
  if (handover.taking) {
    return "Freezing it on the other computer and restoring it here.";
  }
  return null;
}

export const SharingSection: React.FC<{
  session: NetworkSession;
  sharingTerminal: boolean;
  sharingScreen: FramebufferSharing;
  handover: MachineHandover;
  /**
   * Whether this computer can adopt the partner's machine: it runs none, or
   * only a copy of the partner's, and the partner says it runs one.
   */
  canTakeMachine: boolean;
  /** Whether a machine runs on this computer. */
  hasMachine: boolean;
  /** The surface this computer's machine presents, or null without one. */
  presenting: PrimarySurface | null;
  replication: MachineReplication;
}> = ({
  session,
  sharingTerminal,
  sharingScreen,
  handover,
  canTakeMachine,
  hasMachine,
  presenting,
  replication,
}) => {
  const { state, partner } = session;
  const note = takeNote(handover);
  const owner = hasMachine && !replication.replicating;

  return (
    <div className="ksharing">
      <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>Share a machine</div>
      {state.sharingError && (
        <div className="knetwork-error" role="alert">
          {`Sharing with the hosting computer failed: ${state.sharingError}`}
        </div>
      )}
      {state.partners.length === 0 && (
        <p className="knetwork-note">
          No computer in this session can be shared with yet. Each computer
          that joins can be shown this machine, follow it, or take it over.
        </p>
      )}
      {state.partners.length > 1 && (
        <fieldset className="ksharing-partners">
          <legend className="knetwork-note">Share with one computer at a time</legend>
          {state.partners.map((candidate) => (
            <label key={candidate.id} className="ksharing-partner">
              <input
                type="radio"
                name="ksharing-partner"
                checked={partner?.id === candidate.id}
                onChange={() => session.choosePartner(candidate.id)}
              />
              {candidate.name}
            </label>
          ))}
        </fieldset>
      )}
      {partner && (
        <>
          <p className="knetwork-note ksharing-status" role="status">
            {sharedSummary(
              partner.name,
              hasMachine,
              handover.peerHasMachine,
              presenting,
              sharingTerminal,
              sharingScreen,
              handover.offering,
              replication,
            )}
          </p>
          {replication.failure !== null && (
            <p className="knetwork-note" role="status">
              {`Running a copy of this machine has not worked yet, and this `
                + `computer keeps asking: ${replication.failure}`}
            </p>
          )}
          {/* The grant is the machine owner's: joining starts by sending the
              machine's whole state to the partner, so the person holding it
              decides how it may be followed. */}
          {owner && (
            <div className="knetwork-actions" role="group" aria-label="What the other computer can do">
              <button
                type="button"
                className="kshare-btn ksharing-grant"
                aria-pressed={replication.grant === "watch"}
                onClick={() => replication.setGrant("watch")}
              >
                Watch
              </button>
              <button
                type="button"
                className="kshare-btn ksharing-grant"
                aria-pressed={replication.grant === "join"}
                onClick={() => replication.setGrant("join")}
              >
                Join
              </button>
            </div>
          )}
          {owner && (
            <p className="knetwork-note">
              Watch shares this screen only; Join lets the other computer run
              a copy of this machine.
            </p>
          )}
          <div className="knetwork-actions">
            {owner && handover.peerHasMachine && (
              <button type="button" className="kshare-btn" onClick={() => void session.watch()}>
                {`Watch ${partner.name}'s machine`}
              </button>
            )}
            {canTakeMachine && (
              <button
                type="button"
                className="kshare-btn kshare-btn-primary"
                onClick={handover.take}
                disabled={handover.taking}
              >
                {handover.taking ? "Taking it over..." : "Take over this machine"}
              </button>
            )}
          </div>
          {canTakeMachine && note !== null && (
            <p className="knetwork-note" role="status">{note}</p>
          )}
        </>
      )}
    </div>
  );
};
