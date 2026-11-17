import * as G from './generated/program-extensions.ts';

const PAGE=G.MEMORY_GROUP_PAGE_BYTES,CONTROL=G.MEMORY_GROUP_CONTROL/4;
export interface GroupPageExtent {readonly first:number;readonly pages:number}

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
  private locked<T>(operation:(words:Uint32Array)=>T):T {
    this.validate();const lock=new Int32Array(this.memory.buffer,CONTROL*4,1);
    while(Atomics.compareExchange(lock,0,0,1)!==0)Atomics.wait(lock,0,1);
    try {this.validate();return operation(new Uint32Array(this.memory.buffer));}
    finally {Atomics.store(lock,0,0);Atomics.notify(lock,0,1);}
  }
}
