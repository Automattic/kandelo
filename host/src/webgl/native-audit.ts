/**
 * Native-divergence audit (Stage A1 of the GL predict-then-execute plan).
 *
 * WHY THIS EXISTS. The host still decides whether many guest GL commands
 * were accepted by asking the native renderer: it calls WebGL, then
 * `getError()`, a synchronous round trip to the browser's GPU process. The
 * plan (maintainer decision D-48) makes the host's own GLES 2.0 validation
 * authoritative instead, as a native driver's user-mode validation is, and
 * turns native errors into an audit signal. Before any production path can
 * stop asking, every place where the host does not yet know the outcome has
 * to be found. This module finds them by running the real workloads (dEQP,
 * compositors) with every native call checked against the host's
 * prediction.
 *
 * WHAT IT DOES. When enabled (test-only, never by default), every WebGL 2
 * context created in this realm is instrumented: after each native method
 * call the audit reads native `getError()` immediately and compares the
 * result with the host's prediction for that call. The default prediction
 * is "accepted": a call the host issues without saying otherwise is one the
 * host has validated (guest command) or owns outright (replay, restore,
 * presentation, cleanup). Where the host still leaves the decision to the
 * native renderer, the gap table in native-predictions.ts says so, keyed by
 * the guest op, query or kernel import and the native method, so the audit
 * reports those as known prediction gaps rather than as surprises. A call
 * site can also state a prediction directly (`withNativePrediction`,
 * `predictNextNativeCall`). OUT_OF_MEMORY and CONTEXT_LOST_WEBGL are the
 * genuinely unpredictable boundaries (D-50, context loss); they are
 * recorded but are never divergences.
 *
 * PRODUCTION BEHAVIOR IS UNCHANGED. Errors the audit reads are queued and
 * handed back to the host's own `getError()` calls in GL flag semantics
 * (each distinct flag reported once until read), so checked call sites,
 * muxer error capture and guest glGetError replies see what they would
 * have seen. Only the order of two different pending flags can differ,
 * which ES 2.0 section 2.5 leaves unspecified. With the audit off nothing
 * is instrumented and the hooks below are a single boolean test.
 *
 * MODES. "fatal" is the D-49 audit policy: a divergence is reported, then
 * latched as a fatal host fault naming the op, process, session and batch.
 * "record" reports every divergence and continues, so one run can produce
 * the complete divergence list a fatal run would stop at the first entry
 * of.
 */
import * as O from "./ops.js";
import { nativePredictionGap, type NativePrediction } from "./native-predictions.js";
export { nativeDecides, type NativePrediction } from "./native-predictions.js";

export type GlAuditMode = "record" | "fatal";

export type GlAuditCause =
  | "unpredicted"      // predicted accepted, native raised an error
  | "native-decided"   // a recorded gap (native-predictions.ts) or the site left it to native
  | "wrong-error"      // predicted one error, native raised another
  | "missing-error"    // predicted an error, native accepted
  | "unattributed"     // an error appeared outside any audited call
  | "out-of-memory"    // boundary (D-50)
  | "context-lost"     // boundary
  | "guest-error-flags" // guest UMD prediction differs from the host oracle
  | "instrumented";    // a context came under audit (proves the audit ran)

export interface GlAuditRecord {
  /** "context" records mark each instrumented renderer, so a run with no
   * divergence is distinguishable from a run the audit never reached. */
  kind: "divergence" | "boundary" | "context";
  cause: GlAuditCause;
  mode: GlAuditMode;
  /** Native method and summarized arguments. */
  call: string;
  observed: string;
  predicted: string;
  /** Kernel import (host_gl_submit, host_gl_query, ...) or "unscoped". */
  entry: string;
  entryArgs: readonly number[];
  /** The executing frame's process; otherwise the import's first argument
   * (the process id for GL/GBM imports, not for every KMS import). */
  pid: number | null;
  session: number | null;
  /** Audit-local sequence of entries and executed submission frames. */
  batch: number;
  /** Guest TLV op or query op being executed, when known. */
  op: string | null;
  opArgs: string | null;
  /** First host frame outside this module, then a few callers. */
  site: string;
  stack: readonly string[];
  /** Occurrence number of this (cause, call method, site, op) signature. */
  occurrence: number;
}

