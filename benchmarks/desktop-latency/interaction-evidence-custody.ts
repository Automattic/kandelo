// Shared Node/browser custody; this diagnostic budget never changes a guest
// operation timeout or turns an offered stimulus into a latency endpoint.
export async function preserveInteractionEvidence<T>(
  operation: () => Promise<T>, localSnapshot: () => unknown,
  sourceSnapshot: () => Promise<unknown>,
  persist: (record: Record<string,unknown>) => void | Promise<void>,
  sourceTimeoutMs: number,
): Promise<T> {
  if(!Number.isInteger(sourceTimeoutMs)||sourceTimeoutMs<1||sourceTimeoutMs>60000)
    throw Error('Invalid explicit source-observation budget');
  let result: T | undefined;
  let failed=false,original:unknown;
  try {result=await operation();} catch(error) {failed=true;original=error;}
  let local:unknown;const observationErrors:unknown[]=[];
  try {local=localSnapshot();} catch(error) {observationErrors.push(error);}
  const base={operationStatus:failed?'failed':'passed',operationError:failed?String(original):null,localEvidence:local};
  const rethrow=(errors:unknown[],message:string):never=>{
    const all=[...(failed?[original]:[]),...errors];
    throw new AggregateError(all,message+': '+all.map(String).join('; '));
  };
  // WHY first: a browser snapshot may never settle after the operation's
  // deadline. Persist known offers/original outcome before entering that RPC.
  try {await persist({...base,phase:'local-captured',sourceStatus:'pending',evidenceAvailable:false,observationErrors:observationErrors.map(String)});}
  catch(error){rethrow([...observationErrors,error],'Interaction local evidence persistence failed');}
  const observed=await observeInteractionSource(sourceSnapshot,sourceTimeoutMs);
  // Both source settlement handlers are owned from creation. A late reply
  // cannot overwrite the persisted timeout or publish a recovered success.
  if(observed.status!=='available')observationErrors.push(observed.error);
  const record={...base,phase:'source-observed',sourceStatus:observed.status,
    sourceEvidence:observed.status==='available'?observed.value:undefined,
    evidenceAvailable:observationErrors.length===0,observationErrors:observationErrors.map(String)};
  try {await persist(record);} catch(error) {
    rethrow([...observationErrors,error],'Interaction evidence persistence failed');
  }
  if(observationErrors.length)rethrow(observationErrors,'Interaction evidence unavailable; no complete measurement');
  if(failed)throw original;
  return result!;
}


/** Bounded diagnostic observation only; late settlement is owned but cannot
 * revise the returned timeout. This does not cancel an underlying browser RPC. */
export async function observeInteractionSource(sourceSnapshot:()=>Promise<unknown>,sourceTimeoutMs:number) {
  if(!Number.isInteger(sourceTimeoutMs)||sourceTimeoutMs<1||sourceTimeoutMs>60000)
    throw Error('Invalid explicit source-observation budget');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const source=Promise.resolve().then(sourceSnapshot).then(
    value=>({status:'available' as const,value}),
    error=>({status:'unavailable' as const,error}),
  );
  const deadline=new Promise<{status:'timeout';error:Error}>(resolve=>{
    timer=setTimeout(()=>resolve({status:'timeout',error:Error('Original input source observation exceeded '+sourceTimeoutMs+'ms')}),sourceTimeoutMs);
  });
  const observed=await Promise.race([source,deadline]);
  clearTimeout(timer);
  return observed;
}
