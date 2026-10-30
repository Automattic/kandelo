import { isKernelExportFailure } from "../kernel-entry-gate.js";
/** Actual copied-byte accounting shared by one object group. The RPC chunk
 * limit is independent of this staging resource budget. */
export class GlUniformLookupBudget {
  private usedBytes = 0;
  constructor(readonly limit = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid uniform lookup byte budget");
  }
  get used(): number { return this.usedBytes; }
  allocate(length: number): GlUniformLookupBytes | null {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.limit-this.usedBytes) return null;
    try {
      const value=new GlUniformLookupBytes(this,new Uint8Array(length));
      this.usedBytes+=length;return value;
    } catch (error) { if(isKernelExportFailure(error)) throw error; return null; }
  }
  release(length: number): void {
    if(length>this.usedBytes) throw new Error("Uniform lookup byte charge lost");
    this.usedBytes-=length;
  }
}
export class GlUniformLookupBytes {
  private data: Uint8Array<ArrayBuffer> | null;
  constructor(private budget: GlUniformLookupBudget, bytes: Uint8Array<ArrayBuffer>) { this.data=bytes; }
  get bytes(): Uint8Array<ArrayBuffer> {
    if(!this.data) throw new Error("Uniform lookup bytes retired");
    return this.data;
  }
  release(): void {
    if(!this.data) return;
    this.budget.release(this.data.byteLength);this.data=null;
  }
}
