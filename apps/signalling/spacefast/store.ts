/** State stays in MySQL; a worker never owns the authoritative session map. */
export interface Session { offer: string; answer: string | null; created: number }
export interface Join extends Session { refused: string | null }
export interface Room { name: string; key: string; touched: number; joins: Record<string, Join> }
export type Kind = "sessions" | "rooms";
export type Entry = Session | Room;
export interface Index {
  sessions: Record<string, { created: number }>;
  rooms: Record<string, { touched: number; joins: Record<string, { created: number }> }>;
}
export interface Change<T> { entry: Entry | null; result: T }
export interface Store {
  read(kind: Kind, key: string): Promise<{ entry: Entry | null; now: number }>;
  mutate<T>(kind: Kind, key: string, change: (entry: Entry | null, now: number, index: Index) => Change<T>): Promise<T>;
}
export class HttpError extends Error {
  status: number;
  retryAfter?: string;
  constructor(status: number, message: string, retryAfter?: string) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export const MAX_STORE_BYTES = 8 * 1024 * 1024;
export const TABLE = "kandelo_signalling_v1";
const EMPTY = '{"sessions":{},"rooms":{}}';
export interface Database {
  prepare(sql: string): {
    bind(...values: (string | number)[]): { all(): Promise<QueryResult> };
    all(): Promise<QueryResult>;
  };
}
export interface QueryResult { success?: boolean; results?: Record<string, unknown>[]; meta?: { changes?: number } }
export function pruneEntry(kind: Kind, value: Entry | null, now: number): Entry | null {
  if (!value) return null;
  if (kind === "sessions") return (value as Session).created + 600 > now ? value : null;
  const room = value as Room;
  if (room.touched + 60 <= now) return null;
  room.joins = Object.fromEntries(Object.entries(room.joins).filter(([, join]) => join.created + 120 > now));
  return room;
}
function parse(value: unknown): any {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}
function integer(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid signalling database integer");
  return n;
}
// Tokens/names are validated by the handler. Quoted JSON paths also keep a
// session named "constructor" or "__proto__" from becoming JS object authority.
const pathFor = (kind: Kind, key: string) => `$."${kind}".${JSON.stringify(key)}`;

interface Delta { sets: { path: string; value: unknown }[]; removes: string[] }
function difference(before: unknown, after: unknown, path: string, delta: Delta): void {
  if (before && after && typeof before === "object" && typeof after === "object") {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) delta.removes.push(`${path}.${JSON.stringify(key)}`);
    for (const [key, value] of Object.entries(b)) difference(a[key], value, `${path}.${JSON.stringify(key)}`, delta);
  } else if (before !== after) delta.sets.push({ path, value: after });
}

