/**
 * Native-divergence audit for the GL predict-then-execute contract (D-48).
 * Host validation decides guest acceptance; native errors verify that model.
 *
 * Record mode checks every native method so an inventory can identify the
 * offending call. Fatal mode defers accepted guest work to the physical
 * submitted-batch sample: an immediate oracle would put synchronous GPU
 * round trips back into the path whose behavior the audit must exercise.
 * Exact error, native-decided and private bookkeeping checks stay immediate.
 * Before those transitions, held flags retain their original submission token
 * so an older observation cannot poison new work or disappear at a boundary.
 * Nested calls share their outer physical submission and error ownership.
 *
 * Fatal divergence is reported and latched with its process, session and
 * batch; batch sampling does not invent a particular failing operation.
 * Native OOM and context loss retain their documented reset boundaries.
 * Record mode continues to collect findings rather than asserting acceptance.
 *
 * Observed flags are queued with GL flag semantics for the normal checked
 * paths. Reading them for diagnostics must not swallow guest-visible errors.
 * No context is instrumented by default; these hooks are diagnostic controls,
 * not a substitute for the production per-context recovery policy.
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
  | "batch-native-error" // an actual submitted-batch sample, not a per-call observation
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

type FatalBatchPhase = "predicted" | "sample" | "exact";
type GlAuditBatchHooks = {
  configure(mode: GlAuditMode | undefined): void;
  phase(gl: object): FatalBatchPhase | undefined;
  identity(gl: object): object | undefined;
  nativeCall(gl: object, deferred: boolean): void;
  takeDeferred(gl: object): boolean;
  readError(gl: object, error: number, next: () => number, reported?: boolean): never;
  fail(gl: object, detail: string): never;
};
let batchHooks: GlAuditBatchHooks | undefined;
/** The batch module registers after its live dispatcher is initialized. An
 * already-configured realm must install the same adapter as a later configure;
 * otherwise env/URL startup order could silently retain the per-call oracle. */
export function registerGlAuditBatchHooks(hooks: GlAuditBatchHooks): void {
  if (batchHooks) throw new Error("GL audit batch hooks registered twice");
  batchHooks = hooks;
  hooks.configure(glAuditOn ? mode : undefined);
}
function fatalBatchPhase(gl: object): FatalBatchPhase | undefined {
  return glAuditOn && mode === "fatal" ? batchHooks?.phase(gl) : undefined;
}

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
  batchHooks?.configure(mode);
}

