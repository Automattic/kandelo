import { ERRNO } from "../generated/abi";
import type { OverlayActivationCodecCall } from "./overlay-activation-codec";

export interface ImageBindingIdentity {
  generation: number;
  digest: string;
  content: string;
  initialized: boolean;
  version: number;
}

export type ImageBindingState = {
  phase: "active";
  target: ImageBindingIdentity;
} | {
  phase: "prepared";
  target: ImageBindingIdentity;
  source: ImageBindingIdentity;
};

export class UnprovenImageFreshnessError extends Error {
  readonly recovery = "unproven-image-freshness";

  constructor(message = "Cannot prove the latest persistent image state; refusing an older checkpoint", options?: ErrorOptions) {
    super(message, options);
    this.name = "UnprovenImageFreshnessError";
  }
}

export type ImageBindingPolicyCall = (operation: 19 | 20, input: Uint8Array) => ReturnType<OverlayActivationCodecCall> | Promise<ReturnType<OverlayActivationCodecCall>>;

export interface ImageBindingSelection {
  choice: "primary" | "target" | "source" | "empty";
  repair: boolean;
}

function evidencePacket(primary: ImageBindingIdentity | null, binding: ImageBindingState | null): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  const target = binding?.target;
  const source = binding?.phase === "prepared" ? binding.source : undefined;
  let flags = 0;
  for (const [index, identity] of [primary, target, source].entries()) {
    if (identity == null) continue;
    flags |= 1 << index;
    if (identity.initialized) flags |= 16 << index;
    view.setFloat64(8 + 16 * index, typeof identity.version === "number" ? identity.version : NaN, true);
    view.setFloat64(16 + 16 * index, typeof identity.generation === "number" ? identity.generation : NaN, true);
  }
  const matches = (primary !== null && target !== undefined && primary.digest === target.digest ? 1 : 0)
    | (primary !== null && source !== undefined && primary.digest === source.digest ? 2 : 0)
    | (primary !== null && target !== undefined && primary.content === target.content ? 4 : 0)
    | (source !== undefined && target !== undefined && source.content === target.content ? 8 : 0);
  view.setUint32(0, flags, true);
  view.setUint32(4, matches, true);
  return bytes;
}

async function invoke(call: ImageBindingPolicyCall, operation: 19 | 20, input: Uint8Array): Promise<Uint8Array> {
  const result = await call(operation, input);
  if (typeof result === "number") {
    if (result === -ERRNO.EIO) throw new UnprovenImageFreshnessError();
    if (Number.isInteger(result) && result < 0) throw Object.assign(new Error("Native image binding policy refused its request"), { errno: -result });
    throw new Error("Native image binding policy returned no bytes");
  }
  if (result.length !== (operation === 19 ? 0 : 8)) throw new Error("Native image binding policy returned invalid transport geometry");
  return result;
}

export async function validateImageBindingState(call: ImageBindingPolicyCall, binding: ImageBindingState): Promise<void> {
  await invoke(call, 19, evidencePacket(null, binding));
}

export async function selectImageBinding(
  call: ImageBindingPolicyCall,
  primary: ImageBindingIdentity | null,
  binding: ImageBindingState | null,
): Promise<ImageBindingSelection> {
  const bytes = await invoke(call, 20, evidencePacket(primary, binding));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const choice = view.getUint32(0, true);
  const repair = view.getUint32(4, true);
  if (choice > 3 || repair > 1) throw new Error("Native image binding policy returned an invalid selection");
  return { choice: (["empty", "primary", "target", "source"] as const)[choice]!, repair: repair === 1 };
}
