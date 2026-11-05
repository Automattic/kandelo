import * as React from "react";
import type { sessionInvitation } from "../../../lib/network-session";
import { sessionDefaults } from "../../../../../web-libs/kandelo-session/src/package-sessions";
import { InvitationMetadata, JoinActivityForm } from "./ActivityForms";
import { SessionNotice } from "./SessionNotice";
import { NetworkDialog } from "./NetworkDialog";

/** A URL preview needs no machine; it grants no authority to join or execute. */
export function SessionInvitationPreview({ invitation, close, dismiss, error }: {
  invitation: NonNullable<ReturnType<typeof sessionInvitation>>; close: () => void; dismiss: () => void; error?: string;
}) {
  const offer = invitation.offer;
  return <NetworkDialog title="Session invitation" close={close} summary={<div className="knetwork-status" data-phase="offline" role="status">
      <span className="knetwork-dot" aria-hidden="true" /><strong>{invitation.name}</strong><span>Not connected</span>
    </div>} notice={<SessionNotice readiness tone={error ? "error" : "working"}>
      {error ? `This computer could not start: ${error}` : "Starting computer…"}
    </SessionNotice>}>
    <InvitationMetadata offer={offer} />
    {offer?.presentation ? <JoinActivityForm offer={offer} presentation={offer.presentation} room={invitation.name}
      values={sessionDefaults(offer.presentation.join.fields)} setValues={() => {}} blocked dismiss={dismiss} />
      : offer ? <p className="knetwork-note">Activity details will appear after startup.</p>
      : <form>
        <div className="knetwork-actions"><button className="kshare-btn kshare-btn-primary" disabled>Join session</button><button type="button" className="kshare-btn" onClick={dismiss}>Dismiss</button></div>
      </form>}
  </NetworkDialog>;
}
