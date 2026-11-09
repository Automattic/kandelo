import assert from 'node:assert/strict';

export const roiPositions={a:{x:180,y:200},b:{x:440,y:200},c:{x:440,y:400}};
export type RoiPose=keyof typeof roiPositions;
export const roiBackground=[34,51,68] as const;
export const sprite={width:64,height:40,halo:2};
export type RoiState={pose:RoiPose;challenge:string};
export type DecisionConfig={schema:'complete-response-roi/v1';session:string;trial:string;challenge:string;tag:string;
  states:{id:'predecessor'|'response';regions:{x:number;y:number;width:number;height:number;rgb:string}[]}[];
  searchRadius:number;maxChannelError:number;maxMeanError:number};
export function validateChallenge(challenge:string){assert(/^[a-f0-9]{32}$/.test(challenge),'128-bit lowercase challenge required');}

// Independent expected raster specification. The browser renderer below is
// separately implemented and must agree with fixed goldens/negative controls;
// captured candidate after-images never become expected response templates.
export function expectedSpritePixel(x:number,y:number,challenge:string):readonly number[]{
  validateChallenge(challenge);
  if(x>=28&&x<60&&y>=4&&y<36){
    const bit=(Math.floor((y-4)/4)*16+Math.floor((x-28)/2));
    const byte=parseInt(challenge.slice(Math.floor(bit/8)*2,Math.floor(bit/8)*2+2),16);
    return byte&(1<<(7-bit%8))?[240,240,240]:[8,8,8];
  }
  const arrow=x>=0&&y>=0&&x<24&&y<32&&x<=Math.floor(y*.75)&&!(y>24&&x<8);
  return arrow?[255,26,13]:roiBackground;
}
export function decisionConfiguration(session:string,trial:string,before:RoiState,after:RoiState,
  geometry:{x:{scale:number;offset:number};y:{scale:number;offset:number}}):DecisionConfig{
  validateChallenge(before.challenge);validateChallenge(after.challenge);
  assert(before.pose!==after.pose,'A movement trial requires distinct semantic positions');
  assert(before.challenge!==after.challenge,'Challenge reuse');
  // This first complete-raster control requires 1:1 calibrated CSS/capture
  // pixels. Unknown resampling is not repaired by learning an observed image.
  for(const axis of [geometry.x,geometry.y])assert(Math.abs(axis.scale-1)<.003&&Math.abs(axis.offset-Math.round(axis.offset))<=1,'Unqualified dense ROI transform');
  const rects=[before.pose,after.pose].map(p=>({x:roiPositions[p].x-sprite.halo,y:roiPositions[p].y-sprite.halo,width:sprite.width+2*sprite.halo,height:sprite.height+2*sprite.halo}));
  const regions=(state:RoiState)=>rects.map(r=>{
    const bytes=new Uint8Array(r.width*r.height*3);const p=roiPositions[state.pose];
    for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){
      const sx=r.x+x-p.x,sy=r.y+y-p.y;
      const rgb=sx>=0&&sy>=0&&sx<sprite.width&&sy<sprite.height?expectedSpritePixel(sx,sy,state.challenge):roiBackground;
      bytes.set(rgb,(y*r.width+x)*3);
    }
    return{x:r.x+Math.round(geometry.x.offset),y:r.y+Math.round(geometry.y.offset),width:r.width,height:r.height,rgb:Buffer.from(bytes).toString('base64')};
  });
  return{schema:'complete-response-roi/v1',session,trial,challenge:after.challenge,tag:session+'/'+trial,
    states:[{id:'predecessor',regions:regions(before)},{id:'response',regions:regions(after)}],searchRadius:0,maxChannelError:16,maxMeanError:2};
}
export function requireDecision(row:any,c:DecisionConfig,expected:'predecessor'|'response',native:boolean){
  assert.equal(row.kind,'frame');assert.equal(row.active,true);
  if(native){assert.equal(row.captureAuthority,'selected-display-composition-crop/no-window-exclusions');assert.equal(row.visibilityPolicy,'response-roi');}
  else assert.equal(row.native,false,'Synthetic evidence cannot become native');
  const m=row.decisionMatch;
  assert(m&&m.schema===c.schema&&m.session===c.session&&m.trial===c.trial&&m.challenge===c.challenge&&m.tag===c.tag,'Stale/legacy decision identity');
  assert.equal(m.state,'matched');assert.equal(m.matches.length,1);assert.equal(m.matches[0].id,expected);
  const pixels=c.states[0].regions.reduce((n,r)=>n+r.width*r.height,0);assert.equal(m.requiredPixels,pixels,'Incomplete decision coverage');
  assert(Number.isInteger(row.index)&&Number.isFinite(row.displayMs),'Invalid physical frame identity');
  return row;
}
export function isDecision(row:any,c:DecisionConfig,expected:'predecessor'|'response'){
  const m=row?.decisionMatch;
  return row?.kind==='frame'&&m?.schema===c.schema&&m.session===c.session&&m.trial===c.trial&&m.challenge===c.challenge&&m.tag===c.tag&&m.state==='matched'&&m.matches.length===1&&m.matches[0].id===expected;
}
