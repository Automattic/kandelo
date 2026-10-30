/** Actual narrow renderer cleanup custody for deferred scalar root retirement.
 * This is not a callback, guest binding proxy or a transport success marker. */
import { isKernelExportFailure } from "../kernel-entry-gate.js";
import type { GlContextRegistry,GlContextExecutionLease,GlExecutionRetirementReceipt } from "./registry.js";
import { retainSurfaceStorage,type GlSurfaceStorageLease } from "./surface-resources.js";
import type { GlFenceOwner } from "./fences.js";
import type { GlMuxer } from "./muxer.js";
import { captureNativeGlErrors } from "./errors.js";
import { repairNativeState, type NativeRetirementReceipt } from "./native-recovery.js";
import type { GlOperationStream } from "./operation-stream.js";
import { glSubmitExecuting } from "./submit-drain.js";
export type GlForwardRetirementKind="context"|"surface"|"session";

export class GlForwardNativeRetirement {
  private executionReceipts:GlExecutionRetirementReceipt[]|null=null;
  private storageReceipt:NativeRetirementReceipt|null=null;
  private fenceReceipts:NativeRetirementReceipt[]|null=null;
  private wake:(()=>void)|undefined;
  private execution:GlContextExecutionLease|null=null;
  private storage:GlSurfaceStorageLease|null=null;
  private fences:GlFenceOwner|null=null;
  private contexts=new Set<WebGL2RenderingContext>();
  private prepared=false;
  private abandoned=false;
  private revoked=false;
  private finished=false;
  private contextId:number|null=null;
  private surfaceId:number|null=null;
  constructor(readonly kind:GlForwardRetirementKind,readonly source:number,
    readonly pid:number,readonly session:number,private operations:GlOperationStream,private strictPhysical=false) {}
  watch(wake:()=>void):void {this.wake=wake;for(const receipt of this.executionReceipts??[])receipt.watch(wake);this.storageReceipt?.watch(wake);for(const receipt of this.fenceReceipts??[])receipt.watch(wake);if(this.finished)wake();}
  /** Allocate/capture every actual capability before revoking public roots.
   * A failed capture remains owned here and retryable; never report an ACK. */
  prepare(registry:GlContextRegistry,muxers:WeakMap<WebGL2RenderingContext,GlMuxer>):boolean {
    if(this.abandoned)return false;
    if(this.prepared)return true;
    const binding=registry.get(this.pid,this.session);if(!binding || binding.operations!==this.operations)return false;
    if(this.kind==="context" && binding.contextId!==this.source)return false;
    if(this.kind==="surface" && binding.surfaceId!==this.source)return false;
    try {
      if(binding.gl && this.kind!=="surface") {
        const muxer=muxers.get(binding.gl);if(!muxer)return false;
        this.contexts.add(binding.gl);
        this.execution??=registry.retainContextExecution(this.pid,this.session,muxer);
        if(!this.execution)return false;
      }
      if(this.kind!=="context" && binding.surface.gl) {
        this.contexts.add(binding.surface.gl);
        if(binding.surface.presentTarget || binding.surface.borrowedTarget) {
          this.storage??=retainSurfaceStorage(binding.surface);if(!this.storage)return false;
          if(this.strictPhysical && binding.surface.presentTarget) {
            this.storageReceipt??=this.storage.observeRetirement();if(!this.storageReceipt)return false;
            if(this.wake)this.storageReceipt.watch(this.wake);
          }
        }
      }
      if(this.kind==="session") {
        this.fences=binding.fences;
        if(this.strictPhysical && this.fenceReceipts===null) {
          this.fenceReceipts=this.fences.captureRetirements();if(!this.fenceReceipts)return false;
          if(this.wake)for(const receipt of this.fenceReceipts)receipt.watch(this.wake);
        }
        for(const gl of this.fences.contexts())this.contexts.add(gl);
      }
      if(this.strictPhysical && this.executionReceipts===null) {
        this.executionReceipts=registry.captureSessionRetirements(this.pid,this.session,this.operations);
        if(!this.executionReceipts)return false;
        for(const receipt of this.executionReceipts){this.contexts.add(receipt.context);if(this.wake)receipt.watch(this.wake);}
      }
      this.contextId=binding.contextId;this.surfaceId=binding.surfaceId;
      this.prepared=true;return true;
    }catch(error){if(isKernelExportFailure(error))throw error;return false;}
  }
  private capture(muxers:WeakMap<WebGL2RenderingContext,GlMuxer>):void {
    for(const gl of this.contexts) {
      const muxer=muxers.get(gl);if(muxer)muxer.captureCurrentErrors();else captureNativeGlErrors(gl,null);
    }
  }
  private blocked(muxers:WeakMap<WebGL2RenderingContext,GlMuxer>):boolean {
    for(const gl of this.contexts)if(glSubmitExecuting(muxers.get(gl)))return true;
    return false;
  }
  revoke(registry:GlContextRegistry,muxers:WeakMap<WebGL2RenderingContext,GlMuxer>):boolean {
    if(this.revoked)return true;
    if(!this.prepare(registry,muxers))return false;
    if(this.blocked(muxers))return false;
    try {
      const binding=registry.get(this.pid,this.session);
      if(!binding || binding.operations!==this.operations || (this.kind!=="surface" && binding.contextId!==this.contextId)
        || (this.kind!=="context" && binding.surfaceId!==this.surfaceId))return false;
      this.capture(muxers);
      if(this.kind==="context")registry.destroyContext(this.pid,this.session);
      else if(this.kind==="surface")registry.destroySurface(this.pid,this.session);
      else registry.unbind(this.pid,this.session);
      this.revoked=true;return true;
    }catch(error){
      if(isKernelExportFailure(error))throw error;
      // Unbind removes the exact public slot in finally. A captured context
      // lease proves the actual old source is retired even if fence cleanup
      // then throws; keep that fence owner and retry it below.
      if(this.kind==="session" && this.execution?.retired && !registry.get(this.pid,this.session))this.revoked=true;
      return this.revoked;
    }
  }
  retry(muxers:WeakMap<WebGL2RenderingContext,GlMuxer>):boolean {
    if(this.finished)return true;
    if(!this.revoked)return false;
    if(this.blocked(muxers))return false;
    try {
      this.capture(muxers);
      if(this.execution && !this.execution.release())return false;
      this.execution=null;
      if(this.storage && !this.storage.release(null))return false;
      this.storage=null;
      if(this.fences) {
        this.fences.close();
        // Actual fence handles/retirement receipts remain in this narrow owner
        // until deletion succeeds; they are not a numeric cleanup promise.
        if(this.fences.contexts().size)return false;
        this.fences=null;
      }
      for(const gl of this.contexts)if(!repairNativeState(gl))return false;
      if(this.strictPhysical && (this.executionReceipts?.some(receipt=>!receipt.complete)
        || (this.storageReceipt && !this.storageReceipt.complete) || this.fenceReceipts?.some(receipt=>!receipt.complete)))return false;
      this.contexts.clear();this.finished=true;return true;
    }catch(error){if(isKernelExportFailure(error))throw error;return false;}
  }
  /** Before any revocation, rollback releases only actual captured holds.
   * Failure keeps those exact holds/journals; it never recaptures a source. */
  abandonPreparation(muxers:WeakMap<WebGL2RenderingContext,GlMuxer>):boolean {
    if(this.abandoned)return true;if(this.revoked)return false;
    try {
      this.capture(muxers);
      if(this.execution && !this.execution.release())return false;this.execution=null;
      if(this.storage && !this.storage.release(null))return false;this.storage=null;
      for(const receipt of this.executionReceipts??[])receipt.forget();this.executionReceipts=null;
      this.storageReceipt?.forget();this.storageReceipt=null;
      for(const receipt of this.fenceReceipts??[])receipt.forget();this.fenceReceipts=null;
      this.fences=null;this.contexts.clear();this.wake=undefined;this.abandoned=true;return true;
    }catch(error){if(isKernelExportFailure(error))throw error;return false;}
  }
  forget():void {if(!this.finished)return;for(const receipt of this.executionReceipts??[])receipt.forget();this.storageReceipt?.forget();for(const receipt of this.fenceReceipts??[])receipt.forget();this.wake=undefined;}
  get complete():boolean {return this.finished;}
  covers(kind:GlForwardRetirementKind,source:number):boolean {
    return this.prepared && this.kind==="session" && (kind==="session" ? source===0
      : kind==="context" ? source===this.contextId : source===this.surfaceId);
  }
}
