/** Stateful native stand-in for raw BO identity/retirement checks. Real pixel
 * and shader behavior is exercised separately by the browser source driver. */
export function foreignTextureGl() {
  const alive = new Set<object>(), frames = new Map<object,Map<number,object|null>>();
  const parameters = new Map<object,Map<number,number>>(), units = new Map<number,Map<number,object|null>>();
  const errors: number[] = [];
  let active=0, draw: object|null=null, read: object|null=null, rbo: object|null=null;
  const control = {fault:"",failDelete:false};
  const reject=(label:string)=>{if(control.fault!==label)return false;control.fault="";errors.push(0x500);return true;};
  const make=()=>{const value={};alive.add(value);return value;};
  const binding=(target:number)=>units.get(active)?.get(target)??null;
  const gl = {
    TEXTURE0:0x84c0,ACTIVE_TEXTURE:0x84e0,TEXTURE_BINDING_2D:0x8069,TEXTURE_2D:0x0de1,
    FRAMEBUFFER:0x8d40,READ_FRAMEBUFFER:0x8ca8,DRAW_FRAMEBUFFER:0x8ca9,
    FRAMEBUFFER_BINDING:0x8ca6,DRAW_FRAMEBUFFER_BINDING:0x8ca6,READ_FRAMEBUFFER_BINDING:0x8caa,
    RENDERBUFFER:0x8d41,RENDERBUFFER_BINDING:0x8ca7,COLOR_ATTACHMENT0:0x8ce0,DEPTH_STENCIL_ATTACHMENT:0x821a,
    DEPTH24_STENCIL8:0x88f0,FRAMEBUFFER_COMPLETE:0x8cd5,RGBA:0x1908,UNSIGNED_BYTE:0x1401,
    LINEAR:0x2601,CLAMP_TO_EDGE:0x812f,TEXTURE_MIN_FILTER:0x2801,TEXTURE_MAG_FILTER:0x2800,TEXTURE_WRAP_S:0x2802,TEXTURE_WRAP_T:0x2803,
    getError:()=>errors.shift()??0,
    createTexture:()=>{const value=make();parameters.set(value,new Map([[0x2800,0x2601],[0x2801,0x2702],[0x2802,0x2901],[0x2803,0x2901]]));return value;},
    createFramebuffer:()=>{const value=make();frames.set(value,new Map());return value;},
    createRenderbuffer:()=>make(),
    deleteTexture:(value:object)=>{if(control.failDelete||reject("deleteTexture")){if(control.failDelete)errors.push(0x500);return;}alive.delete(value);},
    deleteFramebuffer:(value:object)=>{if(reject("deleteFramebuffer"))return;alive.delete(value);frames.delete(value);},
    deleteRenderbuffer:(value:object)=>alive.delete(value),
    isTexture:(value:object)=>alive.has(value),isFramebuffer:(value:object)=>alive.has(value),
    getParameter:(pname:number):any=>pname===0x84e0?active+0x84c0:pname===0x8069?binding(0x0de1):pname===0x8514?binding(0x8513):pname===0x8ca6?draw:pname===0x8caa?read:pname===0x8ca7?rbo:0,
    activeTexture:(value:number)=>{if(reject("activeTexture"))return;active=value-0x84c0;},
    bindTexture:(target:number,value:object|null)=>{if(reject("bindTexture"))return;let unit=units.get(active);if(!unit){unit=new Map();units.set(active,unit);}unit.set(target,value);},
    getTexParameter:(_target:number,pname:number)=>parameters.get(binding(0x0de1)!)?.get(pname)??0,
    texParameteri:(_target:number,pname:number,value:number)=>parameters.get(binding(0x0de1)!)!.set(pname,value),
    texImage2D:()=>{},texSubImage2D:()=>{},copyTexSubImage2D:()=>{},pixelStorei:()=>{},
    bindFramebuffer:(target:number,value:object|null)=>{if(reject("bindFramebuffer"))return;if(target!==0x8ca8)draw=value;if(target!==0x8ca9)read=value;},
    framebufferTexture2D:(target:number,point:number,_textureTarget:number,texture:object|null)=>{if(reject("framebufferTexture2D"))return;const frame=target===0x8ca8?read:draw;if(frame)frames.get(frame)!.set(point,texture);},
    framebufferRenderbuffer:()=>{},checkFramebufferStatus:()=>0x8cd5,
    bindRenderbuffer:(_target:number,value:object|null)=>{rbo=value;},renderbufferStorage:()=>{},
  };
  return {gl:gl as unknown as WebGL2RenderingContext,alive,frames,units,control};
}
