import { viewportMarkers } from './viewport-calibration.js';

export const cursorPositions = { a: { x: 180, y: 200 }, b: { x: 440, y: 200 }, c: { x: 440, y: 400 } };
export function cursorControlScript(mode: 'dom' | 'offscreen') {
  const worker = `let gl,program;onmessage=e=>{try{const m=e.data;if(m.kind==='init'){
    const canvas=m.canvas;gl=canvas.getContext('webgl2',{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true});
    if(!gl)throw Error('No worker WebGL2 context');
    const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s};
    program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,'#version 300 es\\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}'));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;uniform vec2 pose;out vec4 color;void main(){vec2 p=floor(vec2(gl_FragCoord.x,600.0-gl_FragCoord.y)-pose);bool a=p.x>=0.0&&p.y>=0.0&&p.x<24.0&&p.y<32.0&&p.x<=p.y*0.75&&!(p.y>24.0&&p.x<8.0);color=a?vec4(1.0,26.0/255.0,13.0/255.0,1.0):vec4(34.0/255.0,51.0/255.0,68.0/255.0,1.0);}'));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const ext=gl.getExtension('WEBGL_debug_renderer_info');postMessage({kind:'ready',attributes:gl.getContextAttributes(),renderer:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER)});return;}
    const delayStartAt=performance.now(),until=delayStartAt+m.delay;while(performance.now()<until){}const workerBeforeDrawAt=performance.now(),beforeDrawAt=performance.timeOrigin+workerBeforeDrawAt;
    gl.uniform2f(gl.getUniformLocation(program,'pose'),m.x,m.y);gl.drawArrays(gl.TRIANGLES,0,3);gl.flush();postMessage({kind:'applied',id:m.id,beforeDrawAt,delayElapsedMs:workerBeforeDrawAt-delayStartAt,delayStartAt,workerBeforeDrawAt,workerTimeOrigin:performance.timeOrigin});
  }catch(e){postMessage({kind:'error',error:String(e)})}};`;
  // Deliberately a source string: page code must not capture transpiler helpers
  // from the Node realm. This page is a control, never a Kandelo implementation.
  return `(async()=>{const g=globalThis;const mode=${JSON.stringify(mode)},positions=${JSON.stringify(cursorPositions)};
    document.documentElement.style.cssText='margin:0;width:100%;height:100%;background:rgb(34,51,68)';
    document.body.style.cssText='margin:0;width:100%;height:100%;overflow:hidden;background:rgb(34,51,68)';
    g.inputs=[];g.controlErrors=[];g.nextTarget='a';g.skip=false;g.delay=0;
    if(mode==='dom'){
      const cursor=document.createElement('div');cursor.style.cssText='position:absolute;width:24px;height:32px;background:rgb(255,26,13);clip-path:polygon(0 0,24px 32px,8px 32px,8px 24px,0 24px)';document.body.append(cursor);
      g.pose=async(id,delay=0)=>{const delayStartAt=performance.now(),until=delayStartAt+delay;while(performance.now()<until){}const beforeDrawAt=performance.now();cursor.style.left=positions[id].x+'px';cursor.style.top=positions[id].y+'px';return{beforeDrawAt,delayElapsedMs:beforeDrawAt-delayStartAt,delayStartAt,drawClock:'page',drawTimeOrigin:performance.timeOrigin};};
    }else{
      const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;canvas.style.cssText='display:block;width:800px;height:600px';document.body.append(canvas);
      const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));let serial=0;const callbacks=new Map();
      await new Promise((resolve,reject)=>{worker.onerror=e=>{reject(Error(e.message));for(const c of callbacks.values())c.reject(Error(e.message));};worker.onmessage=e=>{const m=e.data;if(m.kind==='error'){reject(Error(m.error));g.controlErrors.push(m.error);for(const c of callbacks.values())c.reject(Error(m.error));return;}if(m.kind==='ready'){g.workerInfo=m;resolve();return;}callbacks.get(m.id)?.resolve({...m,beforeDrawAt:m.beforeDrawAt-performance.timeOrigin,drawClock:'worker',drawTimeOrigin:m.workerTimeOrigin});callbacks.delete(m.id);};const offscreen=canvas.transferControlToOffscreen();worker.postMessage({kind:'init',canvas:offscreen},[offscreen]);});
      g.pose=(target,delay=0)=>new Promise((resolve,reject)=>{const id=++serial;callbacks.set(id,{resolve,reject});worker.postMessage({id,delay,...positions[target]});});
    }
    g.markers=visible=>{for(const e of document.querySelectorAll('[data-native-marker]'))e.remove();if(visible)for(const p of ${JSON.stringify(viewportMarkers(800, 600))}){const e=document.createElement('div');e.dataset.nativeMarker='1';e.style.cssText='position:fixed;width:12px;height:12px;pointer-events:none;z-index:99999;left:'+(p.x-6)+'px;top:'+(p.y-6)+'px;background:rgb('+p.rgb.join(',')+')';document.body.append(e);}};
    let pulse=0;const indicator=document.createElement('div');indicator.style.cssText='position:fixed;left:4px;top:4px;width:2px;height:2px;pointer-events:none';document.body.append(indicator);
    g.pulse=()=>{indicator.style.background=++pulse%2?'#ac5317':'#1753ac';};
    addEventListener('keydown',e=>{if(e.code!=='KeyA')return;const row={seq:g.inputs.length+1,target:g.nextTarget,eventAt:e.timeStamp,handlerAt:performance.now(),skip:g.skip,delay:g.delay};g.inputs.push(row);if(g.skip)return;g.lastDraw=g.pose(g.nextTarget,g.delay);g.lastDraw.then(t=>{row.beforeDrawAt=t.beforeDrawAt;row.injectedDelayMs=t.delayElapsedMs;row.delayStartAt=t.delayStartAt;row.workerBeforeDrawAt=t.workerBeforeDrawAt??null;row.drawClock=t.drawClock;row.drawTimeOrigin=t.drawTimeOrigin;row.ackAt=performance.now();}).catch(e=>g.controlErrors.push(String(e)));});
    g.whenIdle=()=>g.lastDraw??Promise.resolve();
    await g.pose('c');
  })()`;
}
