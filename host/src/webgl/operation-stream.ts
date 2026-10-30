import { QOP_CREATE_FENCE, QOP_FENCE_STATUS, QOP_RELEASE_FENCE } from "./ops.js";

/** The ordering owner is one kernel-authorized GL session, independent of a
 * reusable public context slot. Tickets retain scalars and this ledger only;
 * no guest memory, callback, query destination or forwarding port is stored. */
export type GlOperationKind = "commands" | "query" | "fence-create" | "fence-status"
  | "fence-release" | "present" | "make-current";
type State = "queued" | "running" | "complete" | "cancelled";
const immediateRefusals = {
  busy:Object.freeze({state:"busy" as const}),closed:Object.freeze({state:"closed" as const}),
  exhausted:Object.freeze({state:"exhausted" as const}),allocationFailure:Object.freeze({state:"allocation-failure" as const}),
};

export class GlOperationTicket {
  constructor(private readonly stream: GlOperationStream,
    readonly kind: GlOperationKind, readonly sequence: number) {}
  get ready(): boolean { return this.stream.ready(this); }
  start(): boolean { return this.stream.start(this); }
  finish(): void { this.stream.finish(this); }
  cancel(): boolean { return this.stream.cancel(this); }
}

export class GlOperationStream {
  private tickets: GlOperationTicket[] = [];
  private states = new WeakMap<GlOperationTicket, State>();
  private serial = 0;
  private closed = false;

  reserve(kind: GlOperationKind): GlOperationTicket | null {
    if (this.closed || this.serial === Number.MAX_SAFE_INTEGER) return null;
    try {
      const ticket = new GlOperationTicket(this, kind, this.serial + 1);
      this.states.set(ticket, "queued");
      this.tickets.push(ticket);
      this.serial++;
      return ticket;
    } catch { return null; }
  }

  /** Immediate results cannot outlive the caller's output authority. Refuse
   * before admission when an accepted prefix has not completed; a future
   * asynchronous path must own a detached result receipt instead. */
  immediateState(): "idle" | "busy" | "closed" | "exhausted" {
    if (this.closed) return "closed";
    if (this.serial === Number.MAX_SAFE_INTEGER) return "exhausted";
    return this.tickets.length ? "busy" : "idle";
  }
  tryBeginImmediateTyped(kind: Exclude<GlOperationKind, "commands">):
    {state:"entered";ticket:GlOperationTicket} | {state:"busy"|"closed"|"exhausted"|"allocation-failure"} {
    const state = this.immediateState();
    if (state !== "idle") return immediateRefusals[state];
    const ticket = this.reserve(kind);
    if (!ticket) return immediateRefusals.allocationFailure;
    let entered:{state:"entered";ticket:GlOperationTicket};
    try { entered={state:"entered",ticket}; }
    catch {ticket.cancel();return immediateRefusals.allocationFailure;}
    if (!ticket.start()) { ticket.cancel(); return this.closed ? immediateRefusals.closed : immediateRefusals.allocationFailure; }
    return entered;
  }
  tryBeginImmediate(kind: Exclude<GlOperationKind, "commands">): GlOperationTicket | null {
    const result = this.tryBeginImmediateTyped(kind);
    return result.state === "entered" ? result.ticket : null;
  }

  ready(ticket: GlOperationTicket): boolean {
    return !this.closed && this.tickets[0] === ticket && this.states.get(ticket) === "queued";
  }
  start(ticket: GlOperationTicket): boolean {
    if (!this.ready(ticket)) return false;
    this.states.set(ticket, "running");
    return true;
  }
  finish(ticket: GlOperationTicket): void {
    if (this.states.get(ticket) !== "running") return;
    this.states.set(ticket, "complete");
    this.compact();
  }
  cancel(ticket: GlOperationTicket): boolean {
    const state = this.states.get(ticket);
    if (state === undefined || state === "running") return false;
    if (state === "queued") this.states.set(ticket, "cancelled");
    this.compact();
    return true;
  }
  close(): void {
    this.closed = true;
    for (const ticket of this.tickets) if (this.states.get(ticket) === "queued") this.states.set(ticket, "cancelled");
    this.compact();
  }
  get pending(): number { return this.tickets.length; }
  private compact(): void {
    while (this.tickets.length) {
      const state = this.states.get(this.tickets[0]);
      if (state !== "complete" && state !== "cancelled") return;
      this.tickets.shift();
    }
  }
}

export function queryOperationKind(op: number): "query" | "fence-create" | "fence-status" | "fence-release" {
  return op === QOP_CREATE_FENCE ? "fence-create" : op === QOP_FENCE_STATUS ? "fence-status"
    : op === QOP_RELEASE_FENCE ? "fence-release" : "query";
}
