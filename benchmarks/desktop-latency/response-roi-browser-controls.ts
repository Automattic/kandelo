import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {decisionConfiguration} from './response-roi.js';
import {responseControlScript} from './response-control-page.js';
import {screenshotRaster} from './captured-raster.js';
import {learnPixelTemplate,type WindowRaster} from './pixel-template.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=process.env.KPERF_ROI_BROWSER_OUT;assert(out);
const pw=await import(pathToFileURL(join(root,'apps/browser-demos/node_modules/@playwright/test/index.mjs')).href);
const binary=join(out,'pixel-matcher-offline');
const before={pose:'a' as const,challenge:'0'.repeat(32)},after={pose:'b' as const,challenge:'f'.repeat(32)};
const config=decisionConfiguration('independent-browser-golden','fresh-trial',before,after,{x:{scale:1,offset:0},y:{scale:1,offset:0}});
const match=(r:WindowRaster,configuration:any=config,legacy=false)=>JSON.parse(execFileSync(binary,[],{input:JSON.stringify({[legacy?'configuration':'decision']:configuration,...r,bgra:Buffer.from(r.bgra).toString('base64')})+'\n',encoding:'utf8',maxBuffer:1_000_000}));
const results:any[]=[];
for(const engine of ['chromium','firefox','webkit'] as const){
 const dir=join(out,engine);mkdirSync(dir);const home=mkdtempSync(join(dir,'home-'));
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'chromium'}:{}),...(engine==='firefox'?{env:{...process.env,CFFIXED_USER_HOME:home}}:{})});
 try{for(const mode of ['dom','offscreen'] as const){
  const caseDir=join(dir,mode);mkdirSync(caseDir);const context=await browser.newContext({viewport:{width:800,height:600},deviceScaleFactor:1});
  try{
   const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.goto('data:text/html,<title>Headless complete response control</title>');await page.evaluate(responseControlScript(mode));
   // Exercise the actual producer's refusal path, retaining the raw endpoint
   // before a trial exists. This is a separate setup control, saved then reset
   // explicitly in the fixture; the metrology controller never resets inputs.
   await page.keyboard.press('a');
   const unarmed=await page.evaluate(()=>{const g=globalThis as any;return{inputs:g.roiInputs,keyUps:g.roiKeyUps,errors:g.roiErrors};});
   assert.equal(unarmed.inputs.length,1);const endpoint=unarmed.inputs[0];assert.equal(endpoint.refused,'unarmed');assert.equal(endpoint.trial,null);assert.equal(endpoint.code,'KeyA');assert.equal(endpoint.trusted,true);assert.equal(endpoint.repeat,false);assert(Number.isFinite(endpoint.eventAt)&&endpoint.handlerAt>=endpoint.eventAt);assert.equal(unarmed.keyUps.length,1);assert(unarmed.errors.includes('Unarmed original input'));
   writeFileSync(join(caseDir,'unarmed-original-input.json'),JSON.stringify(unarmed,null,2));
   await page.evaluate(()=>{const g=globalThis as any;g.roiInputs=[];g.roiKeyUps=[];g.roiErrors=[];g.roiUnexpected=[];});
   const capture=async(name:string)=>screenshotRaster(page,join(caseDir,name+'.png'));
   let poseSerial=0;const poseAttempts:any[]=[];
   const pose=async(s:typeof before|typeof after)=>{await page.evaluate((s:any)=>(globalThis as any).roiPose(s),s);const expected=s.pose==='a'?'predecessor':'response',deadline=Date.now()+15_000;for(let i=0;i<128&&Date.now()<deadline;i++){const name='pose-'+expected+'-'+(++poseSerial),r=await capture(name),got=match(r);poseAttempts.push({name,got});writeFileSync(join(caseDir,'pose-witness-attempts.json'),JSON.stringify(poseAttempts,null,2));if(got.state==='matched'&&got.matches[0].id===expected)return;}throw Error('No positive setup pose pixels');};
   const check=(name:string,r:WindowRaster,id:string|null)=>{const result=match(r);results.push({engine,mode,name,result,rasterSha256:createHash('sha256').update(r.bgra).digest('hex'),native:false});writeFileSync(join(out,'results-running.json'),JSON.stringify(results,null,2));assert.equal(result.state,id?'matched':'unmatched',`${engine}/${mode}/${name}`);if(id)assert.equal(result.matches[0].id,id);return result;};
   await pose(before);const a=await capture('before');check('independent-predecessor',a,'predecessor');
   await pose(after);const b=await capture('response');check('independently-predicted-response',b,'response');
   const sparseTemplate=learnPixelTemplate(a,b,{x:440,y:200,width:64,height:40});
   const sparse={tag:'old-sparse',template:sparseTemplate,candidates:[{id:'b',x:440,y:200}],searchRadius:0,maxChannelError:16,maxMeanError:4};
   const spoof={...a,bgra:a.bgra.slice()};for(let y=198;y<242;y++)for(let x=438;x<506;x++)spoof.bgra.set([0,255,0,255],y*spoof.stride+x*4);
   for(const p of sparseTemplate.points){const at=(200+p.y)*spoof.stride+(440+p.x)*4;spoof.bgra.set(b.bgra.subarray(at,at+4),at);}
   // This is a REAL headless composited occluder, not a response source. It
   // preserves exactly the old sparse witness points while hiding other pixels.
   await page.evaluate(({packed}:{packed:string})=>{
     const bytes=Uint8ClampedArray.from(atob(packed),c=>c.charCodeAt(0));for(let i=0;i<bytes.length;i+=4){const b=bytes[i];bytes[i]=bytes[i+2];bytes[i+2]=b;}
     const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;canvas.dataset.roiOccluder='1';canvas.style.cssText='position:fixed;left:0;top:0;z-index:999999;pointer-events:none';canvas.getContext('2d')!.putImageData(new ImageData(bytes,800,600),0,0);document.body.append(canvas);
   },{packed:Buffer.from(spoof.bgra).toString('base64')});
   const occluded=await capture('sparse-preserving-opaque-overlay');assert.equal(match(occluded,sparse,true).state,'matched');check('sparse-preserving-opaque-overlay',occluded,null);
   await page.evaluate(()=>document.querySelectorAll('[data-roi-occluder]').forEach(e=>e.remove()));
   await pose(before);await page.evaluate((t:any)=>(globalThis as any).roiArm(t),{trial:'noop',after,noOp:true,delayMs:0});await page.keyboard.press('a');check('actual-original-noop',await capture('noop'),'predecessor');
   await pose(before);
   // ACK/rAF is not a displayed wrong-response endpoint. Seal a real positive
   // predecessor, then await an independently specified GREEN-glyph witness.
   const witness=structuredClone(config);for(const region of witness.states[1].regions){const rgb=Buffer.from(region.rgb,'base64');for(let i=0;i<rgb.length;i+=3)if(rgb[i]===255&&rgb[i+1]===26&&rgb[i+2]===13){rgb[i]=0;rgb[i+1]=255;rgb[i+2]=0;}region.rgb=rgb.toString('base64');}
   const attempts:any[]=[];
   const observeUntil=async(name:string,c:any,id:string)=>{const deadline=Date.now()+15_000;for(let i=0;i<128&&Date.now()<deadline;i++){const r=await capture(name+'-'+i),got=match(r,c),normal=match(r);attempts.push({name,i,got,normal});writeFileSync(join(caseDir,'wrong-witness-attempts.json'),JSON.stringify({witness,attempts},null,2));if(name==='wrong')assert(!normal.matches.some((m:any)=>m.id==='response'),'Wrong-source control produced a legitimate response');if(got.state==='matched'&&got.matches[0].id===id)return r;}throw Error('No positive '+name+' pixel witness');};
   await observeUntil('before-wrong',config,'predecessor');
   await page.evaluate((t:any)=>(globalThis as any).roiArm(t),{trial:'wrong',after,noOp:false,delayMs:0,wrong:true});await page.keyboard.press('a');await page.evaluate(()=>(globalThis as any).whenIdle());
   check('fresh-code-wrong-glyph',await observeUntil('wrong',witness,'response'),null);
   await pose(before);await page.evaluate((t:any)=>(globalThis as any).roiArm(t),{trial:'source-error',after,noOp:false,delayMs:0,sourceError:true});await page.keyboard.press('a');check('source-error-no-output',await capture('source-error'),'predecessor');
   const source=await page.evaluate(()=>{const g=globalThis as any;return{inputs:g.roiInputs,errors:g.roiErrors};});assert(source.errors.includes('Injected response source error'));assert.equal(source.inputs.length,3);assert.deepEqual(errors,[]);
   writeFileSync(join(caseDir,'source-record.json'),JSON.stringify({source,sparseConfiguration:sparse,configuration:config,browserVersion:browser.version(),native:false,completePresentationCoverage:false},null,2));
  }finally{await context.close();}
 }}finally{await browser.close();}
}
writeFileSync(join(out,'results.json'),JSON.stringify({scope:'headless-content-controls',qualifiedNative:false,completePresentationCoverage:false,controls:results},null,2));
console.log('PASS actual headless DOM/worker source + opaque sparse-spoof/noop/wrong/source-error controls',results.length);
