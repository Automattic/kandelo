import {prepareNativeCall,type PreparedNativeCall} from "./native-recovery.js";
/** Scalar setters can already be accepted by the C driver before submit.
 * Admit immutable renderer capabilities and the bounded wire receiver while
 * context creation can still refuse; first Viewport/Color must not allocate
 * a limit row, query extensions, or construct a decoder view afterward. */
import type {GlBinding} from "./registry.js";
import {GlWirePayload} from "./wire-payload.js";
import {maxViewport} from "./limits.js";
import {glesExtensionAdvertised} from "./capabilities.js";
type ScalarNativeCalls={range:PreparedNativeCall;blend:PreparedNativeCall};
const calls=new WeakMap<WebGL2RenderingContext,ScalarNativeCalls>();
/** Only synchronous numeric arguments are shared, never logical shadow or
 * error authority. The caller supplies the current binding to the checked
 * receiver, so a thrown native call still resets exactly its original owner.
 * Weak ownership avoids retaining a native renderer from a retired binding. */
export function scalarNativeCalls(gl:WebGL2RenderingContext):ScalarNativeCalls {
  const known=calls.get(gl);if(known)return known;
  const reserved={range:prepareNativeCall(gl,["depthRange",0,1]),blend:prepareNativeCall(gl,["blendFuncSeparate",1,0,1,0])};
  calls.set(gl,reserved);return reserved;
}
const extendedColors=new WeakMap<WebGL2RenderingContext,boolean>();
export function scalarColorsUnclamped(gl:WebGL2RenderingContext):boolean {
  const known=extendedColors.get(gl);if(known!==undefined)return known;
  // The fallback preserves direct observed module users. Normal guest
  // contexts call this during cold admission, before any local acceptance.
  const extended=glesExtensionAdvertised(gl,"GL_EXT_color_buffer_half_float");
  extendedColors.set(gl,extended);return extended;
}
export function prepareScalarState(b:GlBinding,nativeAdmission=false):void {
  if(!b.gl)return;
  // Null-renderer bindings allocate no decoder. Journals share this same
  // receiver; its only guest-memory hold is the synchronous walk's finally.
  if(!b.wirePayload)b.wirePayload=new GlWirePayload();
  maxViewport(b.gl);scalarNativeCalls(b.gl);
  // Re-admission may reuse a restored native context object. Refresh optional
  // color capability there; ordinary journal activation only reads the cold
  // cache and never adds a capability query to a program switch.
  if(nativeAdmission)extendedColors.set(b.gl,glesExtensionAdvertised(b.gl,"GL_EXT_color_buffer_half_float"));
  else scalarColorsUnclamped(b.gl);
}
