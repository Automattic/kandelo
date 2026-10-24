import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement, type NativeRetirement } from "./native-recovery.js";
import type { GlBinding } from "./registry.js";
import { prepareConvertedVertexData } from "./vertex-data.js";
import { activeVertexArray } from "./buffer-references.js";
import { checkedGlCall, recordGlError } from "./program-objects.js";

const ARRAY = 0x8892, ELEMENT = 0x8893;
const COPY_READ = 0x8f36, COPY_WRITE = 0x8f37;
export const BUFFER_TRANSFER_BYTES = 65536;
type GlVertexDataView = { native: WebGLBuffer; valid: boolean };

type BufferView = { native: WebGLBuffer; valid: boolean };
/** GLES buffer identity is independent of WebGL's vertex/index classification.
 * Exactly one current native view supplies bytes for stale views. */
export type GlBufferStore = {
  views: Map<number, BufferView>;
  converted: Map<string, GlVertexDataView>;
  source: WebGLBuffer;
  size: number;
  usage: number;
};

export function canonicalBuffer(b: GlBinding, native: WebGLBuffer): WebGLBuffer {
  return b.bufferViewOwners.get(native) ?? native;
}

export function allocateNativeBuffer(b: GlBinding, retirement?: NativeRetirement): WebGLBuffer | null {
  let native: WebGLBuffer | null = null;
  if (!checkedGlCall(b, () => { native = b.gl!.createBuffer(); if (retirement) retirement.calls[0][1] = native; })) {
    if (native && !retirement) checkedGlCall(b, () => b.gl!.deleteBuffer(native));
    return null;
  }
  if (!native) recordGlError(b,0x505);
  return native;
}

function boundBuffer(b: GlBinding, target: number): WebGLBuffer | null {
  if (target === ARRAY) return b.shadow.arrayBuffer && canonicalBuffer(b,b.shadow.arrayBuffer);
  if (target === ELEMENT) return activeVertexArray(b).element;
  return null;
}

function nativeView(b: GlBinding, object: WebGLBuffer | null, target: number): WebGLBuffer | null {
  return object && (b.bufferStores.get(object)?.views.get(target)?.native ?? object);
}

/** Run a bounded transfer without changing native copy bindings. */
export function withBufferTransfer(b: GlBinding, source: WebGLBuffer, destination: WebGLBuffer,
    operation: () => boolean): boolean {
  const gl = b.gl!;
  let read: WebGLBuffer | null = null, write: WebGLBuffer | null = null;
  if (!checkedGlCall(b, () => {
    read = gl.getParameter(COPY_READ) as WebGLBuffer | null;
    write = gl.getParameter(COPY_WRITE) as WebGLBuffer | null;
  })) return false;
  return applyNativeChanges(b,[{apply: () => checkedGlCall(b, () => gl.bindBuffer(COPY_READ,source)) &&
    checkedGlCall(b, () => gl.bindBuffer(COPY_WRITE,destination)) && operation(), restore:nativeInverse(b)}],
    {finalizer:nativeInverse(b,[["bindBuffer",COPY_READ,read]],[["bindBuffer",COPY_WRITE,write]])});
}

/** WebGL forbids native copying between its two buffer classes. Only
 * bounded independent bytes enter the host heap. */
function synchronizeView(b: GlBinding, store: GlBufferStore, view: BufferView): boolean {
  if (view.valid) return true;
  const gl = b.gl!;
  let scratch: Uint8Array<ArrayBuffer>;
  try { scratch = new Uint8Array(Math.min(store.size,BUFFER_TRANSFER_BYTES)); }
  catch { recordGlError(b,0x505); return false; }
  const accepted = withBufferTransfer(b,store.source,view.native,() => {
    if (!checkedGlCall(b, () => gl.bufferData(COPY_WRITE,store.size,store.usage))) return false;
    for (let offset=0; offset<store.size; offset+=BUFFER_TRANSFER_BYTES) {
      const bytes = scratch.subarray(0,Math.min(BUFFER_TRANSFER_BYTES,store.size-offset));
      if (!checkedGlCall(b, () => gl.getBufferSubData(COPY_READ,offset,bytes))) return false;
      if (!checkedGlCall(b, () => gl.bufferSubData(COPY_WRITE,offset,bytes))) return false;
    }
    return true;
  });
  if (accepted) view.valid = true;
  return accepted;
}

/** Reserve bookkeeping before native binding. Queued and checked callers use
 * the same acceptance result; rejected candidates never become logical state. */
