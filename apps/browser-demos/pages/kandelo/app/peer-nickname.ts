// Peer nickname — the name each person gives themselves in a shared pair.
//
// WHY: the dock badge names who the user is, and a name does that better
// than the role words: your own name says you type, someone else's says you
// are watching them. The name belongs to the person, not to a machine or a
// role, so it lives here rather than in the replication state — a take-over
// moves the machine and the names stay where the people are.
//
// The name is this browser's own, kept in localStorage: user-local,
// clearable, never part of a machine, a checkpoint, or the decision log. It
// crosses the wire as presentation on the replication channel, next to the
// publisher's cursor. The other person's name is their input, so it is
// capped and stripped like every other text that arrives on the wire.
import * as React from "react";
import { LocalReplicationLog } from "@host/replication/log-local";
import type { PeerLink } from "../../../lib/peer-link";
import { presentableNickname } from "../../../lib/peer-nickname";

const NICKNAME_STORAGE_KEY = "kandelo.nickname";

function readStoredNickname(): string {
  try {
    return window.localStorage.getItem(NICKNAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

interface PeerNickname {
  /** This person's name as typed, for the input. */
  nickname: string;
  setNickname: (name: string) => void;
  /** The other person's name, or null while unheard or when they gave none. */
  peerNickname: string | null;
}

export function usePeerNickname(link: PeerLink | null): PeerNickname {
  const [nickname, setNicknameState] = React.useState(readStoredNickname);
  const [peerNickname, setPeerNickname] = React.useState<string | null>(null);
  // The exchange outlives renders, and the effect below must not rerun on
  // every keystroke, so changes reach the wire through refs rather than deps.
  const nicknameRef = React.useRef(nickname);
  const announceRef = React.useRef<{
    set: (name: string | null) => void;
  } | null>(null);

  const setNickname = React.useCallback((name: string) => {
    nicknameRef.current = name;
    setNicknameState(name);
    try {
      window.localStorage.setItem(NICKNAME_STORAGE_KEY, name);
    } catch {
      // User preference storage can be unavailable in private or restricted contexts.
    }
    announceRef.current?.set(presentableNickname(name));
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
    announceRef.current = announce;
    return () => {
      announceRef.current = null;
      announce.stop();
    };
  }, [link]);

  return { nickname, setNickname, peerNickname };
}
