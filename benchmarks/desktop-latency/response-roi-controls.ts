import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {decisionConfiguration,expectedSpritePixel,roiBackground,roiPositions,sprite,requireDecision} from './response-roi.js';
import {learnPixelTemplate,type WindowRaster} from './pixel-template.js';
import {calibrateViewport,viewportMarkers} from './viewport-calibration.js';
import {HeadlessWindowObserver} from './headless-window-observer.js';

const out=process.env.KPERF_ROI_CONTROLS_OUT;assert(out);const binary=join(out,'pixel-matcher-offline');
const before={pose:'a' as const,challenge:'0'.repeat(32)},after={pose:'b' as const,challenge:'f'.repeat(32)};
const config=decisionConfiguration('fixed-golden-session','trial-one',before,after,{x:{scale:1,offset:0},y:{scale:1,offset:0}});
assert.deepEqual(expectedSpritePixel(28,4,'0'.repeat(32)),[8,8,8]);assert.deepEqual(expectedSpritePixel(28,4,'8'+'0'.repeat(31)),[240,240,240]);
assert.deepEqual(expectedSpritePixel(58,32,'0'.repeat(31)+'1'),[240,240,240]);assert.deepEqual(expectedSpritePixel(56,32,'0'.repeat(31)+'1'),[8,8,8]);
const raster=(state:typeof before|typeof after):WindowRaster=>{const r={width:800,height:600,stride:3200,bgra:new Uint8Array(800*600*4)};for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){
  const p=roiPositions[state.pose],sx=x-p.x,sy=y-p.y,rgb=sx>=0&&sy>=0&&sx<sprite.width&&sy<sprite.height?expectedSpritePixel(sx,sy,state.challenge):roiBackground,at=y*r.stride+x*4;r.bgra.set([rgb[2],rgb[1],rgb[0],255],at);}return r;};