export function bindBufferObject(b: GlBinding, target: number, name: number): boolean {
  const gl = b.gl!;
  if (target !== ARRAY && target !== ELEMENT) { recordGlError(b,0x500); return false; }
  let object = name ? b.buffers.get(name) ?? null : null;
  const implicit = name !== 0 && object === null;
  const candidate = reserveNativeRetirement(b,[["deleteBuffer",null]]);
  if (!candidate) return false;
  let committed = false;
  let discardCandidate: (() => void) | undefined;
  try {
    if (implicit && !(object = allocateNativeBuffer(b,candidate))) { retireNativeRetirement(candidate); return false; }
    let store = object ? b.bufferStores.get(object) : undefined;
    let view = store?.views.get(target);
    let created: WebGLBuffer | null = implicit ? object : null;
    let newStore = false, newView = false;
    let vao: ReturnType<typeof activeVertexArray> | undefined;
    const previous = target === ARRAY ? b.shadow.arrayBuffer : nativeView(b,boundBuffer(b,target),target);
    const discard = discardCandidate = () => {
      if (implicit) b.buffers.delete(name);
      if (newStore && object) b.bufferStores.delete(object);
      else if (newView) store!.views.delete(target);
      if (newStore || newView) b.bufferViewOwners.delete(view!.native);
      retireNativeRetirement(candidate);
    };
    try {
      if (target === ELEMENT) vao = activeVertexArray(b);
      if (object && !store) {
        view = {native:object,valid:true};
        store = {converted:new Map(),views:new Map([[target,view]]),source:object,size:0,usage:0x88e4};
        newStore = true;
      } else if (store && !view) {
        created = allocateNativeBuffer(b,candidate);
        if (!created) { retireNativeRetirement(candidate); return false; }
        view = {native:created,valid:false}; newView = true;
      }
      // These maps are synchronous implementation bookkeeping, unpublished to
      // the guest until native acceptance; reserve all capacity before effects.
      if (implicit && object) b.buffers.set(name,object);
      if (newStore && object) b.bufferStores.set(object,store!);
      else if (newView) store!.views.set(target,view!);
      if (newStore || newView) b.bufferViewOwners.set(view!.native,object!);
    } catch {
      discard(); recordGlError(b,0x505); return false;
    }
    const accepted = applyNativeChanges(b,[{apply: () => {
      // Classify before COPY_WRITE; otherwise WebGL classifies index data as
      // vertex data. Nested utility repair restores copy selectors first.
      if (newView && !checkedGlCall(b, () => gl.bindBuffer(target,view!.native))) return false;
      if (store && view && !synchronizeView(b,store,view)) return false;
      return checkedGlCall(b, () => gl.bindBuffer(target,view?.native ?? object));
    },restore:nativeInverse(b,[["bindBuffer",target,previous]])}]);
    if (!accepted) { discard(); return false; }
    const native = view?.native ?? object;
    if (target === ARRAY) b.shadow.arrayBuffer = native;
    else vao!.element = object;
    transferNativeRetirement(candidate); committed = true;
    return true;
  } catch { discardCandidate?.(); recordGlError(b,0x505); return false; }
  finally { if (!committed) retireNativeRetirement(candidate); }
}

function updateSource(store: GlBufferStore, target: number): void {
  const source = store.views.get(target)!;
  for (const view of store.views.values()) view.valid = view === source;
  for (const view of store.converted.values()) view.valid = false;
  store.source = source.native;
}

export function replaceBufferData(b: GlBinding, target: number, data: number | Uint8Array<ArrayBuffer>, usage: number): void {
  if (target !== ARRAY && target !== ELEMENT) { recordGlError(b,0x500); return; }
  const object = boundBuffer(b,target), store = object && b.bufferStores.get(object);
  if (!store) { recordGlError(b,0x502); return; }
  if (!checkedGlCall(b, () => {
    if (typeof data === "number") b.gl!.bufferData(target,data,usage);
    else b.gl!.bufferData(target,data,usage);
  })) return;
  store.size = typeof data === "number" ? data : data.byteLength;
  store.usage = usage; updateSource(store,target);
}

export function updateBufferData(b: GlBinding, target: number, offset: number, data: Uint8Array<ArrayBuffer>): void {
  if (target !== ARRAY && target !== ELEMENT) { recordGlError(b,0x500); return; }
  const object = boundBuffer(b,target), store = object && b.bufferStores.get(object);
  if (!store) { recordGlError(b,0x502); return; }
  // Reject before synchronizing; a failed partial update cannot change the
  // authoritative storage or its size/usage metadata.
  if (offset < 0 || offset+data.byteLength > store.size) { recordGlError(b,0x501); return; }
  if (data.byteLength === 0) return;
  const view = store.views.get(target)!;
  if (!synchronizeView(b,store,view)) return;
  if (checkedGlCall(b, () => b.gl!.bufferSubData(target,offset,data))) updateSource(store,target);
}

export function prepareBufferDraw(b: GlBinding, indexed: boolean): boolean {
  const vao = activeVertexArray(b);
  const required = new Map<WebGLBuffer, Set<number>>();
  for (const a of vao.attributes.values()) if (a.enabled && a.buffer && !a.view) required.set(a.buffer,new Set([ARRAY]));
  if (indexed && vao.element) {
    let targets = required.get(vao.element);
    if (!targets) { targets = new Set(); required.set(vao.element,targets); }
    targets.add(ELEMENT);
  }
  for (const [object,targets] of required) {
    const store = b.bufferStores.get(object);
    if (!store) continue;
    for (const target of targets) {
      const view = store.views.get(target);
      if (!view) { recordGlError(b,0x502); return false; }
      if (!synchronizeView(b,store,view)) return false;
    }
  }
  for (const a of vao.attributes.values()) if (a.enabled && a.view && !prepareConvertedVertexData(b,a)) return false;
  return true;
}

/** Both native views end with the single logical object's last reference. */
export function destroyBufferStorage(b: GlBinding, object: WebGLBuffer): boolean {
  const store = b.bufferStores.get(object);
  const natives = new Set([object, ...[...(store?.views.values() ?? []), ...(store?.converted.values() ?? [])].map(view => view.native)]);
  for (const native of natives) if (!checkedGlCall(b, () => b.gl!.deleteBuffer(native))) return false;
  for (const native of natives) b.bufferViewOwners.delete(native);
  b.bufferStores.delete(object);
  return true;
}
