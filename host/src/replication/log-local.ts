/**
 * The decision log on a wire.
 *
 * A replica runs the machine itself and needs the values the primary's host
 * produced. This module carries them: the computer holding the machine
 * publishes its log, and every replica takes the entries in order and feeds
 * them to its own `ReplicationLogReader`.
 *
 * Nothing here is droppable. A framebuffer mirror skips frames when the wire
 * backs up, because a watcher would rather see the current frame than an old
 * one. A missing decision is not a late frame — it is a replica that quietly
 * stopped being the same machine — so a congested wire costs delay and never
 * entries. The channel is expected to queue, which is why the peer link gives
 * this label the handover's deep-queue defaults rather than the mirror's
 * shallow ones.
 *
 * A replica joins at boot and replays from the machine's first decision, so a
 * publisher sends its whole log to a watcher that says hello and streams from
 * there. The recorder therefore keeps every entry; see
 * `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "How a replica joins a GL machine".
 *
 * A replica can also join a machine that is already running, and that join
 * starts here too: the replica asks, and the answer is the machine's state
 * together with the first decision it made after that state was read. Which
 * makes this channel the whole join — state and log — rather than the log
 * alone. See § "How a replica joins a machine that is already running".
 *
 * The protocol is channel-agnostic in the same way the migration transports
 * are: the default is a same-origin `BroadcastChannel`, and any injected
 * `MessageChannelLike` carries the same messages to a remote peer.
 *
 * A recording outlives the channel that published it. A remote link drops —
 * the network hiccuped, the peers reconnect by session name — and everything
 * the wire needs to continue lives in a {@link ReplicationHistory}: the ring
 * of recently published entries and the digest chain over the whole stream.
 * The machine's side suspends its recording instead of stopping it, hands the
 * history to the next wire, and a replica that reports the last sequence it
 * received resumes from the ring — no fresh checkpoint, no second freeze. A
 * position the ring no longer holds is refused, and the replica falls back to
 * the join it would have made anyway.
 */
import type { MessageChannelLike } from "../migration/channel.js";
import type { ReplicationLogEntry } from "./log.js";
import { ReplicationDivergence } from "./log.js";
import { encodeMessage } from "../migration/codec.js";

const LOCAL_REPLICATION_CHANNEL = "kandelo-replication-log";

/**
 * How many entries one running digest covers before it crosses the wire.
 *
 * Small enough that a corrupted or misdecoded entry is caught within a
 * couple of seconds of machine time, large enough that the digest traffic
 * disappears next to the entries it covers.
 */
const DIGEST_INTERVAL = 256;

/**
 * How many bytes of published entries a recording keeps for a resume.
 *
 * The ring exists to ride out a dropped link, not to replace the join: it
 * needs to hold what a machine decides across the seconds-to-minutes a
 * reconnect takes, and a replica whose position fell off the tail still has
 * the checkpoint path. Entries are counted at their codec size, the same
 * bytes the digest folds and the wire carries.
 */
const HISTORY_BYTES = 8 * 1024 * 1024;

/**
 * The chained digest the publisher and every watcher fold entry by entry.
 *
 * The digest is FNV-1a over the codec's bytes for each entry, seeded with
 * the digest so far, so one folded value covers the whole stream in order.
 * It is deliberately synchronous and not cryptographic: the channel is
 * ordered and trusted, so the failure this catches is a defect — a codec
 * that rebuilt an entry differently than it was sent, a publisher and a
 * watcher running builds that disagree about a decision's shape — and a
 * defect has no incentive to search for a collision. Folding synchronously
 * is what lets the publisher post a digest immediately after the entry it
 * covers, which is what lets a watcher verify by position instead of
 * holding hashes for every sequence number.
 */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

