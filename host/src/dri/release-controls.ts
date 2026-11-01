/** Private DRI physical-release codec. No public scheduling is activated here.
 * Provisional R3 constants: replace with generated shared constants once the
 * coordinated kernel-host declaration is generated. Never reuse GL query wire. */
export const DRI_RELEASE_MAGIC = 0x52495244;
export const DRI_RELEASE_VERSION = 1;
export const DRI_RELEASE_HEADER_BYTES = 64;
export const DRI_RELEASE_EFFECT_BYTES = 48;
export const DRI_RELEASE_REPLY_BYTES = 48;
export const DriReleaseControl = {
  Reserve: 1, ReleaseReservation: 2, Begin: 3, Poll: 4, Forget: 5,
} as const;
export const DriReleasePhase = {
  Reserved: 1, ReservationReleased: 2, Pending: 3,
  Rejected: 4, Retired: 5, Forgotten: 6,
} as const;
export type DriReleaseControl = typeof DriReleaseControl[keyof typeof DriReleaseControl];
export type DriReleasePhase = typeof DriReleasePhase[keyof typeof DriReleasePhase];
export type DriReleaseEffect = Readonly<{
  tag: number; sourcePid: number; object: number;
  a: bigint; b: bigint; c: bigint; d: bigint;
}>;
export type DriReleaseRequest = Readonly<{
  control: DriReleaseControl; token: bigint; pid: number;
  execGeneration: bigint; grant: bigint; effects: readonly DriReleaseEffect[];
}>;
const MAX_ID = 0x7fff_ffff_ffff_ffffn;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const positiveId = (id: bigint): boolean => id > 0n && id <= MAX_ID;
const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0 && pid <= 0x7fff_ffff;

/** Copies before parsing. Returned scalars/records retain no kernel/guest
 * buffer, and neither caller mutation nor Memory.grow can change their seal.
 * Allocation exceptions remain pre-entry failures; they are not malformed wire. */
export function decodeDriReleaseRequest(input: Uint8Array): DriReleaseRequest | null {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength < DRI_RELEASE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer);
  const control = view.getUint16(6, true);
  if (view.getUint32(0, true) !== DRI_RELEASE_MAGIC || view.getUint16(4, true) !== DRI_RELEASE_VERSION
      || control < DriReleaseControl.Reserve || control > DriReleaseControl.Forget
      || view.getUint32(20, true) || view.getBigUint64(56, true)) return null;
  const token = view.getBigUint64(8, true), pid = view.getUint32(16, true);
  const execGeneration = view.getBigUint64(24, true), grant = view.getBigUint64(32, true);
  const count = view.getBigUint64(40, true), planBytes = view.getBigUint64(48, true);
  if (!positiveId(token) || !validPid(pid) || count * BigInt(DRI_RELEASE_EFFECT_BYTES) !== planBytes
      || planBytes !== BigInt(bytes.byteLength - DRI_RELEASE_HEADER_BYTES)) return null;
  if (control === DriReleaseControl.Reserve ? grant !== 0n : !positiveId(grant)) return null;
  if (control <= DriReleaseControl.ReleaseReservation && count !== 0n) return null;
  const effects: DriReleaseEffect[] = [];
  for (let offset = DRI_RELEASE_HEADER_BYTES; offset < bytes.byteLength; offset += DRI_RELEASE_EFFECT_BYTES) {
    const tag = view.getUint32(offset, true), sourcePid = view.getInt32(offset + 4, true);
    const object = view.getUint32(offset + 8, true);
    const a = view.getBigUint64(offset + 16, true), b = view.getBigUint64(offset + 24, true);
    const c = view.getBigUint64(offset + 32, true), d = view.getBigUint64(offset + 40, true);
    if (!validPid(sourcePid) || view.getUint32(offset + 12, true) || c || d
        || (tag !== 6 && sourcePid !== pid)) return null;
    switch (tag) {
      case 1: if (!object || !b || a + b > MAX_U64) return null; break;
      case 2: case 3: case 6: if (!object || a || b) return null; break;
      // Actual old framebuffer identity is mandatory; no lease-only hide.
      case 4: if (!object || !a || b) return null; break;
      case 5: if (object || !a || !b) return null; break;
      default: return null;
    }
    effects.push(Object.freeze({tag, sourcePid, object, a, b, c, d}));
  }
  return Object.freeze({control: control as DriReleaseControl, token, pid, execGeneration, grant,
    effects: Object.freeze(effects)});
}

/** Exact ordered plan equality, including multiplicity and foreign ownership.
 * This checks a seal; it does not authenticate a registration or grant. */
export function sameDriReleasePlan(a: DriReleaseRequest, b: DriReleaseRequest): boolean {
  return a.token === b.token && a.pid === b.pid && a.execGeneration === b.execGeneration
    && a.grant === b.grant && a.effects.length === b.effects.length
    && a.effects.every((effect, i) => {
      const other = b.effects[i];
      return effect.tag === other.tag && effect.sourcePid === other.sourcePid && effect.object === other.object
        && effect.a === other.a && effect.b === other.b && effect.c === other.c && effect.d === other.d;
    });
}

/** Reply encoding does not fabricate retirement: the caller must supply the
 * actual receiver phase. Impossible control/phase/errno combinations refuse. */
export function encodeDriReleaseReply(request: DriReleaseRequest, phase: DriReleasePhase,
  grant = request.grant, errno = 0): Uint8Array | null {
  if (!positiveId(request.token) || !validPid(request.pid) || request.execGeneration < 0n
      || request.execGeneration > MAX_U64 || request.control < 1 || request.control > 5) return null;
  const rejected = phase === DriReleasePhase.Rejected;
  if (rejected ? !Number.isInteger(errno) || errno <= 0 || errno > 0x7fff_ffff : errno !== 0) return null;
  if (request.control === DriReleaseControl.Reserve) {
    if (phase !== DriReleasePhase.Reserved && !rejected) return null;
    if (rejected ? grant !== 0n : !positiveId(grant)) return null;
  } else {
    if (grant !== request.grant || !positiveId(grant)) return null;
    if (request.control === DriReleaseControl.ReleaseReservation) {
      if (phase !== DriReleasePhase.ReservationReleased && !rejected) return null;
    } else if (request.control === DriReleaseControl.Forget) {
      if (phase !== DriReleasePhase.Forgotten && phase !== DriReleasePhase.Pending && !rejected) return null;
    } else if (phase !== DriReleasePhase.Pending && phase !== DriReleasePhase.Retired && !rejected) return null;
  }
  const bytes = new Uint8Array(DRI_RELEASE_REPLY_BYTES), view = new DataView(bytes.buffer);
  view.setUint32(0, DRI_RELEASE_MAGIC, true); view.setUint16(4, DRI_RELEASE_VERSION, true);
  view.setUint16(6, phase, true); view.setBigUint64(8, request.token, true);
  view.setBigUint64(16, grant, true); view.setUint32(24, request.pid, true);
  view.setUint32(28, errno, true); view.setBigUint64(32, request.execGeneration, true);
  return bytes;
}
