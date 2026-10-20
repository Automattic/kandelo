import { createDatabaseStore, HttpError, type Database, type Entry, type Room, type Session, type Store } from "./store.ts";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Kandelo-Host-Key",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
const NAME = /^(?=.{1,64}$)[a-z]+(?:-[a-z]+)*$/;
const TOKEN = /^[a-z]{20,64}$/;
const trim = (s: string) => s.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, "");
const printable = (s: string) => trim(s.replace(/[\x00-\x1f\x7f]/g, ""));
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value) + "\n", { status, headers: { ...HEADERS, ...extra } });
function parameter(url: URL, name: string): string {
  // PHP arrays are invalid where a scalar is required. Duplicate scalar
  // parameters follow PHP's last-value rule rather than URLSearchParams.get.
  if ([...url.searchParams.keys()].some(k => k.startsWith(name + "["))) return "";
  return url.searchParams.getAll(name).at(-1) ?? "";
}
function token(value: string, what: string): string {
  if (!TOKEN.test(value)) throw new HttpError(422, `a ${what} is 20 to 64 lowercase letters`);
  return value;
}
async function body(request: Request, max: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new HttpError(413, "a connect code must be 1 to 65536 bytes"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
function text(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError(422, "the request must be UTF-8 text"); }
}
async function code(request: Request): Promise<string> {
  const bytes = await body(request, 65536);
  if (!bytes.length) throw new HttpError(413, "a connect code must be 1 to 65536 bytes");
  const value = trim(text(bytes));
  if (!value.startsWith("kandelo1:")) throw new HttpError(422, "this is not a Kandelo connect code");
  return value;
}
async function keyHash(request: Request): Promise<string> {
  const key = request.headers.get("X-Kandelo-Host-Key") ?? "";
  if (!TOKEN.test(key)) throw new HttpError(401, "the host key is 20 to 64 lowercase letters");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map(n => n.toString(16).padStart(2, "0")).join("");
}
function equalHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function hosted(entry: Entry | null, hash: string): Room {
  if (!entry) throw new HttpError(404, "no such room");
  const room = entry as Room;
  if (!equalHash(room.key, hash)) throw new HttpError(403, "this is not the room's host");
  return room;
}

/** The PHP piplet's HTTP protocol, independent of storage and hosting. */
export function createSignallingHandler(store: Store): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const method = request.method;
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
      const url = new URL(request.url);
      const role = parameter(url, "role");
      if (url.searchParams.has("room") || [...url.searchParams.keys()].some(k => k.startsWith("room["))) {
        const room = token(parameter(url, "room"), "room token");
        if (method === "GET") {
          const entry = (await store.read("rooms", room)).entry as Room | null;
          if (!entry) throw new HttpError(404, "no such room");
          if (!url.searchParams.has("join") && ![...url.searchParams.keys()].some(k => k.startsWith("join["))) return json({ room, name: entry.name });
          const join = token(parameter(url, "join"), "join token");
          const value = entry.joins[join];
          if (!value) throw new HttpError(404, "no such join");
          return json({ answer: value.answer, refused: value.refused });
        }
        if (method !== "POST") throw new HttpError(405, "use GET, POST, or OPTIONS");
        if (role === "join") {
          const join = token(parameter(url, "join"), "join token");
          const offer = await code(request);
          await store.mutate("rooms", room, (entry, now) => {
            if (!entry) throw new HttpError(404, "no such room");
            const value = entry as Room;
            if (value.joins[join]) throw new HttpError(409, "this join is already waiting");
            if (Object.values(value.joins).filter(j => j.answer === null && j.refused === null).length >= 8) throw new HttpError(503, "too many computers are joining this room at once", "2");
            value.joins[join] = { offer, answer: null, refused: null, created: now };
            return { entry: value, result: undefined };
          });
          return json({ ok: true }, 201);
        }
        const hash = await keyHash(request);
        if (role === "host") {
          let payload: any;
          try { payload = JSON.parse(text(await body(request, 4096))); } catch { throw new HttpError(422, "a room needs a name"); }
          if (typeof payload?.name !== "string") throw new HttpError(422, "a room needs a name");
          const name = printable(payload.name);
          if (!name || [...name].length > 64) throw new HttpError(422, "a room name is 1 to 64 printable characters");
          const waiting = await store.mutate("rooms", room, (entry, now, index) => {
            if (!entry && Object.keys(index.rooms).length >= 256) throw new HttpError(503, "the signalling server is full");
            const value = entry ? hosted(entry, hash) : { name, key: hash, touched: now, joins: {} };
            value.name = name; value.touched = now;
            return { entry: value, result: Object.entries(value.joins).filter(([, j]) => j.answer === null && j.refused === null).map(([join, j]) => ({ join, offer: j.offer })) };
          });
          return json({ room, name, joins: waiting });
        }
        if (role === "answer" || role === "refuse") {
          const join = token(parameter(url, "join"), "join token");
          let value: string;
          if (role === "answer") value = await code(request);
          else {
            let bytes: Uint8Array;
            try { bytes = await body(request, 256); } catch { throw new HttpError(422, "a refusal is 1 to 256 bytes of text"); }
            value = printable(text(bytes));
            if (!value || new TextEncoder().encode(value).length > 256) throw new HttpError(422, "a refusal is 1 to 256 bytes of text");
          }
          await store.mutate("rooms", room, (entry, now) => {
            const r = hosted(entry, hash); const j = r.joins[join];
            if (!j) throw new HttpError(404, "no such join");
            if (j.answer !== null || j.refused !== null) throw new HttpError(409, "this join is already answered");
            j[role === "answer" ? "answer" : "refused"] = value; r.touched = now;
            return { entry: r, result: undefined };
          });
          return json({ ok: true });
        }
        if (role === "close") {
          await store.mutate("rooms", room, entry => { hosted(entry, hash); return { entry: null, result: undefined }; });
          return json({ ok: true });
        }
        throw new HttpError(422, "a room role is host, join, answer, refuse, or close");
      }
      const name = parameter(url, "session");
      if (!NAME.test(name)) throw new HttpError(422, "a session name is lowercase words separated by dashes, 64 characters at most");
      if (method === "GET") {
        const { entry } = await store.read("sessions", name);
        if (!entry) throw new HttpError(404, `no session named "${name}"`);
        return json({ name, ...entry });
      }
      if (method !== "POST") throw new HttpError(405, "use GET, POST, or OPTIONS");
      const connectCode = await code(request);
      if (role === "offer" || role === "answer") {
        await store.mutate("sessions", name, (entry, now, index) => {
          if (role === "offer") {
            if (!entry && Object.keys(index.sessions).length >= 256) throw new HttpError(503, "the signalling server is full");
            return { entry: { offer: connectCode, answer: null, created: now }, result: undefined };
          }
          if (!entry) throw new HttpError(404, `no session named "${name}"`);
          const s = entry as Session;
          if (s.answer !== null) throw new HttpError(409, `the session "${name}" is already answered`);
          s.answer = connectCode; return { entry: s, result: undefined };
        });
        return json({ ok: true }, role === "offer" ? 201 : 200);
      }
      throw new HttpError(422, 'the role is either "offer" or "answer"');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, { ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}), ...(error.status === 405 ? { Allow: "GET, POST, OPTIONS" } : {}) });
      // Database errors may contain SQL parameters (SDP addresses or tokens).
      console.error("Signalling request failed", error instanceof Error ? error.name : "Unknown error");
      return json({ error: "the signalling server failed" }, 503);
    }
  };
}
const stores = new WeakMap<Database, Store>();
export default async function signallingRoute(request: Request, context: { env: { DB?: Database } }): Promise<Response> {
  // OPTIONS does not need a database, just as in the PHP implementation.
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const db = context.env.DB;
  if (!db) return json({ error: "the signalling database is unavailable" }, 503);
  let store = stores.get(db);
  if (!store) { store = createDatabaseStore(db); stores.set(db, store); }
  return createSignallingHandler(store)(request);
}
