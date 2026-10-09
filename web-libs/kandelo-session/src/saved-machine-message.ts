// Saved machine messages — a saved machine's home, kept by one computer while
// the other computer runs the machine.
//
// The computer that saved the machine keeps its home in IndexedDB. After it
// hands the machine over, it offers the other computer the saved state (no
// bytes), the other computer reads the running home against that state and
// sends what changed, and the keeper writes each change and answers it.
//
// Every message is the other computer's input. A path names an entry under the
// home directory and nothing else: an entry that could reach outside it is
// refused here, before it is written to IndexedDB and later seeded into a
// machine.

import { canonicalAbsolutePath } from "./boot-descriptor";
import type { SavedState } from "./home-tracker";
import { presentableMachineName } from "./machine-name";
import type { SavedMachineChanges, SavedMachineEntry } from "./saved-machine";

const REASON_MAX_LENGTH = 500;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export type SavedMachineMessage =
  /** Keeper: run the home against this saved state and send what changes. */
  | { readonly type: "offer"; readonly name: string; readonly home: string; readonly states: [string, SavedState][] }
  /** Runner: the machine runs here and its changes will come. */
  | { readonly type: "accept" }
  /** Runner: the home changed, and the changes come once they settle. */
  | { readonly type: "modified" }
  | ({ readonly type: "changes"; readonly seq: number } & SavedMachineChanges)
  /** Keeper: the changes numbered `seq` are in the saved copy. */
  | { readonly type: "saved"; readonly seq: number }
  | { readonly type: "failed"; readonly seq: number; readonly reason: string }
  /** Runner: the machine stopped here and no other computer took it. */
  | { readonly type: "stopped" };

export class SavedMachineMessageError extends Error {}

export function parseSavedMachineMessage(raw: unknown): SavedMachineMessage {
  const message = record(raw, "message");
  switch (message.type) {
    case "offer": {
      const name = typeof message.name === "string" ? presentableMachineName(message.name) : null;
      if (name === null) throw new SavedMachineMessageError("offer names no machine");
      if (typeof message.home !== "string" || message.home === "/" || !canonicalAbsolutePath(message.home)) {
        throw new SavedMachineMessageError(`offer names no home directory: ${JSON.stringify(message.home)}`);
      }
      return { type: "offer", name, home: message.home, states: list(message.states, "states").map(pathState) };
    }
    case "accept":
    case "modified":
    case "stopped":
      return { type: message.type };
    case "changes":
      return {
        type: "changes",
        seq: sequence(message.seq),
        put: list(message.put, "put").map(entry),
        remove: list(message.remove, "remove").map(path),
      };
    case "saved":
      return { type: "saved", seq: sequence(message.seq) };
    case "failed":
      if (typeof message.reason !== "string") throw new SavedMachineMessageError("failure gives no reason");
      return { type: "failed", seq: sequence(message.seq), reason: message.reason.slice(0, REASON_MAX_LENGTH) };
    default:
      throw new SavedMachineMessageError(`unknown message type: ${JSON.stringify(message.type)}`);
  }
}

function pathState(raw: unknown): [string, SavedState] {
  const pair = list(raw, "state");
  if (pair.length !== 2) throw new SavedMachineMessageError("a state is not a path and a state");
  const fields = record(pair[1], "state");
  const node = owner(fields);
  if (fields.kind === "directory") return [path(pair[0]), { ...node, kind: "directory" }];
  if (fields.kind === "symlink") return [path(pair[0]), { ...node, kind: "symlink", target: target(fields.target) }];
  if (fields.kind !== "file") throw new SavedMachineMessageError(`unknown state kind: ${JSON.stringify(fields.kind)}`);
  if (typeof fields.digest !== "string" || !DIGEST_RE.test(fields.digest)) {
    throw new SavedMachineMessageError("a file state has no SHA-256 digest");
  }
  return [path(pair[0]), { ...node, kind: "file", mtimeMs: time(fields.mtimeMs), digest: fields.digest }];
}

function entry(raw: unknown): SavedMachineEntry {
  const fields = record(raw, "entry");
  const node = { path: path(fields.path), ...owner(fields) };
  if (fields.kind === "directory") return { ...node, kind: "directory" };
  if (fields.kind === "symlink") return { ...node, kind: "symlink", target: target(fields.target) };
  if (fields.kind !== "file") throw new SavedMachineMessageError(`unknown entry kind: ${JSON.stringify(fields.kind)}`);
  if (!(fields.bytes instanceof Uint8Array)) throw new SavedMachineMessageError(`file ${node.path} has no bytes`);
  return { ...node, kind: "file", mtimeMs: time(fields.mtimeMs), bytes: fields.bytes };
}

/** A path under the home directory: relative, and with no `.` or `..` component. */
function path(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || !canonicalAbsolutePath(`/${raw}`)) {
    throw new SavedMachineMessageError(`not a path under the home directory: ${JSON.stringify(raw)}`);
  }
  return raw;
}

function owner(fields: Record<string, unknown>): { mode: number; uid: number; gid: number } {
  for (const key of ["mode", "uid", "gid"] as const) {
    const value = fields[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new SavedMachineMessageError(`${key} is not a non-negative integer`);
    }
  }
  return { mode: fields.mode as number, uid: fields.uid as number, gid: fields.gid as number };
}

function target(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw.includes("\0")) {
    throw new SavedMachineMessageError("a symlink has no target");
  }
  return raw;
}

function time(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new SavedMachineMessageError("a file has no modification time");
  return raw;
}

function sequence(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new SavedMachineMessageError("a change has no sequence number");
  }
  return raw;
}

function record(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SavedMachineMessageError(`${what} is not an object`);
  }
  return raw as Record<string, unknown>;
}

function list(raw: unknown, what: string): unknown[] {
  if (!Array.isArray(raw)) throw new SavedMachineMessageError(`${what} is not a list`);
  return raw;
}