/** Test support: restore the default (off) state. */
export function resetGlAuditForTesting(): void {
  glAuditOn = false; sink = null; fault = null; scope = null; sequence = 0;
  nextPrediction = null; activePrediction = null; occurrences.clear();
  batchHooks?.configure(undefined);
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

// Distinguish an older exact oracle flag from an observation in this batch.
// The token is empty: flags must not retain any logical owner or guest memory.
type PendingNativeFlag = { error: number; batch?: object };
type AuditState = { gl:object; pending: PendingNativeFlag[]; nativeGetError: () => number };
function takeBatchFlag(state: AuditState, batch: object): PendingNativeFlag | undefined {
  const index=state.pending.findIndex(flag=>flag.batch===batch);
  return index<0?undefined:state.pending.splice(index,1)[0];
}
function nextBatchFlag(state:AuditState,batch:object):number {
  return takeBatchFlag(state,batch)?.error ?? state.nativeGetError();
}
/** A transition to exact checking first fences older deferred native work.
 * Otherwise its flag could be blamed on the next bookkeeping operation, or a
 * receiver could publish after a different call already poisoned the batch. */
function beforeExactOracle(state:AuditState,gl:object):0|undefined {
  const batch=batchHooks?.identity(gl);
  if(!batch)return undefined;
  const held=takeBatchFlag(state,batch);
  if(held)batchHooks!.readError(gl,held.error,()=>nextBatchFlag(state,batch),true);
  if(batchHooks!.takeDeferred(gl)) {
    const error=state.nativeGetError();
    if(error)batchHooks!.readError(gl,error,()=>nextBatchFlag(state,batch));
    return 0; // A real zero observation, reusable by an explicit getError.
  }
  return undefined;
}
function retainNativeFlag(state:AuditState,error:number,batch?:object):void {
  if(!state.pending.some(flag=>flag.error===error&&flag.batch===batch))state.pending.push({error,batch});
}
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
  const state: AuditState = { gl, pending: [], nativeGetError: () => Reflect.apply(nativeGetErrorMethod, gl, []) as number };
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
          if (!glAuditOn) return Reflect.apply(native, gl, args);
          const prediction = nextPrediction ?? activePrediction
            ?? (scope ? nativePredictionGap(scope.opCode, scope.queryCode, scope.entry, name) ?? null : null);
          nextPrediction = null;
          const phase=fatalBatchPhase(gl);
          if(phase&&(phase==="exact"||prediction||state.pending.length))beforeExactOracle(state,gl);
          let result:unknown;
          try {result=Reflect.apply(native,gl,args);}
          catch(error) {
            if(phase)batchHooks!.fail(gl,`native call threw ${String(error)}`);
            throw error;
          }
          // Undefined means host-validated acceptance. Error predictions and
          // remaining native-decides gaps still need the independent exact
          // oracle. In fatal guest batches the real boundary sample owns all
          // other flags; a fabricated per-call NO_ERROR would prove nothing.
          if(prediction||phase!=="predicted")observe(state,name,args,prediction);
          if(phase)batchHooks!.nativeCall(gl,!prediction&&phase==="predicted");
          return result;
        } });
    }
  }
  Object.defineProperty(gl, "getError", { configurable: true, writable: true, enumerable: false,
    value: function auditedGetError(): number {
      const phase=fatalBatchPhase(gl),batch=phase?batchHooks?.identity(gl):undefined;
      // Older oracle flags retain ordinary drain semantics. Only observations
      // belonging to THIS submission can participate in its boundary sample.
      if(phase==="sample"&&batch)return nextBatchFlag(state,batch);
      const observedZero=phase?beforeExactOracle(state,gl):undefined;
      const held=state.pending.shift();
      if(held) {
        if(batch&&held.batch===batch)batchHooks!.readError(gl,held.error,()=>nextBatchFlag(state,batch),true);
        return held.error;
      }
      const error=observedZero===0?0:state.nativeGetError();
      if(error!==0&&batch)batchHooks!.readError(gl,error,()=>nextBatchFlag(state,batch));
      if(error!==0&&glAuditOn)report(classify(error,undefined,true),"getError",[],error,undefined);
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

/** Attribute a REAL native sample to its submitted owner. The batch marks
 * reset and enforces fatal/OOM policy after this record; throwing from the
 * per-call reporter first would leave that ownership transition incomplete. */
export function reportGlAuditBatchError(owner: {gl: WebGL2RenderingContext; pid: number; sessionId: number},
    error: number, label: string, batch: number): void {
  const phase = fatalBatchPhase(owner.gl);
  if (!phase) return;
  const previous = scope;
  scope = {entry:previous?.entry ?? "native-batch",entryArgs:previous?.entryArgs ?? [],
    pid:owner.pid,session:owner.sessionId,batch,op:null,opArgs:null,opCode:null,queryCode:null};
  try {
    const classification = error === GL_OUT_OF_MEMORY ? {kind:"boundary" as const,cause:"out-of-memory" as const}
      : error === CONTEXT_LOST_WEBGL ? {kind:"boundary" as const,cause:"context-lost" as const}
      : {kind:"divergence" as const,cause:"batch-native-error" as const};
    report(classification,"nativeBatchSample",[label],error,undefined,true);
  } finally { scope = previous; }
}

function observe(state: AuditState, method: string, args: readonly unknown[], prediction: NativePrediction | null): void {
  const batch=fatalBatchPhase(state.gl)?batchHooks?.identity(state.gl):undefined;
  if(batch) {
    const errors:number[]=[];
    for(let i=0;i<32;i++){const error=state.nativeGetError();if(!error)break;errors.push(error);}
    // Preserve allocation custody: an exact OOM oracle hands the native result
    // back to its reserved receiver before the caller's post-check resets it.
    // A tagged unconsumed boundary still fences the next call/final sample.
    const ordered=errors.includes(GL_OUT_OF_MEMORY)?[GL_OUT_OF_MEMORY,...errors.filter(e=>e!==GL_OUT_OF_MEMORY)]:errors;
    for(const error of ordered)retainNativeFlag(state,error,classify(error,prediction??undefined,false)?batch:undefined);
    for(const error of errors)report(classify(error,prediction??undefined,false),method,args,error,prediction??undefined,true);
    if(!errors.length&&prediction?.kind==="error") {
      report({kind:"divergence",cause:"missing-error"},method,args,0,prediction,true);
      batchHooks!.fail(state.gl,`native audit missing-error: ${method} returned NO_ERROR`);
    }
    if(!errors.includes(GL_OUT_OF_MEMORY)) {
      const unexpected=errors.find(error=>classify(error,prediction??undefined,false)?.kind==="divergence");
      if(unexpected!==undefined) {
        const index=state.pending.findIndex(flag=>flag.error===unexpected&&flag.batch===batch);
        if(index>=0)state.pending.splice(index,1);
        batchHooks!.readError(state.gl,unexpected,()=>nextBatchFlag(state,batch),true);
      }
    }
    return;
  }
  let raised = false;
  for (let i = 0; i < 32; i++) {
    const error = state.nativeGetError();
    if (error === 0) break;
    raised = true;
    // GL flag semantics: a flag already set records nothing new.
    retainNativeFlag(state,error);
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
    args: readonly unknown[], error: number, prediction: NativePrediction | undefined, batchWillEnforceFatal = false): void {
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
  if (mode === "fatal" && record.kind === "divergence" && !batchWillEnforceFatal) {
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