const predecessor=raster(before),response=raster(after),copy=(r:WindowRaster)=>({...r,bgra:r.bgra.slice()});
const results:any[]=[];
const request=(r:WindowRaster,c:any=config,legacy=false)=>JSON.parse(execFileSync(binary,[],{input:JSON.stringify({[legacy?'configuration':'decision']:c,...r,bgra:Buffer.from(r.bgra).toString('base64')})+'\n',encoding:'utf8',maxBuffer:1_000_000}));
const check=(name:string,r:WindowRaster,want:string,c:any=config)=>{const got=request(r,c);assert.equal(got.state,want,name);results.push({name,result:got,rasterSha256:createHash('sha256').update(r.bgra).digest('hex')});return got;};
const fill=(r:WindowRaster,x:number,y:number,w:number,h:number,rgb:number[])=>{for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)r.bgra.set([rgb[2],rgb[1],rgb[0],255],(y+dy)*r.stride+(x+dx)*4);};
const patch=(to:WindowRaster,from:WindowRaster,x:number,y:number,w:number,h:number)=>{for(let dy=0;dy<h;dy++){const at=(y+dy)*to.stride+x*4;to.bgra.set(from.bgra.subarray(at,at+w*4),at);}};
check('predecessor',predecessor,'matched');const positive=check('complete-response',response,'matched');assert.equal(positive.matches[0].id,'response');
let r=copy(response);patch(r,predecessor,180-2,200-2,68,44);check('ghost-old-position',r,'unmatched');
r=copy(predecessor);patch(r,response,440-2,200-2,68,44);check('new-response-old-not-erased',r,'unmatched');
r=copy(response);fill(r,440,200,1,1,[0,255,0]);check('one-required-pixel-occluded',r,'unmatched');
r=copy(response);fill(r,440+28,200+4,2,4,[8,8,8]);check('one-challenge-cell-wrong',r,'unmatched');
r=copy(response);fill(r,440+63,200+39,1,1,[255,255,255]);check('background-occluded',r,'unmatched');
check('noop-old-phase',predecessor,'matched');assert.equal(request(predecessor).matches[0].id,'predecessor');
r=copy(response);fill(r,440,200,24,32,[0,255,0]);check('marker-without-glyph',r,'unmatched');
r=copy(response);fill(r,440+28,200+4,32,32,[8,8,8]);check('glyph-with-stale-marker',r,'unmatched');
r=copy(response);fill(r,3,3,1,1,[255,255,255]);check('outside-decision-roi-only',r,'matched');
// Causal prior-method false positive: retain exactly the sampled foreground
// points, obscure everything else in the new region, and keep the old ghost.
const template=learnPixelTemplate(predecessor,response,{x:440,y:200,width:64,height:40});
const sparse={tag:'frozen-old-sparse-shape',template,candidates:[{id:'b',x:440,y:200}],searchRadius:0,maxChannelError:0,maxMeanError:0};
const spoof=copy(predecessor);fill(spoof,440-2,200-2,68,44,[0,255,0]);for(const p of template.points){const at=(200+p.y)*spoof.stride+(440+p.x)*4;spoof.bgra.set(response.bgra.subarray(at,at+4),at);}
const sparseGot=request(spoof,sparse,true);assert.equal(sparseGot.state,'matched');const denseGot=check('old-sparse-preserving-opaque-lookalike',spoof,'unmatched');
writeFileSync(join(out,'causal-sparse-false-positive.json'),JSON.stringify({sparse:sparseGot,dense:denseGot,sparseConfiguration:sparse,recipe:'Before raster plus green entire new ROI, then restore only all old learner selected points from response; old ghost remains.',before,after,configuration:config,rasterSha256:createHash('sha256').update(spoof.bgra).digest('hex')},null,2));
for(const [name,mutate] of [
 ['truncated-region',(c:any)=>{c.states[0].regions[0].rgb='AA==';}],
 ['different-state-coverage',(c:any)=>{c.states[0].regions[0].x++;}],
 ['overlapping-coverage',(c:any)=>{c.states[0].regions[1]={...c.states[0].regions[0]};}],
 ['challenge-reuse-malformed',(c:any)=>{c.challenge='bad';}],
 ['work-overflow',(c:any)=>{c.states.forEach((s:any)=>{s.regions=Array.from({length:8},(_,i)=>({x:i*130,y:0,width:128,height:128,rgb:Buffer.alloc(128*128*3).toString('base64')}));});c.searchRadius=1;}],
] as const){const c=structuredClone(config);mutate(c);assert.throws(()=>request(response,c),/offline matcher failure/,name);results.push({name,expectedRefusal:true});}
const frame={kind:'frame',index:2,displayMs:100,active:true,native:false,decisionMatch:positive};requireDecision(frame,config,'response',false);
for(const field of ['session','trial','challenge','tag','schema']){const f=structuredClone(frame);(f.decisionMatch as any)[field]='old';assert.throws(()=>requireDecision(f,config,'response',false));results.push({name:'stale-'+field,expectedRefusal:true});}
assert.throws(()=>requireDecision({...frame,kind:'pixels'},config,'response',false));assert.throws(()=>requireDecision({...frame,captureAuthority:'desktop-independent-window',visibilityPolicy:'response-roi'},config,'response',true));
assert.throws(()=>requireDecision({...frame,decisionMatch:{...positive,requiredPixels:1}},config,'response',false));
// Diagnostics are owned copies. Mutating a consumer's snapshot cannot change
// the fit the helper checks/returns, including on a future refused calibration.
const geometryRaster=copy(predecessor);for(const m of viewportMarkers(800,600))fill(geometryRaster,m.x-6,m.y-6,12,12,m.rgb);
const geometry=calibrateViewport(geometryRaster,viewportMarkers(800,600),value=>{const v=value as any;v.x.scale=0;v.found[0].x=9999;v.found[0].sourceX=-1;});
assert.equal(geometry.x.scale,1);assert.equal(geometry.x.offset,0);assert.equal(geometry.found[0].x,24);assert.equal(geometry.found[0].source.x,24);
results.push({name:'geometry-diagnostic-cannot-mutate-checked-fit',expectedRefusal:false});
const protocol=new HeadlessWindowObserver({},'not-executed',true);
protocol.command('decision '+JSON.stringify(config));
assert.throws(()=>protocol.command('matcher {}'),/incompatible/);
assert.throws(()=>protocol.stream.check(),/incompatible/,'Policy refusal must stay terminal');
results.push({name:'roi-protocol-rejects-sparse-replacement-terminally',expectedRefusal:true});
writeFileSync(join(out,'node-results.json'),JSON.stringify({scope:'offline-complete-roi-controls',qualifiedNative:false,completePresentationCoverage:false,controls:results},null,2));
console.log('PASS complete ROI/goldens/erasure/old-sparse causal falsepositive/stale metadata/refusal controls',results.length);