export function createDatabaseStore(db: Database): Store {
  async function query(sql: string, ...values: (string | number)[]): Promise<QueryResult> {
    const p = db.prepare(sql);
    const r = await (values.length ? p.bind(...values) : p).all();
    if (r.success === false) throw new Error("Signalling database query failed");
    return r;
  }
  let ready: Promise<void> | undefined;
  async function initialize() {
    // A rejected initialization must be retryable on the next request.
    ready ??= (async () => {
      await query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TINYINT PRIMARY KEY, revision VARCHAR(36) NOT NULL, payload LONGTEXT NOT NULL, expiry LONGTEXT NOT NULL)`);
      await query(`INSERT IGNORE INTO ${TABLE} (id, revision, payload, expiry) VALUES (1, ?, ?, ?)`, crypto.randomUUID(), EMPTY, EMPTY);
    })().catch(error => { ready = undefined; throw error; });
    await ready;
  }
  async function snapshot(kind: Kind, key: string, withIndex: boolean) {
    const select = `SELECT revision, UNIX_TIMESTAMP() AS now, JSON_EXTRACT(payload, ?) AS entry${withIndex ? ", expiry" : ""} FROM ${TABLE} WHERE id = 1`;
    let r: QueryResult;
    try { r = await query(select, pathFor(kind, key)); }
    catch { await initialize(); r = await query(select, pathFor(kind, key)); }
    if (!r.results?.[0] && !ready) { await initialize(); r = await query(select, pathFor(kind, key)); }
    // Existing tables need no DDL or seed round trips on the normal path.

    const row = r.results?.[0];
    if (!row || typeof row.revision !== "string") throw new Error("Missing signalling database row");
    const now = integer(row.now);
    const raw = parse(row.entry) as Entry | null;
    return { revision: row.revision, now, raw, entry: pruneEntry(kind, raw ? structuredClone(raw) : null, now), index: withIndex ? parse(row.expiry) as Index : undefined };
  }
  async function discard(id: string) {
    // Cleanup cannot change a committed request into an apparent failure.
    // The next large request also sweeps abandoned, expired staging rows.
    await query(`DELETE FROM ${TABLE}_staging WHERE id = ?`, id).catch(() => {});
  }
  async function upload(value: unknown): Promise<{ id: string; parts: number }> {
    await query(`CREATE TABLE IF NOT EXISTS ${TABLE}_staging (id VARCHAR(36) PRIMARY KEY, payload LONGBLOB NOT NULL, part INT NOT NULL, created BIGINT NOT NULL)`);
    await query(`DELETE FROM ${TABLE}_staging WHERE created + 300 <= UNIX_TIMESTAMP()`);
    const id = crypto.randomUUID();
    try {
      await query(`INSERT INTO ${TABLE}_staging (id, payload, part, created) VALUES (?, '', 0, UNIX_TIMESTAMP())`, id);
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let parts = 0;
      for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
        const chunk = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 16 * 1024)));
        const r = await query(`UPDATE ${TABLE}_staging SET payload = CONCAT(payload, FROM_BASE64(?)), part = part + 1 WHERE id = ? AND part = ? AND created + 300 > UNIX_TIMESTAMP()`, chunk, id, parts);
        if (integer(r.meta?.changes) !== 1) throw new Error("Signalling upload did not advance");
        parts++;
      }
      return { id, parts };
    } catch (error) { await discard(id); throw error; }
  }
  return {
    async read(kind, key) { const { entry, now } = await snapshot(kind, key, false); return { entry, now }; },
    async mutate(kind, key, change) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const s = await snapshot(kind, key, true);
        const index = s.index!;
        if (!index || !index.sessions || !index.rooms) throw new Error("Corrupt signalling expiry index");
        const patch: any = { sessions: {}, rooms: {} };
        for (const [name, session] of Object.entries(index.sessions)) {
          if (session.created + 600 <= s.now) { delete index.sessions[name]; patch.sessions[name] = null; }
        }
        for (const [token, room] of Object.entries(index.rooms)) {
          if (room.touched + 60 <= s.now) { delete index.rooms[token]; patch.rooms[token] = null; continue; }
          const removed: Record<string, null> = {};
          for (const [join, entry] of Object.entries(room.joins)) {
            if (entry.created + 120 <= s.now) { delete room.joins[join]; removed[join] = null; }
          }
          if (Object.keys(removed).length) patch.rooms[token] = { joins: removed };
        }
        const validUntil = s.entry ? kind === "sessions" ? (s.entry as Session).created + 600 : Math.min((s.entry as Room).touched + 60, ...Object.values((s.entry as Room).joins).map(j => j.created + 120)) : s.now + 60;
        const before = s.entry ? structuredClone(s.entry) : null;
        const { entry, result } = change(s.entry, s.now, index);
        if (entry === null) delete index[kind][key];
        else if (kind === "sessions") index.sessions[key] = { created: (entry as Session).created };
        else {
          const room = entry as Room;
          index.rooms[key] = { touched: room.touched, joins: Object.fromEntries(Object.entries(room.joins).map(([join, value]) => [join, { created: value.created }])) };
        }
        const delta: Delta = { sets: [], removes: [] };
        if (entry === null) delta.removes.push(pathFor(kind, key));
        else difference(before, entry, pathFor(kind, key), delta);
        const revision = crypto.randomUUID();
        const encodedIndex = JSON.stringify(index);
        const envelope = { patch, expiry: index, ...delta };
        // A 64 KiB code is legal, but Spacefast limits a broker operation to
        // 64 KiB including SQL/JSON framing. Stage large deltas in bounded
        // chunks; never shrink the protocol limit or split the final commit.
        const inlineArgs = [JSON.stringify(patch), encodedIndex, ...delta.removes, ...delta.sets.flatMap(set => [set.path, JSON.stringify(set.value)])];
        const large = 2 * new TextEncoder().encode(JSON.stringify(inlineArgs)).length + 4096 > 60 * 1024;
        let stage: { id: string; parts: number } | undefined;
        try {
          if (large) stage = await upload(envelope);
          const args: (string | number)[] = [];
          const extract = (path: string) => `JSON_EXTRACT(CONVERT(staged.payload USING utf8mb4), '${path}')`;
          let expression = `JSON_MERGE_PATCH(state.payload, ${stage ? extract("$.patch") : "JSON_EXTRACT(?, '$')"})`;
          if (!stage) args.push(JSON.stringify(patch));
          if (delta.removes.length) {
            expression = `JSON_REMOVE(${expression}, ${delta.removes.map(() => "?").join(", ")})`;
            args.push(...delta.removes);
          }
          if (delta.sets.length) {
            expression = `JSON_SET(${expression}, ${delta.sets.map((set, i) => {
              args.push(set.path);
              if (!stage) args.push(JSON.stringify(set.value));
              return `?, ${stage ? extract(`$.sets[${i}].value`) : "JSON_EXTRACT(?, '$')"}`;
            }).join(", ")})`;
          }
          const from = `${TABLE} AS state${stage ? ` JOIN ${TABLE}_staging AS staged ON staged.id = ?` : ""}`;
          const fromArgs = stage ? [stage.id] : [];
          const expiry = stage ? extract("$.expiry") : "?";
          const lease = stage ? " AND staged.part = ? AND staged.created + 300 > UNIX_TIMESTAMP()" : "";
          // The revision, expiry and whole-store ceiling belong to ONE UPDATE.
          // The stage is immutable before this statement, not a transaction
          // stretched across multiple broker calls.
          const r = await query(`UPDATE ${from} SET state.payload = ${expression}, state.expiry = ${expiry}, state.revision = ? WHERE state.id = 1 AND state.revision = ? AND OCTET_LENGTH(${expression}) <= ? AND UNIX_TIMESTAMP() < ?${lease}`, ...fromArgs, ...args, ...(stage ? [] : [encodedIndex]), revision, s.revision, ...args, MAX_STORE_BYTES, validUntil, ...(stage ? [stage.parts] : []));
          const changes = integer(r.meta?.changes);
          if (changes === 1) return result;
          if (changes !== 0) throw new Error("Invalid signalling update count");
          const check = await query(`SELECT state.revision, OCTET_LENGTH(${expression}) AS bytes FROM ${from} WHERE state.id = 1`, ...args, ...fromArgs);
          if (check.results?.[0]?.revision === s.revision && integer(check.results[0].bytes) > MAX_STORE_BYTES) throw new HttpError(503, "the signalling server is full");
        } finally {
          if (stage) await discard(stage.id);
        }
        // Re-read and re-authorize after contention, including host ownership,
        // expiry and single-answer rules. Never repeat a stale write blindly.
        await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 30));
      }
      throw new HttpError(503, "the session store is busy", "1");
    },
  };
}
