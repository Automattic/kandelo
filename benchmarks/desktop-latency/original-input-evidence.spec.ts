// Source-only sampler parity controls. These headless pages are deliberately
// not Kandelo application or native-display performance evidence.
import test from '../../apps/browser-demos/node_modules/@playwright/test/index.js';
const {expect}=test;
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {desktopCursorSource} from './desktop-cursor-source';
test('original-input evidence matches Node and passively retains browser events',async({page},info)=>{
 const out=process.env.KPERF_INPUT_EVIDENCE_OUT;if(!out)throw Error('Private output required');
 const expected=JSON.parse(readFileSync(join(out,'node.json'),'utf8'));
 await page.route('**/input-evidence-control.html',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Owned source-only input evidence</title><button>control</button>'}));
 await page.goto('/input-evidence-control.html');
 const result=await page.evaluate(async()=>{const url='/benchmarks/desktop-latency/original-input-evidence-fixtures.ts';const m=await import(url);return {...m.originalInputEvidenceFixtures(),failureCustody:await m.originalInputFailureFixtures()};});
 expect(result).toEqual(expected);
 const actual=await page.evaluate(async()=>{
  const url='/benchmarks/desktop-latency/original-input-evidence.ts',m=await import(url),ledger=m.createOriginalInputEvidence({session:'real-browser-events'}),events:string[]=[];
  const listener=(e:Event)=>{events.push(e.type);ledger.recordEvent(e as any,performance.now());};
  for(const kind of ['pointermove','pointerdown','pointerup','wheel','keydown','keyup'])addEventListener(kind,listener,{capture:true,passive:true});
  try{for(const kind of ['pointermove','pointerdown','pointerup','wheel','keydown','keyup'])document.querySelector('button')!.dispatchEvent(new Event(kind,{bubbles:true}));}
  finally{for(const kind of events)removeEventListener(kind,listener,true);}
  return ledger.snapshot();
 });
 expect(actual.complete).toBe(true);expect(actual.inputs.map((i:any)=>i.kind)).toEqual(['pointermove','pointerdown','pointerup','wheel','keydown','keyup']);expect(actual.inputs.every((i:any)=>i.trusted===false&&Number.isFinite(i.eventAt)&&Number.isFinite(i.handlerAt))).toBe(true);
 writeFileSync(join(out,info.project.name+'.json'),JSON.stringify({parity:result,browserEvents:actual,scope:'Headless generic ledger controls only; no native display or application latency.'},null,2));
});


test('cursor adapter preserves original epochs through the shared sampler',async({page},info)=>{
 const out=process.env.KPERF_INPUT_EVIDENCE_OUT;if(!out)throw Error('Private output required');
 await page.route('**/cursor-input-control.html',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><style>canvas{position:absolute;left:100px;top:100px;width:400px;height:400px;cursor:none}</style><div class="kmachine-primary-slot"><canvas class="kmodeset-canvas" width="400" height="400" tabindex="0"></canvas></div><div class="kdemo-surface-controls">400×400 · 1 flips</div>'}));
 await page.goto('/cursor-input-control.html');
 const source=await desktopCursorSource(page,{a:{x:160,y:200},b:{x:260,y:200},c:{x:260,y:350}});
 try{
  await source.reset();await source.trigger('a',{noOp:false,delayMs:0});
  await expect.poll(async()=>(await source.data()).inputs.length).toBe(1);
  const first=await source.data();expect(first.inputs[0].target).toBe('a');expect(first.inputs[0].trusted).toBe(true);
  await source.reset();await source.trigger('b',{noOp:false,delayMs:0});
  await expect.poll(async()=>(await source.data()).inputs.length).toBe(1);
  const second=await source.data();expect(second.inputs[0].target).toBe('b');expect(second.inputs[0].seq).toBe(1);
  expect((second as any).inputEvidence.inputs.length).toBe(2);expect((second.inputs[0] as any).evidenceSeq).toBe(2);
  expect((second as any).inputEvidence.complete).toBe(true);await source.verify();
  writeFileSync(join(out,info.project.name+'-cursor-adapter.json'),JSON.stringify({first,second,scope:'Standalone input-adapter control only: no guest cursor, application or display latency.'},null,2));
 }finally{await page.evaluate(()=>(globalThis as any).__kandeloDesktopPixelProbe.dispose());}
});
