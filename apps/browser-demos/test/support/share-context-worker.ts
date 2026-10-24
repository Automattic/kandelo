import {createMainForwardChannel} from "../../../../host/src/webgl/main-forward";
import {createWasmPosixKernelTestHarness} from "../../../../host/src/kernel";
import {createKernelScratchTestInstance} from "../../../../host/test/support/kernel-scratch-instance";
import * as O from "../../../../host/src/webgl/ops";

// Driver-level ABI 58 construction, not public C sharing or Rust marshalling.
self.onmessage=({data})=>{
  try {
    const forwarded=data.mode==="forwarded";
    const channels=[11,12,13,14].map(session=>createMainForwardChannel({postMessage:message=>postMessage(message)},7,session));
    let gl:WebGL2RenderingContext|null=null,memory:WebAssembly.Memory|null=null;
    let imports:Record<string,(...args:any[])=>any>|null=null;
    const created:object[]=[],deleted:object[]=[],live:Array<()=>boolean>=[];
    if(!forwarded) {
      const canvas=data.canvas as OffscreenCanvas;
      gl=canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true});
      if(!gl)throw new Error("native WebGL2 unavailable");
      for(const [createName,deleteName,isName] of [["createTexture","deleteTexture","isTexture"],["createFramebuffer","deleteFramebuffer","isFramebuffer"],["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"]]) {
        const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
        api[createName]=()=>{const value=create();if(value){created.push(value);live.push(()=>isLive(value));}return value;};
        api[deleteName]=(value:object|null)=>{if(value)deleted.push(value);destroy(value);};
      }
      memory=new WebAssembly.Memory({initial:2,maximum:2});
      const native=createWasmPosixKernelTestHarness({io:{} as any,callbacks:{getProcessMemory:()=>memory!},memory,pointerWidth:4,
        instance:createKernelScratchTestInstance(4,memory,()=>({}),()=>4096)});
      imports=(native.testAuthority.buildImportObject(memory) as {env:typeof imports}).env;
      for(let i=0;i<4;i++)imports!.host_gl_bind(7,4096,65536,11+i);
      native.gl.attachCanvas(7,canvas);
    }
    const requireZero=(rc:number,label:string)=>{if(rc!==0)throw new Error(`${label}: ${rc}`);};
    const create=(i:number,source?:number)=>{
      if(forwarded)requireZero(channels[i].onCreateContext(11+i,source===undefined?undefined:11+source),"forward create");
      else {
        new Uint32Array(memory!.buffer,64,4).set([2,source===undefined?0:21+source,0,0]);
        requireZero(imports!.host_gl_create_context(7,21+i,64,16,11+i),"native create");
      }
    };
    const current=(i:number)=>requireZero(forwarded?channels[i].onMakeCurrent!({drawSurfaceId:0,readSurfaceId:0,width:0,height:0})
      :imports!.host_gl_make_current(7,21+i,0,0,11+i),"current");
    const send=(i:number,op:number,words:number[],tail=new Uint8Array())=>{
      const bytes=new Uint8Array(4+4*words.length+tail.length),view=new DataView(bytes.buffer);
      view.setUint16(0,op,true);view.setUint16(2,4*words.length+tail.length,true);
      words.forEach((word,index)=>view.setUint32(4+4*index,word,true));bytes.set(tail,4+4*words.length);
      if(forwarded)channels[i].onSubmit(bytes);
      else {new Uint8Array(memory!.buffer,4096,bytes.length).set(bytes);requireZero(imports!.host_gl_submit(7,0,bytes.length,11+i),"submit");}
    };
    const query=(i:number,op:number,words:number[],length:number)=>{
      const input=new Uint8Array(words.length*4),view=new DataView(input.buffer);
      words.forEach((word,index)=>view.setUint32(index*4,word,true));
      if(forwarded) {
        const reply=channels[i].onQuery!(op,input,length);if(reply.rc!==length)throw new Error(`query: ${reply.rc}`);return [...reply.bytes];
      }
      new Uint8Array(memory!.buffer,64,input.length).set(input);
      const rc=imports!.host_gl_query(7,op,64,input.length,128,length,11+i);if(rc!==length)throw new Error(`query: ${rc}`);
      return [...new Uint8Array(memory!.buffer,128,length)];
    };
    const pixels=(i:number)=>query(i,O.QOP_READ_PIXELS,[0,0,1,1,0x1908,0x1401],4);
    const storage=(i:number,color:number[])=>{
      send(i,O.OP_BIND_TEXTURE,[0x0de1,17]);
      send(i,O.OP_TEX_IMAGE_2D,[0x0de1,0,0x1908,1,1,0,0x1908,0x1401,4],new Uint8Array(color));
    };
    const attachment=(i:number)=>{
      send(i,O.OP_GEN_FRAMEBUFFERS,[1,7]);send(i,O.OP_BIND_FRAMEBUFFER,[0x8d40,7]);
      send(i,O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,17,0]);
    };
    const destroy=(i:number)=>{if(forwarded)channels[i].onDestroyContext!();else imports!.host_gl_destroy_context(7,21+i);};
    create(0);current(0);storage(0,[255,0,0,255]);attachment(0);const red=pixels(0);
    create(1,0);current(1);attachment(1);const sharedRed=pixels(1);
    send(1,O.OP_BIND_TEXTURE,[0x0de1,17]);
    send(1,O.OP_TEX_SUB_IMAGE_2D,[0x0de1,0,0,0,1,1,0x1908,0x1401,4],new Uint8Array([0,255,0,255]));
    current(0);const sharedGreen=pixels(0);
    create(2);current(2);storage(2,[0,0,255,255]);attachment(2);const independent=pixels(2);
    destroy(0);current(1);const survivor=pixels(1);
    create(3,1);current(3);attachment(3);const chained=pixels(3);
    current(1);send(1,O.OP_DELETE_TEXTURES,[1,17]);
    current(3);const unnamed=pixels(3),publicName=query(3,O.QOP_IS_OBJECT,[1,17],12);
    current(1);storage(1,[255,255,0,255]);
    current(3);const afterReuse=pixels(3);destroy(1);const afterPeerDestroy=pixels(3);
    destroy(2);destroy(3);
    for(let i=0;i<4;i++) {
      if(forwarded){channels[i].onUnbind!(11+i);if(channels[i].onPresent!()!==-5)throw new Error("retired session revived");}
      else imports!.host_gl_unbind(7,11+i);
    }
    const clean=forwarded?null:created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());
    postMessage({type:"share_context_result",red,sharedRed,sharedGreen,independent,survivor,chained,unnamed,
      publicName:publicName.slice(4,8),afterReuse,afterPeerDestroy,clean,error:forwarded?0:gl!.getError()});
  } catch(error){postMessage({type:"share_context_failed",error:String(error)});}
};
