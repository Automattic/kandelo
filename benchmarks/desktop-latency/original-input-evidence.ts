// Opt-in measurement evidence only. No application path imports this module.
export type OriginalInput = {
  kind: string; eventAt: number; handlerAt: number; trusted: boolean;
  target: string | null; clientX?: number; clientY?: number; key?: string;
  code?: string; repeat?: boolean; button?: number; deltaX?: number; deltaY?: number;
  coalesced: Array<{eventAt: number; clientX?: number; clientY?: number; trusted: boolean}>;
};
export type OfferedInput = {id: string; kind: string; offeredAt: number};
type Limits = {session: string; maxInputs?: number; maxOffers?: number; maxCoalesced?: number};

/** A bounded, realm-independent ledger, never an input/response correspondence
 * oracle. Null targets and coalesced inputs remain evidence for the caller. */
export function createOriginalInputEvidence(options: Limits) {
  const limit = (n: number | undefined, fallback: number, name: string) => {
    const v = n ?? fallback;
    if (!Number.isInteger(v) || v < 1 || v > 65536) throw Error('Invalid '+name+' capacity');
    return v;
  };
  if (!options.session || options.session.length > 128) throw Error('Invalid input evidence session');
  const maxInputs = limit(options.maxInputs, 8192, 'input');
  const maxOffers = limit(options.maxOffers, 8192, 'offer');
  const maxCoalesced = limit(options.maxCoalesced, 256, 'coalesced');
  const inputs: Array<OriginalInput & {seq: number; epoch: number}> = [];
  const offers: Array<OfferedInput & {seq: number; epoch: number}> = [];
  const offerIds = new Set<string>();
  let epoch = 0;
  let failure: null | {reason: string; item: unknown} = null;
  let refusedInputs = 0, refusedOffers = 0;
  let lastRefusedInput: unknown = null, lastRefusedOffer: unknown = null;
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const refuse = (reason: string, item: unknown, kind: 'input' | 'offer') => {
    // WHY terminal: a full buffer must invalidate the run, not discard its
    // slow tail and later report quantiles from the surviving prefix.
    failure ??= {reason, item: copy(item)};
    if (kind === 'input') {refusedInputs++;lastRefusedInput=copy(item);}
    else {refusedOffers++;lastRefusedOffer=copy(item);}
    return false;
  };
  const record = (input: OriginalInput, coalescedCount=input.coalesced.length) => {
    // Refused evidence is bounded too, but keeps the original event endpoint
    // and total coalesced count. The failure explicitly forbids completeness.
    // Copy only the declared scalar evidence, never arbitrary caller fields
    // (which could retain a live Memory/view or an unrelated mutable object).
    const bounded = (value: string | undefined, max: number) => typeof value==='string'?value.slice(0,max):undefined;
    const coalesced = input.coalesced.slice(0,maxCoalesced).map(c=>({eventAt:c.eventAt,clientX:c.clientX,clientY:c.clientY,trusted:c.trusted}));
    const sample: OriginalInput = {kind:bounded(input.kind,64)!,eventAt:input.eventAt,handlerAt:input.handlerAt,trusted:input.trusted,target:input.target===null?null:bounded(input.target,128)!,
      clientX:input.clientX,clientY:input.clientY,key:bounded(input.key,1024),code:bounded(input.code,128),repeat:input.repeat,button:input.button,deltaX:input.deltaX,deltaY:input.deltaY,coalesced};
    const summary = {...sample,coalescedCount,originalKindLength:input.kind?.length??0,originalKeyLength:input.key?.length??0};
    if (failure) return refuse(failure.reason,summary,'input');
    if (!input.kind || input.kind.length>64 || (input.key?.length??0)>1024 || (input.code?.length??0)>128 || (input.target?.length??0)>128 || !Number.isFinite(input.eventAt) || input.eventAt<0 || !Number.isFinite(input.handlerAt)) return refuse('Invalid original input identity/time',{...summary,originalEventAt:String(input.eventAt)},'input');
    if (inputs.length>=maxInputs) return refuse('Original input capacity exceeded',summary,'input');
    if (coalescedCount>maxCoalesced) return refuse('Original coalesced capacity exceeded',summary,'input');
    if (input.coalesced.some(c=>!Number.isFinite(c.eventAt)||c.eventAt<0)) return refuse('Invalid original coalesced time',summary,'input');
    inputs.push({...copy(sample),seq:inputs.length+1,epoch});
    return true;
  };
  return {
    beginEpoch() {epoch++;return epoch;},
    record(input: OriginalInput) {return record(input);},
    recordEvent(event: {type: string;timeStamp: number;isTrusted: boolean;clientX?: number;clientY?: number;key?: string;code?: string;repeat?: boolean;button?: number;deltaX?: number;deltaY?: number;getCoalescedEvents?:()=>Array<{timeStamp:number;clientX?:number;clientY?:number;isTrusted:boolean}>},handlerAt: number,target: string|null=null) {
      try {
        const coalesced=event.getCoalescedEvents?.()??[];
        return record({kind:event.type,eventAt:event.timeStamp,handlerAt,trusted:event.isTrusted,target,
          clientX:event.clientX,clientY:event.clientY,key:event.key,code:event.code,repeat:event.repeat,
          button:event.button,deltaX:event.deltaX,deltaY:event.deltaY,
          coalesced:coalesced.slice(0,maxCoalesced).map(c=>({eventAt:c.timeStamp,clientX:c.clientX,clientY:c.clientY,trusted:c.isTrusted}))},coalesced.length);
      } catch(error) {return refuse('Original input read failed',{kind:event.type,eventAt:event.timeStamp,handlerAt,error:String(error)},'input');}
    },
    offer(offer: OfferedInput) {
      const sample={id:offer.id.slice(0,128),kind:offer.kind.slice(0,64),offeredAt:offer.offeredAt};
      const summary={...sample,originalIdLength:offer.id.length,originalKindLength:offer.kind.length};
      if (failure) return refuse(failure.reason,summary,'offer');
      if (!offer.id || offer.id.length>128 || !offer.kind || offer.kind.length>64 || !Number.isFinite(offer.offeredAt) || offers.length>=maxOffers || offerIds.has(offer.id)) return refuse('Invalid, duplicate or excessive offered identity',summary,'offer');
      offerIds.add(offer.id);offers.push({...sample,seq:offers.length+1,epoch});return true;
    },
    snapshot() {
      // WHY epochs do not clear history/failure: controller resets may reuse
      // coordinates, but may not erase an older input or recover from overflow.
      return copy({session:options.session,epoch,complete:failure===null,inputs,offers,
        currentInputs:inputs.filter(i=>i.epoch===epoch).map((i,index)=>({...i,evidenceSeq:i.seq,seq:index+1})),unmatchedInputs:inputs.filter(i=>i.target===null).length,
        failure,refusedInputs,refusedOffers,lastRefusedInput,lastRefusedOffer});
    },
  };
}