export type GlAuditSink = (record: GlAuditRecord) => void;

const GL_OUT_OF_MEMORY = 0x505;
const CONTEXT_LOST_WEBGL = 0x9242;
const ERROR_NAMES: Record<number, string> = {
  0: "NO_ERROR", 0x500: "INVALID_ENUM", 0x501: "INVALID_VALUE", 0x502: "INVALID_OPERATION",
  0x505: "OUT_OF_MEMORY", 0x506: "INVALID_FRAMEBUFFER_OPERATION", 0x9242: "CONTEXT_LOST_WEBGL",
};
/** Methods that cannot raise GL errors: skipping them saves a round trip
 * per call without leaving any error-raising native call unchecked. */
const UNCHECKED_METHODS = new Set([
  "getError", "isContextLost", "getContextAttributes", "getSupportedExtensions", "getExtension",
  "makeXRCompatible", "drawingBufferStorage",
]);

/** Live binding: the hooks in hot paths test only this. */
export let glAuditOn = false;
let mode: GlAuditMode = "record";
let sink: GlAuditSink | null = null;
let fault: ((message: string) => never) | null = null;

type Scope = {
  entry: string; entryArgs: readonly number[]; pid: number | null; session: number | null;
  batch: number; op: string | null; opArgs: string | null;
  /** Raw codes for the gap table (native-predictions.ts). */
  opCode: number | null; queryCode: number | null;
};
let scope: Scope | null = null;
let sequence = 0;
let nextPrediction: NativePrediction | null = null;
let activePrediction: NativePrediction | null = null;
const occurrences = new Map<string, number>();
/** Per signature, how many records are delivered to the sink. Counting
 * continues past it (record.occurrence) so totals stay visible. */
const DELIVERED_PER_SIGNATURE = 64;

/** Enable the audit for this realm. Contexts created afterwards are
 * instrumented through the canvas getContext hook below. */
export function configureGlAudit(options: {
  mode: GlAuditMode; sink: GlAuditSink; fault: (message: string) => never;
}): void {
  if (options.mode !== "record" && options.mode !== "fatal") throw new Error(`Unknown GL audit mode ${String(options.mode)}`);
  mode = options.mode;
  sink = options.sink;
  fault = options.fault;
  glAuditOn = true;
  installGetContextHook();
}

/** Test support: restore the default (off) state. */
export function resetGlAuditForTesting(): void {
  glAuditOn = false; sink = null; fault = null; scope = null; sequence = 0;
  nextPrediction = null; activePrediction = null; occurrences.clear();
}

/** Compare before consuming a locally returned flag. No native query is
 * involved: this oracle independently validated the original guest records. */
export function auditGuestErrorFlags(errors: readonly number[], expected: number): void {
  if (!glAuditOn) return;
  let observed = 0;
  for (const error of errors) {
    const bit = error - 0x500;
    observed |= bit >= 0 && bit <= 6 && (0x67 & (1 << bit)) ? 1 << bit : 0x8000_0000;
  }
  observed >>>= 0;
  if (observed === expected) return;
  report({kind: "divergence", cause: "guest-error-flags"}, "guestErrorFlagMask", errors, observed,
    {kind: "error", error: expected, label: "guest error-flag mask"});
}

/** Parse a mode string from configuration. Unknown values fail loudly: a
 * typo must not silently run an unaudited suite. */
