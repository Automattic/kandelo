import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { createOverlayActivationCodec, type OverlayActivationRecord } from "../../src/vfs/overlay-activation-codec";
import { createOverlaySealCodec } from "../../src/vfs/overlay-seal-codec";
import * as seals from "../../src/vfs/overlay-generation-seal";

const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(resolve(import.meta.dirname,
  "../../../local-binaries/kandelo_image_module32.wasm"))));

export const nativeOverlayControlCall = (operation: number, input: Uint8Array) => filesystem.overlayActivationCodecCall(operation, input);
export const activationCodec = createOverlayActivationCodec(nativeOverlayControlCall);
export const sealCodec = createOverlaySealCodec(nativeOverlayControlCall);
export const encodeOverlayActivation = (record: OverlayActivationRecord) => activationCodec.encode(record);
export const decodeOverlayActivation = (bytes: Uint8Array) => activationCodec.decode(bytes);

type WithoutCodec<Arguments extends unknown[]> = Arguments extends [unknown, ...infer Remaining] ? Remaining : never;
export const writeOverlayGenerationSeal = (...args: WithoutCodec<Parameters<typeof seals.writeOverlayGenerationSeal>>) => seals.writeOverlayGenerationSeal(sealCodec, ...args);
export const writeOverlayGenerationSealSync = (...args: WithoutCodec<Parameters<typeof seals.writeOverlayGenerationSealSync>>) => seals.writeOverlayGenerationSealSync(sealCodec, ...args);
export const verifyOverlayGenerationSeal = (...args: WithoutCodec<Parameters<typeof seals.verifyOverlayGenerationSeal>>) => seals.verifyOverlayGenerationSeal(sealCodec, ...args);
export const digestOverlayStoragePrefix = (...args: WithoutCodec<Parameters<typeof seals.digestOverlayStoragePrefix>>) => seals.digestOverlayStoragePrefix(sealCodec, ...args);
