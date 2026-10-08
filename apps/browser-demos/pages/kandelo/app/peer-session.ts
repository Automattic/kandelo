// Peer session — the signalled link between two Kandelo machines.
//
// WHY: the connection outlives the popover that creates it. Holding the link,
// the codes and the status here means closing the Network popover does not
// drop a connection, and reopening it shows what is actually going on.
//
// Two ways to carry the same two strings. With a signalling server
// configured, the pair shares a session name and the server ferries the
// codes: one side hosts the name, the other joins it, and the connection
// completes by itself. Without one, the three manual steps remain: one side
// creates an invite code, the other answers it, the first completes. The
// server address comes from `?signalling=` or `VITE_SIGNALLING_URL`; a page
// URL is untrusted input, and a hostile address only ever receives the two
// session descriptions the manual flow already hands to a chat window.
import * as React from "react";
import {
  answerPeerInvite,
  createPeerInvite,
  type PeerInvite,
  type PeerLink,
} from "../../../lib/peer-link";
import {
  SESSION_NAME_RULE,
  postSessionAnswer,
  postSessionOffer,
  readSession,
  randomSessionName,
  validSessionName,
  waitForSessionAnswer,
} from "../../../lib/peer-signalling";

function resolveSignallingServer(): string | null {
  const query = new URLSearchParams(window.location.search).get("signalling");
  const configured = query ?? (import.meta.env.VITE_SIGNALLING_URL as
    | string
    | undefined);
  if (!configured) return null;
  try {
    const url = new URL(configured, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

const SIGNALLING_SERVER = resolveSignallingServer();

export interface PeerSession {
  /** Whether a signalling server is configured, and the name flow with it. */
  signalling: boolean;
  /** The session name the two computers agreed on. */
  sessionName: string;
  /** The name hosting uses while no session name is typed. */
  suggestedName: string;
  /** The code to hand to the other computer. */
  localCode: string;
  /** The code pasted from the other computer. */
  remoteCode: string;
  status: string;
  /** Whether the session name is hosted and waits for the other computer. */
  hosting: boolean;
  link: PeerLink | null;
  setSessionName: (name: string) => void;
  setRemoteCode: (code: string) => void;
  hostSession: () => void;
  stopHosting: () => void;
  joinSession: () => void;
  createInvite: () => void;
  answerInvite: () => void;
  completeConnection: () => void;
  disconnect: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePeerSession(): PeerSession {
  const [sessionName, setSessionName] = React.useState("");
  const [suggestedName] = React.useState(randomSessionName);
  const [localCode, setLocalCode] = React.useState("");
  const [remoteCode, setRemoteCode] = React.useState("");
  // Empty while nothing is happening: the connect steps already say there is
  // no connection, so the status only ever reports progress or a failure.
  const [status, setStatus] = React.useState("");
  const [link, setLink] = React.useState<PeerLink | null>(null);
  const pendingInviteRef = React.useRef<PeerInvite | null>(null);
  // Every attempt supersedes the one before it. Without this, a superseded
  // attempt's late failure — or worse, its late-connecting link — lands on
  // top of the attempt the user is actually waiting for.
  const attemptRef = React.useRef(0);
  const linkRef = React.useRef<PeerLink | null>(null);
  const [hosting, setHosting] = React.useState(false);

  // A new attempt supersedes a hosted name as surely as an older attempt.
  const beginAttempt = React.useCallback(() => {
    setHosting(false);
    return ++attemptRef.current;
  }, []);

  const adopt = React.useCallback((connected: PeerLink) => {
    linkRef.current?.close();
    linkRef.current = connected;
    setLink(connected);
    setStatus("Connected to the other computer.");
    connected.onClose(() => {
      if (linkRef.current !== connected) return;
      linkRef.current = null;
      // The other side hung up; this side's peer connection is dead but not
      // closed, and an unclosed one keeps its ICE agent and ports until GC.
      connected.close();
      setLink(null);
      setStatus("Connection lost.");
    });
  }, []);

  React.useEffect(() => () => {
    attemptRef.current += 1;
    pendingInviteRef.current?.cancel();
    linkRef.current?.close();
  }, []);

  const hostSession = React.useCallback(() => {
    void (async () => {
      const attempt = beginAttempt();
      const name = sessionName.trim() || suggestedName;
      setSessionName(name);
      try {
        if (SIGNALLING_SERVER === null) {
          throw new Error("no signalling server is configured");
        }
        if (!validSessionName(name)) throw new Error(SESSION_NAME_RULE);
        setStatus(`Creating the invite for "${name}"...`);
        pendingInviteRef.current?.cancel();
        pendingInviteRef.current = null;
        const invite = await createPeerInvite();
        if (attempt !== attemptRef.current) {
          invite.cancel();
          return;
        }
        pendingInviteRef.current = invite;
        await postSessionOffer(SIGNALLING_SERVER, name, invite.invite);
        if (attempt !== attemptRef.current) return;
        setStatus("");
        setHosting(true);
        const answer = await waitForSessionAnswer(
          SIGNALLING_SERVER,
          name,
          () => attempt === attemptRef.current,
        );
        if (answer === null || attempt !== attemptRef.current) return;
        setHosting(false);
        setStatus("Answer received; completing the connection...");
        const connectedLink = await invite.acceptAnswer(answer);
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        pendingInviteRef.current = null;
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setHosting(false);
        setStatus(`Hosting failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, beginAttempt, sessionName, suggestedName]);

  // The server keeps the offer until it forgets the session; this page stops
  // waiting for an answer to it and closes the invite it would complete.
  const stopHosting = React.useCallback(() => {
    beginAttempt();
    pendingInviteRef.current?.cancel();
    pendingInviteRef.current = null;
    setStatus("");
  }, [beginAttempt]);

  const joinSession = React.useCallback(() => {
    void (async () => {
      const attempt = beginAttempt();
      const name = sessionName.trim();
      try {
        if (SIGNALLING_SERVER === null) {
          throw new Error("no signalling server is configured");
        }
        if (!validSessionName(name)) throw new Error(SESSION_NAME_RULE);
        setStatus(`Joining "${name}"...`);
        const { offer } = await readSession(SIGNALLING_SERVER, name);
        if (attempt !== attemptRef.current) return;
        const { answer, connected } = await answerPeerInvite(offer);
        if (attempt !== attemptRef.current) {
          void connected.then((stale) => stale.close(), () => {});
          return;
        }
        await postSessionAnswer(SIGNALLING_SERVER, name, answer);
        setStatus(`Answered "${name}"; the connection completes by itself.`);
        const connectedLink = await connected;
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Joining failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, beginAttempt, sessionName]);

  const createInvite = React.useCallback(() => {
    void (async () => {
      const attempt = beginAttempt();
      try {
        setStatus("Creating the invite code...");
        pendingInviteRef.current?.cancel();
        pendingInviteRef.current = null;
        const invite = await createPeerInvite();
        if (attempt !== attemptRef.current) {
          invite.cancel();
          return;
        }
        pendingInviteRef.current = invite;
        setLocalCode(invite.invite);
        setStatus("Send this code, paste the answer, then complete the connection.");
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Invite failed: ${describeError(error)}`);
      }
    })();
  }, [beginAttempt]);

  const answerInvite = React.useCallback(() => {
    void (async () => {
      const attempt = beginAttempt();
      try {
        setStatus("Answering the invite...");
        const { answer, connected } = await answerPeerInvite(remoteCode);
        if (attempt !== attemptRef.current) {
          void connected.then((stale) => stale.close(), () => {});
          return;
        }
        setLocalCode(answer);
        setStatus("Send this answer back; the connection completes by itself.");
        const connectedLink = await connected;
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Answer failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, beginAttempt, remoteCode]);

  const completeConnection = React.useCallback(() => {
    void (async () => {
      const attempt = beginAttempt();
      try {
        const invite = pendingInviteRef.current;
        if (!invite) throw new Error("create an invite code first");
        setStatus("Completing the connection...");
        const connectedLink = await invite.acceptAnswer(remoteCode);
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        pendingInviteRef.current = null;
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Connection failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, beginAttempt, remoteCode]);

  const disconnect = React.useCallback(() => {
    beginAttempt();
    pendingInviteRef.current?.cancel();
    pendingInviteRef.current = null;
    linkRef.current?.close();
    linkRef.current = null;
    setLink(null);
    setLocalCode("");
    setRemoteCode("");
    setStatus("");
  }, [beginAttempt]);

  return {
    signalling: SIGNALLING_SERVER !== null,
    sessionName,
    suggestedName,
    localCode,
    remoteCode,
    status,
    hosting,
    link,
    setSessionName,
    setRemoteCode,
    hostSession,
    stopHosting,
    joinSession,
    createInvite,
    answerInvite,
    completeConnection,
    disconnect,
  };
}
