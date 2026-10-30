/** Unwired v1 kernel/host receipt bytes. Decoding grants no owner authority.
 * No production pending dispatch, Detach or custody transfer is enabled. */
import { ERRNO } from "../generated/abi.js";
import { KERNEL_GL_QUERY_CONTROL } from "./ops.js";
export const QUERY_RECEIPT_MAGIC = 0x43525147;
export const QUERY_RECEIPT_VERSION = 1;
export const QUERY_RECEIPT_REQUEST_HEADER = 48;
export const QUERY_RECEIPT_REPLY_HEADER = 32;
const CAP = 65536;
export type QueryControl = "begin" | "poll" | "commit" | "cancel" | "forget";
export type QueryMode = "commit" | "cancel";
export interface QueryBegin {
  op: number; capacity: number; hasCurrent: boolean; context: number | null;
  draw: number; read: number; input: Uint8Array;
}
export interface QueryReceiptRequest { control: QueryControl; token: bigint; begin?: QueryBegin }
export type QueryReceiptReply = { phase: "pending" }
  | { phase: "ready"; result: number; bytes: Uint8Array }
  | { phase: "retiring"; mode: QueryMode }
  // Retired proves cleanup. accepted is publicationAccepted for commit and
  // accepted cancellation for cancel, which must be true. Ready proves neither.
  | { phase: "retired"; mode: QueryMode; accepted: boolean }
  | { phase: "rejected"; error: number };
