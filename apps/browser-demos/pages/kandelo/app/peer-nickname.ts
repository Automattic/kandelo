// Peer nickname — the name each person gives themselves in a shared pair.
//
// WHY: the dock badge names who the user is, and a name does that better
// than the role words: your own name says you type, someone else's says you
// are watching them. The name belongs to the person, not to a machine or a
// role, so it lives here rather than in the replication state — a take-over
// moves the machine and the names stay where the people are.
//
// The name lives only on this page: typed for the session, gone with it,
// never part of a machine, a checkpoint, or the decision log. It crosses the
// wire as presentation on the replication channel, next to the publisher's
// cursor. The other person's name is their input, so it is capped and
// stripped like every other text that arrives on the wire.
import * as React from "react";
import { LocalReplicationLog } from "@host/replication/log-local";
import type { PeerLink } from "../../../lib/peer-link";
import { presentableNickname } from "../../../lib/peer-nickname";

interface PeerNickname {
  /** This person's name as typed, for the input. */
  nickname: string;
  setNickname: (name: string) => void;
  /** The other person's name, or null while unheard or when they gave none. */
  peerNickname: string | null;
}

export function usePeerNickname(link: PeerLink | null): PeerNickname {
  const [nickname, setNicknameState] = React.useState("");
  const [peerNickname, setPeerNickname] = React.useState<string | null>(null);
  // The name is typed before connecting and announced at link-up, so the
  // effect below reads it through a ref rather than rerun on keystrokes.
  const nicknameRef = React.useRef(nickname);

  const setNickname = React.useCallback((name: string) => {
    nicknameRef.current = name;
    setNicknameState(name);
  }, []);

  React.useEffect(() => {
    setPeerNickname(null);
    if (!link) return;
    // The wire wraps the link's channel; the link owns and closes it, so
    // dropping the wire here must not close the channel underneath it.
    const wire = new LocalReplicationLog(link.replication);
    const announce = wire.announceNickname(
      presentableNickname(nicknameRef.current),
      (name) => {
        setPeerNickname(
          typeof name === "string" ? presentableNickname(name) : null,
        );
      },
    );
    return () => announce.stop();
  }, [link]);

  return { nickname, setNickname, peerNickname };
}
