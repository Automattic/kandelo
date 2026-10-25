import { validateSessionOffer, type SessionOffer } from "./package-sessions";

export const ACTIVITY_CHANNEL = "activity-offers-v1";
export const MAX_ACTIVITY_OFFERS_BYTES = 16 * 1024;

export function activityOffersMessage(offers: readonly SessionOffer[]): string {
  if (offers.length > 32) throw new Error("Too many advertised activities");
  const ids = new Set<string>();
  for (const offer of offers) {
    validateSessionOffer(offer);
    const id = `${offer.package}/${offer.offer}`;
    if (ids.has(id)) throw new Error("Duplicate advertised activity");
    ids.add(id);
  }
  const message = JSON.stringify({ version: 1, type: "offers", offers });
  if (new TextEncoder().encode(message).byteLength > MAX_ACTIVITY_OFFERS_BYTES) throw new Error("Advertised activities exceed 16 KiB");
  return message;
}

/** Host-owned discovery only: advertisements carry offers, never launch code. */
export class SessionActivityPeer {
  private disposed = false;
  private retry: ReturnType<typeof setInterval> | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private lastHello = -Infinity;
  constructor(
    private channel: RTCDataChannel,
    private hosting: boolean,
    private advertised: () => readonly SessionOffer[],
    private received: (offers: SessionOffer[]) => void,
    private failed: (message: string) => void,
  ) {
    channel.addEventListener("message", this.message);
    channel.addEventListener("close", this.closed);
    if (!hosting) {
      // RTC can open before the remote controller attaches its listener.
      this.retry = setInterval(() => this.request(), 500);
      this.timeout = setTimeout(() => this.fail("The host did not advertise its activities"), 15_000);
      this.request();
    }
  }
  private request() {
    if (!this.disposed && this.channel.readyState === "open") {
      try { this.channel.send(JSON.stringify({ version: 1, type: "hello" })); }
      catch { this.fail("The activity connection is unavailable"); }
    }
  }
  publish(): void {
    if (this.disposed || !this.hosting || this.channel.readyState !== "open") return;
    if (this.channel.bufferedAmount > MAX_ACTIVITY_OFFERS_BYTES * 4) { this.fail("The activity connection is congested"); return; }
    try { this.channel.send(activityOffersMessage(this.advertised())); }
    catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }
  private message = (event: MessageEvent) => {
    if (this.disposed) return;
    try {
      if (typeof event.data !== "string" || event.data.length > MAX_ACTIVITY_OFFERS_BYTES
        || new TextEncoder().encode(event.data).byteLength > MAX_ACTIVITY_OFFERS_BYTES) throw new Error("Invalid activity advertisement size");
      const value = JSON.parse(event.data);
      if (!value || value.version !== 1 || typeof value !== "object") throw new Error("Invalid activity advertisement version");
      if (this.hosting) {
        if (value.type !== "hello" || Object.keys(value).some(key => !["version", "type"].includes(key))) throw new Error("Only the host can advertise activities");
        if (performance.now() - this.lastHello < 250) return;
        this.lastHello = performance.now();
        this.publish();
      } else {
        if (value.type !== "offers" || !Array.isArray(value.offers) || Object.keys(value).some(key => !["version", "type", "offers"].includes(key))) throw new Error("Invalid activity advertisement");
        activityOffersMessage(value.offers);
        clearInterval(this.retry); clearTimeout(this.timeout);
        this.received(value.offers);
      }
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  };
  private closed = () => this.fail("The host's activity connection closed");
  private fail(message: string) { if (!this.disposed) { this.dispose(); this.failed(message); } }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.retry); clearTimeout(this.timeout);
    this.channel.removeEventListener("message", this.message);
    this.channel.removeEventListener("close", this.closed);
  }
}
