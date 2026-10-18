/**
 * The signalling-server exchange of the two peer-link codes.
 *
 * `apps/signalling/piplet.php` replaces the humans in the manually signalled
 * WebRTC flow: one computer hosts a session under a chosen name and leaves
 * its invite code, the other asks for that name, takes the invite, and
 * leaves its answer code, and the host polls the name until the answer
 * appears. The two codes are the same `kandelo1:` strings the copy-paste
 * flow carries — the server never holds anything else, and the peer link
 * itself is unchanged.
 *
 * A session name is lowercase words separated by dashes, 64 characters at
 * most. The server enforces the rule; validating here too turns a typo into
 * a message instead of a request. The name is the only secret: whoever
 * knows it can read the codes or answer first, so a session that crosses
 * the open internet deserves an unguessable name.
 */

export const SESSION_NAME_RULE =
  "a session name is lowercase words separated by dashes, 64 characters at most";

const SESSION_NAME_PATTERN = /^[a-z]+(-[a-z]+)*$/;
const SESSION_NAME_MAX_LENGTH = 64;
const ANSWER_POLL_MS = 2000;
/** The server forgets a session after ten minutes; polling past that asks
 * about a session that no longer exists. */
const ANSWER_WAIT_MS = 10 * 60 * 1000;

interface SignalledSession {
  offer: string;
  answer: string | null;
}

export function validSessionName(name: string): boolean {
  return (
    name.length <= SESSION_NAME_MAX_LENGTH && SESSION_NAME_PATTERN.test(name)
  );
}

function sessionUrl(server: string, name: string, role?: string): string {
  const url = new URL(server);
  url.searchParams.set("session", name);
  if (role) url.searchParams.set("role", role);
  return url.href;
}

async function refusal(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // A non-JSON refusal is not the piplet; the status line is all there is.
  }
  return `the signalling server answered ${response.status}`;
}

export async function postSessionOffer(
  server: string,
  name: string,
  invite: string,
): Promise<void> {
  const response = await fetch(sessionUrl(server, name, "offer"), {
    method: "POST",
    body: invite,
  });
  if (!response.ok) throw new Error(await refusal(response));
}

export async function readSession(
  server: string,
  name: string,
): Promise<SignalledSession> {
  const response = await fetch(sessionUrl(server, name));
  if (!response.ok) throw new Error(await refusal(response));
  return (await response.json()) as SignalledSession;
}

export async function postSessionAnswer(
  server: string,
  name: string,
  answer: string,
): Promise<void> {
  const response = await fetch(sessionUrl(server, name, "answer"), {
    method: "POST",
    body: answer,
  });
  if (!response.ok) throw new Error(await refusal(response));
}

/**
 * Poll the hosted session until its answer arrives.
 *
 * Returns null when `stillWanted` reports the attempt superseded — the
 * caller has moved on, so neither an answer nor an error is owed. A 404
 * while waiting means the session expired on the server before anyone
 * answered, and that is reported as the failure it is.
 */
export async function waitForSessionAnswer(
  server: string,
  name: string,
  stillWanted: () => boolean,
): Promise<string | null> {
  const deadline = Date.now() + ANSWER_WAIT_MS;
  while (stillWanted()) {
    if (Date.now() > deadline) {
      throw new Error(`the session "${name}" expired before an answer arrived`);
    }
    const { answer } = await readSession(server, name);
    if (answer !== null) return answer;
    await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
  }
  return null;
}

/*
 * Rooms: any number of computers joining one hosting computer, the centre
 * of a star network. The room token travels in the link people share and
 * opens the room to joiners; the host key never leaves the hosting
 * computer and is the only authority for the host's side of the room.
 */

const ROOM_TOKEN_PATTERN = /^[a-z]{20,64}$/;
const ROOM_POLL_MS = 1500;
/** An unanswered join expires on the server after two minutes. */
const ROOM_ANSWER_WAIT_MS = 2 * 60 * 1000;
const HOST_KEY_HEADER = "X-Kandelo-Host-Key";

export interface RoomJoinRequest { join: string; offer: string }
export interface HostedRoom { room: string; name: string; joins: RoomJoinRequest[] }

export function validRoomToken(token: string): boolean {
  return ROOM_TOKEN_PATTERN.test(token);
}

/** 26 random lowercase letters, about 122 bits, without modulo bias. */
export function randomRoomToken(length = 26): string {
  let token = "";
  const bytes = new Uint8Array(64);
  while (token.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // 234 is the largest multiple of 26 at or below 256.
      if (byte < 234 && token.length < length) token += String.fromCharCode(97 + (byte % 26));
    }
  }
  return token;
}

function roomUrl(server: string, room: string, query: Record<string, string> = {}): string {
  if (!validRoomToken(room)) throw new Error("a room token is 20 to 64 lowercase letters");
  const url = new URL(server);
  url.searchParams.set("room", room);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

/** The room is gone: it never existed, expired, or its host closed it. */
export class RoomClosedError extends Error {}

async function roomRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (response.status === 404) throw new RoomClosedError(await refusal(response));
  if (!response.ok) throw new Error(await refusal(response));
  return (await response.json()) as T;
}

/** Create or keep the room, and collect joins still waiting for an answer. */
export function hostRoom(server: string, room: string, key: string, name: string): Promise<HostedRoom> {
  return roomRequest(roomUrl(server, room, { role: "host" }), {
    method: "POST", headers: { [HOST_KEY_HEADER]: key, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function answerRoomJoin(server: string, room: string, key: string, join: string, answer: string): Promise<void> {
  await roomRequest(roomUrl(server, room, { role: "answer", join }), { method: "POST", headers: { [HOST_KEY_HEADER]: key }, body: answer });
}

export async function refuseRoomJoin(server: string, room: string, key: string, join: string, reason: string): Promise<void> {
  await roomRequest(roomUrl(server, room, { role: "refuse", join }), { method: "POST", headers: { [HOST_KEY_HEADER]: key }, body: reason });
}

export async function closeRoom(server: string, room: string, key: string): Promise<void> {
  await roomRequest(roomUrl(server, room, { role: "close" }), { method: "POST", headers: { [HOST_KEY_HEADER]: key }, body: "" });
}

export function readRoom(server: string, room: string): Promise<{ room: string; name: string }> {
  return roomRequest(roomUrl(server, room));
}

export async function postRoomJoin(server: string, room: string, join: string, offer: string): Promise<void> {
  await roomRequest(roomUrl(server, room, { role: "join", join }), { method: "POST", body: offer });
}

/**
 * Poll one join until the host answers it. Returns null when the attempt
 * is superseded; a refusal or an expired room is the failure it is.
 */
export async function waitForRoomAnswer(
  server: string, room: string, join: string, stillWanted: () => boolean,
): Promise<string | null> {
  const deadline = Date.now() + ROOM_ANSWER_WAIT_MS;
  while (stillWanted()) {
    if (Date.now() > deadline) throw new Error("the hosting computer did not answer");
    const status = await roomRequest<{ answer: string | null; refused: string | null }>(roomUrl(server, room, { join }));
    if (status.refused !== null) throw new Error(`the hosting computer refused: ${status.refused}`);
    if (status.answer !== null) return status.answer;
    await new Promise((resolve) => setTimeout(resolve, ROOM_POLL_MS));
  }
  return null;
}