function foldDigest(seed: bigint, entry: ReplicationLogEntry): bigint {
  let hash = seed;
  for (const byte of encodeMessage(entry)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash;
}

/**
 * What one recording accumulates and a dropped wire must not lose.
 *
 * Two things live here because both have to survive the channel: the ring of
 * recently published entries, which is what a rejoining replica resumes from,
 * and the digest chain, which is what lets that replica keep verifying a
 * stream it re-entered in the middle. The recording pushes entries in as it
 * makes them — with or without a wire attached — and whichever wire currently
 * publishes the recording subscribes here and folds here.
 *
 * The ring is bounded by codec bytes and evicts oldest-first. Eviction is
 * safe exactly because everything here was already offered to the wire: an
 * entry a replica still needs but the ring no longer holds means the replica
 * is too far behind to resume, and {@link after} says so with `null`.
 */
export class ReplicationHistory {
  readonly #capacityBytes: number;
  readonly #entries: ReplicationLogEntry[] = [];
  readonly #sizes: number[] = [];
  readonly #listeners = new Set<(entries: readonly ReplicationLogEntry[]) => void>();
  #bytes = 0;
  #lastSeq = -1;
  #digest = FNV_OFFSET;
  #digestedThrough = -1;
  #sinceDigest = 0;

  constructor(capacityBytes = HISTORY_BYTES) {
    this.#capacityBytes = capacityBytes;
  }

  /** Keep `entries` for a resume, and hand them to the attached wire. */
  push(entries: readonly ReplicationLogEntry[]): void {
    for (const entry of entries) {
      this.#entries.push(entry);
      const size = encodeMessage(entry).byteLength;
      this.#sizes.push(size);
      this.#bytes += size;
      this.#lastSeq = entry.seq;
    }
    while (this.#bytes > this.#capacityBytes && this.#entries.length > 0) {
      this.#entries.shift();
      this.#bytes -= this.#sizes.shift()!;
    }
    for (const listener of [...this.#listeners]) listener(entries);
  }

  /** Watch entries as they are pushed. Returns an unsubscribe. */
  subscribe(
    listener: (entries: readonly ReplicationLogEntry[]) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What the ring still holds, oldest first. */
  get entries(): readonly ReplicationLogEntry[] {
    return this.#entries;
  }

  /**
   * The entries after `afterSeq`, or null when the ring no longer reaches
   * back that far.
   *
   * An empty array is a valid answer — the replica received everything the
   * recording has made — and null is the refusal that sends it back to the
   * checkpoint path.
   */
  after(afterSeq: number): readonly ReplicationLogEntry[] | null {
    if (afterSeq > this.#lastSeq) return null;
    if (afterSeq === this.#lastSeq) return [];
    const first = this.#entries[0];
    if (first === undefined || first.seq > afterSeq + 1) return null;
    return this.#entries.slice(afterSeq + 1 - first.seq);
  }

  /**
   * Fold one published entry into the digest chain, once.
   *
   * False when the entry was already folded — a backlog resend, a ring
   * replay — so the chain covers every sequence number exactly once however
   * many times the wire repeats it.
   */
  fold(entry: ReplicationLogEntry): boolean {
    if (entry.seq <= this.#digestedThrough) return false;
    this.#digest = foldDigest(this.#digest, entry);
    this.#digestedThrough = entry.seq;
    this.#sinceDigest += 1;
    return true;
  }

  /** Entries folded since the last digest crossed the wire. */
  get sinceDigest(): number {
    return this.#sinceDigest;
  }

  /** The last sequence number folded into the digest. */
  get digestedThrough(): number {
    return this.#digestedThrough;
  }

  /** The digest so far, as the wire sends it. */
  get digestHex(): string {
    return this.#digest.toString(16);
  }

  /** Mark the digest so far as published. */
  settleDigest(): void {
    this.#sinceDigest = 0;
  }
}

/**
 * A recording whose wire is gone but whose machine is still deciding.
 *
 * The machine's side holds one of these across a dropped link: the history
 * keeps absorbing what the recording makes, and the next wire's `serve`
 * either adopts it for a resume or stops it for a fresh join. Whoever holds
 * it owes it a `stop` eventually — a recording nobody resumes must not run
 * for the rest of the session.
 */
export interface SuspendedRecording {
  readonly history: ReplicationHistory;
  readonly stop: () => Promise<void>;
}

/**
 * Where a watcher stands in the published stream.
 *
 * `nextSeq` is the sequence it expects next; `digest` is its fold through
 * `nextSeq - 1`, or null when it joined a stream it could not verify from
 * the middle. A watcher hands this to its successor after a dropped link, so
 * the resumed stream continues both the sequence and the verification.
 */
export interface ReplicationWatchPosition {
  readonly nextSeq: number;
  readonly digest: string | null;
}

/** One running recording a publisher can read and follow. */
export interface ReplicationLogSource {
  /** Every entry recorded so far, in order. */
  readonly entries: readonly ReplicationLogEntry[];
  /** Watch entries as they are recorded. Returns an unsubscribe. */
  onRecord(listener: (entry: ReplicationLogEntry) => void): () => void;
}

/** One replica's view of the primary's log. */
export interface ReplicationLogSink {
  /** Take entries the primary recorded, in the order it recorded them. */
  entries(entries: readonly ReplicationLogEntry[]): void;
  /**
   * The publisher stopped recording.
   *
   * A machine that is no longer recording is no longer replicable from this
   * point on, and a replica must be told so rather than waiting on a log that
   * will not continue.
   */
  ended(): void;
  /**
   * The log arrived with a hole or out of order.
   *
   * The channel is ordered and reliable, so this is a defect in the transport
   * or in the publisher rather than an expected condition. It reaches the sink
   * because a listener that threw would report it nowhere a replica can act
   * on.
   */
  diverged(error: ReplicationDivergence): void;
  /**
   * The publisher's page walked its web preview to `path`.
   *
   * Presentation, not a decision: the machine's inputs already travel as
   * `http` entries, and this names the page the publisher is looking at so a
   * viewer walks its own preview to the same place. A sink without the
   * callback ignores it — a viewer that cannot follow is stale, not
   * diverged.
   */
  navigated?(path: string): void;
  /**
   * Where the publisher's pointer is over its web preview, or null once it
   * left.
   *
   * Presentation like `navigated`: the clicks already travel as `http`
   * entries, and this is the hand a viewer watches move between them. The
   * position is a fraction of the preview surface, because the two pages
   * size their previews differently and a pixel on one names nothing on the
   * other.
   */
  cursor?(position: PreviewCursor | null): void;
  /**
   * How far the publisher scrolled its web preview.
   *
   * Presentation like `cursor`: scrolling asks the machine for nothing, so it
   * appears in no log entry, and a viewer left at the top of a page the
   * publisher already scrolled is watching a different part of it. The
   * position is a fraction of each axis's scrollable distance, because the
   * two pages size their previews differently and the same page is not as
   * tall in both.
   */
  scrolled?(position: PreviewScroll): void;
  /**
   * Where this watcher now stands, after each batch it accepted.
   *
   * A page that may have to resume after a dropped link keeps the latest one:
   * it is the `afterSeq` the resume reports and the digest the successor
   * watch verifies on from. A sink without the callback is a watcher that
   * will never resume, and loses nothing.
   */
  advanced?(position: ReplicationWatchPosition): void;
}

/**
 * How the computer holding the machine lets the other one follow it.
 *
 * "watch" is the mirror only: pixels cross the wire and nothing else. "join"
 * lets the other computer run a replica, which starts by sending it the
 * machine's whole state. That is the owner's disclosure to make, so the grant
 * is published by the machine's side and a viewer only hears it.
 */
export type ReplicationGrant = "watch" | "join";

/** A pointer position as fractions of the web preview surface, 0..1. */
export interface PreviewCursor {
  readonly x: number;
  readonly y: number;
}

/** A scroll position as fractions of the scrollable distance, 0..1. */
export interface PreviewScroll {
  readonly x: number;
  readonly y: number;
}

type LocalReplicationMessage<TMachine> =
  | { readonly kind: "hello" }
  | { readonly kind: "entries"; readonly entries: readonly ReplicationLogEntry[] }
  | { readonly kind: "digest"; readonly seq: number; readonly hash: string }
  | { readonly kind: "navigated"; readonly path: string }
  | { readonly kind: "cursor"; readonly position: PreviewCursor | null }
  | { readonly kind: "scrolled"; readonly position: PreviewScroll }
  | { readonly kind: "miss"; readonly key: string }
  | { readonly kind: "granted"; readonly grant: ReplicationGrant }
  | { readonly kind: "ended" }
  | { readonly kind: "join"; readonly joinId: string }
  | {
      readonly kind: "resume";
      readonly joinId: string;
      readonly afterSeq: number;
    }
  | { readonly kind: "resumed"; readonly joinId: string }
  | { readonly kind: "withdrawn"; readonly joinId: string }
  | { readonly kind: "serving" }
  | {
      readonly kind: "joined";
      readonly joinId: string;
      readonly machine: TMachine;
    }
  | {
      readonly kind: "refused";
      readonly joinId: string;
      readonly reason: string;
    };

/**
 * `TMachine` is the state a replica starts from, and this class never reads
 * inside it: the channel structured-clones whatever it is given. What travels
 * is the same value a handover moves, because a replica and a taker both need
 * an image to restore into and processes to restore — the difference is that
 * the machine keeps running here.
 */
export class LocalReplicationLog<TMachine = never> {
  readonly #channel: MessageChannelLike;
  readonly #digestInterval: number;
  readonly #historyBytes: number;

  constructor(
    channel: string | MessageChannelLike = LOCAL_REPLICATION_CHANNEL,
    options: { digestInterval?: number; historyBytes?: number } = {},
  ) {
    this.#channel =
      typeof channel === "string" ? new BroadcastChannel(channel) : channel;
    this.#digestInterval = options.digestInterval ?? DIGEST_INTERVAL;
    this.#historyBytes = options.historyBytes ?? HISTORY_BYTES;
  }

  /**
   * Put entries on the wire, and fold each one into the recording's digest.
   *
   * Every path that publishes entries — a backlog, a live recording, a
   * capture's held batch, a ring replay — goes through here, so the digest
   * covers the stream a watcher receives, whatever mixture of paths produced
   * it. A hello or a resume re-sends entries already folded, and the
   * history's own guard keeps a re-send from folding twice. The digest goes
   * out right after the entry that completes its interval, on the same
   * ordered channel, which is what lets a watcher verify it against its own
   * running digest by position. The state lives in the history rather than
   * this wire, so the chain survives the wire the way the recording does.
   */
  #postEntries(
    history: ReplicationHistory,
    entries: readonly ReplicationLogEntry[],
  ): void {
    this.#post({ kind: "entries", entries });
    for (const entry of entries) {
      if (!history.fold(entry)) continue;
      if (history.sinceDigest < this.#digestInterval) continue;
      this.#flushDigest(history);
    }
  }

  /** Publish the digest so far, so short intervals verify as whole ones do. */
  #flushDigest(history: ReplicationHistory): void {
    if (history.sinceDigest === 0) return;
    history.settleDigest();
    this.#post({
      kind: "digest",
      seq: history.digestedThrough,
      hash: history.digestHex,
    });
  }

  /**
   * Publish one running recording.
   *
   * Sends the log so far immediately and again for every watcher that says
   * hello, then one message per recorded entry. Returns a stop function, which
   * tells watchers the recording ended.
   */
  publish(source: ReplicationLogSource): () => void {
    // The source retains its own entries, so this history carries only the
    // digest chain; nothing is ever pushed into its ring.
    const history = new ReplicationHistory(this.#historyBytes);
    const backlog = () => {
      if (source.entries.length === 0) return;
      this.#postEntries(history, [...source.entries]);
    };
    const stopRecord = source.onRecord((entry) => {
      this.#postEntries(history, [entry]);
    });
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "hello") backlog();
    };
    this.#channel.addEventListener("message", listener);
    backlog();
    return () => {
      stopRecord();
      this.#channel.removeEventListener("message", listener);
      this.#flushDigest(history);
      this.#post({ kind: "ended" });
    };
  }

  /**
   * Answer a replica that asks to join this machine while it is running.
   *
   * `capture` reads the machine and starts its recording at that one instant —
   * it is a single operation for that reason, and this class does not split it
   * into a read and a start. Everything the machine then decides goes to the
   * `publish` it is handed, and out on this channel to the replica.
   *
   * `capture` returns null to refuse, and the asker hears the refusal instead
   * of waiting out its timeout. Returns a stop function, which stops the
   * recording and tells the replica it ended.
   *
   * One machine records for one replica. A second join arriving while a
   * recording is live is refused rather than restarting the log, because a
   * restart would begin a new sequence 0 under a replica that is midway
   * through the old one.
   *
   * A withdrawn join frees the machine instead of holding it. The asker that
   * withdrew is gone, so a recording claimed in its name would run for nobody
   * while every live join is refused — the machine stops it, and says it is
   * serving again so an asker still waiting re-asks.
   *
   * `options.suspended` is a recording an earlier wire left running when its
   * link died. A `resume` naming a position the recording's ring still holds
   * adopts it — the replay goes out, then live entries, then `resumed`, and
   * `options.resumed` tells the caller its recording is serving again. A
   * position the ring lost is refused. A fresh `join` supersedes it: the
   * asker that joins instead of resuming has no replica the recording could
   * continue, so the recording stops before the machine is read again.
   *
   * Returns the serving's controls: `stop` ends the recording — including a
   * suspended one nobody resumed — and `suspend` detaches from this wire
   * without stopping it, handing back what the next wire's `serve` needs.
   */
  serve(
    capture: (
      publish: (entries: readonly ReplicationLogEntry[]) => void,
    ) => Promise<{ machine: TMachine; stop: () => Promise<void> } | null>,
    options: {
      suspended?: SuspendedRecording | null;
      resumed?: () => void;
    } = {},
  ): { stop: () => void; suspend: () => SuspendedRecording | null } {
    let suspended = options.suspended ?? null;
    let serving: { stop: () => Promise<void> } | null = null;
    let history: ReplicationHistory | null = null;
    let stopPublishing: (() => void) | null = null;
    let capturing = false;
    let servingId: string | null = null;
    const refuse = (joinId: string, reason: string) => {
      this.#post({ kind: "refused", joinId, reason });
    };
    const attach = (adopted: ReplicationHistory) => {
      history = adopted;
      stopPublishing = adopted.subscribe((entries) =>
        this.#postEntries(adopted, entries),
      );
    };
    const detach = () => {
      stopPublishing?.();
      stopPublishing = null;
      history = null;
    };
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "withdrawn") {
        if (message.joinId !== servingId) return;
        servingId = null;
        // A capture still in flight sees the id moved on and lets the
        // recording go when it resolves; a recording already serving stops
        // now. Either way the machine answers the next asker.
        if (serving !== null) {
          const stopping = serving;
          const chain = history;
          serving = null;
          detach();
          void stopping.stop();
          if (chain !== null) this.#flushDigest(chain);
          this.#post({ kind: "ended" });
          this.#post({ kind: "serving" });
        }
        return;
      }
      if (message.kind === "resume") {
        // A repeat of the resume already serving, like a repeated join.
        if (message.joinId === servingId) return;
        if (serving !== null || capturing) {
          refuse(message.joinId, "this machine is already being replicated");
          return;
        }
        const recording = suspended;
        if (recording === null) {
          refuse(message.joinId, "this machine holds no recording to resume");
          return;
        }
        const replay = recording.history.after(message.afterSeq);
        if (replay === null) {
          refuse(
            message.joinId,
            `this machine no longer holds the log after ${message.afterSeq}`,
          );
          return;
        }
        suspended = null;
        servingId = message.joinId;
        serving = { stop: recording.stop };
        // The replay before `resumed`, on the ordered channel, so the asker
        // that hears the answer has already been handed everything it missed.
        if (replay.length > 0) {
          this.#postEntries(recording.history, replay);
        }
        attach(recording.history);
        this.#post({ kind: "resumed", joinId: message.joinId });
        options.resumed?.();
        return;
      }
      if (message.kind !== "join") return;
      // One asker asks more than once: it repeats the question when it hears
      // this machine start answering, because it cannot tell whether the first
      // one arrived before there was anything listening. A repeat is the same
      // join, not a second replica.
      if (message.joinId === servingId) return;
      if (serving !== null || capturing) {
        refuse(message.joinId, "this machine is already being replicated");
        return;
      }
      // A fresh join while a recording sits suspended is the asker saying it
      // has no replica to resume. The recording continues for nobody from
      // here on, so it stops before the machine is read again.
      if (suspended !== null) {
        const parked = suspended;
        suspended = null;
        void parked.stop();
      }
      capturing = true;
      servingId = message.joinId;
      // Held back until the join is answered. The recording still starts at
      // the capture instant — the entries go out, in order, right before the
      // `joined` — but a capture whose asker withdraws publishes nothing, so
      // no other watcher absorbs sequence numbers from a recording that
      // never served anyone. Held outside the history: the ring may evict,
      // and nothing may be evicted before it was ever offered to the wire.
      let held: ReplicationLogEntry[] | null = [];
      const fresh = new ReplicationHistory(this.#historyBytes);
      void capture((entries) => {
        if (held !== null) {
          held.push(...entries);
          return;
        }
        fresh.push(entries);
      }).then(
        (joined) => {
          capturing = false;
          if (joined === null) {
            if (servingId !== message.joinId) return;
            servingId = null;
            refuse(message.joinId, "this machine cannot be read right now");
            return;
          }
          if (servingId !== message.joinId) {
            // The asker withdrew while the machine was being read.
            void joined.stop();
            this.#post({ kind: "serving" });
            return;
          }
          serving = joined;
          // After the recorder is running, so nothing the machine decides
          // between the read and this message is lost: the replica is already
          // watching entries by the time it asks.
          const releasing = held;
          held = null;
          if (releasing !== null && releasing.length > 0) {
            fresh.push(releasing);
            this.#postEntries(fresh, releasing);
          }
          attach(fresh);
          this.#post({
            kind: "joined",
            joinId: message.joinId,
            machine: joined.machine,
          });
        },
        (error: unknown) => {
          capturing = false;
          if (servingId !== message.joinId) return;
          servingId = null;
          refuse(
            message.joinId,
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    };
    this.#channel.addEventListener("message", listener);
    // Says a machine is here now. Which computer holds the machine changes —
    // a take-over swaps the two — so a replica can be waiting before the
    // machine it is waiting for starts answering, and a single unanswered
    // question would leave it waiting out its whole timeout.
    this.#post({ kind: "serving" });
    return {
      stop: () => {
        this.#channel.removeEventListener("message", listener);
        // A recording still suspended here has nobody left to resume it.
        const parked = suspended;
        suspended = null;
        if (parked !== null) void parked.stop();
        const stopping = serving;
        const chain = history;
        serving = null;
        servingId = null;
        detach();
        if (stopping === null) return;
        void stopping.stop();
        if (chain !== null) this.#flushDigest(chain);
        this.#post({ kind: "ended" });
      },
      suspend: () => {
        this.#channel.removeEventListener("message", listener);
        const stopping = serving;
        const chain = history;
        serving = null;
        servingId = null;
        detach();
        if (stopping !== null && chain !== null) {
          return { history: chain, stop: stopping.stop };
        }
        // Nothing was adopted on this wire; what arrived suspended leaves
        // suspended, for the caller to hand on or stop.
        const parked = suspended;
        suspended = null;
        return parked;
      },
    };
  }

  /**
   * Ask the machine on this channel for the state to start replicating from.
   *
   * Call {@link watch} first. The publisher starts recording inside the read
   * and sends entries from that instant, so a replica that asks before it is
   * watching would miss the decisions its own state does not yet cover.
   *
   * `signal` withdraws the question. The asker re-asks whenever a machine
   * starts answering, so a join outlives the moment it was posted — and an
   * abandoned attempt that cannot withdraw goes on competing with the live
   * one, wins the machine's single recording, and leaves it replicating for
   * nobody while every real join is refused.
   *
   * The signal outlives the answer for the same reason. Once the machine said
   * `joined` it is recording for this asker, and an asker that lets its
   * replica go — the person chose the mirror, the role ended — has to free
   * that recording or every later join is refused. Aborting after the answer
   * posts the same withdrawal, so the attempt's one signal is the whole
   * story: abort it, and the machine serves the next asker whether the answer
   * had arrived or not.
   */
  join(timeoutMs: number, signal?: AbortSignal): Promise<TMachine> {
    const joinId = crypto.randomUUID();
    return new Promise<TMachine>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            `no machine answered the request to replicate it within `
              + `${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      const abort = () => {
        finish();
        // On the wire as well as here: the question already posted may reach
        // the machine after this, and a machine that never hears the
        // withdrawal records for an asker that is gone.
        this.#post({ kind: "withdrawn", joinId });
        reject(new Error("the request to replicate the machine was withdrawn"));
      };
      const listener = (event: MessageEvent) => {
        const message = event.data as LocalReplicationMessage<TMachine>;
        // A machine that started answering after the question was asked never
        // heard it. Ask again rather than wait for a reply to a message that
        // reached nobody.
        if (message.kind === "serving") {
          this.#post({ kind: "join", joinId });
          return;
        }
        if (message.kind === "refused" && message.joinId === joinId) {
          finish();
          reject(new Error(`the machine refused to be replicated: ${message.reason}`));
          return;
        }
        if (message.kind !== "joined" || message.joinId !== joinId) return;
        // Everything but the abort hook. The machine is recording for this
        // asker now, and the hook is how letting the replica go reaches it.
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
        resolve(message.machine);
      };
      const finish = () => {
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
        signal?.removeEventListener("abort", abort);
      };
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new Error("the request to replicate the machine was withdrawn"));
        return;
      }
      signal?.addEventListener("abort", abort);
      this.#channel.addEventListener("message", listener);
      this.#post({ kind: "join", joinId });
    });
  }

  /**
   * Ask the machine on this channel to continue a recording from `afterSeq`.
   *
   * For the replica whose link died: it still runs the machine and still
   * holds every entry through `afterSeq`, so what it needs is the rest of
   * the log, not another checkpoint. Call {@link watch} first, with the
   * position the previous watch reported — the machine replays the missed
   * entries before it answers, and a resume asked before watching would miss
   * them. A watcher that received nothing before the link died asks with
   * `-1` and a fresh watch: a recording that published nothing agrees, and
   * one whose ring lost the start refuses.
   *
   * Resolves when the machine adopted the recording; the entries themselves
   * arrive through the watch. Rejects when the machine refused — it holds no
   * suspended recording, or its ring no longer reaches back to `afterSeq` —
   * and the caller falls back to a full join. `signal` withdraws the ask
   * exactly as {@link join}'s does, and outlives the answer the same way: a
   * resumed recording is freed by aborting, so the machine serves the next
   * asker.
   */
  resume(afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const joinId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            `no machine resumed the recording after ${afterSeq} within `
              + `${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      const abort = () => {
        finish();
        this.#post({ kind: "withdrawn", joinId });
        reject(new Error("the request to resume the recording was withdrawn"));
      };
      const listener = (event: MessageEvent) => {
        const message = event.data as LocalReplicationMessage<TMachine>;
        if (message.kind === "serving") {
          this.#post({ kind: "resume", joinId, afterSeq });
          return;
        }
        if (message.kind === "refused" && message.joinId === joinId) {
          finish();
          reject(new Error(`the machine refused to resume: ${message.reason}`));
          return;
        }
        if (message.kind !== "resumed" || message.joinId !== joinId) return;
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
        resolve();
      };
      const finish = () => {
        clearTimeout(timer);
        this.#channel.removeEventListener("message", listener);
        signal?.removeEventListener("abort", abort);
      };
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new Error("the request to resume the recording was withdrawn"));
        return;
      }
      signal?.addEventListener("abort", abort);
      this.#channel.addEventListener("message", listener);
      this.#post({ kind: "resume", joinId, afterSeq });
    });
  }

  /**
   * Tell every watcher which page this machine's web preview is on.
   *
   * Sent by the publisher whenever its preview navigates, and once when the
   * recording starts, so a viewer that joined mid-session still learns where
   * the user is.
   */
  publishNavigation(path: string): void {
    this.#post({ kind: "navigated", path });
  }

  /**
   * Tell every watcher where this machine's pointer is over its web preview.
   *
   * Sent by the publisher as its pointer moves, and with null when it leaves
   * the preview, so a viewer stops drawing a hand that is no longer there.
   */
  publishCursor(position: PreviewCursor | null): void {
    this.#post({ kind: "cursor", position });
  }

  /**
   * Tell every watcher how far this machine's web preview is scrolled.
   *
   * Sent by the publisher as it scrolls, and once when a page settles, so a
   * viewer that joined mid-page is looking at the part the publisher is.
   */
  publishScroll(position: PreviewScroll): void {
    this.#post({ kind: "scrolled", position });
  }

  /**
   * Tell the publisher its log has no replay of `key`, a request line this
   * watcher's page asked its replica for.
   *
   * The publisher's browser served it from cache, or served it before this
   * replica joined; either way the publisher can still make the request, and
   * once it does, the log carries it to every replica.
   */
  reportMiss(key: string): void {
    this.#post({ kind: "miss", key });
  }

  /**
   * Publish how this machine may be followed.
   *
   * Posted immediately, on every change, and again for every watcher that
   * says hello — the grant is what parks a viewer's join loop, and a viewer
   * that never heard it would ask a machine that does not serve joins and
   * wait out its whole timeout instead. Returns the grant's controls: `set`
   * to change it, `stop` when this computer no longer holds the machine.
   */
  publishGrant(initial: ReplicationGrant): {
    set: (grant: ReplicationGrant) => void;
    stop: () => void;
  } {
    let grant = initial;
    const post = () => this.#post({ kind: "granted", grant });
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "hello") post();
    };
    this.#channel.addEventListener("message", listener);
    post();
    return {
      set: (next) => {
        if (next === grant) return;
        grant = next;
        post();
      },
      stop: () => this.#channel.removeEventListener("message", listener),
    };
  }

  /**
   * Hear how the machine on this channel may be followed. Returns an
   * unsubscribe.
   */
  onGrant(handler: (grant: ReplicationGrant) => void): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "granted") handler(message.grant);
    };
    this.#channel.addEventListener("message", listener);
    return () => this.#channel.removeEventListener("message", listener);
  }

  /**
   * Serve the request lines watchers report missing. Returns an unsubscribe.
   */
  onMiss(handler: (key: string) => void): () => void {
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "miss") handler(message.key);
    };
    this.#channel.addEventListener("message", listener);
    return () => this.#channel.removeEventListener("message", listener);
  }

  /**
   * Deliver the published log into `sink`, in order and without a hole.
   *
   * Says hello so a running publisher answers with what it has. A watcher that
   * joins twice, or that misses a message, would otherwise hand its replica a
   * log that skips or repeats a decision, so an entry that does not continue
   * the sequence is reported as divergence rather than passed on. Returns a
   * stop function.
   *
   * `options.from` continues a predecessor watch whose wire died: the
   * position it last reported through `advanced`. The sequence check picks
   * up at `nextSeq` instead of taking the first entry as the start, and the
   * digest fold continues from the carried value, so a resumed stream stays
   * verified end to end.
   */
  watch(
    sink: ReplicationLogSink,
    options: { from?: ReplicationWatchPosition } = {},
  ): () => void {
    const from = options.from ?? null;
    let nextSeq = from === null ? -1 : from.nextSeq;
    let digest = from?.digest != null ? BigInt(`0x${from.digest}`) : FNV_OFFSET;
    // Verification needs the stream from its first entry: a watcher folding
    // from the middle would disagree with every digest and report a healthy
    // stream as corrupt. Every supported flow starts at zero — a backlog is
    // resent whole, a capture's log starts at the capture — so folding is on
    // until the stream proves it began earlier. A resumed watch inherits its
    // predecessor's answer: the carried digest continues the fold, and a
    // predecessor that was not verifying leaves it off.
    let verifying = from === null ? true : from.digest !== null;
    const listener = (event: MessageEvent) => {
      const message = event.data as LocalReplicationMessage<TMachine>;
      if (message.kind === "ended") {
        sink.ended();
        return;
      }
      if (message.kind === "digest") {
        if (nextSeq < 0) {
          verifying = false;
          return;
        }
        if (!verifying || message.seq < nextSeq - 1) return;
        if (message.seq > nextSeq - 1) {
          sink.diverged(
            new ReplicationDivergence(
              message.seq,
              `the publisher digested through ${message.seq} and this watcher `
                + `received through ${nextSeq - 1}`,
            ),
          );
          return;
        }
        if (message.hash !== digest.toString(16)) {
          sink.diverged(
            new ReplicationDivergence(
              message.seq,
              `the log's running digest through ${message.seq} does not `
                + `match the publisher's`,
            ),
          );
        }
        return;
      }
      if (message.kind === "navigated") {
        sink.navigated?.(message.path);
        return;
      }
      if (message.kind === "cursor") {
        sink.cursor?.(message.position);
        return;
      }
      if (message.kind === "scrolled") {
        sink.scrolled?.(message.position);
        return;
      }
      if (message.kind !== "entries") return;
      const fresh = message.entries.filter((entry) => entry.seq >= nextSeq);
      if (fresh.length === 0) return;
      const first = nextSeq < 0 ? fresh[0]!.seq : nextSeq;
      for (const [offset, entry] of fresh.entries()) {
        if (entry.seq === first + offset) continue;
        sink.diverged(
          new ReplicationDivergence(
            entry.seq,
            `the log jumped to ${entry.seq} where ${first + offset} was next`,
          ),
        );
        return;
      }
      if (nextSeq < 0 && fresh[0]!.seq !== 0) verifying = false;
      if (verifying) {
        for (const entry of fresh) digest = foldDigest(digest, entry);
      }
      nextSeq = fresh[fresh.length - 1]!.seq + 1;
      sink.entries(fresh);
      sink.advanced?.({
        nextSeq,
        digest: verifying ? digest.toString(16) : null,
      });
    };
    this.#channel.addEventListener("message", listener);
    this.#post({ kind: "hello" });
    return () => this.#channel.removeEventListener("message", listener);
  }

  close(): void {
    this.#channel.close();
  }

  #post(message: LocalReplicationMessage<TMachine>): void {
    this.#channel.postMessage(message);
  }
}