export interface ExpectedQueryReply {
  control: QueryControl; token: bigint; capacity: number; retirementMode?: QueryMode;
}
const controls = { begin: 1, poll: 2, commit: 3, cancel: 4, forget: 6 } as const;
const errnos = new Set<number>(Object.values(ERRNO));
function malformed(): never { throw new Error("Malformed query receipt"); }
function unsupported(): never { throw new Error("Unsupported query receipt custody transfer"); }
function uint(value: number): boolean { return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff; }
function tokenValid(token: bigint): boolean { return typeof token === "bigint" && token > 0n && token <= 0x7fff_ffff_ffff_ffffn; }
function controlTag(control: QueryControl): number { return Object.hasOwn(controls,control) ? controls[control] : malformed(); }
function modeTag(mode: QueryMode): number { return mode === "commit" ? 1 : mode === "cancel" ? 2 : malformed(); }
function decodeMode(value: number): QueryMode { return value === 1 ? "commit" : value === 2 ? "cancel" : malformed(); }
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); }
function header(bytes: Uint8Array, min: number, max: number): { v: DataView; token: bigint } {
  if (bytes.byteLength < min || bytes.byteLength > max) return malformed();
  const v = view(bytes);
  if (v.getUint32(0,true) !== QUERY_RECEIPT_MAGIC || v.getUint16(4,true) !== QUERY_RECEIPT_VERSION) return malformed();
  const token = BigInt(v.getUint32(8,true)) | (BigInt(v.getUint32(12,true)) << 32n);
  if (!tokenValid(token)) return malformed();
  return {v,token};
}
function blank(size: number, tag: number, token: bigint): Uint8Array {
  if (!tokenValid(token)) return malformed();
  const bytes = new Uint8Array(size), v = view(bytes);
  v.setUint32(0,QUERY_RECEIPT_MAGIC,true); v.setUint16(4,QUERY_RECEIPT_VERSION,true); v.setUint16(6,tag,true);
  v.setUint32(8,Number(token & 0xffff_ffffn),true); v.setUint32(12,Number(token >> 32n),true);
  return bytes;
}
function validBegin(b: QueryBegin): void {
  if (!uint(b.op) || b.op === KERNEL_GL_QUERY_CONTROL || !uint(b.capacity) || b.capacity > CAP
    || b.input.byteLength > CAP || !uint(b.draw) || !uint(b.read) || typeof b.hasCurrent !== "boolean"
    || (b.context !== null && (!uint(b.context) || b.context === 0))
    || (!b.hasCurrent && (b.context !== null || b.draw !== 0 || b.read !== 0))
    || (b.hasCurrent && b.context === null)) malformed();
}
export function encodeQueryRequest(request: QueryReceiptRequest): Uint8Array {
  const tag = controlTag(request.control), b = request.begin;
  if ((request.control === "begin") !== (b !== undefined)) return malformed();
  if (b) validBegin(b);
  const bytes = blank(48+(b?.input.byteLength ?? 0),tag,request.token), v = view(bytes);
  if (b) {
    v.setUint32(16,b.op,true); v.setUint32(20,b.input.byteLength,true); v.setUint32(24,b.capacity,true);
    v.setUint32(28,Number(b.hasCurrent) | (Number(b.context !== null)<<1),true);
    v.setUint32(32,b.context ?? 0,true); v.setUint32(36,b.draw,true); v.setUint32(40,b.read,true);
    bytes.set(b.input,48);
  } return bytes;
}
export function decodeQueryRequest(bytes: Uint8Array): QueryReceiptRequest {
  const {v,token} = header(bytes,48,48+CAP), tag = v.getUint16(6,true);
  if (tag === 5) return unsupported();
  const control = (Object.keys(controls) as QueryControl[]).find(key => controls[key] === tag);
  if (!control || v.getUint32(44,true) !== 0) return malformed();
  if (control !== "begin") {
    if (bytes.byteLength !== 48 || bytes.subarray(16).some(value => value !== 0)) return malformed();
    return {control,token};
  }
  const flags = v.getUint32(28,true), context = v.getUint32(32,true);
  if ((flags & ~3) !== 0 || v.getUint32(20,true) !== bytes.byteLength-48 || (!(flags&2) && context !== 0)) return malformed();
  const begin: QueryBegin = {op:v.getUint32(16,true),capacity:v.getUint32(24,true),hasCurrent:!!(flags&1),
    context:flags&2 ? context : null,draw:v.getUint32(36,true),read:v.getUint32(40,true),input:bytes.slice(48)};
  validBegin(begin); return {control,token,begin};
}
function validateReply(reply: QueryReceiptReply, e: ExpectedQueryReply): void {
  controlTag(e.control);
  if (!tokenValid(e.token) || !uint(e.capacity) || e.capacity > CAP
    || (["commit","cancel","forget"].includes(e.control) && e.retirementMode === undefined)
    || (e.control === "commit" && e.retirementMode !== "commit")
    || (e.control === "begin" && e.retirementMode !== undefined)) malformed();
  if (e.retirementMode !== undefined) modeTag(e.retirementMode);
  if ((reply.phase === "pending" || reply.phase === "ready")
      && (!["begin","poll"].includes(e.control) || e.retirementMode !== undefined)) malformed();
  if ((reply.phase === "retired" && (e.control === "begin" || e.retirementMode === undefined))
    || (reply.phase === "retiring" && reply.mode === "commit" && e.retirementMode === undefined)
    || (reply.phase === "retiring" && e.control === "forget")
    || (reply.phase === "rejected" && e.control !== "begin")) malformed();
  if (reply.phase === "ready") {
    if (!Number.isInteger(reply.result) || reply.result < -0x8000_0000 || reply.result > 0x7fff_ffff
      || (reply.result < 0 && !errnos.has(-reply.result))
      || reply.bytes.byteLength !== Math.max(0,reply.result) || reply.bytes.byteLength > e.capacity) malformed();
  } else if (reply.phase === "retiring" || reply.phase === "retired") {
    modeTag(reply.mode);
    if (e.retirementMode !== undefined && e.retirementMode !== reply.mode) malformed();
    if (reply.phase === "retired" && (typeof reply.accepted !== "boolean" || (reply.mode === "cancel" && !reply.accepted))) malformed();
  } else if (reply.phase === "rejected" && !errnos.has(reply.error)) malformed();
}
export function encodeQueryReply(reply: QueryReceiptReply, e: ExpectedQueryReply): Uint8Array {
  validateReply(reply,e);
  let tag: number, result = 0, flags = 0;
  let payload: Uint8Array = new Uint8Array(0);
  switch (reply.phase) {
    case "pending": tag = 1; break;
    case "ready": tag = 2; result = reply.result; payload = reply.bytes; break;
    case "retiring": tag = 3; flags = modeTag(reply.mode); break;
    case "retired": tag = 4; flags = modeTag(reply.mode) | (Number(reply.accepted)<<2); break;
    case "rejected": tag = 6; result = -reply.error; break;
    default: return malformed();
  }
  const bytes = blank(32+payload.byteLength,tag,e.token), v = view(bytes);
  v.setInt32(16,result,true); v.setUint32(20,payload.byteLength,true); v.setUint32(24,flags,true); bytes.set(payload,32); return bytes;
}
export function decodeQueryReply(bytes: Uint8Array, e: ExpectedQueryReply): QueryReceiptReply {
  const {v,token} = header(bytes,32,32+CAP), tag = v.getUint16(6,true);
  if (token !== e.token || v.getUint32(28,true) !== 0 || v.getUint32(20,true) !== bytes.byteLength-32) return malformed();
  if (tag === 5) return unsupported();
  const result = v.getInt32(16,true), flags = v.getUint32(24,true);
  if ((tag !== 2 && bytes.byteLength !== 32) || ([1,3,4].includes(tag) && result !== 0)) return malformed();
  let reply: QueryReceiptReply;
  switch (tag) {
    case 1: if (flags) return malformed(); reply = {phase:"pending"}; break;
    case 2: if (flags) return malformed(); reply = {phase:"ready",result,bytes:bytes.slice(32)}; break;
    case 3: reply = {phase:"retiring",mode:decodeMode(flags)}; break;
    case 4: if (flags & ~7) return malformed(); reply = {phase:"retired",mode:decodeMode(flags&3),accepted:!!(flags&4)}; break;
    case 6: if (flags || result >= 0) return malformed(); reply = {phase:"rejected",error:-result}; break;
    default: return malformed();
  }
  validateReply(reply,e); return reply;
}
