import {viewportMarkers} from './viewport-calibration.js';
import {roiPositions,sprite} from './response-roi.js';

export function responseControlScript(mode:'dom'|'offscreen'){
  // Producer is independent of expectedSpritePixel. It paints one opaque
  // sprite containing BOTH requested cursor and challenge. No page-side code
  // can announce a worker response before that worker's complete draw.
  const worker=`let gl,program;onmessage=e=>{try{const m=e.data;if(m.kind==='init'){
    const canvas=m.canvas;gl=canvas.getContext('webgl2',{antialias:false,premultipliedAlpha:false,depth:false,stencil:false,preserveDrawingBuffer:true});if(!gl)throw Error('Worker WebGL2 unavailable');
    const compile=(t,s)=>{let p=gl.createShader(t);gl.shaderSource(p,s);gl.compileShader(p);if(!gl.getShaderParameter(p,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(p));return p;};
    program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,'#version 300 es\\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}'));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;precision highp int;uniform ivec2 pose;uniform uvec4 nonce;uniform bool wrong;out vec4 color;void main(){ivec2 p=ivec2(floor(vec2(gl_FragCoord.x,600.0-gl_FragCoord.y)))-pose;vec3 c=vec3(34,51,68);if(p.x>=28&&p.x<60&&p.y>=4&&p.y<36){int bit=((p.y-4)/4)*16+(p.x-28)/2;uint word=nonce[bit/32];bool on=(word&(1u<<uint(31-bit%32)))!=0u;c=on?vec3(240):vec3(8);}else if(p.x>=0&&p.y>=0&&p.x<24&&p.y<32&&p.x<=int(floor(float(p.y)*0.75))&&!(p.y>24&&p.x<8)){c=wrong?vec3(0,255,0):vec3(255,26,13);}color=vec4(c/255.0,1);}'));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);postMessage({kind:'ready'});return;}
    const start=performance.now();while(performance.now()<start+m.delay){}const end=performance.now();
    gl.uniform2i(gl.getUniformLocation(program,'pose'),m.x,m.y);gl.uniform4uiv(gl.getUniformLocation(program,'nonce'),new Uint32Array(m.challenge.match(/.{8}/g).map(x=>parseInt(x,16))));gl.uniform1i(gl.getUniformLocation(program,'wrong'),m.wrong?1:0);gl.drawArrays(gl.TRIANGLES,0,3);gl.flush();postMessage({kind:'applied',id:m.id,challenge:m.challenge,injectedDelayMs:end-start});
  }catch(e){postMessage({kind:'error',error:String(e)})}};`;
  return `(async()=>{const g=globalThis,mode=${JSON.stringify(mode)},positions=${JSON.stringify(roiPositions)};
    document.documentElement.style.cssText='margin:0;background:rgb(34,51,68)';document.body.style.cssText='margin:0;overflow:hidden;background:rgb(34,51,68)';
    g.roiInputs=[];g.roiKeyUps=[];g.roiUnexpected=[];g.roiErrors=[];g.roiTrial=null;g.roiDraw=Promise.resolve();let paint;
    if(mode==='dom'){
      const image=document.createElement('img');image.width=${sprite.width};image.height=${sprite.height};image.style.cssText='position:absolute;image-rendering:pixelated';document.body.append(image);
      paint=async(s,delay=0,wrong=false)=>{const start=performance.now();while(performance.now()<start+delay){}const end=performance.now();
        const canvas=document.createElement('canvas');canvas.width=${sprite.width};canvas.height=${sprite.height};const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(34,51,68)';ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle=wrong?'rgb(0,255,0)':'rgb(255,26,13)';for(let y=0;y<32;y++)for(let x=0;x<24;x++)if(x<=Math.floor(y*3/4)&&!(y>24&&x<8))ctx.fillRect(x,y,1,1);
        for(let bit=0;bit<128;bit++){const byte=parseInt(s.challenge.substr((bit>>3)*2,2),16),on=(byte>>(7-(bit&7)))&1;ctx.fillStyle=on?'rgb(240,240,240)':'rgb(8,8,8)';ctx.fillRect(28+(bit%16)*2,4+Math.floor(bit/16)*4,2,4);}
        const next=new Image();next.src=canvas.toDataURL();await next.decode();image.src=next.src;image.style.left=positions[s.pose].x+'px';image.style.top=positions[s.pose].y+'px';return{challenge:s.challenge,injectedDelayMs:end-start};};
    }else{
      const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;canvas.style.cssText='width:800px;height:600px;display:block';document.body.append(canvas);let id=0;const pending=new Map();
      const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));
      await new Promise((resolve,reject)=>{worker.onerror=e=>{reject(Error(e.message));for(const p of pending.values())p.reject(Error(e.message));};worker.onmessage=e=>{const m=e.data;if(m.kind==='error'){g.roiErrors.push(m.error);reject(Error(m.error));for(const p of pending.values())p.reject(Error(m.error));return;}if(m.kind==='ready'){resolve();return;}pending.get(m.id)?.resolve(m);pending.delete(m.id);};const offscreen=canvas.transferControlToOffscreen();worker.postMessage({kind:'init',canvas:offscreen},[offscreen]);});
      paint=(s,delay=0,wrong=false)=>new Promise((resolve,reject)=>{const serial=++id;pending.set(serial,{resolve,reject});worker.postMessage({id:serial,...positions[s.pose],challenge:s.challenge,delay,wrong});});
    }
    g.roiPose=(state)=>g.roiDraw=paint(state);
    g.roiArm=trial=>{g.roiTrial=trial;}; // configure only: never paint a challenge here
    const pulse=document.createElement('div');pulse.style.cssText='position:fixed;left:4px;top:4px;width:2px;height:2px;pointer-events:none';document.body.append(pulse);let pulseId=0;g.pulse=()=>pulse.style.background=++pulseId%2?'#ac5317':'#1753ac';
    g.markers=visible=>{for(const e of document.querySelectorAll('[data-native-marker]'))e.remove();if(visible)for(const p of ${JSON.stringify(viewportMarkers(800,600))}){const e=document.createElement('div');e.dataset.nativeMarker='1';e.style.cssText='position:fixed;width:12px;height:12px;pointer-events:none;z-index:99999;left:'+(p.x-6)+'px;top:'+(p.y-6)+'px;background:rgb('+p.rgb.join(',')+')';document.body.append(e);}};
    for(const kind of ['pointerdown','pointerup','wheel'])addEventListener(kind,e=>g.roiUnexpected.push({kind,eventAt:e.timeStamp,trusted:e.isTrusted}));
    addEventListener('keyup',e=>{const row={kind:e.type,code:e.code,eventAt:e.timeStamp,trusted:e.isTrusted};if(e.code==='KeyA')g.roiKeyUps.push(row);else g.roiUnexpected.push(row);});
    addEventListener('keydown',e=>{
      const raw={kind:e.type,code:e.code,repeat:e.repeat,eventAt:e.timeStamp,handlerAt:performance.now(),trusted:e.isTrusted};
      if(e.code!=='KeyA'){g.roiUnexpected.push(raw);return;}
      const t=g.roiTrial;g.roiTrial=null;
      // Original endpoints remain custody even when no trial can own them.
      // Reporting an unarmed error before this append would lose the tail.
      const row={...raw,seq:g.roiInputs.length+1,trial:t?.trial??null,challenge:t?.after?.challenge??null,target:t?.after?.pose??null,skip:t?.noOp??null};g.roiInputs.push(row);
      if(!t){row.refused='unarmed';g.roiErrors.push('Unarmed original input');return;}
      if(t.sourceError){g.roiErrors.push('Injected response source error');return;}if(t.noOp)return;
      g.roiDraw=paint(t.after,t.delayMs,t.wrong).then(r=>Object.assign(row,r)).catch(e=>g.roiErrors.push(String(e)));
    });
    g.whenIdle=()=>g.roiDraw;
  })()`;
}
