import * as G from './generated/program-extensions.ts';

const PAGE=G.MEMORY_GROUP_PAGE_BYTES,CONTROL=G.MEMORY_GROUP_CONTROL/4;
export interface GroupPageExtent {readonly first:number;readonly pages:number}
export interface GroupImagePageAllocation {readonly controls:GroupPageExtent;readonly scratch:GroupPageExtent}
export type GroupPageAllocationResult = 'allocated' | 'busy' | 'exhausted';

/** Physical allocation primitive shared with the translated C grow helper.
 * Only disposable kernel/process Workers may own it. Its caller must retain
 * image/backing/snapshot custody and prove exact retirement before releasing
 * pages; a PID disappearing or a Worker termination request is not that proof.
 * This primitive alone does not enable grouped execution in the normal host.
 */
export class MemoryGroupPagePool {
  private readonly memory:WebAssembly.Memory;
  private readonly maximumPages:number;
  private constructor(memory:WebAssembly.Memory,maximumPages:number) {
    const buffer = memory.buffer as ArrayBufferLike;
    if(!(buffer instanceof SharedArrayBuffer))throw Error('Group pool requires shared storage');
    if(!Number.isSafeInteger(maximumPages)||maximumPages<2||maximumPages>G.MEMORY_GROUP_MAXIMUM_PAGES)throw RangeError('Group pool capacity is outside the versioned layout');
    if(memory.buffer.byteLength%PAGE||memory.buffer.byteLength<PAGE||memory.buffer.byteLength/PAGE>maximumPages)throw RangeError('Group storage does not fit its admitted capacity');
    this.memory=memory;this.maximumPages=maximumPages;
  }
  static initialize(memory:WebAssembly.Memory,maximumPages:number):MemoryGroupPagePool {
    const pool=new MemoryGroupPagePool(memory,maximumPages);
    const bytes=new Uint8Array(memory.buffer,0,PAGE);
    if(bytes.some(byte=>byte!==0))throw Error('Group metadata must be fresh; never reset a live pool');
    const words=new Uint32Array(memory.buffer);
    words[CONTROL+1]=1;words[CONTROL+2]=maximumPages;
    words[G.MEMORY_GROUP_BITMAP/4]=1; // Physical page zero is never guest payload.
    Atomics.store(words,CONTROL+3,G.MEMORY_GROUP_MAGIC);
    return pool;
  }
  static attach(memory:WebAssembly.Memory,maximumPages:number):MemoryGroupPagePool {
    const pool=new MemoryGroupPagePool(memory,maximumPages);pool.validate();return pool;
  }
  allocateContiguous(pages:number):GroupPageExtent|undefined {
    if(!Number.isSafeInteger(pages)||pages<=0||pages>=this.maximumPages)throw RangeError('Invalid physical page extent');
    return this.locked(words=>{
      let first=1,run=0;
      for(let page=1;page<this.maximumPages;page++) {
        if(this.used(words,page)){run=0;first=page+1;}
        else if(++run===pages) {
          const end=first+pages,size=this.memory.buffer.byteLength/PAGE;
          if(end>size) {
            try{this.memory.grow(end-size);}catch(error){if(error instanceof RangeError)return undefined;throw error;}
          }
          // Shared memory growth leaves old views bounded at the old length.
          const fresh=new Uint32Array(this.memory.buffer);
          new Uint8Array(this.memory.buffer,first*PAGE,pages*PAGE).fill(0);
          for(let p=first;p<end;p++)this.setUsed(fresh,p,true);
          fresh[CONTROL+1]=Math.max(fresh[CONTROL+1],end);
          return Object.freeze({first,pages});
        }
      }
      return undefined;
    });
  }
  /** Nonblocking mapping preparation. The caller owns this independent output
   * before acquiring any lock, and must retain it through publication or exact
   * unpublished rollback. Busy/exhausted leave both output and bitmap intact.
   * Fragmented free pages are useful payload: contiguous virtual addresses do
   * not require contiguous physical storage.
   */
  tryAllocatePages(destination:Uint32Array):GroupPageAllocationResult {
    this.independentPages(destination);
    if(!destination.length||destination.length>=this.maximumPages)throw RangeError('Invalid physical page count');
    return this.tryLocked('busy',words=>{
      let found=0,last=0;
      for(let page=1;page<this.maximumPages&&found<destination.length;page++) {
        if(!this.used(words,page)){found++;last=page;}
      }
      if(found!==destination.length)return 'exhausted';
      const size=this.memory.buffer.byteLength/PAGE;
      if(last>=size) {
        try{this.memory.grow(last+1-size);}catch(error){if(error instanceof RangeError)return 'exhausted';throw error;}
      }
      // Allocate refreshed views and zero every selected page before marking
      // any ownership bits. No fallible allocation follows bitmap publication.
      const fresh=new Uint32Array(this.memory.buffer),bytes=new Uint8Array(this.memory.buffer);
      for(let page=1,at=0;page<=last;page++)if(!this.used(fresh,page)) {
        bytes.fill(0,page*PAGE,(page+1)*PAGE);destination[at++]=page;
      }
      for(let at=0;at<destination.length;at++)this.setUsed(fresh,destination[at],true);
      fresh[CONTROL+1]=Math.max(fresh[CONTROL+1],last+1);
      return 'allocated';
    });
  }
  /** Reserve an unpublished image in one pool entry. Roots and replica controls
   * need contiguous storage; private payload pages may use fragmented holes.
   * Busy/exhausted preserve the caller's output and every allocation bit.
   */
  tryAllocateImage(controlsPages:number,scratchPages:number,payload:Uint32Array):GroupImagePageAllocation|'busy'|'exhausted' {
    this.independentPages(payload);
    const total=controlsPages+scratchPages+payload.length;
    if(!Number.isSafeInteger(controlsPages)||controlsPages<1||!Number.isSafeInteger(scratchPages)||scratchPages<1
        ||!Number.isSafeInteger(total))throw RangeError('Invalid image page allocation');
    if(total>=this.maximumPages)return 'exhausted';
    const selected=new Uint32Array(payload.length);
    return this.tryLocked<GroupImagePageAllocation|'busy'|'exhausted'>('busy',words=>{
      const findRun=(count:number,excludeFirst=0,excludePages=0):number=>{
        let run=0;
        for(let page=1;page<this.maximumPages;page++) {
          if(this.used(words,page)||(page>=excludeFirst&&page<excludeFirst+excludePages))run=0;
          else if(++run===count)return page-count+1;
        }
        return 0;
      };
      // Place the larger contiguous region first, so a small control region
      // cannot consume the only run that fits replica scratch.
      const controlsFirst=controlsPages>=scratchPages;
      const firstCount=controlsFirst?controlsPages:scratchPages,secondCount=controlsFirst?scratchPages:controlsPages;
      const first=findRun(firstCount);
      if(!first)return 'exhausted';
      const second=findRun(secondCount,first,firstCount);
      if(!second)return 'exhausted';
      const controlsStart=controlsFirst?first:second,scratchStart=controlsFirst?second:first;
      let found=0,last=Math.max(controlsStart+controlsPages-1,scratchStart+scratchPages-1);
      for(let page=1;page<this.maximumPages&&found<selected.length;page++) {
        if(!this.used(words,page)&&!(page>=controlsStart&&page<controlsStart+controlsPages)
            &&!(page>=scratchStart&&page<scratchStart+scratchPages)) {
          selected[found++]=page;last=Math.max(last,page);
        }
      }
      if(found!==selected.length)return 'exhausted';
      const size=this.memory.buffer.byteLength/PAGE;
      if(last>=size) {
        try{this.memory.grow(last+1-size);}catch(error){if(error instanceof RangeError)return 'exhausted';throw error;}
      }
      // Prepare every view and result object before publishing ownership.
      const fresh=new Uint32Array(this.memory.buffer),bytes=new Uint8Array(this.memory.buffer);
      const result=Object.freeze({controls:Object.freeze({first:controlsStart,pages:controlsPages}),
        scratch:Object.freeze({first:scratchStart,pages:scratchPages})});
      bytes.fill(0,controlsStart*PAGE,(controlsStart+controlsPages)*PAGE);
      bytes.fill(0,scratchStart*PAGE,(scratchStart+scratchPages)*PAGE);
      for(const page of selected)bytes.fill(0,page*PAGE,(page+1)*PAGE);
      payload.set(selected);
      for(let page=controlsStart;page<controlsStart+controlsPages;page++)this.setUsed(fresh,page,true);
      for(let page=scratchStart;page<scratchStart+scratchPages;page++)this.setUsed(fresh,page,true);
      for(const page of selected)this.setUsed(fresh,page,true);
      fresh[CONTROL+1]=Math.max(fresh[CONTROL+1],last+1);
      return result;
    });
  }
  /** Only a never-published allocation may use this rollback. A busy lock
   * leaves ownership with the caller, which must retry on a later worker turn.
   * This API provides no execution fence for previously published pages.
   */
  tryReleaseUnpublishedPages(pages:Uint32Array):'released'|'busy' {
    this.independentPages(pages);
    for(let at=0;at<pages.length;at++) {
      if(!pages[at]||pages[at]>=this.maximumPages||(at>0&&pages[at]<=pages[at-1])) {
        throw Error('Unpublished page custody must be strictly ordered and unique');
      }
    }
    return this.tryLocked('busy',words=>{
      for(let at=0;at<pages.length;at++)if(!this.used(words,pages[at]))throw Error('Unknown or already released unpublished page');
      for(let at=0;at<pages.length;at++)this.setUsed(words,pages[at],false);
      return 'released';
    });
  }
  /** Requires caller-owned exact retirement proof for every listed page. All
   * validation precedes mutation; a repeated release cannot free a sibling.
   */
  releaseRetiredPages(pages:readonly number[]):void {
    const unique=new Set(pages);
    if(unique.size!==pages.length)throw Error('Duplicate physical page retirement');
    this.locked(words=>{
      for(const page of pages)if(!Number.isSafeInteger(page)||page<=0||page>=this.maximumPages||!this.used(words,page))throw Error('Unknown or already retired physical page');
      for(const page of pages)this.setUsed(words,page,false);
    });
  }
  snapshot():{maximumPages:number;allocatedPages:number;highWaterPages:number;physicalExtentPages:number} {
    return this.locked(words=>{
      let allocatedPages=0;for(let page=0;page<this.maximumPages;page++)if(this.used(words,page))allocatedPages++;
      return {maximumPages:this.maximumPages,allocatedPages,highWaterPages:words[CONTROL+1],physicalExtentPages:this.memory.buffer.byteLength/PAGE};
    });
  }
  private used(words:Uint32Array,page:number):boolean {return (words[G.MEMORY_GROUP_BITMAP/4+(page>>>5)]&(1<<(page&31)))!==0;}
  private setUsed(words:Uint32Array,page:number,value:boolean):void {
    const index=G.MEMORY_GROUP_BITMAP/4+(page>>>5),mask=1<<(page&31);
    words[index]=value?words[index]|mask:words[index]&~mask;
  }
  private validate():void {
    const words=new Uint32Array(this.memory.buffer);
    if(Atomics.load(words,CONTROL+3)!==G.MEMORY_GROUP_MAGIC||words[CONTROL+2]!==this.maximumPages||words[CONTROL+1]<1||words[CONTROL+1]>this.maximumPages||!this.used(words,0))throw Error('Incompatible or corrupt physical group pool');
  }
  private independentPages(pages:Uint32Array):void {
    if(!(pages instanceof Uint32Array)||!(pages.buffer instanceof ArrayBuffer))throw TypeError('Page custody requires independent Uint32 storage');
  }
  private tryLocked<T>(busy:T,operation:(words:Uint32Array)=>T):T {
    this.validate();const lock=new Int32Array(this.memory.buffer,CONTROL*4,1);
    if(Atomics.compareExchange(lock,0,0,1)!==0)return busy;
    try {this.validate();return operation(new Uint32Array(this.memory.buffer));}
    finally {Atomics.store(lock,0,0);Atomics.notify(lock,0,1);}
  }
  private locked<T>(operation:(words:Uint32Array)=>T):T {
    this.validate();const lock=new Int32Array(this.memory.buffer,CONTROL*4,1);
    while(Atomics.compareExchange(lock,0,0,1)!==0)Atomics.wait(lock,0,1);
    try {this.validate();return operation(new Uint32Array(this.memory.buffer));}
    finally {Atomics.store(lock,0,0);Atomics.notify(lock,0,1);}
  }
}
