import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createOriginalInputEvidence} from './original-input-evidence.js';
import {preserveInteractionEvidence,observeInteractionSource} from './interaction-evidence-custody.js';
import {clockBounds,nativeVisibleLatencyBounds,qualifyInjectedDelayBounds} from './clock-bounds.js';
import {calibrateViewport,viewportMarkers} from './viewport-calibration.js';
import {snapshotRaster} from './captured-raster.js';
import {decisionConfiguration,isDecision,requireDecision,type RoiState} from './response-roi.js';
import type {WindowObserver} from './native-observer-client.js';

export async function measureResponseRoi(options:{page:any;observer:WindowObserver;out:string;count:number;native:boolean;label:string;sourceErrors:string[];fault?:'source-error'|'wrong-response'}){
  const {page,observer,out,count,native,label}=options;const stream=observer.stream,budget=stream.defaultTimeoutMs;
  assert(Number.isInteger(count)&&count>=4&&count<=120);
  const session='response-'+randomUUID(),ledger=createOriginalInputEvidence({session});
  let source:any,sealedSource:any,serial=0;
  const local=()=>({clock:'node-monotonic',ledger:ledger.snapshot(),proofScope:'complete-response-rois',completePresentationCoverage:false});
  const persist=(record:any)=>{const text=JSON.stringify(record,null,2);writeFileSync(join(out,`response-evidence-${++serial}-${record.phase}.json`),text);writeFileSync(join(out,'response-evidence.json'),text);};
  const read=async()=>{const observation=await observeInteractionSource(()=>page.evaluate(()=>{const g=globalThis as any;return{inputs:g.roiInputs,keyUps:g.roiKeyUps,unexpected:g.roiUnexpected,errors:g.roiErrors};}),budget);
    if(observation.status!=='available'){throw observation.error;}source=observation.value;return source;};
  return preserveInteractionEvidence(async()=>{
    const ready=await stream.wait(r=>r.kind==='ready');if(native){assert.equal(ready.captureAuthority,'selected-display-composition-crop/no-window-exclusions');assert.equal(ready.visibilityPolicy,'response-roi');}else assert.equal(ready.native,false);
    const sourceClock=async()=>{const rows=[];for(let i=0;i<9;i++){const n0=performance.now(),b=await page.evaluate(()=>performance.now()),n1=performance.now();rows.push({n0,n1,b});}return rows;};
    const pcBefore=await sourceClock(),ncBefore=await observer.calibrate();
    const pc0=clockBounds(pcBefore,2),nc0=clockBounds(ncBefore,.25),map0={lo:pc0.lo-nc0.hi,hi:pc0.hi-nc0.lo};
    const setupGuardMs=Math.ceil(map0.hi-map0.lo)+1;
    const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
    let state:RoiState={pose:'c',challenge:'0'.repeat(32)};
    await page.evaluate((s:RoiState)=>(globalThis as any).roiPose(s),state);
    await page.evaluate(()=>(globalThis as any).markers(true));
    const geometryPending=stream.wait(r=>r.kind==='pixels'&&r.id==='geometry',stream.rows.length);observer.command('pixels geometry');await page.evaluate(()=>(globalThis as any).pulse());await observer.flush();
    const geometryRow=await geometryPending,geometry=calibrateViewport(snapshotRaster(geometryRow),viewportMarkers(800,600),fit=>writeFileSync(join(out,'decision-geometry-fit.json'),JSON.stringify({index:geometryRow.index,width:geometryRow.width,height:geometryRow.height,fit})));
    writeFileSync(join(out,'decision-geometry.json'),JSON.stringify({geometry,row:geometryRow.index,viewport:page.viewportSize()}));
    await page.evaluate(()=>(globalThis as any).markers(false));
    const setup=await read();assert.equal(setup.inputs.length,0,'Unexpected original input during setup');assert.equal(setup.keyUps.length,0);assert.deepEqual(setup.unexpected,[]);assert.deepEqual(setup.errors,[]);
    const trials:any[]=[];let fence={index:0,displayMs:0};
    const total=count+2; // one explicit no-op and one known50ms stall
    for(let i=0;i<total;i++){
      const noOp=i===0,delayed=i===total-1,trial='trial-'+i;
      const after:RoiState={pose:state.pose==='a'?'b':'a',challenge:randomBytes(16).toString('hex')};
      const config=decisionConfiguration(session,trial,state,after,geometry);
      writeFileSync(join(out,trial+'-configuration.json'),JSON.stringify(config));
      const ack=stream.wait(r=>r.kind==='decision-configured'&&r.tag===config.tag,stream.rows.length);observer.command('decision '+JSON.stringify(config));await ack;
      const predecessorPending=stream.wait(r=>isDecision(r,config,'predecessor'),stream.rows.length);await page.evaluate(()=>(globalThis as any).pulse());await observer.flush();
      const predecessor=requireDecision(await predecessorPending,config,'predecessor',native);
      assert(predecessor.index>fence.index&&predecessor.displayMs>fence.displayMs,'Old predecessor phase');
      // Unmeasured setup: establish that this predecessor's upper clock bound
      // is before the original event, rather than relying on a transport turn.
      const phaseMs=[0,3,7,11][i%4];await pause(setupGuardMs+phaseMs);
      await page.evaluate((t:any)=>(globalThis as any).roiArm(t),{trial,after,noOp,delayMs:delayed?50:0,wrong:options.fault==='wrong-response',sourceError:options.fault==='source-error'});
      const start=stream.rows.length;
      const pending=noOp?undefined:stream.wait(r=>isDecision(r,config,'response'),start);
      assert(ledger.offer({id:trial,kind:'response-roi-key',offeredAt:performance.now()}));
      persist({phase:'offered',operationStatus:'running',localEvidence:local(),trial,config,predecessor,sourceStatus:'pending'});
      await page.keyboard.press('a');
      const immediate=await read();assert.deepEqual(immediate.errors,[],'Response source error');assert.deepEqual(immediate.unexpected,[],'Unexpected original input');assert.equal(immediate.inputs.length,i+1,'Unexpected source event count');assert.deepEqual(options.sourceErrors,[],'Browser source error');
      if(noOp){
        await pause(100);await page.evaluate(()=>(globalThis as any).pulse());await observer.flush();
        assert(!stream.rows.slice(start).some(r=>isDecision(r,config,'response')),'No-op fabricated response pixels');
        const observed=stream.rows.slice(start).filter(r=>isDecision(r,config,'predecessor')).at(-1);
        assert(observed,'No-op control lacks a positive unchanged predecessor observation');
        const input=immediate.inputs.at(-1);assert(input?.skip&&input.trial===trial&&input.challenge===after.challenge,'No-op original identity');
        assert(predecessor.displayMs+map0.hi<=input.eventAt,'Predecessor not before original event');
        trials.push({trial,after,noOp:true,config,predecessor,unchanged:observed,input,setupGuardMs,phaseMs});fence={index:observed.index,displayMs:observed.displayMs};continue;
      }
      await observer.flush();const visible=requireDecision(await pending!,config,'response',native);
      assert(visible.index>predecessor.index&&visible.displayMs>predecessor.displayMs);
      trials.push({trial,after,noOp:false,delayed,config,predecessor,visible,setupGuardMs,phaseMs});state=after;fence={index:visible.index,displayMs:visible.displayMs};
    }
    const idle=await observeInteractionSource(()=>page.evaluate(()=>(globalThis as any).whenIdle()),budget);if(idle.status!=='available')throw idle.error;
    const pcAfter=await sourceClock(),ncAfter=await observer.calibrate(),data=await read();assert.deepEqual(data.errors,[]);assert.deepEqual(data.unexpected,[]);assert.deepEqual(options.sourceErrors,[]);assert.equal(data.inputs.length,total);assert.equal(data.keyUps.length,total);
    const pc=clockBounds([...pcBefore,...pcAfter],2),nc=clockBounds([...ncBefore,...ncAfter],.25),mapping={lo:pc.lo-nc.hi,hi:pc.hi-nc.lo};
    for(const trial of trials){
      const input=data.inputs.find((r:any)=>r.trial===trial.trial);assert(input&&input.challenge===trial.config.challenge,'Missing/mismatched original response input');trial.input=input;
      assert(trial.predecessor.displayMs+mapping.hi<=input.eventAt,'Predecessor not before original event');
      assert.equal(input.target,trial.after.pose);assert.equal(input.trusted,true);
      if(trial.noOp)continue;assert(!input.skip);
      const rows=stream.rows.filter(r=>r.kind==='frame'&&r.index>=trial.predecessor.index&&r.index<trial.visible.index&&isDecision(r,trial.config,'predecessor'));
      const previous=rows.at(-1)??trial.predecessor;trial.previousNonResponse=previous;
      trial.bounds=nativeVisibleLatencyBounds(input.eventAt,previous.displayMs,trial.visible.displayMs,mapping);
      if(trial.delayed){assert(input.injectedDelayMs>=50,'Promised response-bound stall absent');
        if(native){trial.delayQualification=qualifyInjectedDelayBounds(trial.bounds,50,pc.guardMs+nc.guardMs);assert.equal(trial.delayQualification.status,'qualified','Native known-delay visibility is uncertain');}}
    }
    sealedSource=data;stream.check();persist({phase:'complete',operationStatus:'complete',localEvidence:local(),sourceStatus:'available',sourceEvidence:data,trials,pc,nc});
    return{scope:'synthetic-complete-response-rois',native,nativeContentObserved:native,qualifiedNative:false,nativeMethodAdmission:'pending-physical-positive-and-negative-controls',completePresentationCoverage:false,label,originalInputs:data.inputs.length,matchedResponses:trials.filter(t=>!t.noOp).length,refusedInputs:0,trials,pc,nc,layerAttribution:'unresolved/not-claimed'};
  },local,async()=>{const tail=await read();if(sealedSource)assert.deepEqual(tail,sealedSource,'Original input/source tail changed after classification');return tail;},persist,budget);
}