export function parseGlAuditMode(value: unknown): GlAuditMode | undefined {
  if (value === undefined || value === null || value === "" || value === "0" || value === "off") return undefined;
  if (value === "record" || value === "fatal") return value;
  throw new Error(`GL audit mode must be "record" or "fatal", not ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------- scopes

/** Attribute native calls under `work` to one kernel import entry. */
export function withGlAuditEntry<T>(entry: string, args: readonly unknown[], session: number | null, work: () => T): T {
  const previous = scope;
  const pid = typeof args[0] === "number" ? args[0] : null;
  scope = { entry, entryArgs: args.filter((value): value is number => typeof value === "number").slice(0, 8),
    pid, session, batch: ++sequence, op: null, opArgs: null, opCode: null, queryCode: null };
  if (entry === "host_gl_query" && typeof args[1] === "number") { scope.op = queryName(args[1]); scope.queryCode = args[1]; }
  try { return work(); }
  finally { scope = previous; nextPrediction = null; }
}

/** Attribute native calls under `work` to one executed submission frame. */
export function withGlAuditFrame<T>(binding: { pid: number; sessionId: number }, work: () => T): T {
  const previous = scope;
  scope = { entry: previous?.entry ?? "unscoped", entryArgs: previous?.entryArgs ?? [], pid: binding.pid,
    session: binding.sessionId, batch: ++sequence, op: null, opArgs: null, opCode: null, queryCode: null };
  try { return work(); }
  finally { scope = previous; nextPrediction = null; }
}

/** The command-buffer op now executing inside the current frame, or the
 * command a checked query (QOP_IMAGE_STORAGE) carries. */
export function noteGlAuditOp(op: number, payload: DataView): void {
  nextPrediction = null;
  if (!scope) return;
  scope.opCode = op;
  scope.op = scope.queryCode === null ? opName(op) : `${queryName(scope.queryCode)}/${opName(op)}`;
  const words: string[] = [];
  for (let at = 0; at + 4 <= payload.byteLength && words.length < 8; at += 4) words.push(formatNumber(payload.getUint32(at, true)));
  scope.opArgs = `[${words.join(",")}${payload.byteLength > 32 ? ",…" : ""}] ${payload.byteLength}B`;
}

/** Kernel imports whose native GL calls the audit attributes. */
export function isGlAuditEntryName(name: string): boolean {
  return /^host_(gl|kms|gbm)_/.test(name);
}

/** Wrap one GL/KMS/GBM import so the native calls it makes are attributed
 * to it (import name, process, session). */
export function glAuditEntry(name: string, entry: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  const sessionIndex = ENTRY_SESSION_ARGUMENT[name];
  return function (this: unknown, ...args: unknown[]) {
    const session = sessionIndex !== undefined && typeof args[sessionIndex] === "number" ? args[sessionIndex] as number : null;
    return withGlAuditEntry(name, args, session, () => Reflect.apply(entry, this, args));
  };
}
/** Argument index of the GL session for imports that take one. */
const ENTRY_SESSION_ARGUMENT: Record<string, number> = {
  host_gl_bind: 3, host_gl_unbind: 1, host_gl_create_context: 4, host_gl_update_surface: 4,
  host_gl_destroy_surface: 2, host_gl_make_current: 4, host_gl_submit: 3, host_gl_present: 1,
  host_gl_query: 6,
};

// ------------------------------------------------------------ predictions

/** Run `call` (one or more native calls) under an explicit prediction. */
export function withNativePrediction<T>(prediction: NativePrediction | undefined, call: () => T): T {
  if (!glAuditOn || !prediction) return call();
  const previous = activePrediction;
  activePrediction = prediction;
  try { return call(); }
  finally { activePrediction = previous; }
}

/** Declare the prediction for the next native call only (unchecked call
 * sites issue exactly one native call right after this). */
export function predictNextNativeCall(prediction: NativePrediction): void {
  if (glAuditOn) nextPrediction = prediction;
}

// ------------------------------------------------------- instrumentation

type AuditState = { pending: number[]; nativeGetError: () => number };
const instrumented = new WeakMap<object, AuditState>();

/** Instrument one WebGL 2 context (idempotent; inert with the audit off).
 * The context keeps its identity: methods become own properties of the
 * instance, so WeakMap keys, `canvas.getContext` identity checks and
 * `Reflect.apply(gl[name], gl, ...)` dispatch all keep working. */
export function auditGlContext<T extends object | null>(gl: T): T {
  if (!glAuditOn || !gl || instrumented.has(gl)) return gl;
  const context = gl as unknown as Record<string, unknown>;
  const nativeGetErrorMethod = context.getError as (() => number) | undefined;
  if (typeof nativeGetErrorMethod !== "function") return gl;
  const state: AuditState = { pending: [], nativeGetError: () => Reflect.apply(nativeGetErrorMethod, gl, []) as number };
  instrumented.set(gl, state);
  const seen = new Set<string>();
  for (let proto = Object.getPrototypeOf(gl); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name) || name === "constructor") continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== "function" || UNCHECKED_METHODS.has(name)) continue;
      const native = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(gl, name, { configurable: true, writable: true, enumerable: false,
        value: function audited(...args: unknown[]) {
          const prediction = nextPrediction ?? activePrediction
            ?? (scope ? nativePredictionGap(scope.opCode, scope.queryCode, scope.entry, name) ?? null : null);
          nextPrediction = null;
          const result = Reflect.apply(native, gl, args);
          observe(state, name, args, prediction);
          return result;
        } });
    }
  }
  Object.defineProperty(gl, "getError", { configurable: true, writable: true, enumerable: false,
    value: function auditedGetError(): number {
      if (state.pending.length) return state.pending.shift()!;
      const error = state.nativeGetError();
      if (error !== 0) report(classify(error, undefined, true), "getError", [], error, undefined);
      return error;
    } });
  report({ kind: "context", cause: "instrumented" }, "getContext", ["webgl2"], 0, undefined);
  return gl;
}

/** Contexts created by host code in this realm are instrumented where they
 * are created, without changing any creation site. Only installed when the
 * audit is configured; the hook returns the same context object. */
let hookInstalled = false;
function installGetContextHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  for (const ctor of [globalThis.OffscreenCanvas, (globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement]) {
    const proto = (ctor as { prototype?: { getContext?: (...args: unknown[]) => unknown } } | undefined)?.prototype;
    const original = proto?.getContext;
    if (!proto || typeof original !== "function") continue;
    proto.getContext = function (this: unknown, ...args: unknown[]) {
      const context = Reflect.apply(original, this, args);
      return args[0] === "webgl2" && context && typeof context === "object" ? auditGlContext(context) : context;
    };
  }
}

function observe(state: AuditState, method: string, args: readonly unknown[], prediction: NativePrediction | null): void {
  let raised = false;
  for (let i = 0; i < 32; i++) {
    const error = state.nativeGetError();
    if (error === 0) break;
    raised = true;
    // GL flag semantics: a flag already set records nothing new.
    if (!state.pending.includes(error)) state.pending.push(error);
    report(classify(error, prediction ?? undefined, false), method, args, error, prediction ?? undefined);
  }
  if (!raised && prediction?.kind === "error")
    report({ kind: "divergence", cause: "missing-error" }, method, args, 0, prediction);
}

function classify(error: number, prediction: NativePrediction | undefined, unattributed: boolean):
    { kind: GlAuditRecord["kind"]; cause: GlAuditCause } | null {
  if (error === GL_OUT_OF_MEMORY) return { kind: "boundary", cause: "out-of-memory" };
  if (error === CONTEXT_LOST_WEBGL) return { kind: "boundary", cause: "context-lost" };
  if (unattributed) return { kind: "divergence", cause: "unattributed" };
  if (!prediction) return { kind: "divergence", cause: "unpredicted" };
  if (prediction.kind === "native-decides") return { kind: "divergence", cause: "native-decided" };
  return prediction.error === error ? null : { kind: "divergence", cause: "wrong-error" };
}

function report(classification: { kind: GlAuditRecord["kind"]; cause: GlAuditCause } | null, method: string,
    args: readonly unknown[], error: number, prediction: NativePrediction | undefined): void {
  if (!classification) return;
  const stack = callerStack();
  const site = stack[0] ?? "unknown";
  const current = scope;
  const signature = `${classification.cause}|${method}|${site}|${current?.op ?? ""}|${error}`;
  const occurrence = (occurrences.get(signature) ?? 0) + 1;
  occurrences.set(signature, occurrence);
  const record: GlAuditRecord = {
    kind: classification.kind, cause: classification.cause, mode,
    call: `${method}(${args.map(formatArgument).join(", ")})`,
    observed: errorName(error),
    predicted: !prediction ? "accepted" : prediction.kind === "native-decides"
      ? `native-decides ${prediction.label}: ${prediction.rule}` : `${errorName(prediction.error)} (${prediction.label})`,
    entry: current?.entry ?? "unscoped", entryArgs: current?.entryArgs ?? [],
    pid: current?.pid ?? null, session: current?.session ?? null, batch: current?.batch ?? 0,
    op: current?.op ?? null, opArgs: current?.opArgs ?? null, site, stack, occurrence,
  };
  if (occurrence <= DELIVERED_PER_SIGNATURE || mode === "fatal" || record.kind === "context") {
    try { sink?.(record); } catch { /* A failed diagnostic must not change GL behavior. */ }
  }
  if (mode === "fatal" && record.kind === "divergence") {
    fault?.(`GL audit divergence (${record.cause}): ${record.call} raised ${record.observed}, predicted ${record.predicted}; ` +
      `${record.entry} pid ${record.pid ?? "?"} session ${record.session ?? "?"} batch ${record.batch} op ${record.op ?? "?"}` +
      `${record.opArgs ? ` ${record.opArgs}` : ""} at ${site}`);
  }
}

// --------------------------------------------------------------- helpers

function callerStack(): string[] {
  const text = new Error().stack ?? "";
  const frames: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // Frames only: V8 writes "at fn (url:line:col)", SpiderMonkey and
    // JavaScriptCore "fn@url:line:col"; the "Error" header is neither.
    if (!(/^at\s/.test(line) || line.includes("@")) || /native-audit\.(ts|js)/.test(line)) continue;
    // Repository-relative paths; line numbers are those of the code the
    // engine ran (a dev server's transpiled module), so function names are
    // the stable part of a site.
    frames.push(line.replace(/^at /, "").replace(/https?:\/\/[^/]+\/(@fs)?/g, "")
      .replace(/[^\s(@]*\/(host\/src\/)/g, "$1").replace(/\?[^:)]*/g, ""));
    if (frames.length >= 8) break;
  }
  return frames;
}

function formatNumber(value: number): string {
  return value >= 0x100 && Number.isInteger(value) ? `0x${value.toString(16)}` : String(value);
}

function formatArgument(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean" || value === null || value === undefined) return String(value);
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}[${(value as { length?: number }).length ?? value.byteLength}]`;
  if (typeof value === "object") return (value as object).constructor?.name ?? "object";
  return typeof value;
}

function errorName(error: number): string {
  return ERROR_NAMES[error] ?? `0x${error.toString(16)}`;
}

let opNames: Map<number, string> | null = null;
let queryNames: Map<number, string> | null = null;
function names(prefix: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const [name, value] of Object.entries(O)) {
    if (typeof value === "number" && name.startsWith(prefix) && !map.has(value)) map.set(value, name);
  }
  return map;
}
function opName(op: number): string {
  opNames ??= names("OP_");
  return opNames.get(op) ?? `OP_0x${op.toString(16)}`;
}
function queryName(op: number): string {
  queryNames ??= names("QOP_");
  return queryNames.get(op) ?? `QOP_0x${op.toString(16)}`;
}
